/**
 * Offline checks for the persistent command menu and completions.
 * Run: node test/menu-sanity.ts
 */

import { buildPersistentMenuState, completePersistentArguments } from "../menu.ts";
import type { PersistentState } from "../state.ts";

const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, message: string) {
	checks++;
	if (!condition) failures.push(message);
}

function labels(state: PersistentState | undefined) {
	return buildPersistentMenuState(state).items.map((item) => item.label);
}

function state(status: PersistentState["status"], overrides: Partial<PersistentState> = {}): PersistentState {
	return {
		id: "mission-1",
		mission: "Finish the current feature and verify it",
		status,
		workspaceRoot: "D:\\test-workspaces\\demo",
		startedAt: 1,
		updatedAt: 1,
		iteration: 3,
		...overrides,
	};
}

const offLabels = labels(undefined);
expect(offLabels.includes("Start a mission…"), "off menu should offer Start a mission");
expect(offLabels.includes("View status"), "off menu should offer View status");
expect(offLabels.includes("Help"), "off menu should offer Help");
expect(offLabels.includes("Close"), "off menu should offer Close");
expect(!offLabels.includes("Resume mission"), "off menu should not offer Resume mission");

const activeLabels = labels(state("active"));
expect(activeLabels.includes("View full status"), "active menu should offer full status");
expect(activeLabels.includes("Replace mission…"), "active menu should offer replacement");
expect(activeLabels.includes("Stop (/sleep)"), "active menu should offer stop");
expect(!activeLabels.includes("Resume mission"), "active menu should not offer resume");

const waitingLabels = labels(
	state("active", {
		wakeAt: Date.now() + 60_000,
		wakeMs: 60_000,
		wakeNote: "check the build",
	}),
);
expect(waitingLabels.includes("Wake now"), "waiting menu should offer Wake now");

const dormantView = buildPersistentMenuState(
	state("dormant", { reason: "needs user authorization" }),
);
const dormantLabels = dormantView.items.map((item) => item.label);
expect(dormantLabels.includes("Resume mission"), "dormant menu should offer Resume mission");
expect(dormantView.lines.some((line) => line.includes("needs user authorization")), "dormant reason should be visible");

const allCompletions = completePersistentArguments("");
expect(allCompletions?.map((item) => item.value).join(",") === "resume,off,stop", "empty completion list should expose command actions");
expect(
	completePersistentArguments("re")?.map((item) => item.value).join(",") === "resume",
	"completion should filter resume",
);
expect(completePersistentArguments("unknown") === null, "unknown completion prefix should return null");
expect(completePersistentArguments("resume ") === null, "completion should stop after a subcommand");

if (failures.length > 0) {
	console.error(`FAIL ${failures.length}/${checks} checks:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(`PASS all ${checks} menu checks`);
