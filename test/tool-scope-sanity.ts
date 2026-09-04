/**
 * Offline checks that the plugin only reaches into sessions it was asked to own
 * (no model, no pi process).
 *
 * Pi auto-activates every tool an extension registers, and every active tool is sent
 * in the tool list and the system prompt of every request in that session. These
 * checks drive the real extension factory against a fake ExtensionAPI that mirrors
 * pi 0.84.4 behavior, and assert that with no mission the plugin adds no tools,
 * screens no tool call and leaves compaction to pi — and that a mission arms exactly
 * those things again without dropping built-in or foreign tools.
 *
 * Run: node test/tool-scope-sanity.ts
 */

import { mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import extension from "../index.ts";
import { STATE_ENTRY_TYPE } from "../state.ts";

const BUILTINS = ["read", "bash", "edit", "write"];
const MISSION_TOOLS = ["persistent_dormant", "persistent_wait", "persistent_checkpoint"];
const TMP = realpathSync(os.tmpdir());
const WS_A = mkdirSync(path.join(TMP, "pi-scope-a"), { recursive: true }) || realpathSync(path.join(TMP, "pi-scope-a"));
const WS_B = mkdirSync(path.join(TMP, "pi-scope-b"), { recursive: true }) || realpathSync(path.join(TMP, "pi-scope-b"));
const ROOT_A = WS_A || realpathSync(path.join(TMP, "pi-scope-a"));
const ROOT_B = WS_B || realpathSync(path.join(TMP, "pi-scope-b"));

const failures: string[] = [];
let checks = 0;
function expect(condition: boolean, message: string) {
	checks++;
	if (!condition) failures.push(message);
}

const hasMissionTools = (names: string[]) => MISSION_TOOLS.filter((t) => names.includes(t));

interface Entry { type: string; customType?: string; data?: unknown }

/** Minimal stand-in for the pi extension runtime: tool registry, active set, events, commands. */
function harness(cwd: string) {
	const registry = new Map<string, unknown>();
	const active = new Set(BUILTINS);
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const entries: Entry[] = [];
	const sent: string[] = [];
	const pi = {
		// pi refreshes the tool registry after registerTool and activates new tools.
		registerTool(tool: { name: string }) {
			registry.set(tool.name, tool);
			active.add(tool.name);
		},
		registerCommand(name: string, options: { handler: any }) {
			commands.set(name, { handler: options.handler });
		},
		on(event: string, handler: any) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerShortcut() {},
		registerFlag() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		getActiveTools: () => [...active],
		getAllTools: () => [...registry.keys()].map((name) => ({ name })),
		setActiveTools(names: string[]) {
			active.clear();
			for (const name of names) {
				if (BUILTINS.includes(name) || registry.has(name)) active.add(name);
			}
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendUserMessage(text: string) { sent.push(text); },
		sendMessage() {},
		getFlag: () => undefined,
		getSessionName: () => undefined,
		setSessionName() {},
		setLabel() {},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	};
	const ctx = {
		cwd,
		mode: "rpc",
		hasUI: false,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => entries, getEntries: () => entries },
		ui: { notify() {}, setStatus() {}, setWidget() {}, select: async () => undefined, confirm: async () => undefined, input: async () => undefined },
	};
	return {
		pi,
		ctx,
		entries,
		sent,
		active: () => [...active],
		fire: async (event: string, payload: any = {}) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
			return results;
		},
		run: async (command: string, args = "") => {
			await commands.get(command)?.handler(args, ctx);
		},
	};
}

function load(cwd = ROOT_A) {
	const h = harness(cwd);
	extension(h.pi as never);
	return h;
}

function seedMission(h: ReturnType<typeof harness>, status: "active" | "dormant" | "off", workspaceRoot: string) {
	h.entries.push({
		type: "custom",
		customType: STATE_ENTRY_TYPE,
		data: {
			state: {
				id: "mission-scope-test",
				mission: "keep the test green",
				status,
				workspaceRoot,
				startedAt: Date.now() - 1000,
				updatedAt: Date.now(),
				iteration: 2,
			},
		},
	});
}

const quiet = console.error;
console.error = () => {};

// 1. Registration itself is global: pi activates what an extension registers.
{
	const h = load();
	expect(hasMissionTools(h.active()).length === 3, "fixture assumption: registerTool auto-activates");
}

// 2. A fresh session that never used /persistent must not carry the mission tools.
{
	const h = load();
	await h.fire("session_start", { reason: "startup" });
	const names = h.active();
	expect(hasMissionTools(names).length === 0, "fresh session must not expose mission tools: " + names.join(","));
	expect(BUILTINS.every((t) => names.includes(t)), "fresh session keeps the built-in tools");
}

// 3. /persistent arms them, /sleep takes them away again.
{
	const h = load();
	await h.fire("session_start", { reason: "startup" });
	await h.run("persistent", "write a note that says hi");
	const during = h.active();
	expect(hasMissionTools(during).length === 3, "active mission must expose mission tools: " + during.join(","));
	expect(h.sent.length === 1 && h.sent[0].includes("pi-persistent:kickoff"), "kickoff prompt dispatched while the tools are available");
	await h.run("sleep", "test stop");
	const stopped = h.active();
	expect(hasMissionTools(stopped).length === 0, "after /sleep the mission tools must leave the prompt: " + stopped.join(","));
}

// 4. Restoring a session re-arms exactly what the stored mission status implies.
for (const status of ["active", "dormant", "off"] as const) {
	const h = load();
	seedMission(h, status, ROOT_A);
	await h.fire("session_start", { reason: "resume" });
	const names = h.active();
	const armed = hasMissionTools(names).length === 3;
	expect(armed === (status !== "off"), `restored ${status} mission tools=${armed ? "armed" : "scoped out"}`);
}

// 5. A mission restored under a different workspace is forced off, so the tools stay out.
{
	const h = load(ROOT_A);
	seedMission(h, "active", ROOT_B);
	await h.fire("session_start", { reason: "resume" });
	expect(hasMissionTools(h.active()).length === 0, "cross-workspace restore must leave mission tools scoped out: " + h.active().join(","));
}

// 6. Scoping is surgical: another extension's tools survive both transitions.
{
	const h = load();
	h.pi.registerTool({ name: "other_tool" });
	await h.fire("session_start", { reason: "startup" });
	const idle = h.active();
	expect(idle.includes("other_tool"), "session_start must not drop another extension's tool");
	expect(hasMissionTools(idle).length === 0, "session_start still scopes mission tools out");
	await h.run("persistent", "mission alongside a foreign tool");
	const armed = h.active();
	expect(armed.includes("other_tool") && hasMissionTools(armed).length === 3, "mission start adds its tools without evicting foreign ones");
	await h.run("sleep", "done");
	expect(h.active().includes("other_tool"), "/sleep must not drop another extension's tool");
}

// 7. session_tree navigation to a branch without a mission disarms them.
{
	const h = load();
	await h.fire("session_start", { reason: "startup" });
	await h.run("persistent", "branch mission");
	h.entries.length = 0; // branch with no stored mission state
	await h.fire("session_tree", {});
	expect(hasMissionTools(h.active()).length === 0, "branch without a mission must not keep mission tools: " + h.active().join(","));
}

// 8. A session that never started a mission keeps pi's own behavior: the compaction
//    guard stays out and the workspace guard never screens a tool call.
{
	const h = load();
	await h.fire("session_start", { reason: "startup" });
	const compactResults = await h.fire("session_before_compact", {
		type: "session_before_compact",
		branchEntries: [],
		preparation: {
			firstKeptEntryId: "keep-1",
			messagesToSummarize: [{ role: "user", content: "hello" }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 60_000,
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		},
	});
	expect(compactResults.every((result) => result === undefined), "compaction must stay with pi when no mission exists");
	const outside = path.join(path.parse(ROOT_A).root, "pi-scope-outside-target.txt");
	const guardResults = await h.fire("tool_call", { toolName: "write", input: { path: outside } });
	expect(guardResults.every((result) => result === undefined), "the workspace guard must stay out when no mission exists");
	await h.run("persistent", "mission that arms the guard");
	const armedGuard = await h.fire("tool_call", { toolName: "write", input: { path: outside } });
	expect(armedGuard.some((result) => !!result && typeof result === "object" && (result as { block?: boolean }).block === true), "the workspace guard arms with the mission");
}

console.error = quiet;
if (failures.length > 0) {
	console.error(`FAIL ${failures.length}/${checks} checks:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(`PASS all ${checks} tool-scope checks`);
process.exit(0);