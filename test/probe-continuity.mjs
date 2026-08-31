/**
 * Continuity probe: does the loop actually keep running?
 *
 * C1  the mission forbids dormant/wait, the model only says "done" — the host must
 *     still auto-continue across several settled boundaries (no turn cap, no
 *     "no progress" breaker).
 * C2  a foreign extension-owned message (no persistent marker) lands while active.
 *     The old code dropped the dispatch on that boundary and the loop died silently.
 * C3  /sleep stops it.
 *
 * Run: node test/probe-continuity.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const TMP = path.join(PKG, ".tmp", "continuity");
const WS = path.join(TMP, "ws");
const SESS = path.join(TMP, "sessions");
const NOISE = path.join(TMP, "noise.ts");
const EXT = path.join(PKG, "index.ts");
const MODEL = process.env.PI_E2E_MODEL ?? "minimax/MiniMax-M3";
const THINKING = process.env.PI_E2E_THINKING ?? "high";

rmSync(TMP, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(SESS, { recursive: true });
writeFileSync(
	NOISE,
	[
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
		`export default function (pi: ExtensionAPI) {`,
		`	pi.registerCommand("noise", {`,
		`		description: "Send an unrelated extension-owned message",`,
		`		handler: async () => {`,
		`			pi.sendUserMessage("noise: an unrelated extension message with no persistent marker", { deliverAs: "followUp" });`,
		`		},`,
		`	});`,
		`}`,
		"",
	].join("\n"),
	"utf8",
);

const results = [];
function record(name, pass, detail = "") {
	results.push({ name, pass });
	console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `+${Math.round((Date.now() - t0) / 1000)}s`;

const child = spawn(
	"pi",
	["--mode", "rpc", "--offline", "--no-extensions", "--model", MODEL, "--thinking", THINKING, "--session-dir", SESS, "-e", EXT, "-e", NOISE],
	{ cwd: WS, shell: true, stdio: ["pipe", "pipe", "pipe"] },
);

let settled = 0;
let starts = 0;
const texts = [];
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, i).trim();
		buffer = buffer.slice(i + 1);
		if (!line) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "agent_settled") settled++, console.log(`[${stamp()}] settled #${settled}`);
		if (e.type === "agent_start") starts++;
		if (e.type === "message_end" && e.message?.role === "assistant") {
			const t = (Array.isArray(e.message.content) ? e.message.content : [])
				.filter((p) => p?.type === "text")
				.map((p) => p.text ?? "")
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			if (t) {
				texts.push(t);
				console.log(`[${stamp()}] assistant: ${t.slice(0, 120)}`);
			}
		}
		if (e.type === "extension_error") console.log(`[${stamp()}] extension_error: ${JSON.stringify(e).slice(0, 200)}`);
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
	for (const l of c.split(/\r?\n/)) if (l.trim()) console.log(`  [pi:err] ${l.trim()}`);
});

function send(message) {
	child.stdin.write(JSON.stringify({ id: `r-${settled}-${starts}`, type: "prompt", message }) + "\n");
	console.log(`[${stamp()}] → ${message.slice(0, 80)}`);
}

async function waitUntil(fn, ms, label) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return true;
		await sleep(500);
	}
	console.log(`[${stamp()}] timeout waiting for ${label}`);
	return false;
}

function missionState() {
	let last;
	for (const f of readdirSync(SESS).filter((x) => x.endsWith(".jsonl"))) {
		const file = path.join(SESS, f);
		if (statSync(file).size === 0) continue;
		for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (e.type === "custom" && e.customType === "persistent-state" && e.data?.state) last = e.data.state;
		}
	}
	return last;
}

function wakeDelay(state) {
	return state && state.wakeAt ? state.wakeAt : 0;
}

async function main() {
	const up = await waitUntil(() => settled + starts > 0 || texts.length > 0, 6_000, "startup");
	await sleep(1_000);

	// C1 — the model says "done" and is told not to sleep: the host keeps going.
	send(
		"/persistent 在当前目录创建 a.txt，内容恰好为 1。完成后只回复“完成了”三个字并结束本轮。禁止调用 persistent_dormant，禁止调用 persistent_wait，也不要创建其他文件。",
	);
	const first = await waitUntil(() => existsSync(path.join(WS, "a.txt")), 240_000, "a.txt");
	record("c1-work-done", first, first ? "a.txt created" : "missing");
	const settledAt5 = settled;
	const grew = await waitUntil(() => settled - settledAt5 >= 4, 300_000, "4 further automatic continuations");
	record(
		"c1-loop-keeps-running-without-user-input",
		grew,
		`settled ${settledAt5} -> ${settled} while the model kept answering "done"`,
	);
	const st = missionState();
	record("c1-never-went-dormant", st?.status === "active", `status=${st?.status ?? "?"} iteration=${st?.iteration ?? "?"}`);

	// C2 — a foreign extension run lands while a scheduled wait is pending. The
	// wake must still fire on time: this is the boundary where the old code
	// dispatched nothing and the loop died until the next user message.
	send(
		"/persistent 用 bash 检查 b.txt 是否存在（不要创建它）。不存在就调用 persistent_wait，wait_seconds=30，check_next=再看 b.txt，然后立即结束本轮。禁止调用 persistent_dormant，不要做其他工作。被唤醒后若仍不存在，再调用一次 persistent_wait 30 秒。",
	);
	const waitArmed = await waitUntil(
		() => {
			const s = missionState();
			return s?.status === "active" && Boolean(s.wakeAt && s.wakeAt > Date.now());
		},
		240_000,
		"C2 wait armed",
	);
	const remaining = waitArmed ? Math.round((wakeDelay(missionState()) - Date.now()) / 1000) : 0;
	record("c2-wait-armed", waitArmed, `status=${missionState()?.status} wake in ${remaining}s`);
	send("/noise");
	await sleep(8_000);
	const startsAfterNoise = starts;
	const leftAfterNoise = missionState()?.wakeAt ? Math.round((wakeDelay(missionState()) - Date.now()) / 1000) : 0;
	if (leftAfterNoise > 0) await sleep(leftAfterNoise * 1000 + 25_000);
	const wokeAfterForeign = starts > startsAfterNoise;
	const st2 = missionState();
	record(
		"c2-wake-survives-foreign-run",
		wokeAfterForeign,
		`starts ${startsAfterNoise} -> ${starts} with no user prompt in between (noise landed ${remaining}s into a ${remaining}s wait)`,
	);
	record("c2-still-active", st2?.status === "active", `status=${st2?.status ?? "?"} iteration=${st2?.iteration ?? "?"}`);

	// C3 — /sleep stops it. An already in-flight run may finish, but nothing starts.
	send("/sleep continuity probe done");
	await waitUntil(() => missionState()?.status === "off", 30_000, "state off");
	const startsAtSleep = starts;
	await sleep(25_000);
	record("c3-no-new-run-after-sleep", starts === startsAtSleep, `agent_start delta=${starts - startsAtSleep}`);
	record("c3-state-off", missionState()?.status === "off", `status=${missionState()?.status ?? "?"}`);
}

const watchdog = setTimeout(() => {
	record("watchdog", false, "probe exceeded 18min");
	finish(1);
}, 18 * 60_000);

let finished = false;
function finish(code) {
	if (finished) return;
	finished = true;
	clearTimeout(watchdog);
	try {
		child.stdin.end();
		child.kill();
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		const failed = results.filter((r) => !r.pass);
		console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
		process.exit(code ?? (failed.length ? 1 : 0));
	}, 500);
}

main().then(() => finish(0)).catch((e) => {
	record("driver", false, String(e?.message ?? e));
	finish(1);
});
