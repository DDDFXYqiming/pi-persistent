[简体中文](README.md) | English

# pi-persistent

> Resident autonomous mode for the **Pi Coding Agent**. After `/persistent <mission>` the agent keeps working across settled run boundaries and finds in-scope follow-ups on its own, until you `/sleep`. No turn-limit breakers, writes confined to the workspace, zero user-blocking.

Continuation and persistence mechanics follow the proven patterns of [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions) (MIT). The plugin installs no `automaticTurns` / `noProgressTurns` circuit breakers. Exactly four things stop it. The mission is satisfied (evidence-based), a permission boundary is hit, user input is required, or you run `/sleep`.

## What it does

- **Single-flight settled dispatch.** The next continuation prompt is dispatched only at a boundary where `agent_settled` has fired, `isIdle()` is true, and no messages are queued, so provider retries, compaction and queued follow-ups drain first. It never dispatches twice. Failed deliveries are re-sent by a delivery watchdog with exponential backoff and no give-up cap.
- **Proactivity after completion.** It closes open loops, re-verifies that earlier changes still hold, hardens what exists, and documents. It does not invent unrelated work and does not expand scope beyond the mission.
- **Rules that cannot be lost.** The full rule set rides every plugin-owned message. Whatever compaction, context resets or forks swallow, the newest owned message always restates the complete rules.
- **Checkpoint state machine.** `persistent_checkpoint` records the current target, the last known state, the next check, and the stopping condition. State persists across `/reload`, resume and forks via session custom entries (immutable snapshots).
- **Two LLM tools.** `persistent_checkpoint` and `persistent_dormant`, both requiring the `persistent_id` shown in the latest persistent prompt. After a mission is replaced mid-run, stale leftover tool calls from the old run are rejected by id. The latter sleeps quietly with a concrete reason, and the next real user message wakes it automatically.
- **STEERING.** The newest user message is the current top priority. The model executes it first, then resumes the mission. This is rule 7 plus a steering check line in every continuation, and the model was verified to comply.
- **Zero user-blocking.** Notifications go through `ui.notify` (a toast) only. The `confirm` / `select` / `input` blocking primitives are never called, and the loop never waits on the user.
- **Lifecycle self-healing.** `/persistent resume` and a successful manual `/compact` schedule the next continuation immediately, and finishing a manual compaction is not treated as a user interruption. An active mission restored after a crash or restart auto-resumes. Session tree navigation reloads state from the selected branch. Forking into a different workspace disables the mission and asks for an explicit new one.

## Workspace boundary (enforced while active)

| Layer | Scope | Mechanism |
|---|---|---|
| Deterministic | `write` / `edit` | `tool_call` interception. The target path is realpath-resolved through its deepest existing ancestor (defeats `..` traversal and symlink/junction escapes), case-insensitive on Windows, and must land inside the workspace root. The block reason is returned to the model |
| Best-effort | `bash` / `powershell` | a denylist of machine-level destructive operations (`format` / `diskpart` / `bcdedit` / `reg add` / `schtasks` / `rm -rf /` / drive-root deletions and so on) combined with write-shaped tokens (`>` / `>>` / `tee` / `cp` / `mv` / `Set-Content` / `Out-File` and so on), inline interpreter write calls (`writeFileSync` / `open(...,'w')` and so on), and mutating git subcommands, naming outside targets. Outside targets include absolute paths, relative `..` traversal, and `~` / `$env:TEMP`-style home and temp environment paths. URLs are stripped before extraction to avoid false positives, and `2>&1`-style descriptor duplication is not treated as a file write |
| Allowed | `read` / `grep` / `find` / `ls` | read-only, available everywhere |

The shell scanner is heuristic and meant to stop accidental damage. A determined adversary is out of its scope. Missions that need hard isolation belong in a container or WSL, and the two layers here are the second net. There are no approval popups in this mode. Human guidance flows through conversation (wake, steer, or replace the mission) and never pauses the loop.

## Install

```bash
# from GitHub (recommended)
pi install git:github.com/DDDFXYqiming/pi-persistent

# local fallback (Windows schannel / npm interception)
git clone https://github.com/DDDFXYqiming/pi-persistent.git
pi install <absolute-path>

# try without installing
pi -e <absolute-path>\index.ts
```

No build step. pi runs the TypeScript sources directly via jiti, and `typebox` resolves through pi's bundled extension modules, so it works right after install. Requires Pi `0.80.6+` (the `agent_settled` event).

## Usage

Active only after `/persistent`, inert otherwise.

```
/persistent <mission>      # start (mission ≤ 4000 chars; put long instructions in a file)
/persistent                # status (mission / workspace / auto count)
/persistent resume         # wake a dormant mission
/persistent off            # stop (same as /sleep)
/sleep [reason]            # put it to sleep
```

The status bar shows `♾ active · auto N` (loop running) or `♾ 💤 dormant · reason` (quiet, wakeable). The four stop conditions are mission satisfied with evidence, a workspace boundary hit, required user input, and `/sleep`. There are no turn caps and no speculative "no progress" breakers. Transient provider errors back off exponentially (10 s → 5 min) and then continue. Hard quota/auth errors park the mission dormant until your next message.

## Verification

- **Type and boundary unit checks 41/41** (offline, no model), covering junction escapes, case-insensitivity, `..` traversal, out-of-drive writes, relative `..` redirections, `$env:TEMP` environment paths, inline interpreter write calls, mutating git subcommands, `rm -rf /`-class commands, and URL false-positive plus `2>&1` descriptor-duplication pass-through.
- **E2E RPC 13/13** (`qwen-local/qwen3.8-27b` real model, four paths)
  - The mission loop runs end to end. write → read back → byte-level check → checkpoint → dormant → the loop stays quiet.
  - The boundary holds. A `C:\…\Temp\escape.txt` write is blocked with the reason surfaced, zero bypass attempts, and the escape file never exists.
  - Steering works. While dormant, a new user instruction is executed first ("User explicit instruction - top priority"), then the mission resumes.
  - `/sleep` stops immediately. No new runs, and stale tool calls become no-ops.
- **Flow matrix 7/7** (same model). True automatic continuation, `/persistent resume` dispatching immediately, shell relative-path plus interpreter escape blocked, continuation after manual compaction, stale tool calls rejected by id after a mid-run mission replacement, zero extension errors, zero delivery resends.
- **Crash restore.** After the process behind an active mission is force-killed, a restart auto-resumes and finishes the remaining work, then goes dormant.
- **Cross-project fork.** Forking an active session into another cwd disables the mission and asks for an explicit new one.
- Two test entry points. `npm test` runs typecheck plus the guard unit tests. Four E2E scripts ship with the repo, `node test/drive-rpc.mjs`, `node test/probe-qwen-flows.mjs`, `node test/drive-qwen-restore.mjs`, and `node test/probe-qwen-fork.mjs`, defaulting to `qwen-local/qwen3.8-27b` and overridable with `PI_E2E_MODEL`.

## Permissions

- Intercepts `write` / `edit` / `bash` / `powershell` tool calls (block plus reason), only while the mode is active
- Appends `persistent-state` custom session entries for state (immutable snapshots), stored inside the session file with nothing else written to disk
- `ui.notify` toasts plus `ui.setStatus` status text
- No conversation image access, no network access, no blocking UI primitives
