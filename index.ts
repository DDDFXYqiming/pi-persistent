/**
 * pi-persistent — resident autonomous mode for the Pi coding agent.
 *
 * /persistent <mission> starts a standing autonomous loop: after every fully
 * settled run boundary the extension dispatches one continuation prompt, so
 * the agent keeps working the mission and then keeps finding in-scope
 * follow-ups — until it goes dormant (its own judgment), the provider hits a
 * hard stop, or the user runs /sleep. There are no turn counters and no
 * no-progress breakers; the only limits are the mission scope and the
 * workspace boundary.
 *
 * Non-blocking by construction: the loop never waits on the user. User-facing
 * notifications use ui.notify (a toast, not a dialog); the blocking ui
 * primitives (confirm/select/input) are never called.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	blockCommand,
	blockOutsideWorkspace,
	checkCommand,
	isInsideRoot,
	resolveRealRoot,
} from "./guard.ts";
import {
	buildContinuationPrompt,
	buildKickoffPrompt,
	CHECKPOINT_TOOL_DESCRIPTION,
	DORMANT_TOOL_DESCRIPTION,
} from "./prompts.ts";
import {
	loadState,
	MISSION_MAX_CHARS,
	newId,
	STATUS_KEY,
	type PersistentState,
	statusLabel,
	truncate,
} from "./state.ts";

const STATE_ENTRY_TYPE = "persistent-state";

/** Provider errors where retrying cannot ever succeed until the user acts. */
const HARD_STOP_RE =
	/usage[_\s-]*(?:limit|cap)|quota|insufficient[_\s-]*(?:quota|credits?|balance)|out of credits|payment required|invalid api key|unauthori[sz]ed|credentials/i;

const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 300_000;
const DELIVERY_WATCHDOG_MS = 15_000;
const MAX_DELIVERY_RETRIES = 3;

export default function (pi: ExtensionAPI) {
	log("loaded (awaiting /persistent <mission>)");
	let state: PersistentState | undefined;
	/** Rotated on start/sleep/restore; stale timers and dispatches bail out on mismatch. */
	let generation = 0;
	let consecutiveErrors = 0;
	let lastRunAborted = false;
	let hardStopMessage: string | undefined;
	let backoffTimer: ReturnType<typeof setTimeout> | undefined;
	let dispatchSeq = 0;
	let awaitingStart: { seq: number; retries: number; timer: ReturnType<typeof setTimeout> } | undefined;

	function log(message: string) {
		console.error(`[pi-persistent] ${message}`);
	}

	function persist() {
		if (!state) return;
		try {
			pi.appendEntry(STATE_ENTRY_TYPE, { state });
		} catch (error) {
			log(`appendEntry failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function clearTimers() {
		if (backoffTimer) {
			clearTimeout(backoffTimer);
			backoffTimer = undefined;
		}
		if (awaitingStart) {
			clearTimeout(awaitingStart.timer);
			awaitingStart = undefined;
		}
	}

	function updateStatus(ctx: ExtensionContext | undefined) {
		if (!ctx?.ui?.setStatus) return;
		try {
			if (!state || state.status === "off") {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} else if (state.status === "active") {
				ctx.ui.setStatus(STATUS_KEY, `♾ active · auto ${state.iteration}`);
			} else {
				ctx.ui.setStatus(
					STATUS_KEY,
					`♾ 💤 dormant · auto ${state.iteration}${state.reason ? ` · ${truncate(state.reason, 60)}` : ""}`,
				);
			}
		} catch {
			/* status UI is best-effort in every mode */
		}
	}

	function goDormant(ctx: ExtensionContext | undefined, reason: string) {
		if (!state || state.status !== "active") return;
		state.status = "dormant";
		state.reason = truncate(reason, 1000);
		state.updatedAt = Date.now();
		persist();
		clearTimers();
		updateStatus(ctx);
		// ui.notify is a non-blocking toast in every mode; the loop is never paused by it.
		try {
			ctx?.ui?.notify?.(`pi-persistent dormant: ${truncate(reason, 120)}`, "info");
		} catch {
			/* ignore */
		}
		log(`dormant: ${truncate(reason, 120)}`);
	}

	function doSleep(ctx: ExtensionContext, reason: string) {
		if (!state) {
			try {
				ctx.ui.notify("Persistent mode is not active.");
			} catch {
				/* ignore */
			}
			return;
		}
		generation++;
		clearTimers();
		state.status = "off";
		state.reason = truncate(reason, 1000);
		state.updatedAt = Date.now();
		persist();
		updateStatus(ctx);
		try {
			ctx.ui.notify(`Persistent mode off: ${truncate(reason, 120)}`, "info");
		} catch {
			/* ignore */
		}
		log(`off: ${truncate(reason, 120)}`);
	}

	function dispatchContinuation() {
		if (!state || state.status !== "active") return;
		state.iteration++;
		state.updatedAt = Date.now();
		persist();
		const seq = ++dispatchSeq;
		const prompt = buildContinuationPrompt(state, state.iteration);
		pi.sendUserMessage(prompt);
		// Delivery watchdog: if the sent prompt never started a run, resend.
		const gen = generation;
		const timer = setTimeout(() => {
			if (gen !== generation || state?.status !== "active") return;
			if (!awaitingStart || awaitingStart.seq !== seq) return;
			if (awaitingStart.retries >= MAX_DELIVERY_RETRIES) {
				log(`continuation #${state.iteration} not delivered after ${awaitingStart.retries} retries; waiting for the next settled boundary`);
				awaitingStart = undefined;
				return;
			}
			awaitingStart.retries++;
			log(`resending continuation #${state.iteration} (attempt ${awaitingStart.retries + 1})`);
			pi.sendUserMessage(prompt);
			awaitingStart.timer = timer;
		}, DELIVERY_WATCHDOG_MS);
		if (awaitingStart) clearTimeout(awaitingStart.timer);
		awaitingStart = { seq, retries: 0, timer };
	}

	function scheduleDispatch(ctx: ExtensionContext) {
		if (!state || state.status !== "active") return;
		if (backoffTimer) return;
		if (ctx.isIdle?.() === false) return;
		if (ctx.hasPendingMessages?.()) return;
		const delay =
			consecutiveErrors > 0
				? Math.min(BACKOFF_BASE_MS * 2 ** Math.min(consecutiveErrors - 1, 6), BACKOFF_MAX_MS)
				: 0;
		if (delay === 0) {
			dispatchContinuation();
			return;
		}
		const gen = generation;
		log(`provider errors: ${consecutiveErrors}; retrying continuation in ${Math.round(delay / 1000)}s (backoff only, the mission stays active)`);
		backoffTimer = setTimeout(() => {
			backoffTimer = undefined;
			if (gen !== generation || state?.status !== "active") return;
			if (ctx.isIdle?.() === false) return;
			if (ctx.hasPendingMessages?.()) return;
			dispatchContinuation();
		}, delay);
	}

	// ---------- lifecycle ----------

	pi.on("session_start", (_event, ctx) => {
		const loaded = loadState(ctx);
		state = loaded;
		generation++;
		clearTimers();
		consecutiveErrors = 0;
		lastRunAborted = false;
		hardStopMessage = undefined;
		if (state && state.status !== "off") {
			state.workspaceRoot = resolveRealRoot(state.workspaceRoot);
			try {
				ctx.ui.notify(
					`pi-persistent: restored ${state.status} mission (auto ${state.iteration}). Use /sleep to stop it.`,
					"info",
				);
			} catch {
				/* ignore */
			}
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		persist();
		clearTimers();
		updateStatus(ctx);
	});

	// Any real user input (interactive or RPC) wakes a dormant mission. The
	// extension's own continuation prompts arrive with source "extension" and
	// are ignored here; /persistent and /sleep manage their own state.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		if (/^\/(?:persistent|sleep)\b/.test(event.text.trimStart())) return;
		if (state?.status === "dormant") {
			state.status = "active";
			state.reason = undefined;
			state.updatedAt = Date.now();
			persist();
			updateStatus(ctx);
			log("woken from dormant by user input");
		}
	});

	// ---------- run classification ----------

	pi.on("agent_start", () => {
		if (awaitingStart) {
			clearTimeout(awaitingStart.timer);
			awaitingStart = undefined;
		}
	});

	pi.on("agent_end", (event) => {
		if (!state || state.status !== "active") return;
		const final = findFinalAssistant(event.messages);
		if (!final) return;
		if (final.stopReason === "aborted") {
			lastRunAborted = true;
			return;
		}
		if (final.stopReason === "error") {
			consecutiveErrors++;
			const message = final.errorMessage ?? "unknown provider error";
			if (HARD_STOP_RE.test(message)) hardStopMessage = message;
			return;
		}
		consecutiveErrors = 0;
		hardStopMessage = undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state || state.status !== "active") return;
		if (hardStopMessage) {
			const message = hardStopMessage;
			hardStopMessage = undefined;
			goDormant(ctx, `provider hard stop (wakes on your next message): ${truncate(message, 300)}`);
			return;
		}
		if (lastRunAborted) {
			// The user interrupted on purpose; their next message drives the next turn,
			// and the loop resumes from its settled boundary afterwards.
			lastRunAborted = false;
			return;
		}
		scheduleDispatch(ctx);
	});

	// ---------- workspace guard ----------

	pi.on("tool_call", (event) => {
		if (!state || state.status !== "active") return;
		if (event.toolName === "write" || event.toolName === "edit") {
			const pathInput = (event.input as { path?: unknown } | undefined)?.path;
			if (typeof pathInput === "string" && pathInput.trim() && !isInsideRoot(state.workspaceRoot, pathInput)) {
				return { block: true, reason: blockOutsideWorkspace(pathInput, state.workspaceRoot) };
			}
			return;
		}
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = (event.input as { command?: unknown } | undefined)?.command;
			if (typeof command === "string" && command.trim()) {
				const check = checkCommand(command, state.workspaceRoot);
				if (check.denial) {
					return { block: true, reason: blockCommand(command, check.denial, state.workspaceRoot) };
				}
			}
		}
	});

	// ---------- persistent-mode tools ----------

	pi.registerTool({
		name: "persistent_dormant",
		label: "Persistent dormant",
		description: DORMANT_TOOL_DESCRIPTION,
		promptSnippet: "persistent_dormant: stop autonomous continuation (persistent mode)",
		parameters: Type.Object({
			reason: Type.String({
				description:
					"Concrete reason: what user input / outside authorization is required, or the evidence that the mission is fully satisfied",
				minLength: 1,
				maxLength: 1000,
			}),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!state || state.status === "off") {
				return {
					content: [{ type: "text", text: "Persistent mode is not active; this call is a no-op." }],
					details: { applied: false },
				};
			}
			goDormant(ctx, params.reason);
			return {
				content: [
					{
						type: "text",
						text: "Persistent mode is now dormant. Autonomous continuation stops; any next user message wakes it again.",
					},
				],
				details: { applied: true },
			};
		},
	});

	pi.registerTool({
		name: "persistent_checkpoint",
		label: "Persistent checkpoint",
		description: CHECKPOINT_TOOL_DESCRIPTION,
		promptSnippet: "persistent_checkpoint: update the mission checkpoint (persistent mode)",
		parameters: Type.Object({
			last_known_state: Type.String({
				description: "Where the work stands right now, evidence-based",
				minLength: 1,
				maxLength: 4000,
			}),
			next_check: Type.Optional(
				Type.String({ description: "What to check or do next, if applicable", maxLength: 1000 }),
			),
			stopping_condition: Type.Optional(
				Type.String({
					description: "Condition under which this line of work is done or must stop",
					maxLength: 1000,
				}),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!state || state.status === "off") {
				return {
					content: [{ type: "text", text: "Persistent mode is not active; this call is a no-op." }],
					details: { applied: false },
				};
			}
			state.checkpoint = {
				lastKnownState: truncate(params.last_known_state, 4000),
				nextCheck: params.next_check ? truncate(params.next_check, 1000) : undefined,
				stoppingCondition: params.stopping_condition ? truncate(params.stopping_condition, 1000) : undefined,
				updatedAt: Date.now(),
			};
			state.updatedAt = Date.now();
			persist();
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: "Checkpoint saved." }],
				details: { applied: true },
			};
		},
	});

	// ---------- commands ----------

	pi.registerCommand("persistent", {
		description: "Start / inspect persistent autonomous mode (/persistent <mission>, off, resume)",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				try {
					ctx.ui.notify(
						`pi-persistent: ${statusLabel(state)}${state ? `\nmission: ${truncate(state.mission, 200)}\nworkspace: ${state.workspaceRoot}` : ""}\n/start: /persistent <mission> · stop: /sleep`,
						"info",
					);
				} catch {
					/* ignore */
				}
				return;
			}
			if (input === "off" || input === "stop") {
				doSleep(ctx, "user command");
				return;
			}
			if (input === "resume") {
				if (state?.status === "dormant") {
					state.status = "active";
					state.reason = undefined;
					state.updatedAt = Date.now();
					persist();
					updateStatus(ctx);
					try {
						ctx.ui.notify("pi-persistent: resumed.", "info");
					} catch {
						/* ignore */
					}
				} else {
					try {
						ctx.ui.notify(`pi-persistent: ${statusLabel(state)}`, "info");
					} catch {
						/* ignore */
					}
				}
				return;
			}
			if (input.length > MISSION_MAX_CHARS) {
				try {
					ctx.ui.notify(`pi-persistent: mission too long (max ${MISSION_MAX_CHARS} characters). Put long instructions in a file and reference it.`, "error");
				} catch {
					/* ignore */
				}
				return;
			}
			generation++;
			clearTimers();
			consecutiveErrors = 0;
			lastRunAborted = false;
			hardStopMessage = undefined;
			state = {
				id: newId(),
				mission: input,
				status: "active",
				workspaceRoot: resolveRealRoot(ctx.cwd),
				startedAt: Date.now(),
				updatedAt: Date.now(),
				iteration: 0,
			};
			persist();
			updateStatus(ctx);
			try {
				ctx.ui.notify(
					`Persistent mode active. Workspace root: ${state.workspaceRoot}. Stop with /sleep.`,
					"info",
				);
			} catch {
				/* ignore */
			}
			log(`started mission ${state.id} in ${state.workspaceRoot}`);
			pi.sendUserMessage(buildKickoffPrompt(state));
		},
	});

	pi.registerCommand("sleep", {
		description: "Put persistent mode to sleep (stop autonomous work)",
		handler: async (args, ctx) => {
			doSleep(ctx, args.trim() || "user command (/sleep)");
		},
	});
}

interface AssistantMessageLike {
	stopReason?: string;
	errorMessage?: string;
}

function findFinalAssistant(messages: unknown[]): AssistantMessageLike | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = messages[index] as Record<string, unknown> | undefined;
		if (!candidate || typeof candidate !== "object") continue;
		if (candidate.role !== "assistant") continue;
		return {
			stopReason: typeof candidate.stopReason === "string" ? candidate.stopReason : undefined,
			errorMessage: typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined,
		};
	}
	return undefined;
}
