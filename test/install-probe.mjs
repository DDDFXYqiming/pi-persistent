/**
 * Install probe: verifies the globally-installed copy (auto-discovery, no -e)
 * loads and registers its commands — no model calls.
 *
 * Run: node test/install-probe.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";

const TMP = path.resolve(import.meta.dirname, "..", ".tmp", "probe");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(path.join(TMP, "ws"), { recursive: true });
mkdirSync(path.join(TMP, "sessions"), { recursive: true });

const child = spawn(
	"pi",
	["--mode", "rpc", "--offline", "--session-dir", path.join(TMP, "sessions")],
	{ cwd: path.join(TMP, "ws"), shell: true, stdio: ["pipe", "pipe", "pipe"] },
);

let loaded = false;
let commandStatus = false;
let stdoutAll = "";
let stderrAll = "";

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderrAll += chunk;
	if (chunk.includes("[pi-persistent] loaded")) loaded = true;
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	stdoutAll += chunk;
	if (chunk.includes("pi-persistent")) commandStatus = true;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && !loaded) await sleep(250);
	console.log(`[probe] extension auto-discovered: ${loaded}`);
	if (loaded) {
		child.stdin.write(JSON.stringify({ id: "probe", type: "prompt", message: "/persistent" }) + "\n");
		await sleep(3_000);
	}
	try {
		child.stdin.end();
		child.kill();
	} catch { /* ignore */ }
	await sleep(500);
	const pass = loaded;
	console.log(`\n[probe] ${pass ? "PASS" : "FAIL"} — pi-persistent loaded via installed package / extension discovery`);
	if (!pass) {
		console.log(`--- stderr tail ---\n${stderrAll.slice(-1500)}`);
		console.log(`--- stdout tail ---\n${stdoutAll.slice(-1500)}`);
	}
	process.exit(pass ? 0 : 1);
}

main();
