/**
 * Session-persisted state for pi-persistent.
 *
 * State lives as a custom session entry (type "persistent-state"). The newest
 * entry on the current branch wins. Session entries survive /reload, resume,
 * forks and compaction, so the mode and its checkpoint come back with the
 * session; nothing is written to disk outside the session file.
 */

export type PersistentStatus = "active" | "dormant" | "off";

export interface PersistentCheckpoint {
	lastKnownState?: string;
	nextCheck?: string;
	stoppingCondition?: string;
	updatedAt: number;
}

export interface PersistentState {
	id: string;
	mission: string;
	status: PersistentStatus;
	/** Realpath'd workspace root; the only area writable while active. */
	workspaceRoot: string;
	startedAt: number;
	updatedAt: number;
	/** Automatic continuations dispatched so far. Informational, never a limit. */
	iteration: number;
	checkpoint?: PersistentCheckpoint;
	reason?: string;
}

export const STATE_ENTRY_TYPE = "persistent-state";
export const STATUS_KEY = "persistent";
export const MISSION_MAX_CHARS = 4000;

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface SessionContextLike {
	sessionManager?: {
		getBranch?: () => SessionEntryLike[];
		getEntries?: () => SessionEntryLike[];
	};
}

export function newId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

export function isValidMission(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim()) && value.length <= MISSION_MAX_CHARS;
}

export function normalizeState(raw: unknown): PersistentState | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		!value.id ||
		!isValidMission(value.mission) ||
		typeof value.workspaceRoot !== "string" ||
		!value.workspaceRoot ||
		(typeof value.status !== "string" ||
			!["active", "dormant", "off"].includes(value.status)) ||
		typeof value.startedAt !== "number" ||
		typeof value.updatedAt !== "number" ||
		typeof value.iteration !== "number"
	) {
		return undefined;
	}
	const checkpointRaw = value.checkpoint;
	let checkpoint: PersistentCheckpoint | undefined;
	if (checkpointRaw && typeof checkpointRaw === "object" && !Array.isArray(checkpointRaw)) {
		const cp = checkpointRaw as Record<string, unknown>;
		checkpoint = {
			lastKnownState: typeof cp.lastKnownState === "string" ? cp.lastKnownState : undefined,
			nextCheck: typeof cp.nextCheck === "string" ? cp.nextCheck : undefined,
			stoppingCondition: typeof cp.stoppingCondition === "string" ? cp.stoppingCondition : undefined,
			updatedAt: typeof cp.updatedAt === "number" ? cp.updatedAt : 0,
		};
	}
	return {
		id: value.id,
		mission: value.mission,
		status: value.status as PersistentStatus,
		workspaceRoot: value.workspaceRoot,
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
		iteration: Number.isSafeInteger(value.iteration) && value.iteration >= 0 ? value.iteration : 0,
		checkpoint,
		reason: typeof value.reason === "string" ? value.reason : undefined,
	};
}

export function loadState(ctx: SessionContextLike): PersistentState | undefined {
	const entries =
		ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
	const entry = entries
		.filter((e) => e.type === "custom" && e.customType === STATE_ENTRY_TYPE)
		.pop();
	return entry ? normalizeState((entry.data as Record<string, unknown> | undefined)?.state) : undefined;
}

export function statusLabel(state: PersistentState | undefined): string {
	if (!state) return "off (never started)";
	switch (state.status) {
		case "active":
			return `active · auto ${state.iteration}`;
		case "dormant":
			return `dormant · auto ${state.iteration}${state.reason ? ` · ${truncate(state.reason, 80)}` : ""}`;
		case "off":
			return `off${state.reason ? ` · ${truncate(state.reason, 80)}` : ""}`;
	}
}

export function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
