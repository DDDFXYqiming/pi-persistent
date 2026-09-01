/**
 * User-invoked persistent-mode menu.
 *
 * The autonomous loop never opens this menu or waits on the user. This flow is
 * only entered when a user explicitly runs `/persistent` without arguments.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	defineMenu,
	runMenu,
	sanitizeTerminalText,
	type ActionMenuItem,
} from "@narumitw/pi-tui-kit";
import {
	MISSION_MAX_CHARS,
	statusLabel,
	truncate,
	type PersistentState,
} from "./state.ts";

type ScreenId = "main" | "status" | "help";
type ActionId =
	| "start"
	| "replace"
	| "resume"
	| "sleep"
	| "wake"
	| "status"
	| "help";

export interface PersistentMenuActions {
	getState(): PersistentState | undefined;
	startMission(mission: string, ctx: ExtensionCommandContext): void | Promise<void>;
	resumeMission(ctx: ExtensionCommandContext): void | Promise<void>;
	sleep(ctx: ExtensionCommandContext, reason: string): void | Promise<void>;
	wakeMission(ctx: ExtensionCommandContext): void | Promise<void>;
}

export interface PersistentMenuOptions {
	signal?: AbortSignal;
	isCurrent?(): boolean;
}

export interface PersistentArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

const PERSISTENT_ARGUMENT_COMPLETIONS: readonly PersistentArgumentCompletion[] = [
	{ value: "resume", label: "resume", description: "Resume a dormant mission" },
	{ value: "off", label: "off", description: "Stop automatic continuation" },
	{ value: "stop", label: "stop", description: "Alias for off" },
];

export function completePersistentArguments(
	argumentPrefix: string,
): PersistentArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart();
	if (prefix === "") return [...PERSISTENT_ARGUMENT_COMPLETIONS];
	if (/\s/.test(prefix)) return null;
	const matches = PERSISTENT_ARGUMENT_COMPLETIONS.filter(
		(item) => item.value.startsWith(prefix) || item.label.startsWith(prefix),
	);
	return matches.length > 0 ? matches : null;
}

export async function showPersistentMenu(
	ctx: ExtensionCommandContext,
	actions: PersistentMenuActions,
	options: PersistentMenuOptions = {},
): Promise<void> {
	if (ctx.mode !== "tui") {
		notify(ctx, formatStatus(actions.getState()), "info");
		return;
	}

	const isMenuCurrent = () =>
		!options.signal?.aborted && (options.isCurrent?.() ?? true);
	const currentStateKey = () => actions.getState()?.id ?? null;
	const currentStateMatches = (expectedId: string | null) =>
		currentStateKey() === expectedId;

	const editMission = async (replace: boolean, signal: AbortSignal) => {
		const expectedState = actions.getState();
		const expectedStateId = expectedState?.id ?? null;
		if (replace && (!expectedState || expectedState.status === "off")) {
			notify(ctx, "There is no active mission to replace.", "warning");
			return { kind: "stay" as const };
		}
		const draft = await ctx.ui.editor(
			replace ? "Replace persistent mission" : "Start persistent mission",
			replace ? expectedState?.mission ?? "" : "",
		);
		if (signal.aborted || !isMenuCurrent()) return { kind: "close" as const };
		if (draft === undefined) return { kind: "stay" as const };
		const mission = draft.trim();
		if (!mission) {
			notify(ctx, "Enter a mission, or press Esc to go back.", "warning");
			return { kind: "stay" as const };
		}
		if (mission.length > MISSION_MAX_CHARS) {
			notify(
				ctx,
				`Mission is too long (${mission.length}/${MISSION_MAX_CHARS} characters). Put long instructions in a file and reference it.`,
				"warning",
			);
			return { kind: "stay" as const };
		}
		if (!currentStateMatches(expectedStateId)) {
			notify(ctx, "The persistent state changed. Open /persistent again.", "warning");
			return { kind: "stay" as const };
		}

		if (replace) {
			const current = actions.getState();
			if (!current || current.status === "off") {
				notify(ctx, "The persistent state changed. Open /persistent again.", "warning");
				return { kind: "stay" as const };
			}
			const confirmed = await ctx.ui.confirm(
				"Replace persistent mission?",
				`Current mission:\n${safe(current.mission, 180)}\n\nNew mission:\n${safe(mission, 180)}`,
			);
			if (signal.aborted || !isMenuCurrent()) return { kind: "close" as const };
			if (!confirmed) return { kind: "stay" as const };
			if (!currentStateMatches(expectedStateId)) {
				notify(ctx, "The persistent state changed. Open /persistent again.", "warning");
				return { kind: "stay" as const };
			}
		}

		await actions.startMission(mission, ctx);
		return { kind: "close" as const };
	};

	const menu = defineMenu<
		PersistentState | undefined,
		ScreenId,
		ActionId
	>({
		start: "main",
		screens: {
			main: () => {
				const state = actions.getState();
				const view = buildPersistentMenuState(state);
				return {
					kind: "actions",
					title: "Persistent",
					lines: view.lines,
					items: view.items,
					hint: "close",
				};
			},
			status: () => ({
				kind: "detail",
				title: "Persistent status",
				lines: statusLines(actions.getState()),
				hint: "back",
			}),
			help: () => ({
				kind: "detail",
				title: "Persistent help",
				lines: helpLines(),
				hint: "back",
			}),
		},
		actions: {
			start: async ({ signal }) => editMission(false, signal),
			replace: async ({ signal }) => editMission(true, signal),
			resume: async ({ state }) => {
				if (!state || state.status !== "dormant" || !currentStateMatches(state.id)) {
					notify(ctx, "The persistent state changed. Open /persistent again.", "warning");
					return { kind: "stay" };
				}
				await actions.resumeMission(ctx);
				return { kind: "close" };
			},
			sleep: async ({ state }) => {
				if (!state || !currentStateMatches(state.id)) {
					notify(ctx, "The persistent state changed. Open /persistent again.", "warning");
					return { kind: "stay" };
				}
				const confirmed = await ctx.ui.confirm(
					"Stop persistent mode?",
					`The mission remains in the session history, but automatic continuation will stop.\n\n${safe(state.mission, 220)}`,
				);
				if (!confirmed) return { kind: "rejected" };
				if (!isMenuCurrent() || !currentStateMatches(state.id)) return { kind: "close" };
				await actions.sleep(ctx, "user menu");
				return { kind: "close" };
			},
			wake: async ({ state }) => {
				if (!state || state.status !== "active" || !isWaiting(state) || !currentStateMatches(state.id)) {
					notify(ctx, "The persistent wait is no longer active.", "warning");
					return { kind: "stay" };
				}
				await actions.wakeMission(ctx);
				return { kind: "close" };
			},
			status: async () => ({ kind: "to", screen: "status" }),
			help: async () => ({ kind: "to", screen: "help" }),
		},
	});

	await runMenu(ctx, menu, {
		getState: () => actions.getState(),
		signal: options.signal,
		isCurrent: isMenuCurrent,
		onError: (menuCtx, error) => {
			notify(
				menuCtx,
				`Persistent menu failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		},
	});
}

export interface PersistentMenuStateView {
	lines: string[];
	items: ActionMenuItem<ScreenId, ActionId>[];
}

export function buildPersistentMenuState(
	state: PersistentState | undefined,
): PersistentMenuStateView {
	return {
		lines: mainLines(state),
		items: mainItems(state),
	};
}

function mainItems(state: PersistentState | undefined): ActionMenuItem<ScreenId, ActionId>[] {
	const items: ActionMenuItem<ScreenId, ActionId>[] = [];
	if (!state || state.status === "off") {
		items.push(actionItem("start", "Start a mission…", "start"));
	} else if (state.status === "active") {
		if (isWaiting(state)) items.push(actionItem("wake", "Wake now", "wake"));
		items.push(actionItem("status", "View full status", "status"));
		items.push(actionItem("replace", "Replace mission…", "replace"));
		items.push(actionItem("sleep", "Stop (/sleep)", "sleep"));
	} else {
		items.push(actionItem("resume", "Resume mission", "resume"));
		items.push(actionItem("status", "View full status", "status"));
		items.push(actionItem("replace", "Replace mission…", "replace"));
		items.push(actionItem("sleep", "Stop (/sleep)", "sleep"));
	}
	if (!state || state.status === "off") items.push(actionItem("status", "View status", "status"));
	items.push(actionItem("help", "Help", "help"));
	items.push({ id: "close", label: "Close", close: true });

	return items;
}

function actionItem(
	id: string,
	label: string,
	action: ActionId,
): ActionMenuItem<ScreenId, ActionId> {
	return { id, label, action };
}

function mainLines(state: PersistentState | undefined): string[] {
	if (!state) return ["off (never started)", "No mission is currently set."];
	const lines = [
		safe(statusLabel(state), 220),
		`Mission: ${safe(state.mission, 220)}`,
		`Workspace: ${safe(state.workspaceRoot, 220)}`,
		`Automatic continuations: ${state.iteration}`,
	];
	if (isWaiting(state)) lines.push(`Waiting for approximately ${remainingSeconds(state)}s`);
	if (state.reason) lines.push(`Reason: ${safe(state.reason, 220)}`);
	return lines;
}

function statusLines(state: PersistentState | undefined): string[] {
	if (!state) return ["No persistent mission is currently set."];
	const lines = [
		`Status: ${safe(statusLabel(state), 220)}`,
		`Mission: ${safe(state.mission, 400)}`,
		`Workspace: ${safe(state.workspaceRoot, 260)}`,
		`Persistent id: ${safe(state.id, 80)}`,
		`Automatic continuations: ${state.iteration}`,
	];
	if (state.checkpoint) {
		lines.push("", "Checkpoint:");
		lines.push(`Last known state: ${safe(state.checkpoint.lastKnownState ?? "(empty)", 400)}`);
		if (state.checkpoint.nextCheck) lines.push(`Next check: ${safe(state.checkpoint.nextCheck, 240)}`);
		if (state.checkpoint.stoppingCondition) {
			lines.push(`Stopping condition: ${safe(state.checkpoint.stoppingCondition, 240)}`);
		}
	}
	if (state.reason) lines.push("", `Reason: ${safe(state.reason, 400)}`);
	return lines;
}

function helpLines(): string[] {
	return [
		"Persistent mode keeps one mission moving across settled turns.",
		"After the mission is satisfied, Pi may continue with useful in-scope follow-ups.",
		"Automatic continuation stops when the mission needs your input, a safety boundary is hit, or you sleep it.",
		"",
		"/persistent <mission>  Start or replace directly",
		"/persistent resume     Wake a dormant mission",
		"/persistent off        Stop automatic continuation",
		"/sleep                 Stop automatic continuation",
		"",
		"write/edit remain confined to the mission workspace while the mode is active.",
	];
}

function formatStatus(state: PersistentState | undefined): string {
	if (!state) return "pi-persistent: off (never started)";
	return `pi-persistent: ${safe(statusLabel(state), 220)}\nmission: ${safe(state.mission, 220)}\nworkspace: ${safe(state.workspaceRoot, 220)}\nmenu: /persistent (TUI)`;
}

function isWaiting(state: PersistentState): boolean {
	return typeof state.wakeAt === "number" && state.wakeAt > Date.now();
}

function remainingSeconds(state: PersistentState): number {
	return Math.max(1, Math.ceil(((state.wakeAt ?? Date.now()) - Date.now()) / 1000));
}

function safe(value: string, max: number): string {
	return truncate(sanitizeTerminalText(value), max);
}

function notify(
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
) {
	try {
		ctx.ui.notify(message, level);
	} catch {
		/* stale command context */
	}
}
