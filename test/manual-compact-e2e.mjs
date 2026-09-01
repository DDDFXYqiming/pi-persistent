#!/usr/bin/env node
/**
 * Manual /compact E2E for the pi-persistent compaction guard.
 * Spawns an isolated Pi RPC session with a real model, forces compaction,
 * and verifies the guard (not pi's default path) produced the summary while
 * the session keeps running afterwards. Thinking stays HIGH on purpose: the
 * guard must not inherit it into the summarization request.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.join(tmpdir(), `pi-persistent-compact-e2e-${process.pid}`);
const WORKSPACE = path.join(ROOT, "workspace");
const SESSIONS = path.join(ROOT, "sessions");
const EXT = path.join(PKG, "index.ts");
const PI_JS = process.env.PI_E2E_PI_JS ?? path.join(PKG, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const MODEL = process.env.PI_E2E_MODEL ?? "aliyun-tokenplan/qwen3.8-flash";
const THINKING = process.env.PI_E2E_THINKING ?? "high";
const TIMEOUT = Number(process.env.PI_E2E_TIMEOUT_MS ?? 300_000);

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(SESSIONS, { recursive: true });
// Isolated agent dir: copy the real auth/model catalog and shrink the
// compaction keep-recent window so the short E2E conversation actually
// yields messages to summarize. The temp dir is removed in cleanup.
const AGENT = path.join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const realAgent = path.join(home, ".pi", "agent");
for (const name of ["models.json", "auth.json"]) {
	const src = path.join(realAgent, name);
	if (existsSync(src)) copyFileSync(src, path.join(AGENT, name));
}
writeFileSync(
	path.join(AGENT, "settings.json"),
	JSON.stringify({ compaction: { keepRecentTokens: 50, reserveTokens: 2048 }, theme: "dark" }, null, 2) + "\n",
	"utf8",
);

const results = [];
const events = [];
let buffer = "";
let stderrText = "";
let settled = 0;
let extensionErrors = 0;
let startupState;
let compactResponse;
let stopping;

function record(name, pass, detail = "") {
	results.push({ name, pass, detail });
	console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function sessionEntries() {
	const files = readdirSync(SESSIONS).filter((n) => n.endsWith(".jsonl"));
	if (!files.length) return [];
	const file = files.map((n) => path.join(SESSIONS, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
	return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
		try { return [JSON.parse(line)]; } catch { return []; }
	});
}

function waitFor(predicate, label, timeoutMs = TIMEOUT) {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (predicate()) return resolve(true);
			if (Date.now() >= deadline) { console.log(`timeout: ${label}`); return resolve(false); }
			setTimeout(check, 250);
		};
		check();
	});
}

const child = spawn(process.execPath, [PI_JS, "--mode", "rpc", "--offline", "--no-extensions", "--no-tools", "--model", MODEL, "--thinking", THINKING, "--session-dir", SESSIONS, "-e", EXT], { cwd: WORKSPACE, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: AGENT } });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		try {
			const event = JSON.parse(line);
			events.push(event);
			if (event.type === "response" && event.id === "startup-state" && event.success) startupState = event.data;
			if (event.type === "response" && event.id === "manual-compact") compactResponse = event;
			if (event.type === "agent_settled") settled += 1;
			if (event.type === "extension_error") {
				extensionErrors += 1;
				console.log(`extension_error ${JSON.stringify(event).slice(0, 400)}`);
			}
		} catch { /* non-json */ }
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderrText += chunk; for (const line of chunk.split(/\r?\n/)) if (line.trim()) console.log(`  [pi] ${line.trim().slice(0, 300)}`); });

function stopChild() {
	if (stopping) return stopping;
	stopping = new Promise((resolve) => {
		let done = false;
		const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
		const t = setTimeout(finish, 5_000);
		child.once("exit", finish);
		try { child.stdin.end(); } catch {}
		if (process.platform === "win32" && child.pid && child.exitCode === null) {
			spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		}
		if (child.exitCode === null) child.kill();
	});
	return stopping;
}

async function cleanup() {
	for (let i = 0; i < 20; i++) {
		try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); return true; }
		catch { await new Promise((r) => setTimeout(r, 250)); }
	}
	return false;
}

async function main() {
	child.stdin.write(JSON.stringify({ id: "startup-state", type: "get_state" }) + "\n");
	if (!(await waitFor(() => startupState !== undefined, "startup state"))) throw new Error("no startup state");

	const prompts = [
		"请用中文写一段约800字的说明，主题是压缩守护模块的设计目标，不要调用工具。",
		"请再用中文写一段约800字的说明，主题是离线测试与端到端测试的分工，不要调用工具。",
	];
	for (let i = 0; i < prompts.length; i++) {
		child.stdin.write(JSON.stringify({ id: `turn-${i + 1}`, type: "prompt", message: prompts[i] }) + "\n");
		if (!(await waitFor(() => settled >= i + 1, `settled ${i + 1}`))) throw new Error(`turn ${i + 1} did not settle`);
	}

	// RPC-native compaction (TUI built-in /compact is not routed in RPC mode).
	child.stdin.write(JSON.stringify({ id: "manual-compact", type: "compact" }) + "\n");
	const compactDone = await waitFor(() => compactResponse !== undefined, "compact response");
	const guardLogged = /\[pi-persistent\] guard: (llm|compressed|fallback) compaction of/.test(stderrText);
	const compactEntry = sessionEntries().find((e) => e.type === "compaction" && e.details?.guard === "pi-persistent");
	const summaryOk = Boolean(compactEntry && typeof compactEntry.summary === "string" && compactEntry.summary.length > 40);
	const pathTag = compactEntry?.details?.path ?? "none";
	const structured = Boolean(compactEntry && /^## /m.test(compactEntry.summary));

	child.stdin.write(JSON.stringify({ id: "post", type: "prompt", message: "请只用一个词回答：还在吗。不要调用工具。" }) + "\n");
	const resumed = await waitFor(() => settled >= 3, "post-compaction turn");

	record("model-and-thinking-configured", startupState?.model?.provider === MODEL.split("/")[0], MODEL);
	record("compact-command-accepted", compactDone && compactResponse?.success === true && compactResponse?.command === "compact", JSON.stringify(compactResponse ?? {}).slice(0, 220));
	record("guard-log-emitted", guardLogged, guardLogged ? "stderr guard line seen" : stderrText.slice(-300));
	record("guard-produced-compaction-entry", Boolean(compactEntry), `path=${pathTag}`);
	record("summary-present-and-structured", summaryOk && structured, `len=${compactEntry?.summary?.length ?? 0}`);
	record("session-continues-after-compaction", resumed, `settled=${settled}`);
	record("no-extension-errors", extensionErrors === 0, `count=${extensionErrors}`);
}

let cleaned = true;
try {
	await main();
} catch (error) {
	console.error(error);
	process.exitCode = 2;
} finally {
	await stopChild();
	cleaned = await cleanup();
}
if (!cleaned) console.log("WARN: temp dir not cleaned:", ROOT);
const passed = results.filter((r) => r.pass).length;
console.log(`\n=== COMPACT GUARD E2E: ${passed}/${results.length} passed ===`);
if (process.exitCode !== 2) process.exitCode = passed === results.length ? 0 : 1;

setTimeout(() => { console.error("GLOBAL WATCHDOG"); void stopChild().then(() => process.exit(2)); }, TIMEOUT * 3).unref();
