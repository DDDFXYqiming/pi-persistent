/**
 * Workspace confinement guard for persistent mode.
 *
 * Two layers, in decreasing order of strength:
 * 1. Deterministic: write/edit tool calls have their target path resolved,
 *    realpath'd (deepest existing ancestor, defeating symlinks/junctions and
 *    `..` traversal) and checked against the workspace root. Outside → blocked.
 * 2. Best-effort: bash/powershell commands are scanned for a denylist of
 *    machine-level destructive operations, and for filesystem-write-shaped
 *    tokens combined with write *targets* that resolve outside the root. This
 *    layer is heuristic by nature; strong isolation belongs to a container.
 *
 * A block denies ONE action; it must never read as "abandon the mission". The
 * block reasons say so, because the model follows that text.
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

/** Broad "could this command write anywhere?" gate — only opens the path scan. */
const WRITE_TOKEN_RE =
	/(?:>>|>)|\btee\b|\bout-file\b|\bset-content\b|\badd-content\b|\bnew-item\b|\bmkdir\b|\bmd\s+\S|\bcp\b|\bcopy\b|\bmv\b|\bmove\b|\bxcopy\b|\brobocopy\b|\brm\b|\bdel\b|\bremove-item\b|\berase\b|\bunlink\b|\btruncate\b|\btouch\b|\bnpm\s+(?:install|i)\b|\bpip3?\s+install\b|\bcurl\b[^|&;]*\s+-o\b|\bwget\b|\binvoke-webrequest\b/i;
const INLINE_SCRIPT_WRITE_RE =
	/\b(?:writefilesync|appendfilesync|writefile|appendfile|createwritestream|write_text|write_bytes)\b|\b(?:opensync|open)\s*\([^)]*,\s*["'](?:w|a|x)|\bsystem\.io\.file\]?::(?:write|append)/i;
const GIT_MUTATION_RE =
	/\bgit\b[^|&;]*(?:\badd\b|\bcommit\b|\bcheckout\b|\bswitch\b|\breset\b|\bclean\b|\bmerge\b|\brebase\b|\bpull\b|\bfetch\b|\bstash\b|\bworktree\b|\brestore\b|\brm\b|\bmv\b|\bpush\b)/i;

/**
 * Commands whose positional arguments ARE filesystem targets. Deliberately
 * narrower than WRITE_TOKEN_RE: installers (npm/pip install) read a source and
 * write inside the project, so treating their arguments as write targets only
 * produces false positives on legitimate monorepo paths like `../local-pkg`.
 */
const PATH_TAKING_WORDS = new Set([
	"rm", "rmdir", "del", "erase", "unlink", "truncate", "rd",
	"mv", "move", "cp", "copy", "xcopy", "robocopy", "tee", "touch",
	"mkdir", "md", "new-item", "set-content", "add-content", "out-file", "remove-item",
]);

// Unexpanded home/temp environment tokens. Matched against candidate paths and
// against the text of inline-script literals, never against arbitrary prose in
// an echo argument.
const OUTSIDE_ENV_RE =
	/(?:^|["'])?(?:~[\\/]|%(?:USERPROFILE|HOME|TEMP|TMP|APPDATA|LOCALAPPDATA)%|\$env:(?:USERPROFILE|HOME|TEMP|TMP|APPDATA|LOCALAPPDATA)\b|\$\{?(?:HOME|USERPROFILE|TEMP|TMP)\}?\b|process\.env\.(?:HOME|USERPROFILE|TEMP|TMP)\b)/i;

const DRIVE_PATH_RE = /[a-z]:[\\/][^\s"'|&;<>)]*/gi;
const UNIX_ABS_RE = /(?:^|[\s;|(=])(\/[^\s"'|&;<>)]*)/g;
const HOME_REL_RE = /(?:^|[\s;|(=])(~\/[^\s"'|&;<>)]*)/g;

const REDIRECT_TARGET_RE = /(?:^|[\s;&(])\d*>{1,2}\s*("([^"\n]*)"|'([^'\n]*)'|([^\s;&|)]+))/g;

function stripEdge(p: string): string {
	return p.replace(/^["'(&]+/, "").replace(/[)"']+$/, "").replace(/[\\/]+$/, "");
}

function stripQuotes(p: string): string {
	const trimmed = p.trim();
	const match = /^(["'])([\s\S]*)\1$/.exec(trimmed);
	return (match ? match[2] : trimmed).trim();
}

function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"\n]*)"|'([^'\n]*)'|(\S+)/g;
	for (const m of segment.matchAll(re)) {
		tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
	}
	return tokens;
}

function unexpandedName(candidate: string): string {
	const trimmed = candidate.trim().replace(/^["']|["']$/g, "");
	const homeMatch = /^(?:~|\$env:(?:USERPROFILE|HOME)|%HOME%|%USERPROFILE%|\$\{?HOME\}?|process\.env\.HOME)(.*)$/i.exec(trimmed);
	if (homeMatch) return `$HOME${homeMatch[1]}`;
	const tempMatch =
		/^(?:\$env:(?:TEMP|TMP)|%TEMP%|%TMP%|\$\{?(?:TEMP|TMP)\}?|process\.env\.(?:TEMP|TMP))(.*)$/i.exec(trimmed);
	if (tempMatch) return path.join(process.env.TEMP || process.env.TMP || "C:\\Temp", tempMatch[1]);
	const appDataMatch =
		/^(?:\$env:(?:APPDATA|LOCALAPPDATA)|%APPDATA%|%LOCALAPPDATA%)(.*)$/i.exec(trimmed);
	if (appDataMatch) return path.join(process.env.APPDATA || "", appDataMatch[1]);
	return trimmed;
}

/** String literals in `text`, one nesting level deep (shell quoting swallows inner quotes). */
function stringLiterals(text: string, depth = 2): string[] {
	if (depth <= 0) return [];
	const literalRe = /"([^"\n]*)"|'([^'\n]*)'/g;
	const out: string[] = [];
	for (const m of text.matchAll(literalRe)) {
		const literal = m[1] ?? m[2] ?? "";
		if (!literal) continue;
		out.push(literal);
		out.push(...stringLiterals(literal, depth - 1));
	}
	return out;
}

/**
 * Paths the command actually writes to: every redirect target, plus the
 * positional arguments of path-taking write commands.
 */
function writeTargets(command: string): string[] {
	const targets: string[] = [];
	for (const m of command.matchAll(REDIRECT_TARGET_RE)) {
		const raw = m[2] ?? m[3] ?? m[4];
		if (raw && raw !== "/dev/null" && !/^\d+$/.test(raw)) targets.push(stripQuotes(raw));
	}
	// Download/output flags name a target whatever the verb is (curl -o, wget -O,
	// Invoke-WebRequest -OutFile), and their verb is not in PATH_TAKING_WORDS.
	for (const m of command.matchAll(/(?:^|\s)(?:-o|-O|--output|-outfile|-out-file)\s+("([^"\n]*)"|'([^'\n]*)'|(\S+))/g)) {
		const raw = m[2] ?? m[3] ?? m[4];
		if (raw) targets.push(stripQuotes(raw));
	}
	for (const segment of command.split(/[;&|\n]+/)) {
		const tokens = tokenize(segment).map(stripQuotes);
		let verbIndex = -1;
		for (let i = 0; i < tokens.length; i++) {
			const head = tokens[i].toLowerCase().replace(/\.exe$/, "").split(/[\\/]/).pop() || "";
			if (PATH_TAKING_WORDS.has(head)) {
				verbIndex = i;
				break;
			}
		}
		if (verbIndex < 0) continue;
		for (const token of tokens.slice(verbIndex + 1)) {
			if (!token || (/^[-/]/.test(token) && token !== "/") || /^[<>]/.test(token)) continue; // bare / is a path, not a flag
			targets.push(token);
		}
	}
	return targets;
}

export interface CommandCheck {
	denial?: string;
}

/**
 * Returns a short denial reason when the command must be blocked, or undefined
 * when it passes. Heuristic by design: it catches drive-level destruction and
 * write targets resolving outside the workspace; it is not a sandbox.
 */
export function checkCommand(command: string, rootReal: string): CommandCheck {
	for (const [pattern, reason] of DENY_PATTERNS) {
		if (pattern.test(command)) return { denial: `command ${reason}` };
	}
	// File-descriptor duplication (for example `2>&1`) does not write a path.
	// Remove it before looking for filesystem redirection tokens.
	const writeScan = command.replace(/\b\d*\s*>\s*&\s*\d+\b/g, "");
	const inlineWrite = INLINE_SCRIPT_WRITE_RE.test(writeScan);
	const mayWrite = WRITE_TOKEN_RE.test(writeScan) || inlineWrite || GIT_MUTATION_RE.test(writeScan);
	if (!mayWrite) return {};

	const candidates: string[] = [];
	for (const target of writeTargets(writeScan)) {
		candidates.push(unexpandedName(stripEdge(target)));
	}
	if (inlineWrite) {
		// In an inline interpreter write the path is always a string literal, so
		// every literal in the script is a candidate target.
		for (const literal of stringLiterals(writeScan)) {
			candidates.push(unexpandedName(stripEdge(literal)));
		}
	}
	// URLs contain "p://..." fragments that look like drive paths; strip them
	// before absolute-path extraction. Quoted runs are masked here: an absolute
	// path inside a commit message or an echo payload is prose, not a write
	// target (real quoted targets were collected above).
	const masked = writeScan.replace(/"[^"\n]*"|'[^'\n]*'/g, " ");
	const scanned = masked.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "");
	for (const match of scanned.matchAll(DRIVE_PATH_RE)) candidates.push(unexpandedName(stripEdge(match[0])));
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
		// Still unexpanded (process.env.TEMP + '/x' etc.) → it names home/temp.
		if (OUTSIDE_ENV_RE.test(candidate)) {
			return { denial: "command targets a home/temp environment path" };
		}
		if (/^\$HOME/.test(candidate) || !isInsideRoot(rootReal, candidate)) {
			return { denial: `command writes outside the workspace ("${candidate}")` };
		}
	}
	return {};
}

const NOT_A_STOP =
	"This denies this one action only — the mission is NOT finished and persistent mode is NOT stopped. " +
	"Do not look for a workaround, and do not call persistent_dormant over a block: put this step's " +
	"side effects inside the workspace root, then continue the mission.";

export function blockOutsideWorkspace(pathInput: string, rootReal: string): string {
	return (
		`Persistent mode blocked this write: "${pathInput}" resolves outside the workspace root "${rootReal}". ` +
		NOT_A_STOP +
		" If the mission genuinely cannot proceed without writing there, say so in one short message and keep " +
		"working on the in-scope parts that do not need it."
	);
}

export function blockCommand(command: string, denial: string, rootReal: string): string {
	return (
		`Persistent mode blocked this command: ${denial}. ` +
		`Shell side effects are confined to the workspace root "${rootReal}". ` +
		NOT_A_STOP +
		" Command: " +
		command.slice(0, 200)
	);
}
