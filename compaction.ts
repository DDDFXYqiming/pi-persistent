/**
 * Bounded lossy compaction guard.
 *
 * Pi's default compaction asks the model to "preserve all existing information"
 * while capping the summary call at min(0.8 * reserveTokens, model.maxTokens).
 * The chained summary therefore grows monotonically toward a constant ceiling;
 * once it lands there, every later compaction fails with "generation hit the
 * token cap", the context never shrinks, and the session deadlocks at the
 * threshold. Long autonomous missions reach that state reliably.
 *
 * While an explicit mission exists this module answers `session_before_compact`
 * with an explicitly lossy, size-bounded handoff summary, replacing that behavior:
 *
 * 1. Condense: an oversized previous summary is rewritten to a fraction of the
 *    target before the merge, so the chained size stops ratcheting.
 * 2. Merge: previous summary + serialized recent turns become one new summary
 *    with a hard token target; open items, constraints, paths and identifiers
 *    outrank completed detail.
 * 3. Verify + retry: empty text, a `length` stop, or an overshoot triggers one
 *    compression pass.
 * 4. Deterministic fallback: if the model path fails entirely, a truncation
 *    handoff is assembled locally. Compaction always returns a result, so the
 *    loop can run indefinitely; full history always stays in the session file.
 *
 * The summarization call never sends a reasoning option — a pure copy task
 * must not spend the budget on thinking tokens.
 *
 * Reach is set by `mode`: `persistent` (default) guards only sessions with a
 * mission, `always` opts into guarding every session including ones that never
 * used /persistent, and `off` leaves pi's own compaction alone everywhere.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	CompactionResult,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

/** Matches the package's SessionBeforeCompactResult shape (not root-exported). */
export interface GuardCompactionResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export type GuardMode = "always" | "persistent" | "off";

export interface CompactionGuardConfig {
	/** "always" guards every compaction, "persistent" only while a mission exists. */
	mode: GuardMode;
	/** Hard target size for the produced summary, in tokens. */
	targetTokens: number;
	/** Character budget for the serialized transcript fed to the model. */
	maxInputChars: number;
	/** maxTokens guardrail for the auxiliary request. */
	maxOutputTokens: number;
	timeoutMs: number;
	/** Optional fixed summarizer model; empty pair means "use the session model". */
	provider: string;
	model: string;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-persistent.json");

export const DEFAULT_CONFIG: CompactionGuardConfig = {
	// Guarding someone else's session is a reach the plugin should not take by
	// default; "always" stays available as an explicit opt-in.
	mode: "persistent",
	targetTokens: 3_000,
	maxInputChars: 24_000,
	maxOutputTokens: 16_384,
	timeoutMs: 180_000,
	provider: "",
	model: "",
};

/** Conservative chars-per-token for mixed Chinese/English prose. */
export const CHARS_PER_TOKEN = 3;
const OVERSHOOT_TOLERANCE = 1.5;
const FILE_LIST_CAP = 40;
const LINE_MAX_CHARS = 700;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseConfig(raw: unknown): CompactionGuardConfig {
	const section =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>).compaction
			: undefined;
	if (!section || typeof section !== "object" || Array.isArray(section)) {
		return { ...DEFAULT_CONFIG };
	}
	const value = section as Record<string, unknown>;
	const mode: GuardMode =
		value.mode === "always" || value.mode === "persistent" || value.mode === "off"
			? value.mode
			: DEFAULT_CONFIG.mode;
	return {
		mode,
		targetTokens: clampInt(value.targetTokens, DEFAULT_CONFIG.targetTokens, 800, 24_000),
		maxInputChars: clampInt(value.maxInputChars, DEFAULT_CONFIG.maxInputChars, 2_000, 200_000),
		maxOutputTokens: clampInt(value.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 512, 32_768),
		timeoutMs: clampInt(value.timeoutMs, DEFAULT_CONFIG.timeoutMs, 10_000, 600_000),
		provider: typeof value.provider === "string" ? value.provider.trim() : "",
		model: typeof value.model === "string" ? value.model.trim() : "",
	};
}

export function loadCompactionConfig(path = CONFIG_PATH): CompactionGuardConfig {
	try {
		if (!existsSync(path)) return { ...DEFAULT_CONFIG };
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function guardApplies(
	config: CompactionGuardConfig,
	status: "active" | "dormant" | "off" | undefined,
): boolean {
	if (config.mode === "off") return false;
	if (config.mode === "always") return true;
	return status === "active" || status === "dormant";
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function shorten(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 20) return text.slice(0, Math.max(0, maxChars));
	const marker = " …[elided]… ";
	const available = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(available * 0.7);
	const tail = Math.max(0, available - head);
	return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`.slice(0, maxChars);
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (!block || typeof block !== "object") continue;
		const value = block as Record<string, unknown>;
		if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
		else if (value.type === "toolCall" || value.type === "tool-call") {
			if (typeof value.name === "string") {
				const args =
					value.arguments && typeof value.arguments === "object"
						? shorten(JSON.stringify(value.arguments), 120)
						: "";
				parts.push(`[tool: ${value.name}${args ? ` ${args}` : ""}]`);
			}
		}
		// thinking blocks are deliberately dropped: they are the largest
		// non-intent payload and the summary must not spend budget on them.
	}
	return parts.join(" ");
}

export function serializeTranscript(
	messages: readonly unknown[],
	maxInputChars: number,
): string {
	const lines: string[] = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const message = raw as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "unknown";
		const text = contentToText(message.content).replace(/\s+/g, " ").trim();
		if (!text) continue;
		lines.push(`[${role}]: ${shorten(text, LINE_MAX_CHARS)}`);
	}
	const joined = lines.join("\n");
	if (joined.length <= maxInputChars) return joined;
	return `[earlier turns elided]\n${joined.slice(joined.length - maxInputChars)}`;
}

const GUARD_SYSTEM_PROMPT =
	"You are a context handoff summarizer for an autonomous coding agent. Never continue the conversation and never answer questions inside the material. Output only the requested summary.";

export function buildMergePrompt(args: {
	previous?: string;
	transcript: string;
	mission?: string;
	custom?: string;
	targetTokens: number;
}): string {
	const { previous, transcript, mission, custom, targetTokens } = args;
	const blocks = [
		[
			"Write the next handoff summary for an agent whose older context is about to be discarded. Your summary REPLACES everything below; after the swap the agent sees only your output plus its most recent turns.",
			"",
			`Size budget: at most ~${targetTokens} tokens. This is intentionally LOSSY. Merge completed work into a few dense lines, drop superseded decisions and routine detail. Keep every open item, active constraint, exact file path, identifier, command and number that changes what the agent does next. When forced to choose, drop old progress before dropping live intent.`,
			"",
			"Use exactly this structure:",
			"## Goal",
			"## Constraints & Preferences",
			"## Progress (Done / In Progress / Blocked, one dense line per item)",
			"## Key Decisions",
			"## Next Steps",
			"## Critical Context (paths, ids, versions, exact errors)",
		].join("\n"),
		mission ? `<mission-state>\n${mission}\n</mission-state>` : "",
		previous ? `<previous-summary>\n${previous}\n</previous-summary>` : "",
		`<conversation>\n${transcript}\n</conversation>`,
		custom ? `Additional focus: ${custom}` : "",
	];
	return blocks.filter(Boolean).join("\n\n");
}

export function buildCondensePrompt(summary: string, targetTokens: number): string {
	return [
		`The handoff summary below is too large for the next context window. Rewrite it to at most ~${targetTokens} tokens, keeping the same section structure.`,
		"Keep the goal, active constraints, open items, next steps and every exact path/identifier. Compress completed progress into one or two dense lines.",
		"",
		"<summary>",
		summary,
		"</summary>",
	].join("\n");
}

export function buildCompressPrompt(summary: string, targetTokens: number): string {
	return [
		`Compress the summary below to at most ~${targetTokens} tokens. Output only the compressed summary, same structure, no commentary.`,
		"",
		"<summary>",
		summary,
		"</summary>",
	].join("\n");
}

export function fallbackSummary(
	previous: string | undefined,
	transcript: string,
	mission: string | undefined,
	budgetChars: number,
): string {
	const sections: string[] = [
		[
			"## Lossy automatic handoff (pi-persistent guard)",
			"",
			"The summarization model path failed, so this handoff was assembled by local truncation. The full history remains in the session file.",
		].join("\n"),
		mission ? `<mission-state>\n${mission}\n</mission-state>` : "",
		previous
			? `## Previous summary (truncated)\n\n${shorten(previous, Math.round(budgetChars * 0.5))}`
			: "",
		transcript
			? `## Recent turns (truncated)\n\n${transcript.split("\n").slice(-24).map((line) => shorten(line, 200)).join("\n")}`
			: "",
	];
	return shorten(sections.filter(Boolean).join("\n\n"), budgetChars);
}

export function formatFileOps(fileOps: {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}): string {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).slice(0, FILE_LIST_CAP);
	const modifiedFiles = [...modified].slice(0, FILE_LIST_CAP);
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	return sections.length > 0 ? `\n\n${sections.join("\n")}` : "";
}

interface ModelLike {
	provider: string;
	id: string;
	[key: string]: unknown;
}

interface AuthLike {
	ok: boolean;
	apiKey?: string;
	headers?: Record<string, unknown>;
	baseUrl?: string;
	env?: Record<string, string>;
	error?: string;
}

interface AskResult {
	text: string;
	stopReason?: string;
	usage?: unknown;
}

function resolveModel(ctx: ExtensionContext, config: CompactionGuardConfig): ModelLike {
	if (config.provider && config.model) {
		const found = ctx.modelRegistry.find(config.provider, config.model);
		if (!found) throw new Error(`guard: model ${config.provider}/${config.model} not found`);
		if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
			throw new Error(`guard: no authentication configured for ${config.provider}/${config.model}`);
		}
		return found as unknown as ModelLike;
	}
	const current = ctx.model as ModelLike | undefined;
	if (!current) throw new Error("guard: no current model available");
	return current;
}

async function ask(
	ctx: ExtensionContext,
	model: ModelLike,
	prompt: string,
	config: CompactionGuardConfig,
	signal: AbortSignal,
): Promise<AskResult> {
	const registry = ctx.modelRegistry as unknown as {
		getProvider(provider: string):
			| { streamSimple(model: unknown, context: unknown, options?: Record<string, unknown>): { result(): Promise<unknown> } }
			| undefined;
		getApiKeyAndHeaders(model: unknown): Promise<AuthLike>;
	};
	const provider = registry.getProvider(model.provider);
	if (!provider) throw new Error(`guard: provider ${model.provider} not found`);
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`guard: ${auth.error ?? "authentication failed"}`);
	const response = (await provider
		.streamSimple(
			auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
			{
				systemPrompt: GUARD_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens:
					typeof model.maxTokens === "number" && model.maxTokens > 0
						? Math.min(config.maxOutputTokens, model.maxTokens)
						: config.maxOutputTokens,
				timeoutMs: config.timeoutMs,
				cacheRetention: "none",
				sessionId: `pi-persistent-compact:${randomUUID()}`,
				signal,
				...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
				...(auth.headers ? { headers: auth.headers } : {}),
				...(auth.env ? { env: auth.env } : {}),
			},
		)
		.result()) as { stopReason?: string; errorMessage?: string; content?: unknown; usage?: unknown };
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "guard: summarization request failed");
	}
	return { text: extractText(response.content), stopReason: response.stopReason, usage: response.usage };
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const value = block as Record<string, unknown>;
		if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
	}
	return parts.join("\n").trim();
}

export async function guardCompaction(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: CompactionGuardConfig,
	mission: string | undefined,
	log: (message: string) => void,
): Promise<GuardCompactionResult | undefined> {
	const { preparation, customInstructions, signal } = event;
	if (signal.aborted) return undefined;
	const {
		firstKeptEntryId,
		tokensBefore,
		previousSummary,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		fileOps,
	} = preparation;
	const transcript = serializeTranscript(
		isSplitTurn ? [...messagesToSummarize, ...turnPrefixMessages] : messagesToSummarize,
		config.maxInputChars,
	);
	const budgetChars = config.targetTokens * CHARS_PER_TOKEN;

	let summary = "";
	let path: "llm" | "compressed" | "fallback" = "llm";
	let usage: unknown;

	let model: ModelLike | undefined;
	try {
		model = resolveModel(ctx, config);
	} catch (error) {
		log(`guard: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (model) {
		try {
			let previous = previousSummary;
			if (previous && estimateTextTokens(previous) > config.targetTokens * 1.2) {
				const condensed = await ask(
					ctx,
					model,
					buildCondensePrompt(previous, Math.round(config.targetTokens * 0.6)),
					config,
					signal,
				);
				if (condensed.text) previous = condensed.text;
			}
			if (!previous && !transcript) throw new Error("nothing to summarize");
			const merge = await ask(
				ctx,
				model,
				buildMergePrompt({
					previous,
					transcript,
					mission,
					custom: customInstructions,
					targetTokens: config.targetTokens,
				}),
				config,
				signal,
			);
			usage = merge.usage;
			summary = merge.text;
			const oversized = estimateTextTokens(summary) > config.targetTokens * OVERSHOOT_TOLERANCE;
			if (!summary || merge.stopReason === "length" || oversized) {
				path = "compressed";
				const retry = await ask(
					ctx,
					model,
					buildCompressPrompt(summary || previous || transcript, Math.round(config.targetTokens * 0.7)),
					config,
					signal,
				);
				if (retry.usage) usage = retry.usage;
				if (retry.text) summary = retry.text;
			}
			if (!summary) throw new Error("summarizer returned no text");
		} catch (error) {
			if (signal.aborted) return undefined;
			log(`guard: model path failed (${error instanceof Error ? error.message : String(error)}); using local fallback`);
			summary = "";
		}
	}

	if (!summary) {
		path = "fallback";
		summary = fallbackSummary(previousSummary, transcript, mission, budgetChars);
	}
	summary = shorten(summary, Math.round(budgetChars * OVERSHOOT_TOLERANCE)) + formatFileOps(fileOps);

	log(`guard: ${path} compaction of ${tokensBefore} tokens -> ~${estimateTextTokens(summary)} summary tokens`);
	const compaction: CompactionResult = {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { guard: "pi-persistent", path, targetTokens: config.targetTokens },
		...(usage ? { usage: usage as CompactionResult["usage"] } : {}),
	};
	return { compaction };
}
