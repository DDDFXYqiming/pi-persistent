/**
 * Workspace confinement guard for persistent mode.
 *
 * Two layers, in decreasing order of strength:
 * 1. Deterministic: write/edit tool calls have their target path resolved,
 *    realpath'd (deepest existing ancestor, defeating symlinks/junctions and
 *    `..` traversal) and checked against the workspace root. Outside → blocked.
 * 2. Best-effort: bash/powershell commands are scanned for a denylist of
 *    machine-level destructive operations, and for filesystem-write-shaped
 *    tokens combined with absolute paths outside the workspace root. This
 *    layer is heuristic by nature; strong isolation belongs to a container.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";

const IS_WINDOWS = process.platform === "win32";

export function resolveRealRoot(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

/** Realpath of the deepest existing ancestor of `target`, missing tail appended. */
function realExistingPath(target: string): string {
	const abs = path.resolve(target);
	let current = abs;
	const missing: string[] = [];
	for (;;) {
		try {
			return missing.length === 0
				? realpathSync(current)
				: path.join(realpathSync(current), ...missing);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return abs; // reached the drive root without success
			missing.unshift(path.basename(current));
			current = parent;
		}
	}
}

export function isInsideRoot(rootReal: string, targetPath: string): boolean {
	const abs = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(rootReal, targetPath);
	const real = realExistingPath(abs);
	const a = IS_WINDOWS ? rootReal.toLowerCase() : rootReal;
	const b = IS_WINDOWS ? real.toLowerCase() : real;
	const rel = path.relative(a, b);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Convert a Git-Bash style absolute path (/c/Users/...) to its Windows form. */
function gitBashToWindows(unixPath: string): string | undefined {
	const match = /^\/([a-z])(?:\/(.*))?$/i.exec(unixPath);
	if (!match) return undefined;
	const drive = `${match[1].toUpperCase()}:`;
	return match[2] ? `${drive}\\${match[2].replace(/\//g, "\\")}` : `${drive}\\`;
}

const DENY_PATTERNS: Array<[RegExp, string]> = [
	[/\bformat(?:\.com)?\s+[a-z]:/i, "formats a drive"],
	[/\bdiskpart\b/i, "diskpart modifies partitions"],
	[/\bbcdedit\b/i, "bcdedit modifies boot configuration"],
	[/\bshutdown(?:\.exe)?\b/i, "shuts the machine down"],
	[/\bcipher\s+\/w\b/i, "cipher /w wipes free space"],
	[
		/\breg(?:\.exe)?\s+(?:add|delete|import|remove|restore|save|unload)\b/i,
		"modifies the registry",
	],
	[
		/\bschtasks(?:\.exe)?\s+\/(?:create|change|delete|run)\b/i,
		"creates or changes scheduled tasks",
	],
	[/\bnet\s+(?:user|localgroup)\b[^|&;]*\/(?:add|delete)\b/i, "modifies local accounts"],
	[/\bmklink\b/i, "creates filesystem links"],
	[/\bwevtutil(?:\.exe)?\s+cl\b/i, "clears event logs"],
	[/\brm\s+-[a-z]*[rf][a-z]*[rf][a-z]*\s+\/(?:\s|$)/i, "rm -rf /"],
	[
		/remove-item\b[^|&;]*-recurse[^|&;]*\s["']?[a-z]:\\\s*(?:["']|$)/i,
		"Remove-Item on a drive root",
	],
	[/rd(?:\.exe)?\s+\/s\s+\/q\s+["']?[a-z]:\\\s*["']?(?:\s|$)/i, "rd /s /q on a drive root"],
];

const WRITE_TOKEN_RE =
	/(?:>>|>)|\btee\b|\bout-file\b|\bset-content\b|\badd-content\b|\bnew-item\b|\bmkdir\b|\bmd\s+\S|\bcp\b|\bcopy\b|\bmv\b|\bmove\b|\bxcopy\b|\brobocopy\b|\brm\b|\bdel\b|\bremove-item\b|\berase\b|\bunlink\b|\btruncate\b|\btouch\b|\bnpm\s+(?:install|i)\b|\bpip3?\s+install\b|\bcurl\b[^|&;]*\s+-o\b|\bwget\b|\binvoke-webrequest\b/i;
const INLINE_SCRIPT_WRITE_RE =
	/\b(?:writefilesync|appendfilesync|writefile|appendfile|createwritestream|write_text|write_bytes)\b|\b(?:opensync|open)\s*\([^)]*,\s*["'](?:w|a|x)|\bsystem\.io\.file\]?::(?:write|append)/i;
const GIT_MUTATION_RE =
	/\bgit\b[^|&;]*(?:\badd\b|\bcommit\b|\bcheckout\b|\bswitch\b|\breset\b|\bclean\b|\bmerge\b|\brebase\b|\bpull\b|\bfetch\b|\bstash\b|\bworktree\b|\brestore\b|\brm\b|\bmv\b)/i;
const TRAVERSAL_RE = /(?:^|[\s"'=(;])\.\.(?:[\\/]|(?=\s|$))/;
const OUTSIDE_ENV_RE =
	/(?:~[\\/]|%(?:USERPROFILE|HOME|TEMP|TMP|APPDATA|LOCALAPPDATA)%|\$env:(?:USERPROFILE|HOME|TEMP|TMP|APPDATA|LOCALAPPDATA)\b|\$\{?(?:HOME|USERPROFILE|TEMP|TMP)\}?\b|process\.env\.(?:HOME|USERPROFILE|TEMP|TMP)\b)/i;

const DRIVE_PATH_RE = /[a-z]:[\\/][^\s"'|&;<>)]*/gi;
const UNIX_ABS_RE = /(?:^|[\s;|(=])(\/[^\s"'|&;<>)]*)/g;
const HOME_REL_RE = /(?:^|[\s;|(=])(~\/[^\s"'|&;<>)]*)/g;

function stripEdge(p: string): string {
	return p.replace(/^["'(&]+/, "").replace(/[)"']+$/, "").replace(/[\\/]+$/, "");
}

export interface CommandCheck {
	denial?: string;
}

/**
 * Returns a short denial reason when the command must be blocked, or undefined
 * when it passes. Heuristic by design: it catches drive-level destruction and
 * write-shaped commands pointing outside the workspace; it is not a sandbox.
 */
export function checkCommand(command: string, rootReal: string): CommandCheck {
	for (const [pattern, reason] of DENY_PATTERNS) {
		if (pattern.test(command)) return { denial: `command ${reason}` };
	}
	// File-descriptor duplication (for example `2>&1`) does not write a path.
	// Remove it before looking for filesystem redirection tokens.
	const writeScan = command.replace(/\b\d*\s*>\s*&\s*\d+\b/g, "");
	const mayWrite = WRITE_TOKEN_RE.test(writeScan) || INLINE_SCRIPT_WRITE_RE.test(writeScan) || GIT_MUTATION_RE.test(writeScan);
	if (!mayWrite) return {};
	if (TRAVERSAL_RE.test(writeScan)) {
		return { denial: "write-capable command uses parent-directory traversal" };
	}
	if (OUTSIDE_ENV_RE.test(writeScan)) {
		return { denial: "write-capable command targets a home/temp environment path" };
	}

	// URLs contain "p://..." fragments that look like drive paths; strip them
	// before absolute-path extraction.
	const scanned = writeScan.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "");
	const candidates: string[] = [];
	for (const match of scanned.matchAll(DRIVE_PATH_RE)) {
		candidates.push(stripEdge(match[0]));
	}
	for (const match of scanned.matchAll(UNIX_ABS_RE)) {
		const converted = gitBashToWindows(stripEdge(match[1]));
		if (converted) candidates.push(converted);
	}
	for (const match of scanned.matchAll(HOME_REL_RE)) {
		candidates.push(`$HOME\\${stripEdge(match[1]).slice(2)}`);
	}

	for (const candidate of candidates) {
		if (!candidate || /^[a-z]:\\$/i.test(candidate)) {
			return { denial: "command targets a drive root" };
		}
		if (/^\$HOME/.test(candidate) || !isInsideRoot(rootReal, candidate)) {
			return { denial: `command writes outside the workspace ("${candidate}")` };
		}
	}
	return {};
}

export function blockOutsideWorkspace(pathInput: string, rootReal: string): string {
	return (
		`Persistent mode: "${pathInput}" resolves outside the workspace root "${rootReal}". ` +
		"Writes are confined to the workspace. If the mission cannot proceed without this, " +
		'call persistent_dormant with reason "requires authorization outside the workspace".'
	);
}

export function blockCommand(command: string, denial: string, rootReal: string): string {
	return (
		`Persistent mode blocked this command: ${denial}. ` +
		`Shell side effects are confined to the workspace root "${rootReal}". ` +
		"Command: " +
		command.slice(0, 200)
	);
}
