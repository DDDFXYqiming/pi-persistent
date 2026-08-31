[简体中文](README.md) | English

# pi-persistent

> Resident autonomous mode for the **Pi Coding Agent**. After `/persistent <mission>` the agent keeps working across settled run boundaries and finds in-scope follow-ups on its own, until you `/sleep`. No turn-limit breakers, writes confined to the workspace, zero user-blocking.

Continuation and persistence mechanics follow the proven patterns of [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions) (MIT); the behaviour is aligned with OpenAI's unreleased Codex `Persistent mode` (`continue working until put to sleep` plus proactivity, see `codex-rs/core/templates/persistent_mode.md`). The plugin installs no `automaticTurns` / `noProgressTurns` circuit breakers, and the model does not get to decide to wrap up.

**The user is the only stop.** The model has three moves — keep working, `persistent_wait` to sleep and be woken automatically, or `persistent_dormant` for a genuine dead end — and none of them is "finished". A tool call rejected by the workspace boundary denies **one action**, it is not a stop reason (see below). Provider hard errors back off and retry first; only two in a row make the mission dormant.

## What it does

- **Single-flight settled dispatch.** The next continuation prompt is dispatched only at a boundary where `agent_settled` has fired, `isIdle()` is true, and no messages are queued, so provider retries, compaction and queued follow-ups drain first. It never dispatches twice. Failed deliveries are re-sent by a delivery watchdog with exponential backoff and no give-up cap.
- **Proactivity after completion.** It closes open loops, re-verifies that earlier changes still hold, hardens what exists, and documents. It does not invent unrelated work and does not expand scope beyond the mission.
- **Wait instead of stop.** `persistent_wait(wait_seconds, check_next)` lets the host wake the mission on a timer: status stays `active`, a wake prompt is dispatched when it elapses, and no user input is required. This mirrors Codex's "schedule the next useful check … often 1–3 minutes". Without it, an agent that wants to "look again in two minutes" had dormancy as its only option, which is one of the reasons the old build stopped early.
- **Rules that cannot be lost.** The full rule set rides every plugin-owned message. Whatever compaction, context resets or forks swallow, the newest owned message always restates the complete rules.
- **Checkpoint state machine.** `persistent_checkpoint` records the current target, the last known state, the next check, and the stopping condition. State persists across `/reload`, resume and forks via session custom entries (immutable snapshots).
- **Three LLM tools.** `persistent_checkpoint`, `persistent_wait` and `persistent_dormant`, all requiring the `persistent_id` shown in the latest persistent prompt. After a mission is replaced mid-run, stale leftover tool calls from the old run are rejected by id. Dormancy sleeps quietly with a concrete reason and the next real user message wakes it; both the prompt and the tool descriptions state explicitly that a blocked call, an unchanged/pending result, or having answered the original ask once are **not** dormant reasons.
- **STEERING.** The newest user message is the current top priority. The model executes it first, then resumes the mission. This is rule 7 plus a steering check line in every continuation, and the model was verified to comply.
- **Zero user-blocking.** Notifications go through `ui.notify` (a toast) only. The `confirm` / `select` / `input` blocking primitives are never called, and the loop never waits on the user.
- **Lifecycle self-healing.** `/persistent resume` and a successful manual `/compact` schedule the next continuation immediately, and finishing a manual compaction is not treated as a user interruption. An active mission restored after a crash or restart auto-resumes, and an unexpired `persistent_wait` is re-armed for its remaining time. Session tree navigation reloads state from the selected branch. Forking into a different workspace disables the mission and asks for an explicit new one.
- **No silent leaks.** If the host is momentarily busy at a settled boundary (`isIdle()` false / messages queued), the dispatcher now polls instead of returning — the old build dropped that one dispatch and the loop stayed dead until the user spoke again. A run owned by a foreign extension message (no mission marker) is still treated as a valid idle boundary and continues the mission; the old build recognised no owner and stopped forever.

## Workspace boundary (enforced while active)

| Layer | Scope | Mechanism |
|---|---|---|
| Deterministic | `write` / `edit` | `tool_call` interception. The target path is realpath-resolved through its deepest existing ancestor (defeats `..` traversal and symlink/junction escapes), case-insensitive on Windows, and must land inside the workspace root. The block reason is returned to the model |
| Best-effort | `bash` / `powershell` | a denylist of machine-level destructive operations (`format` / `diskpart` / `bcdedit` / `reg add` / `schtasks` / `rm -rf /` / drive-root deletions and so on) combined with write-shaped tokens (`>` / `>>` / `tee` / `cp` / `mv` / `Set-Content` / `Out-File` and so on), inline interpreter write calls (`writeFileSync` / `open(...,'w')` and so on), and mutating git subcommands, naming outside targets. Outside targets include absolute paths, relative `..` traversal, and `~` / `$env:TEMP`-style home and temp environment paths. URLs are stripped before extraction to avoid false positives, and `2>&1`-style descriptor duplication is not treated as a file write |
| Allowed | `read` / `grep` / `find` / `ls` | read-only, available everywhere |

The shell scanner is heuristic and meant to stop accidental damage. A determined adversary is out of its scope. Missions that need hard isolation belong in a container or WSL, and the two layers here are the second net. There are no approval popups in this mode. Human guidance flows through conversation (wake, steer, or replace the mission) and never pauses the loop.

**A block is not a stop.** Every block reason now ends with a fixed line saying that this denies one action only, that the mission is not finished and persistent mode is not stopped, and asks the agent to move that step's side effects inside the root and continue. The old text said "if you cannot proceed, call persistent_dormant" — which handed the model an exit ramp on every single denial and was the number one cause of early stopping.

**Only real write targets are inspected.** The path check no longer substring-matches the whole command. It first works out where the command actually writes: redirect targets, positional arguments of path-taking commands (`cp` / `mv` / `rm` / `tee` / `Set-Content` / `mkdir` / …), `-o` / `--output` / `-OutFile` values, and string literals inside inline interpreter writes (`writeFileSync`, `open(...,'w')`). Git-bash paths, `~` and `$env:TEMP` are expanded, then compared by realpath. So `npm install ../local-pkg`, `echo "see ~/docs" > notes.md` and `git commit -m "handle /tmp cleanup"` no longer misfire, while `echo x > ..\escape.txt`, `cp a.txt ../out/b.txt` and `git -C C:\Temp reset --hard` still block.

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

The status bar shows `♾ active · auto N` (loop running), `♾ ⏳ waiting 27s · auto N` (a `persistent_wait` is in flight and will self-wake) or `♾ 💤 dormant · reason` (quiet, wakeable). There are effectively **two** stops: you run `/sleep`, or the model calls `persistent_dormant` because progress genuinely needs user input or authorization it cannot obtain. There are no turn caps and no speculative "no progress" breakers; finishing the mission is not a stop, running out of useful in-scope follow-ups is. Transient provider errors back off exponentially (10 s → 5 min) and then continue. Quota/auth hard errors back off and notify first, and only after two in a row does the mission park dormant until your next message.

## Verification

All of the below ran in isolated workspaces (`.tmp/<probe>/workspace` with a dedicated `--session-dir`), driving pi over the CLI (`pi --mode rpc --offline --no-extensions -e <abs>/index.ts`) with model `minimax/MiniMax-M3` at thinking level `high`.

- **Type and boundary unit checks 53/53** (offline, no model). Junction escapes, case-insensitivity, `..` traversal, out-of-drive writes, `$env:TEMP` / `process.env.TEMP` environment paths, inline interpreter write calls (including nested quoting), mutating git subcommands, `rm -rf /`-class commands, URL false positives and `2>&1` descriptor duplication. 12 new regression checks cover the false-positive fixes (`npm install ../local-pkg`, `pip3 install -e ../pkg`, `echo "see ~/docs" > notes.md`, `git commit -m "handle /tmp ..." ` must pass; `cp a.txt ../out/b.txt`, `touch ../x`, `Set-Content "notes\..\..\escape.txt"` must still block).
- **E2E RPC 18/18** (`node test/drive-rpc.mjs`, five paths)
  - The mission loop runs end to end: write -> read back -> byte-level check -> checkpoint -> dormant -> the loop stays quiet.
  - **A block no longer ends the mission.** The out-of-workspace write to `C:\...\Temp\pi-persistent-escape.txt` is blocked with the reason surfaced, the model attempts no bypass and does **not** go dormant over the denial - it writes `blocked-note.txt` inside the root instead (`p2-kept-working-after-block`), and only dormants once the work is actually done. The escape file never exists.
  - **`persistent_wait` self-wake.** Tool called -> status stays `active` with `wakeAt` persisted -> the mission wakes itself `gap=20s` after the call (not at the settled boundary), with zero user input.
  - Dormancy wakes on a real user message, executes it first (STEERING), then dormants again. `/sleep` stops immediately and stale tool calls become no-ops.
- **Continuity probe 8/8** (`node test/probe-continuity.mjs`, new in this build)
  - `c1-loop-keeps-running-without-user-input`: with dormant and wait both forbidden by the mission, an agent that only ever replies "done" is still auto-continued across settled boundaries (settled 0 -> 4, `status=active iteration=4`). Finishing does not stop it.
  - `c2-wake-survives-foreign-run`: a foreign extension message with no mission marker (a second `noise.ts` extension) lands inside a 30s wait window; it does not dirty mission ownership and the wake still fires on schedule (starts 5 -> 6, no user prompt in between).
  - After `/sleep` the in-flight run may finish but no new run starts (agent_start delta 0).
- **Flow matrix 7/7** (`node test/probe-qwen-flows.mjs`). True automatic continuation, `/persistent resume` dispatching immediately, shell relative-path plus interpreter escape blocked, continuation after manual compaction, stale tool calls rejected by id after a mid-run mission replacement, zero extension errors, zero delivery resends.
- **Crash restore PASS** (`node test/drive-qwen-restore.mjs`). An active mission's process is force-killed mid long-command; the restart auto-resumes with no user input, finishes the remaining work, then dormants.
- **Cross-project fork PASS** (`node test/probe-qwen-fork.mjs`). Forking an active session into another cwd forces the mission `off` and asks for an explicit new one.
- Test entry points. `npm test` runs typecheck plus the guard unit tests. Five E2E scripts: `drive-rpc.mjs`, `probe-continuity.mjs`, `probe-qwen-flows.mjs`, `drive-qwen-restore.mjs`, `probe-qwen-fork.mjs`, all defaulting to `minimax/MiniMax-M3` at `high`, overridable with `PI_E2E_MODEL` / `PI_E2E_THINKING`.


## Permissions

- Intercepts `write` / `edit` / `bash` / `powershell` tool calls (block plus reason), only while the mode is active
- Appends `persistent-state` custom session entries for state (immutable snapshots, including the pending `persistent_wait` deadline), stored inside the session file with nothing else written to disk
- `ui.notify` toasts plus `ui.setStatus` status text
- No conversation image access, no network access, no blocking UI primitives
