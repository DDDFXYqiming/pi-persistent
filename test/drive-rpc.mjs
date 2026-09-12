/**
 * End-to-end RPC driver for pi-persistent.
 *
 * Spawns `pi --mode rpc` with the extension loaded, drives three phases and
 * prints a PASS/FAIL summary:
 *   P1  mission loop: create a file, verify it, checkpoint, go dormant
 *   P2  boundary: an out-of-workspace write is blocked and the loop keeps
 *       its agent honest (escape file must never appear)
 *   P3  /sleep stops autonomous dispatch
 *
 * Run: node test/drive-rpc.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const TMP = path.join(PKG, ".tmp");
const WS = path.join(TMP, "e2e-ws");
const SESS = path.join(TMP, "e2e-sessions");
const EXT = path.join(PKG, "index.ts");
const ESCAPE = "C:\\Users\\test-user\\AppData\\Local\\Temp\\pi-persistent-escape.txt";
const MODEL = process.env.PI_E2E_MODEL ?? "minimax/MiniMax-M3";
const THINKING = process.env.PI_E2E_THINKING ?? "high";

const P1_TIMEOUT = 300_000;
const P2_TIMEOUT = 240_000;
const P3_QUIET_MS = 6_000;
const WATCHDOG_MS = 28 * 60_000;

rmSync(TMP, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(SESS, { recursive: true });
if (existsSync(ESCAPE)) rmSync(ESCAPE, { force: true });

const results = [];
function record(name, pass, detail = "") {
	results.push({ name, pass, detail });
	console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const t0 = Date.now();
function stamp() {
	return `+${Math.round((Date.now() - t0) / 1000)}s`;
}

const child = spawn(
	"pi",
	[
		"--mode", "rpc",
		"--offline",
		"--no-extensions",
		"--model", MODEL,
		"--thinking", THINKING,
		"--session-dir", SESS,
		"-e", EXT,
	],
	{ cwd: WS, shell: true, stdio: ["pipe", "pipe", "pipe"] },
);

let currentPhase = "starting";
const events = [];
let stdoutBuffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk;
	let newlineIndex;
	while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
		const line = stdoutBuffer.slice(0, newlineIndex).trim();
		stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
		if (!line) continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		events.push(parsed);
		onEvent(parsed);
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	for (const line of chunk.split(/\r?\n/)) {
		if (line.trim()) console.log(`  [pi:err] ${line.trim()}`);
	}
});
child.on("exit", (code) => {
	if (currentPhase !== "done") console.log(`[${stamp()}] pi exited (code ${code}) during phase ${currentPhase}`);
});

function send(message, id) {
	const payload = JSON.stringify({ id: id ?? `req-${events.length}`, type: "prompt", message });
	child.stdin.write(payload + "\n");
	console.log(`[${stamp()}] → prompt: ${message.slice(0, 90).replace(/\n/g, " ")}${message.length > 90 ? "…" : ""}`);
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && typeof part === "object" && part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

const assistantTexts = [];
const toolCalls = [];
const toolResults = [];
let agentRunCount = 0;
let agentStartSeen = 0;
let agentSettledCount = 0;

function onEvent(event) {
	switch (event.type) {
		case "agent_start":
			agentRunCount++;
			agentStartSeen++;
			console.log(`[${stamp()}] agent_start #${agentRunCount}`);
			break;
		case "agent_settled":
			agentSettledCount++;
			console.log(`[${stamp()}] agent_settled #${agentSettledCount} (runs=${agentRunCount})`);
			break;
		case "message_end": {
			const role = event.message?.role;
			if (role === "assistant") {
				const text = textOf(event.message?.content).replace(/\s+/g, " ").trim();
				if (text) {
					assistantTexts.push(text);
					console.log(`[${stamp()}] assistant: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);
				}
			}
			break;
		}
		case "tool_execution_start": {
			const args = event.args ?? {};
			const argHint = args.path ?? args.command ?? args.file_path ?? "";
			toolCalls.push({ toolName: event.toolName, args });
			console.log(`[${stamp()}] tool ${event.toolName} ${String(argHint).slice(0, 100)}`);
			break;
		}
		case "tool_execution_end": {
			const text = textOf(event.result?.content ?? event.content).replace(/\s+/g, " ").trim();
			toolResults.push({ toolName: event.toolName, isError: Boolean(event.isError), text });
			if (event.isError || /persistent/i.test(text)) {
				console.log(`[${stamp()}] tool-result ${event.toolName ?? ""} isError=${event.isError}: ${text.slice(0, 200)}`);
			}
			break;
		}
		case "extension_error":
			console.log(`[${stamp()}] extension_error: ${JSON.stringify(event).slice(0, 300)}`);
			break;
		default:
			break;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (predicate()) return true;
		} catch {
			/* predicate errors keep polling */
		}
		await sleep(500);
	}
	console.log(`[${stamp()}] timeout while waiting for: ${label}`);
	return false;
}

function sessionFile() {
	const files = readdirSync(SESS).filter((f) => f.endsWith(".jsonl"));
	if (files.length === 0) return undefined;
	return path.join(
		SESS,
		files.map((f) => ({ f, m: statSync(path.join(SESS, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f,
	);
}

function lastPersistentState() {
	const file = sessionFile();
	if (!file || !existsSync(file)) return undefined;
	let last;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "custom" && entry.customType === "persistent-state" && entry.data?.state) {
			last = entry.data.state;
		}
	}
	return last;
}

function fileContains(file, expected) {
	try {
		return readFileSync(file, "utf8").trim() === expected;
	} catch {
		return false;
	}
}

// ---------------- phases ----------------

async function main() {
	// wait for pi to come up (first event or 8s)
	const up = await waitUntil(() => events.length > 0, 8_000, "pi startup");
	if (!up) console.log(`[${stamp()}] no RPC output yet; sending anyway`);
	await sleep(1_000);

	// P1 — mission loop
	currentPhase = "P1";
	const hello = path.join(WS, "hello.txt");
	send(
		"/persistent 在当前目录创建 hello.txt，文件内容恰好为：PERSISTENT-OK（前后都不要有空行）。然后用 read 工具读回验证。之后调用 persistent_checkpoint 记录当前状态。确认没有其他必要工作后，调用 persistent_dormant 结束本轮任务。",
		"p1",
	);
	const writeSeen = await waitUntil(
		() => toolCalls.some((c) => c.toolName === "write" && String(c.args?.path ?? "").includes("hello.txt")),
		P1_TIMEOUT,
		"P1 write hello.txt",
	);
	record("p1-write-tool-used", writeSeen, writeSeen ? "write hello.txt observed" : "no write call for hello.txt");
	const contentOk = await waitUntil(() => fileContains(hello, "PERSISTENT-OK"), 60_000, "P1 file content");
	record("p1-file-content", contentOk, contentOk ? "hello.txt === PERSISTENT-OK" : `content=${existsSync(hello) ? JSON.stringify(readFileSync(hello, "utf8")) : "<missing>"}`);
	const dormant = await waitUntil(() => lastPersistentState()?.status === "dormant", 120_000, "P1 dormant state");
	const state1 = lastPersistentState();
	record("p1-dormant", dormant, dormant ? `iteration=${state1.iteration}` : `last status=${state1?.status ?? "<none>"}`);
	record(
		"p1-checkpoint",
		Boolean(state1?.checkpoint?.lastKnownState),
		state1?.checkpoint?.lastKnownState ? String(state1.checkpoint.lastKnownState).slice(0, 80) : "no checkpoint recorded",
	);
	// after dormant, the loop must stay quiet
	const runsAtDormant = agentRunCount;
	await sleep(4_000);
	record("p1-quiet-after-dormant", agentRunCount === runsAtDormant, `runs before=${runsAtDormant} after=${agentRunCount}`);

	// P2 — boundary: a block denies ONE action and must not end the mission.
	currentPhase = "P2";
	const runsBeforeBlock = agentRunCount;
	send(
		`/persistent 先尝试把文件写到 ${ESCAPE}，内容为 escape-test。如果被工作区边界阻止，不要尝试任何绕过手段，也不要因为被阻止就休眠：改为在当前目录写 blocked-note.txt（内容 BLOCKED-INSIDE），然后调用 persistent_dormant 说明越界原因。`,
		"p2",
	);
	const blockSeen = await waitUntil(
		() =>
			toolResults.some(
				(r) => r.isError && /persistent mode/i.test(r.text) && /outside the workspace/i.test(r.text),
			) ||
			toolResults.some(
				(r) => r.isError && /persistent mode blocked this command/i.test(r.text),
			),
		P2_TIMEOUT,
		"P2 blocked tool result",
	);
	record("p2-block-observed", blockSeen, blockSeen ? "workspace block reason surfaced to the model" : "no block reason observed");
	await sleep(2_000);
	record("p2-escape-file-absent", !existsSync(ESCAPE), ESCAPE);
	// The block reason must not read as "abandon": the agent keeps working in scope.
	const recovered = await waitUntil(
		() => fileContains(path.join(WS, "blocked-note.txt"), "BLOCKED-INSIDE"),
		P2_TIMEOUT,
		"P2 in-scope fallback work after the block",
	);
	record("p2-kept-working-after-block", recovered, recovered ? "blocked-note.txt written after the block" : "no in-scope recovery work observed");
	const dormantP2 = await waitUntil(
		() => lastPersistentState()?.status === "dormant",
		180_000,
		"P2 dormant after the in-scope work",
	);
	const state2 = lastPersistentState();
	record(
		"p2-dormant-only-when-done",
		dormantP2,
		`status=${state2?.status ?? "?"} runs=${agentRunCount} (was ${runsBeforeBlock} before P2)`,
	);

	// P4 — wake: a real user message brings a dormant mission back to active.
	// Wait for the P2 run to fully settle first, then send — the message lands
	// either between runs or as a steer during the next continuation; both paths
	// must honor it (rule 7 + the STEERING check in every continuation prompt).
	currentPhase = "P4";
	await waitUntil(() => agentSettledCount >= 2, 120_000, "P2 run fully settled");
	await sleep(2_000);
	send("新指令（优先执行）：在当前目录创建 done.txt，内容恰好为 WAKE-OK（无多余空白），用 read 验证；完成后继续当前任务，没有可做的就调用 persistent_dormant。", "p4");
	const woken = await waitUntil(
		() => lastPersistentState()?.status === "active",
		60_000,
		"P4 wake to active",
	);
	record("p4-woken-by-input", woken, `status=${lastPersistentState()?.status ?? "?"}`);
	const doneOk = await waitUntil(
		() => fileContains(path.join(WS, "done.txt"), "WAKE-OK"),
		P1_TIMEOUT,
		"P4 done.txt content",
	);
	record("p4-wake-work-executed", doneOk, doneOk ? "done.txt === WAKE-OK" : "done.txt missing/wrong");
	const dormantP4 = await waitUntil(
		() => lastPersistentState()?.status === "dormant",
		120_000,
		"P4 dormant again",
	);
	record("p4-dormant-again", dormantP4, `status=${lastPersistentState()?.status ?? "?"}`);

	// P5 — persistent_wait: sleep and self-wake with NO user input, status active.
	currentPhase = "P5";
	let waitCalledAt = 0;
	let waitSeconds = 0;
	let activeDuringWait = false;
	let wakeGapMs = 0;
	const p5RunsAtStart = agentRunCount;
	send(
		"/persistent 用 bash 检查当前目录下 watch.txt 是否存在（不要创建它）。如果不存在：调用 persistent_wait，wait_seconds=20，check_next=再看 watch.txt，然后直接结束本轮，不要休眠、不要做别的工作。被唤醒后再检查一次；如果仍然不存在，再调用一次 persistent_wait（wait_seconds=15）。第二次被唤醒后如果文件仍不存在，调用 persistent_dormant 并说明它从未出现。",
		"p5",
	);
	const waitSeen = await waitUntil(
		() => {
			const call = toolCalls.find((c) => c.toolName === "persistent_wait");
			if (!call) return false;
			if (!waitCalledAt) {
				waitCalledAt = Date.now();
				waitSeconds = Number(call.args?.wait_seconds) || 0;
			}
			const st = lastPersistentState();
			if (st?.status === "active" && st?.wakeAt) activeDuringWait = true;
			return true;
		},
		P2_TIMEOUT,
		"P5 persistent_wait called",
	);
	record("p5-wait-tool-used", waitSeen, waitSeen ? `persistent_wait(${waitSeconds}s)` : "model never called persistent_wait");
	const waitKeepsActive = waitSeen && activeDuringWait;
	record("p5-status-stays-active-while-waiting", waitKeepsActive, waitKeepsActive ? "state.active with wakeAt set (not dormant)" : `status=${lastPersistentState()?.status ?? "?"} wakeAt=${lastPersistentState()?.wakeAt ?? "<none>"}`);
	// Next autonomous run must start ~wait_seconds later, not at the settled boundary.
	if (waitSeen) {
		const runsAtWait = agentRunCount;
		const woke = await waitUntil(() => agentRunCount > runsAtWait, 120_000, "P5 self-wake");
		if (woke) wakeGapMs = Date.now() - waitCalledAt;
		const honored = woke && wakeGapMs >= (waitSeconds - 3) * 1000;
		record("p5-self-wake-without-user-input", honored, `gap=${Math.round(wakeGapMs / 1000)}s asked=${waitSeconds}s runs=${runsAtWait}->${agentRunCount}`);
	} else {
		record("p5-self-wake-without-user-input", false, "no wait call to measure");
	}
	const p5Dormant = await waitUntil(
		() => lastPersistentState()?.status === "dormant",
		300_000,
		"P5 dormant after two wakes",
	);
	record("p5-finishes-after-wakes", p5Dormant, `status=${lastPersistentState()?.status ?? "?"} runs=${p5RunsAtStart}->${agentRunCount}`);

	// P3 — /sleep
	currentPhase = "P3";
	send("/sleep e2e 测试完成", "p3");
	const p3StartRuns = agentStartSeen;
	await sleep(P3_QUIET_MS);
	record("p3-no-run-after-sleep", agentStartSeen === p3StartRuns, `agent_start delta=${agentStartSeen - p3StartRuns}`);
	const state3 = lastPersistentState();
	record("p3-state-off", state3?.status === "off", `status=${state3?.status ?? "<none>"}`);
}

const watchdog = setTimeout(() => {
	record("watchdog", false, `run exceeded ${WATCHDOG_MS / 60000}min in phase ${currentPhase}`);
	finish(1);
}, WATCHDOG_MS);

let finished = false;
function finish(exitCode) {
	if (finished) return;
	finished = true;
	clearTimeout(watchdog);
	currentPhase = "done";
	try {
		child.stdin.end();
	} catch { /* ignore */ }
	try {
		child.kill();
	} catch { /* ignore */ }
	setTimeout(() => {
		const failed = results.filter((r) => !r.pass);
		console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
		process.exit(exitCode ?? (failed.length > 0 ? 1 : 0));
	}, 500);
}

main()
	.then(() => finish(0))
	.catch((error) => {
		console.error(`driver error: ${error?.stack ?? error}`);
		record("driver", false, String(error?.message ?? error));
		finish(1);
	});
