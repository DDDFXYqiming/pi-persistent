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
	buildWakePrompt,
	CHECKPOINT_TOOL_DESCRIPTION,
	ownedPromptStateId,
	DORMANT_TOOL_DESCRIPTION,
	WAIT_TOOL_DESCRIPTION,
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

interface AwaitingStart {
	seq: number;
	generation: number;
	stateId: string;
	prompt: string;
	retries: number;
	timer?: ReturnType<typeof setTimeout>;
}

export default function (pi: ExtensionAPI) {
	log("loaded (awaiting /persistent <mission>)");
	let state: PersistentState | undefined;
	/** Rotated on start/sleep/restore; stale timers and dispatches bail out on mismatch. */
	let generation = 0;
	let consecutiveErrors = 0;
	let lastRunAborted = false;
	let hardStopMessage: string | undefined;
	/** Consecutive provider hard stops (quota/auth). One is not enough to stop. */
	let hardStopStreak = 0;
	let backoffTimer: ReturnType<typeof setTimeout> | undefined;
	let deferredDispatchTimer: ReturnType<typeof setTimeout> | undefined;
	let dispatchSeq = 0;
	let awaitingStart: AwaitingStart | undefined;
	let wakeTimer: ReturnType<typeof setTimeout> | undefined;
	/** Latest callback context, kept so timers can refresh the status line. */
	let lastCtx: ExtensionContext | undefined;
	let nextRunStateId: string | undefined;
	let currentRunStateId: string | undefined;
	let currentRunHadOutcome = false;

	function log(message: string) {
		console.error(`[pi-persistent] ${message}`);
	}

	function persist() {
		if (!state) return;
		try {
			// SessionManager retains custom-entry data by reference in memory. Store an
			// immutable snapshot so later mutations cannot rewrite older branch states.
			pi.appendEntry(STATE_ENTRY_TYPE, { state: structuredClone(state) });
		} catch (error) {
			log(`appendEntry failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function clearTimers() {
		if (wakeTimer) {
			clearTimeout(wakeTimer);
			wakeTimer = undefined;
		}
		if (backoffTimer) {
			clearTimeout(backoffTimer);
			backoffTimer = undefined;
		}
		if (deferredDispatchTimer) {
			clearTimeout(deferredDispatchTimer);
			deferredDispatchTimer = undefined;
		}
		if (awaitingStart) {
			if (awaitingStart.timer) clearTimeout(awaitingStart.timer);
			awaitingStart = undefined;
		}
	}

	function updateStatus(ctx: ExtensionContext | undefined) {
		// A ctx captured before a session replacement/reload is invalidated by pi and
		// throws on ANY property access, so the whole body is guarded.
		try {
			if (!ctx?.ui?.setStatus) return;
			if (!state || state.status === "off") {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} else if (state.status === "active") {
				// Show the requested wait length, not a countdown: nothing refreshes
				// the status line while the loop is asleep.
				const waiting = state.wakeAt && state.wakeAt > Date.now();
				const secs = waiting ? Math.max(1, Math.round((state.wakeMs ?? 1000) / 1000)) : 0;
				ctx.ui.setStatus(
					STATUS_KEY,
					waiting
						? `♾ ⏳ waiting ${secs}s · auto ${state.iteration}`
						: `♾ active · auto ${state.iteration}`,
				);
			} else {
				ctx.ui.setStatus(
					STATUS_KEY,
					`♾ 💤 dormant · auto ${state.iteration}${state.reason ? ` · ${truncate(state.reason, 60)}` : ""}`,
				);
			}
		} catch {
			/* status UI is best-effort, and a stale ctx must never break the loop */
		}
	}

	/** Whether it is safe to dispatch now. A dead ctx counts as idle (dispatch retries). */
	function safeCanDispatch(ctx: ExtensionContext | undefined): boolean {
		try {
			return ctx?.isIdle?.() === true && !ctx?.hasPendingMessages?.();
		} catch {
			return true;
		}
	}

	function goDormant(ctx: ExtensionContext | undefined, reason: string) {
		if (!state || state.status !== "active") return;
		state.status = "dormant";
		state.wakeAt = undefined;
		state.wakeMs = undefined;
		state.wakeNote = undefined;
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
		state.wakeAt = undefined;
		state.wakeMs = undefined;
		state.wakeNote = undefined;
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

	function deliverOwnedPrompt(intent: AwaitingStart, deliverAs: "steer" | "followUp") {
		if (
			awaitingStart?.seq !== intent.seq ||
			intent.generation !== generation ||
			state?.status !== "active" ||
			state.id !== intent.stateId
		) {
			return;
		}
		try {
			pi.sendUserMessage(intent.prompt, { deliverAs });
		} catch (error) {
			log(`owned prompt send failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (awaitingStart?.seq !== intent.seq) return;
		const delay = Math.min(DELIVERY_WATCHDOG_MS * 2 ** Math.min(intent.retries, 4), BACKOFF_MAX_MS);
		intent.timer = setTimeout(() => {
			if (awaitingStart?.seq !== intent.seq) return;
			intent.retries++;
			log(`resending owned prompt (attempt ${intent.retries + 1}, state ${intent.stateId})`);
			deliverOwnedPrompt(intent, "followUp");
		}, delay);
	}

	function beginOwnedDelivery(prompt: string, stateId: string, deliverAs: "steer" | "followUp") {
		if (awaitingStart?.stateId === stateId && awaitingStart.prompt === prompt) return;
		if (awaitingStart?.timer) clearTimeout(awaitingStart.timer);
		const intent: AwaitingStart = {
			seq: ++dispatchSeq,
			generation,
			stateId,
			prompt,
			retries: 0,
		};
		awaitingStart = intent;
		deliverOwnedPrompt(intent, deliverAs);
	}

	function dispatchContinuation(kind: "auto" | "wake" = "auto") {
		if (!state || state.status !== "active" || awaitingStart) return;
		// Real wall-clock slept time: from when the wait was armed, not from wakeAt
		// (Date.now() - wakeAt is only the lateness of the timer).
		const armedAt = state?.wakeAt && state.wakeMs ? state.wakeAt - state.wakeMs : undefined;
		const waitedMs = kind === "wake" && armedAt ? Math.max(0, Date.now() - armedAt) : 0;
		const wakeNote = kind === "wake" ? state.wakeNote : undefined;
		state.iteration++;
		state.wakeAt = undefined;
		state.wakeMs = undefined;
		state.wakeNote = undefined;
		state.updatedAt = Date.now();
		persist();
		const prompt =
			kind === "wake"
				? buildWakePrompt(state, state.iteration, waitedMs, wakeNote)
				: buildContinuationPrompt(state, state.iteration);
		beginOwnedDelivery(prompt, state.id, "followUp");
	}

	/**
	 * Sleep, then self-wake. persistent_wait uses this instead of dormant so the
	 * mission stays active and the loop restarts itself with no user input.
	 */
	function scheduleWake(delayMs: number, note?: string) {
		if (!state || state.status !== "active") return;
		if (wakeTimer) clearTimeout(wakeTimer);
		if (deferredDispatchTimer) {
			clearTimeout(deferredDispatchTimer);
			deferredDispatchTimer = undefined;
		}
		state.wakeAt = Date.now() + delayMs;
		state.wakeMs = delayMs;
		state.wakeNote = note ? truncate(note, 400) : undefined;
		state.updatedAt = Date.now();
		persist();
		updateStatus(lastCtx);
		const gen = generation;
		const stateId = state.id;
		wakeTimer = setTimeout(() => {
			wakeTimer = undefined;
			if (gen !== generation || state?.status !== "active" || state.id !== stateId) return;
			log(`persistent_wait elapsed (asked ${Math.round(delayMs / 1000)}s); waking the mission`);
			// No ctx access here: pi queues a followUp safely even if a run is active.
			dispatchContinuation("wake");
		}, delayMs);
	}

	function deferScheduleDispatch(ctx: ExtensionContext, delay = 0, kind: "auto" | "wake" = "auto") {
		if (!state || state.status !== "active") return;
		if (deferredDispatchTimer) clearTimeout(deferredDispatchTimer);
		const gen = generation;
		const stateId = state.id;
		deferredDispatchTimer = setTimeout(() => {
			deferredDispatchTimer = undefined;
			if (gen !== generation || state?.status !== "active" || state.id !== stateId) return;
			if (!safeCanDispatch(ctx)) {
				deferScheduleDispatch(ctx, Math.min(Math.max(delay, 100) * 2, 1_000), kind);
				return;
			}
			scheduleDispatch(ctx, kind);
		}, delay);
	}

	function scheduleDispatch(ctx: ExtensionContext, kind: "auto" | "wake" = "auto") {
		if (!state || state.status !== "active" || awaitingStart) return;
		if (backoffTimer) return;
		// A pending wait wins over any scheduling nudge: never dispatch through it.
		if (state.wakeAt && state.wakeAt > Date.now()) {
			if (!wakeTimer) scheduleWake(state.wakeAt - Date.now(), state.wakeNote);
			return;
		}
		// Previously these returned silently and the loop died until the next user
		// message. A busy boundary means "retry", not "stop".
		if (!safeCanDispatch(ctx)) {
			deferScheduleDispatch(ctx, 100, kind);
			return;
		}
		const delay =
			consecutiveErrors > 0
				? Math.min(BACKOFF_BASE_MS * 2 ** Math.min(consecutiveErrors - 1, 6), BACKOFF_MAX_MS)
				: 0;
		if (delay === 0) {
			dispatchContinuation(kind);
			return;
		}
		const gen = generation;
		log(`provider/delivery errors: ${consecutiveErrors}; retrying continuation in ${Math.round(delay / 1000)}s (backoff only, the mission stays active)`);
		backoffTimer = setTimeout(() => {
			backoffTimer = undefined;
			if (gen !== generation || state?.status !== "active") return;
			if (!safeCanDispatch(ctx)) {
				deferScheduleDispatch(ctx, 100, kind);
				return;
			}
			dispatchContinuation(kind);
		}, delay);
	}

	// ---------- lifecycle ----------

	function restoreSelectedBranch(ctx: ExtensionContext, reason: string) {
		lastCtx = ctx;
		generation++;
		clearTimers();
		state = loadState(ctx);
		consecutiveErrors = 0;
		lastRunAborted = false;
		hardStopMessage = undefined;
		hardStopStreak = 0;
		nextRunStateId = undefined;
		currentRunStateId = undefined;
		currentRunHadOutcome = false;
		if (!state || state.status === "off") {
			updateStatus(ctx);
			return;
		}

		state.workspaceRoot = resolveRealRoot(state.workspaceRoot);
		const currentRoot = resolveRealRoot(ctx.cwd);
		const sameRoot = isInsideRoot(state.workspaceRoot, currentRoot) && isInsideRoot(currentRoot, state.workspaceRoot);
		if (!sameRoot) {
			state.status = "off";
			state.reason = `workspace changed from ${state.workspaceRoot} to ${currentRoot}; start a new /persistent mission`;
			state.workspaceRoot = currentRoot;
			state.updatedAt = Date.now();
			persist();
			updateStatus(ctx);
			try {
				ctx.ui.notify(`pi-persistent disabled after ${reason}: workspace changed. Start a new mission explicitly.`, "warning");
			} catch {
				/* ignore */
			}
			return;
		}

		try {
			ctx.ui.notify(
				`pi-persistent: restored ${state.status} mission (auto ${state.iteration}). Use /sleep to stop it.`,
				"info",
			);
		} catch {
			/* ignore */
		}
		updateStatus(ctx);
		if (state.status !== "active") return;
		// A wait that was in flight when the process died resumes where it left off.
		if (state.wakeAt && state.wakeAt > Date.now()) {
			scheduleWake(state.wakeAt - Date.now(), state.wakeNote);
			return;
		}
		if (state.wakeAt) state.wakeAt = undefined;
		deferScheduleDispatch(ctx);
	}

	pi.on("session_start", (event, ctx) => {
		restoreSelectedBranch(ctx, event.reason);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreSelectedBranch(ctx, "session tree navigation");
	});

	pi.on("session_before_compact", (_event) => {
		if (state?.status === "active") clearTimers();
	});

	pi.on("session_compact", (event, ctx) => {
		if (!state || state.status !== "active" || event.willRetry) return;
		lastRunAborted = false;
		deferScheduleDispatch(ctx);
	});

	pi.on("session_compact_failed", (event, ctx) => {
		if (!state || state.status !== "active" || event.willRetry) return;
		lastRunAborted = false;
		deferScheduleDispatch(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		persist();
		generation++;
		clearTimers();
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* ignore */
		}
	});

	// Extension-owned messages carry a mission id. Drop a delayed prompt when a
	// replacement mission is now current; bind accepted prompts to their run so
	// stale agent_end/tool activity cannot mutate or classify the new mission.
	pi.on("input", (event, ctx) => {
		lastCtx = ctx;
		if (event.source === "extension") {
			const ownedStateId = ownedPromptStateId(event.text);
			if (!ownedStateId) return;
			if (!state || state.status !== "active" || state.id !== ownedStateId) {
				log(`discarded stale owned prompt for state ${ownedStateId}`);
				return { action: "handled" as const };
			}
			if (awaitingStart?.stateId === ownedStateId) {
				if (awaitingStart.timer) clearTimeout(awaitingStart.timer);
				awaitingStart = undefined;
			}
			// Pi may deliver steer/followUp work inside the current high-level agent
			// cycle without another agent_start event. Bind both the current and next
			// observed run to the accepted mission id.
			currentRunStateId = ownedStateId;
			nextRunStateId = ownedStateId;
			currentRunHadOutcome = false;
			return;
		}
		if (/^\/(?:persistent|sleep)\b/.test(event.text.trimStart())) return;
		if (state?.status === "dormant") {
			state.status = "active";
			state.reason = undefined;
			state.updatedAt = Date.now();
			persist();
			updateStatus(ctx);
			log("woken from dormant by user input");
		}
		if (state?.status === "active") {
			nextRunStateId = state.id;
			// A user message preempts any scheduled wait: this run is the wake.
			if (state.wakeAt) {
				state.wakeAt = undefined;
				state.wakeMs = undefined;
				if (wakeTimer) {
					clearTimeout(wakeTimer);
					wakeTimer = undefined;
				}
				updateStatus(ctx);
			}
		}
	});

	// ---------- run classification ----------

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		// Cheapest guaranteed-fresh status refresh: timers must not touch a ctx.
		updateStatus(ctx);
		currentRunHadOutcome = false;
		if (nextRunStateId) {
			currentRunStateId = nextRunStateId;
			nextRunStateId = undefined;
		}
		if (awaitingStart && currentRunStateId === awaitingStart.stateId) {
			if (awaitingStart.timer) clearTimeout(awaitingStart.timer);
			awaitingStart = undefined;
		}
	});

	pi.on("agent_end", (event, ctx) => {
		lastCtx = ctx;
		if (!state || state.status !== "active" || currentRunStateId !== state.id) return;
		currentRunHadOutcome = true;
		const final = findFinalAssistant(event.messages);
		if (!final) {
			consecutiveErrors++;
			return;
		}
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
		hardStopStreak = 0;
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		const settledStateId = currentRunStateId;
		currentRunStateId = undefined;
		if (!state || state.status !== "active") return;
		if (settledStateId !== state.id) {
			// A foreign run (another extension's message, a stray prompt) just ended. The
			// mission is still active and this is a valid idle boundary: keep the loop
			// alive instead of silently stopping until the next user message.
			log(`settled on a non-persistent run (state ${settledStateId ?? "none"}); continuing the mission`);
			scheduleDispatch(ctx);
			return;
		}
		if (!currentRunHadOutcome) consecutiveErrors++;
		if (hardStopMessage) {
			const message = hardStopMessage;
			hardStopMessage = undefined;
			hardStopStreak++;
			if (hardStopStreak >= 2) {
				goDormant(ctx, `provider hard stop survived one backoff retry (wakes on your next message): ${truncate(message, 300)}`);
				return;
			}
			// First hard stop: stay active and let the exponential backoff retry it.
			log(`provider hard stop (retrying with backoff, mission stays active): ${truncate(message, 200)}`);
			try {
				ctx.ui.notify(`pi-persistent: provider hard error, retrying with backoff: ${truncate(message, 120)}`, "warning");
			} catch {
				/* ignore */
			}
			consecutiveErrors = Math.max(consecutiveErrors, 1);
			scheduleDispatch(ctx);
			return;
		}
		if (lastRunAborted) {
			// A direct user interruption does not self-restart. Manual compaction clears
			// this flag in session_compact/session_compact_failed and schedules there.
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
			persistent_id: Type.String({
				description: "Exact persistent id shown in the latest persistent prompt",
				minLength: 1,
				maxLength: 100,
			}),
			reason: Type.String({
				description:
					"Concrete reason: what user input / outside authorization is required, or the evidence that the mission is fully satisfied",
				minLength: 1,
				maxLength: 1000,
			}),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!state || state.status !== "active") {
				return {
					content: [{ type: "text", text: "Persistent mode is not active; this call is a no-op." }],
					details: { applied: false },
				};
			}
			if (params.persistent_id !== state.id) {
				return {
					content: [{ type: "text", text: `Rejected stale persistent_dormant call for id ${params.persistent_id}; current id is ${state.id}.` }],
					details: { applied: false, stale: true },
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
		name: "persistent_wait",
		label: "Persistent wait",
		description: WAIT_TOOL_DESCRIPTION,
		promptSnippet: "persistent_wait: sleep then self-wake, mission stays active (persistent mode)",
		parameters: Type.Object({
			persistent_id: Type.String({
				description: "Exact persistent id shown in the latest persistent prompt",
				minLength: 1,
				maxLength: 100,
			}),
			wait_seconds: Type.Number({
				description: "How long to sleep before the host wakes you again (clamped to 5-3600s)",
				minimum: 0,
			}),
			check_next: Type.Optional(
				Type.String({ description: "What to look at on wake", maxLength: 400 }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			lastCtx = ctx;
			if (!state || state.status !== "active") {
				return {
					content: [{ type: "text", text: "Persistent mode is not active; this call is a no-op." }],
					details: { applied: false },
				};
			}
			if (params.persistent_id !== state.id) {
				return {
					content: [{ type: "text", text: `Rejected stale persistent_wait call for id ${params.persistent_id}; current id is ${state.id}.` }],
					details: { applied: false, stale: true },
				};
			}
			const seconds = Math.min(Math.max(Math.round(params.wait_seconds) || 60, 5), 3600);
			scheduleWake(seconds * 1000, params.check_next);
			return {
				content: [
					{
						type: "text",
						text: `Persistent mode stays active and will wake itself in ${seconds}s. Nothing to do now — end the turn without dormant.`,
					},
				],
				details: { applied: true, waitSeconds: seconds },
			};
		},
	});

	pi.registerTool({
		name: "persistent_checkpoint",
		label: "Persistent checkpoint",
		description: CHECKPOINT_TOOL_DESCRIPTION,
		promptSnippet: "persistent_checkpoint: update the mission checkpoint (persistent mode)",
		parameters: Type.Object({
			persistent_id: Type.String({
				description: "Exact persistent id shown in the latest persistent prompt",
				minLength: 1,
				maxLength: 100,
			}),
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
			if (!state || state.status !== "active") {
				return {
					content: [{ type: "text", text: "Persistent mode is not active; this call is a no-op." }],
					details: { applied: false },
				};
			}
			if (params.persistent_id !== state.id) {
				return {
					content: [{ type: "text", text: `Rejected stale persistent_checkpoint call for id ${params.persistent_id}; current id is ${state.id}.` }],
					details: { applied: false, stale: true },
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
					dispatchContinuation();
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
			nextRunStateId = undefined;
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
			// A dead ctx throws on any property access; degrade to steer so the kickoff is not lost.
			let idle = false;
			try {
				idle = ctx.isIdle?.() === true;
			} catch {
				/* stale ctx → not idle */
			}
			beginOwnedDelivery(buildKickoffPrompt(state), state.id, idle ? "followUp" : "steer");
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
