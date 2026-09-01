/**
 * Offline sanity checks for compaction.ts — no model, no network.
 * Run: node test/compaction-sanity.ts
 */

import assert from "node:assert/strict";
import {
	buildMergePrompt,
	estimateTextTokens,
	fallbackSummary,
	formatFileOps,
	guardApplies,
	guardCompaction,
	parseConfig,
	serializeTranscript,
	shorten,
} from "../compaction.ts";

let checks = 0;
function pass(name: string) {
	checks++;
	console.log(`PASS ${name}`);
}

// ---------- guardApplies ----------
assert.equal(guardApplies({ mode: "off", targetTokens: 1, maxInputChars: 1, maxOutputTokens: 1, timeoutMs: 1, provider: "", model: "" }, "active"), false);
assert.equal(guardApplies({ mode: "always", targetTokens: 1, maxInputChars: 1, maxOutputTokens: 1, timeoutMs: 1, provider: "", model: "" }, undefined), true);
assert.equal(guardApplies({ mode: "persistent", targetTokens: 1, maxInputChars: 1, maxOutputTokens: 1, timeoutMs: 1, provider: "", model: "" }, "dormant"), true);
assert.equal(guardApplies({ mode: "persistent", targetTokens: 1, maxInputChars: 1, maxOutputTokens: 1, timeoutMs: 1, provider: "", model: "" }, "off"), false);
assert.equal(guardApplies({ mode: "persistent", targetTokens: 1, maxInputChars: 1, maxOutputTokens: 1, timeoutMs: 1, provider: "", model: "" }, undefined), false);
pass("guardApplies mode matrix");

// ---------- config parsing ----------
const parsed = parseConfig({ compaction: { mode: "bogus", targetTokens: 10, maxOutputTokens: 1e9, timeoutMs: "x" } });
assert.equal(parsed.mode, "always");
assert.equal(parsed.targetTokens, 800); // clamped up to min
assert.equal(parsed.maxOutputTokens, 32_768); // clamped down to max
assert.equal(parsed.timeoutMs, 180_000); // non-number -> default
assert.equal(parseConfig(null).mode, "always");
assert.equal(parseConfig({}).targetTokens, 3_000);
pass("config defaults, clamps, and mode fallback");

// ---------- transcript serialization ----------
const transcript = serializeTranscript(
	[
		{ role: "user", content: "build the city" },
		{ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(5_000) }, { type: "text", text: "done" }, { type: "toolCall", name: "edit", arguments: { path: "index.html" } }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
	],
	10_000,
);
assert.ok(!transcript.includes("xxxx"));
assert.ok(transcript.includes("[tool: edit"));
assert.ok(transcript.includes("[user]: build the city"));
const capped = serializeTranscript(
	Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `msg ${i} ${"y".repeat(100)}` })),
	500,
);
assert.ok(capped.startsWith("[earlier turns elided]"));
assert.ok(capped.length <= 500 + "[earlier turns elided]\n".length);
assert.ok(capped.includes("msg 99"));
pass("transcript drops thinking, keeps intent, caps to tail");
assert.equal(shorten("abcdefghij", 5).length, 5);
assert.equal(shorten("abc", 10), "abc");

// ---------- fake harness ----------
interface Recorded {
	model: unknown;
	context: { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> };
	options: Record<string, unknown>;
}

function makeCtx(responses: Array<{ text?: string; stopReason?: string; errorMessage?: string }>) {
	const calls: Recorded[] = [];
	const streamSimple = (model: unknown, context: Recorded["context"], options: Record<string, unknown> = {}) => {
		calls.push({ model, context, options });
		const next = responses.shift() ?? { text: "## Goal\nfallback canned" };
		return {
			result: async () =>
				next.stopReason === "error"
					? { stopReason: "error", errorMessage: next.errorMessage ?? "boom" }
					: { stopReason: next.stopReason ?? "stop", content: [{ type: "text", text: next.text ?? "" }], usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 } },
		};
	};
	const ctx = {
		mode: "rpc",
		hasUI: false,
		model: { provider: "fake", id: "m" },
		modelRegistry: {
			find: () => undefined,
			hasConfiguredAuth: () => true,
			getProvider: (name: string) => (name === "fake" ? { streamSimple } : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
		ui: { notify: () => {}, setStatus: () => {} },
	} as never;
	return { ctx, calls };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
	const controller = new AbortController();
	const event = {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "keep-1",
			messagesToSummarize: [
				{ role: "user", content: "first task" },
				{ role: "assistant", content: "did it", stopReason: "stop" },
			],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 77_000,
			fileOps: { read: new Set(["a.ts"]), written: new Set(["b.ts"]), edited: new Set(["c.ts"]) },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			...overrides,
		},
		branchEntries: [],
		reason: "threshold",
		willRetry: false,
		signal: controller.signal,
	};
	return { event, controller };
}

const config = parseConfig({ compaction: { targetTokens: 800, maxInputChars: 8_000, maxOutputTokens: 2_048 } });
const logs: string[] = [];
const log = (m: string) => logs.push(m);

// ---------- happy path ----------
{
	const { ctx, calls } = makeCtx([{ text: "## Goal\nkeep going\n## Next Steps\n1. test" }]);
	const { event } = makeEvent();
	const result = await guardCompaction(event as never, ctx, config, undefined, log);
	assert.ok(result?.compaction);
	assert.equal(result.compaction.firstKeptEntryId, "keep-1");
	assert.equal(result.compaction.tokensBefore, 77_000);
	assert.equal((result.compaction.details as { path: string }).path, "llm");
	assert.ok(result.compaction.summary.includes("## Next Steps"));
	assert.ok(result.compaction.summary.includes("<modified-files>")) // file ops appended
	assert.equal(calls.length, 1);
	const options = calls[0].options;
	assert.ok(!("reasoning" in options), "guard must never send a reasoning option");
	assert.equal(options.cacheRetention, "none");
	assert.equal(options.maxTokens, 2_048);
	assert.ok(String(options.sessionId).startsWith("pi-persistent-compact:"));
	assert.ok(calls[0].context.messages[0].content[0].text.includes("[user]: first task"));
	pass("happy path: passthrough ids, file ops, no reasoning, cacheRetention none");
}

// ---------- condense phase for oversized previous summary ----------
{
	const hugePrevious = "## Goal\n" + "z".repeat(4_000); // > 800 * 1.2 tokens
	const { ctx, calls } = makeCtx([
		{ text: "## Goal\ncondensed previous" },
		{ text: "## Goal\nmerged" },
	]);
	const { event } = makeEvent({ previousSummary: hugePrevious });
	const result = await guardCompaction(event as never, ctx, config, undefined, log);
	assert.equal(calls.length, 2);
	assert.ok(calls[0].context.messages[0].content[0].text.includes("Rewrite it"));
	assert.ok(calls[1].context.messages[0].content[0].text.includes("condensed previous"));
	assert.ok(!(calls[1].context.messages[0].content[0].text.includes("zzzz")), "raw oversized summary must not reach the merge");
	assert.equal((result!.compaction!.details as { path: string }).path, "llm");
	pass("oversized previous summary is condensed before merge");
}

// ---------- overshoot triggers compression ----------
{
	const { ctx, calls } = makeCtx([
		{ text: "q".repeat(800 * 3 * 2) }, // way over target*1.5
		{ text: "## Goal\nnow small enough" },
	]);
	const { event } = makeEvent();
	const result = await guardCompaction(event as never, ctx, config, undefined, log);
	assert.equal(calls.length, 2);
	assert.ok(calls[1].context.messages[0].content[0].text.includes("Compress the summary"));
	assert.equal((result!.compaction!.details as { path: string }).path, "compressed");
	assert.ok(result!.compaction!.summary.includes("now small enough"));
	pass("oversized merge output triggers one compression pass");
}

// ---------- length stop triggers compression ----------
{
	const { ctx, calls } = makeCtx([
		{ text: "## Goal\ntruncated", stopReason: "length" },
		{ text: "## Goal\nrecovered" },
	]);
	const { event } = makeEvent();
	const result = await guardCompaction(event as never, ctx, config, undefined, log);
	assert.equal(calls.length, 2);
	assert.ok(result!.compaction!.summary.includes("recovered"));
	pass("stopReason=length triggers compression retry");
}

// ---------- model error falls back deterministically ----------
{
	const { ctx } = makeCtx([{ stopReason: "error", errorMessage: "connection refused" }]);
	const { event } = makeEvent({ previousSummary: "## Goal\nold summary content" });
	const result = await guardCompaction(event as never, ctx, config, "Mission: keep running", log);
	assert.ok(result?.compaction);
	const details = result.compaction.details as { path: string; guard: string };
	assert.equal(details.path, "fallback");
	assert.equal(details.guard, "pi-persistent");
	assert.ok(result.compaction.summary.includes("pi-persistent guard"));
	assert.ok(result.compaction.summary.includes("Mission: keep running"));
	assert.ok(result.compaction.summary.includes("old summary content"));
	assert.ok(result.compaction.summary.includes("[user]: first task"));
	pass("provider failure still returns a compaction (never breaks the loop)");
}

// ---------- empty text falls back ----------
{
	const { ctx } = makeCtx([{ text: "   " }, { text: "" }]);
	const { event } = makeEvent();
	const result = await guardCompaction(event as never, ctx, config, undefined, log);
	assert.equal((result!.compaction!.details as { path: string }).path, "fallback");
	pass("empty summarizer text falls back instead of failing");
}

// ---------- abort returns undefined ----------
{
	const { ctx, calls } = makeCtx([{ text: "should not be used" }]);
	const { event, controller } = makeEvent();
	controller.abort();
	const result = await guardCompaction(event as never, ctx, config, undefined, log);
	assert.equal(result, undefined);
	assert.equal(calls.length, 0);
	pass("aborted signal is respected (no forced compaction)");
}

// ---------- split turn includes prefix messages ----------
{
	const { ctx, calls } = makeCtx([{ text: "## Goal\nok" }]);
	const { event } = makeEvent({
		isSplitTurn: true,
		turnPrefixMessages: [{ role: "user", content: "prefix turn content" }],
	});
	await guardCompaction(event as never, ctx, config, undefined, log);
	assert.ok(calls[0].context.messages[0].content[0].text.includes("prefix turn content"));
	pass("split-turn prefix messages enter the transcript");
}

// ---------- file ops cap and partition ----------
{
	const read = new Set(Array.from({ length: 60 }, (_, i) => `read${i}.ts`));
	const written = new Set(["read3.ts", "mod.ts"]);
	const text = formatFileOps({ read, written, edited: new Set() });
	const readBlock = text.split("<read-files>")[1]?.split("</read-files>")[0] ?? "";
	assert.equal((readBlock.match(/read\d+\.ts/g) ?? []).length, 40);
	assert.ok(text.includes("mod.ts"));
	assert.ok(!text.split("<read-files>")[1].split("</read-files>")[0].includes("read3.ts"), "modified files leave the read list");
	pass("file lists are partitioned and capped at 40");
}

// ---------- merge prompt carries budget + lossy rule ----------
{
	const prompt = buildMergePrompt({ transcript: "t", targetTokens: 6000, mission: "M", custom: "focus X" });
	assert.ok(prompt.includes("~6000 tokens"));
	assert.ok(prompt.includes("LOSSY"));
	assert.ok(prompt.includes("<mission-state>"));
	assert.ok(prompt.includes("focus X"));
	assert.ok(estimateTextTokens("abc".repeat(300)) === 300);
	assert.ok(fallbackSummary(undefined, "", undefined, 100).includes("pi-persistent guard"));
}
pass("prompt builders and estimators");

console.log(`PASS all ${checks} compaction guard checks`);
