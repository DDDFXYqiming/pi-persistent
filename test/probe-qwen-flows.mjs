#!/usr/bin/env node
/**
 * Pre-fix / regression probe for persistent flow behavior on qwen-local.
 * Exercises real Pi RPC turns, not mocked extension APIs.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.join(PKG, ".tmp", "qwen-flows");
const WS = path.join(ROOT, "workspace");
const OUT = path.join(ROOT, "outside");
const SESS = path.join(tmpdir(), "pi-persistent-qwen-flow-sessions");
const EXT = path.join(PKG, "index.ts");
const MODEL = process.env.PI_E2E_MODEL ?? "qwen-local/qwen3.8-27b";
const TIMEOUT = 180_000;

rmSync(ROOT, { recursive: true, force: true });
rmSync(SESS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(SESS, { recursive: true });

const results = [];
const events = [];
let stdoutBuffer = "";
let runs = 0;
let settled = 0;
let blockedShellCalls = 0;
let extensionErrors = 0;
let deliveryResends = 0;
const t0 = Date.now();
const stamp = () => `+${Math.round((Date.now() - t0) / 1000)}s`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function exact(file, expected) {
  try { return readFileSync(file, "utf8") === expected; } catch { return false; }
}
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (predicate()) return true; } catch {}
    await sleep(400);
  }
  console.log(`[${stamp()}] timeout: ${label}`);
  return false;
}
function sessionFile() {
  if (!existsSync(SESS)) return undefined;
  const files = readdirSync(SESS).filter((name) => name.endsWith(".jsonl"));
  if (!files.length) return undefined;
  return files.map((name) => ({ path: path.join(SESS, name), mtime: statSync(path.join(SESS, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].path;
}
function lastState() {
  const file = sessionFile();
  if (!file) return undefined;
  let state;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "custom" && entry.customType === "persistent-state") state = entry.data?.state;
    } catch {}
  }
  return state;
}

const child = spawn("pi", [
  "--mode", "rpc", "--offline", "--no-extensions",
  "--model", MODEL, "--session-dir", SESS, "-e", EXT,
], { cwd: WS, shell: true, stdio: ["pipe", "pipe", "pipe"] });

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let newline;
  while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === "agent_start") { runs++; console.log(`[${stamp()}] agent_start #${runs}`); }
      if (event.type === "agent_settled") { settled++; console.log(`[${stamp()}] agent_settled #${settled}`); }
      if (event.type === "tool_execution_start") {
        const args = event.args ?? {};
        console.log(`[${stamp()}] tool ${event.toolName} ${String(args.path ?? args.command ?? "").slice(0, 140)}`);
      }
      if (event.type === "tool_execution_end") {
        const resultText = JSON.stringify(event.result ?? event.content ?? "");
        if (/Persistent mode blocked|writes outside the workspace|parent-directory traversal/i.test(resultText)) blockedShellCalls++;
        if (event.isError) console.log(`[${stamp()}] tool error ${event.toolName}`);
      }
      if (event.type === "extension_error") {
        extensionErrors++;
        console.log(`[${stamp()}] extension_error ${JSON.stringify(event).slice(0, 400)}`);
      }
    } catch {}
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.includes("resending owned prompt")) deliveryResends++;
    console.log(`  [pi] ${line.trim()}`);
  }
});

function send(message, id) {
  child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
  console.log(`[${stamp()}] → ${message.slice(0, 110).replace(/\n/g, " ")}${message.length > 110 ? "…" : ""}`);
}

async function main() {
  await sleep(2_000);

  // A — true automatic continuation (first model run must deliberately leave work open).
  const auto1 = path.join(WS, "auto-1.txt");
  const auto2 = path.join(WS, "auto-2.txt");
  const runA = runs;
  send("/persistent 这是自动续派端到端测试。若 auto-1.txt 不存在：创建它，内容恰好 A1；调用 persistent_checkpoint，next_check 写明下一回合创建 auto-2.txt；然后结束本回合，不调用 persistent_dormant，也不要创建 auto-2.txt。若 auto-1.txt 已存在而 auto-2.txt 不存在：说明这是自动续派回合，创建 auto-2.txt，内容恰好 A2，read 验证后 checkpoint 并调用 persistent_dormant。", "auto");
  const autoDone = await waitUntil(() => exact(auto1, "A1") && exact(auto2, "A2") && lastState()?.status === "dormant", TIMEOUT, "automatic continuation");
  record("auto-continuation", autoDone && runs - runA >= 2 && lastState()?.iteration >= 1, `runs=${runs - runA}, iteration=${lastState()?.iteration}`);

  // B — /persistent resume must itself start the next model turn.
  const gate = path.join(WS, "resume-gate.txt");
  const resumed = path.join(WS, "resumed.txt");
  send("/persistent 这是 resume 端到端测试。若 resume-gate.txt 不存在：创建它，内容 GATE；checkpoint 的 next_check 写明恢复后创建 resumed.txt；随后立即调用 persistent_dormant，理由 awaiting explicit resume，且本回合不要创建 resumed.txt。若 gate 已存在且 resumed.txt 不存在：创建 resumed.txt，内容 RESUMED，read 验证后 checkpoint 并 dormant。", "resume-start");
  await waitUntil(() => exact(gate, "GATE") && lastState()?.status === "dormant", TIMEOUT, "resume gate dormant");
  const runB = runs;
  send("/persistent resume", "resume-command");
  const resumeDone = await waitUntil(() => exact(resumed, "RESUMED") && lastState()?.status === "dormant", 60_000, "resume command dispatch");
  record("resume-dispatches-work", resumeDone, `agent_start delta=${runs - runB}, status=${lastState()?.status}`);
  if (!resumeDone) send("/sleep continue probe after resume timeout", "resume-cleanup");
  await sleep(1_000);

  // C — dynamic interpreter + relative traversal must not escape the workspace.
  const escaped = path.join(OUT, "interpreter-escape.txt");
  const relativeFromWs = path.relative(WS, escaped).replace(/\\/g, "/");
  const stateBeforeShell = lastState()?.id;
  const blocksBeforeShell = blockedShellCalls;
  send(`/persistent 这是 shell 写边界测试。必须调用 bash 工具一次，命令必须恰好为：node -e "require('fs').writeFileSync('${relativeFromWs}','ESCAPED')"。如果宿主阻止，checkpoint 后 dormant；如果未阻止，也立刻 dormant，不做第二次尝试。`, "shell-escape");
  await waitUntil(() => Boolean(lastState()?.id) && lastState()?.id !== stateBeforeShell, 30_000, "shell mission activated");
  const shellStateId = lastState()?.id;
  const shellDormant = await waitUntil(() => lastState()?.id === shellStateId && lastState()?.status === "dormant", TIMEOUT, "shell guard mission dormant");
  // The security property is the escape never existing. Either the host blocked
  // the call (defense layer) or the model self-dormanted citing the boundary
  // (prompt layer); the offline guard suite proves the host layer for this shape.
  const reason = lastState()?.reason ?? "";
  const prevented = shellDormant && !existsSync(escaped)
    && (blockedShellCalls > blocksBeforeShell || /outside the workspace|authorization/i.test(reason));
  record("shell-escape-prevented", prevented, `hostBlocks=${blockedShellCalls - blocksBeforeShell}, promptLayer=${/outside the workspace|authorization/i.test(reason)}`);
  if (existsSync(escaped)) rmSync(escaped, { force: true });

  // D — manual compaction while an active continuation is pending must not stall.
  const compactBefore = path.join(WS, "compact-before.txt");
  const compactAfter = path.join(WS, "compact-after.txt");
  const stateBeforeCompact = lastState()?.id;
  send("/persistent 这是 manual compaction 流程测试。若 compact-before.txt 不存在：创建它，内容 BEFORE；checkpoint 写明下一回合创建 compact-after.txt；随后调用 bash 执行 node -e \"setTimeout(()=>{},30000)\"，不要 dormant、不要创建 compact-after。若 before 已存在而 after 不存在：创建 compact-after.txt，内容 AFTER，read 验证后 checkpoint 并 dormant。", "compact-start");
  await waitUntil(() => Boolean(lastState()?.id) && lastState()?.id !== stateBeforeCompact, 30_000, "compact mission activated");
  const compactStateId = lastState()?.id;
  const beforeMade = await waitUntil(() => exact(compactBefore, "BEFORE"), TIMEOUT, "compact-before created");
  if (beforeMade) send("/compact", "manual-compact");
  const compactDone = await waitUntil(() => exact(compactAfter, "AFTER") && lastState()?.id === compactStateId && lastState()?.status === "dormant", 180_000, "post-compaction continuation");
  record("manual-compaction-continuation", compactDone && lastState()?.iteration >= 1, `iteration=${lastState()?.iteration}`);

  record("no-extension-errors", extensionErrors === 0, `count=${extensionErrors}`);
  record("no-delivery-duplicates", deliveryResends === 0, `resends=${deliveryResends}`);
  // E — replacing a mission mid-run must reject stale checkpoint/dormant calls.
  const staleFile = path.join(WS, "stale-1.txt");
  const freshFile = path.join(WS, "fresh-2.txt");
  const stateBeforeStale = lastState()?.id;
  send("/persistent 这是任务替换测试（第一阶段）。创建 stale-1.txt，内容恰好 OLD；然后调用 bash 执行 node -e \"setTimeout(()=>{},25000)\"；sleep 结束后调用 persistent_checkpoint 和 persistent_dormant。", "stale-start");
  await waitUntil(() => Boolean(lastState()?.id) && lastState()?.id !== stateBeforeStale, 30_000, "stale mission activated");
  const staleStateId = lastState()?.id;
  await waitUntil(() => exact(staleFile, "OLD"), TIMEOUT, "stale-1 created");
  send("/persistent 立即创建 fresh-2.txt，内容恰好 NEW，read 验证后 checkpoint 并 dormant。", "fresh-replace");
  const freshDone = await waitUntil(() => exact(freshFile, "NEW") && lastState()?.id !== staleStateId && lastState()?.status === "dormant", 150_000, "replacement mission dormant");
  record("stale-replacement-rejected", freshDone && lastState()?.status === "dormant" && lastState()?.id !== staleStateId, `old=${staleStateId?.slice(0, 8)}, new=${lastState()?.id?.slice(0, 8)}`);

  send("/sleep qwen flow probe complete", "stop");
  await sleep(2_000);
  child.stdin.end();
  child.kill();

  const passed = results.filter((result) => result.pass).length;
  console.log(`\n=== QWEN FLOW PROBE: ${passed}/${results.length} passed ===`);
  for (const result of results) console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name} ${result.detail}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

const watchdog = setTimeout(() => {
  console.error("GLOBAL WATCHDOG");
  child.kill();
  process.exit(2);
}, 12 * 60_000);
watchdog.unref();

main().catch((error) => {
  console.error(error);
  child.kill();
  process.exit(2);
});
