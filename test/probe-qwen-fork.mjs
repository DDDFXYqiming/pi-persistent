#!/usr/bin/env node
/** Cross-project fork probe: an active mission forked into another cwd must be disabled, not carried over. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.join(PKG, ".tmp", "qwen-fork");
const WS_A = path.join(ROOT, "proj-a");
const WS_B = path.join(ROOT, "proj-b");
const SESS = path.join(tmpdir(), "pi-persistent-qwen-fork-sessions");
const EXT = path.join(PKG, "index.ts");
const MODEL = process.env.PI_E2E_MODEL ?? "qwen-local/qwen3.8-27b";

rmSync(ROOT, { recursive: true, force: true });
rmSync(SESS, { recursive: true, force: true });
mkdirSync(WS_A, { recursive: true });
mkdirSync(WS_B, { recursive: true });
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
  for (const line of readStateLines(file)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "custom" && entry.customType === "persistent-state") state = entry.data?.state;
    } catch {}
  }
  return state;
}
function readStateLines(file) {
  if (!file || !existsSync(file)) return [];
  try { return readFileSync(file, "utf8").split(/\r?\n/); } catch { return []; }
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

async function main() {
  // Phase 1: start an active mission in project A, then kill the process.
  const first = spawn("pi", [
    "--mode", "rpc", "--offline", "--no-extensions", "--model", MODEL,
    "--session-dir", SESS, "-e", EXT,
  ], { cwd: WS_A, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  first.stdout.setEncoding("utf8");
  first.stdout.on("data", (chunk) => { buffer += chunk; });
  first.stderr.setEncoding("utf8");
  first.stderr.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) if (line.includes("pi-persistent")) console.log(`[pi-a] ${line.trim()}`);
  });
  await sleep(1_500);
  first.stdin.write(JSON.stringify({
    id: "start",
    type: "prompt",
    message: "/persistent 跨项目 fork 测试任务：在当前目录创建 fork-a.txt，内容 A-OK，然后 dormant。",
  }) + "\n");
  const started = await waitUntil(() => {
    const file = sessionFile();
    return file && lastState(file)?.status === "active";
  }, 60_000, "active mission in project A");
  const sourceFile = sessionFile();
  console.log(`phase1 active=${started}, file=${sourceFile}`);
  spawnSync("taskkill", ["/PID", String(first.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(1_500);
  if (!started || !sourceFile) {
    console.log("FAIL fork probe setup");
    process.exit(1);
  }

  // Phase 2: fork that session into project B. The extension must disable the mission.
  const second = spawn("pi", [
    "--mode", "rpc", "--offline", "--no-extensions", "--model", MODEL,
    "--session-dir", SESS, "--fork", sourceFile, "-e", EXT,
  ], { cwd: WS_B, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  let sawDisabledNotice = false;
  second.stderr.setEncoding("utf8");
  second.stderr.on("data", (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (line.includes("workspace changed")) sawDisabledNotice = true;
      if (line.includes("pi-persistent")) console.log(`[pi-b] ${line.trim()}`);
    }
  });
  await sleep(4_000);
  const forkedFile = sessionFile();
  const state = forkedFile ? lastState(forkedFile) : undefined;
  second.stdin.write(JSON.stringify({ id: "stop", type: "prompt", message: "/sleep fork probe done" }) + "\n");
  await sleep(1_500);
  spawnSync("taskkill", ["/PID", String(second.pid), "/T", "/F"], { stdio: "ignore" });

  const pass = state?.status === "off" && Boolean(state?.reason?.includes("workspace changed"));
  console.log(`${pass ? "PASS" : "FAIL"} cross-project-fork-disables-mission — status=${state?.status}, reason=${state?.reason ?? "(none)"}, notice=${sawDisabledNotice}`);
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
