/**
 * TUI boundary smoke test for the user-invoked persistent menu.
 * Run: node test/menu-tui.ts
 */

import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showPersistentMenu } from "../menu.ts";
import type { PersistentState } from "../state.ts";

const tui = createTuiHarness({ width: 100, rows: 24 });
let state: PersistentState | undefined;
let startedMission: string | undefined;

const ctx = {
	mode: "tui" as const,
	hasUI: true,
	ui: {
		custom: tui.custom,
		notify: () => undefined,
		confirm: async () => true,
		editor: async () => "Finish the current feature",
	},
} as unknown as ExtensionCommandContext;

const running = showPersistentMenu(ctx, {
	getState: () => state,
	startMission: async (mission) => {
		startedMission = mission;
		state = {
			id: "mission-1",
			mission,
			status: "active",
			workspaceRoot: "D:\\AI_Projects\\demo",
			startedAt: 1,
			updatedAt: 1,
			iteration: 0,
		};
	},
	resumeMission: async () => undefined,
	sleep: async () => undefined,
	wakeMission: async () => undefined,
});

await tui.waitForOpen();
tui.setFocused(true);
const frame = tui.render().join("\n");
const failures: string[] = [];
if (!frame.includes("Persistent")) failures.push("TUI frame should show Persistent title");
if (!frame.includes("Start a mission")) failures.push("off menu should show Start a mission");
if (!frame.includes("View status")) failures.push("off menu should show View status");

tui.press("tui.select.confirm");
await tui.waitForPending();
await running;
if (startedMission !== "Finish the current feature") failures.push("Start a mission should open the editor and start the returned mission");
tui.dispose();

if (failures.length > 0) {
	console.error(`FAIL ${failures.length} TUI checks:`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("PASS TUI menu smoke checks");
