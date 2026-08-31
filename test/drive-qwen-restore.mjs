#!/usr/bin/env node
/** End-to-end crash/restart restore test using qwen-local and a real session JSONL. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.join(PKG, ".tmp", "qwen-restore");
const WS = path.join(ROOT, "workspace");
const SESS = path.join(tmpdir(), "pi-persistent-qwen-restore-sessions");
const EXT = path.join(PKG, "index.ts");
const MODEL = process.env.PI_E2E_MODEL ?? "qwen-local/qwen3.8-27b";
const BEFORE = path.join(WS, "restore-before.txt");
const AFTER = path.join(WS, "restore-after.txt");

rmSync(ROOT, { recursive: true, force: true });
rmSync(SESS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(SESS, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sessionFile() {
  if (!existsSync(SESS)) return undefined;
  const files = readdirSync(SESS).filter((name) => name.endsWith(".jsonl"));
  return files.map((name) => ({ path: path.join(SESS, name), mtime: statSync(path.join(SESS, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.path;
}
function lastState(file) {
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
function exact(file, expected) {
  try { return readFileSync(file, "utf8") === expected; } catch { return false; }
}
async function waitUntil(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (predicate()) return true; } catch {}
    await sleep(300);
  }
  console.log(`timeout: ${label}`);
  return false;
}
function startPi(extra = []) {
  const child = spawn("pi", [
    "--mode", "rpc", "--offline", "--no-extensions", "--model", MODEL,
    "--session-dir", SESS, ...extra, "-e", EXT,
  ], { cwd: WS, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let starts = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "agent_start") { starts++; console.log(`agent_start #${starts}`); }
        if (event.type === "tool_execution_start") console.log(`tool ${event.toolName}`);
      } catch {}
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim()) console.log(`[pi] ${line.trim()}`);
  });
  return { child, get starts() { return starts; } };
}
function killTree(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else child.kill("SIGKILL");
}

async function main() {
  const first = startPi();
  await sleep(1_500);
  first.child.stdin.write(JSON.stringify({
    id: "start",
    type: "prompt",
    message: "/persistent 这是进程崩溃恢复测试。若 restore-before.txt 不存在：创建它，内容 BEFORE；checkpoint 写明进程恢复后创建 restore-after.txt；然后调用 bash 执行 node -e \"setTimeout(()=>{},60000)\"，不要 dormant、不要创建 after。若 before 已存在且 after 不存在，说明这是恢复后的自动续派：创建 restore-after.txt，内容 RESTORED，read 验证，checkpoint 后 dormant。",
  }) + "\n");
  const beforeMade = await waitUntil(() => exact(BEFORE, "BEFORE") && Boolean(sessionFile()), 180_000, "restore-before");
  if (!beforeMade) {
    killTree(first.child);
    console.log("FAIL restore setup");
    process.exit(1);
  }
  const file = sessionFile();
  console.log(`killing active pi; state=${lastState(file)?.status}`);
  killTree(first.child);
  await sleep(2_000);

  const second = startPi(["--session", file]);
  const restored = await waitUntil(
    () => exact(AFTER, "RESTORED") && lastState(file)?.status === "dormant" && second.starts >= 1,
    240_000,
    "automatic restart continuation",
  );
  second.child.stdin.write(JSON.stringify({ id: "stop", type: "prompt", message: "/sleep restore test complete" }) + "\n");
  await sleep(1_000);
  killTree(second.child);
  console.log(`${restored ? "PASS" : "FAIL"} crash-restart-auto-resume — starts=${second.starts}, state=${lastState(file)?.status}`);
  process.exit(restored ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
