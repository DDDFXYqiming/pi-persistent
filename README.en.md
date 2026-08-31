[简体中文](README.md) | English

# pi-persistent

> Resident autonomous mode for the **Pi Coding Agent**: after `/persistent <mission>` the agent keeps working across settled run boundaries and self-finds in-scope follow-ups until you `/sleep`. **No turn-limit breakers, workspace-confined writes, zero user-blocking.**

Continuation and persistence mechanics follow the proven patterns of [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions) (MIT). **No `automaticTurns` / `noProgressTurns` circuit breakers** — the only stop conditions are: mission satisfied (evidence-based), a permission boundary, required user input, or `/sleep`.

## What it does

- **Single-flight settled dispatch**: the next continuation prompt is dispatched only at `agent_settled` + `isIdle()` + no pending messages, so provider retries, automatic compaction and queued follow-ups drain first — never dispatched twice; failed deliveries re-send on an exponential watchdog with no give-up cap
- **Proactivity after completion**: close open loops, re-verify earlier changes still hold, harden, document; no invented unrelated work, no scope beyond the mission
- **Rules that cannot be lost**: the full rule set rides every plugin-owned message — no matter what compaction, context resets or forks swallow, the newest owned message always restates the complete rules
- **Checkpoint state machine**: `persistent_checkpoint` records the current target, last known state, next check, and stopping condition; state persists as immutable session custom entries across `/reload`, resume and forks
- **Two LLM tools**: `persistent_checkpoint` and `persistent_dormant`, both requiring the `persistent_id` shown in the latest persistent prompt — after a mission is replaced mid-run, stale leftover tool calls from the old run are rejected by id; the next real user message wakes a dormant mission automatically
- **STEERING**: the newest user message is the current top priority — execute it first, then resume the mission (rule 7 + a steering check line in every continuation; verified the model complies)
- **Zero user-blocking**: notifications go through `ui.notify` (a toast) only — `confirm` / `select` / `input` blocking primitives are never called; the loop never waits on the user
- **Lifecycle self-healing**: `/persistent resume` and a successful manual `/compact` schedule the next continuation immediately (manual compaction completion is not treated as a user interruption); an active mission restored after a crash or restart auto-resumes; session tree navigation reloads state from the selected branch; forking into a different workspace disables the mission and requires an explicit new one

## Workspace boundary (enforced while active)

| Layer | Scope | Mechanism |
|---|---|---|
| Deterministic | `write` / `edit` | `tool_call` interception: the target path is realpath-resolved through its deepest existing ancestor (defeats `..` traversal and symlink/junction escapes), case-insensitive on Windows, must land inside the workspace root; the block reason is returned to the model |
| Best-effort | `bash` / `powershell` | a denylist of machine-level destructive operations (`format` / `diskpart` / `bcdedit` / `reg add` / `schtasks` / `rm -rf /` / drive-root deletions…) plus write-shaped tokens (`>` / `>>` / `tee` / `cp` / `mv` / `Set-Content` / `Out-File`…, inline interpreter write calls (`writeFileSync` / `open(...,'w')` …), mutating git subcommands) naming outside targets: absolute paths, relative `..` traversal, and `~` / `$env:TEMP`-style home/temp environment paths; URLs are stripped before extraction to avoid false positives, and `2>&1`-style descriptor duplication is not treated as a file write |
| Allowed | `read` / `grep` / `find` / `ls` | read-only, available everywhere |

The shell scanner is heuristic — it catches mistakes, not adversaries. Missions that need hard isolation belong in a container or WSL; the two layers here are the second net. There are **no approval popups** in this mode — human guidance flows through conversation (wake / steer / replace the mission), never by pausing the loop.

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

No build step — pi runs the TypeScript sources directly via jiti; `typebox` resolves through pi's bundled extension modules. Requires Pi `0.80.6+` (the `agent_settled` event).

## Usage

Active only after `/persistent` (inert otherwise):

```
/persistent <mission>      # start (mission ≤ 4000 chars; put long instructions in a file)
/persistent                # status (mission / workspace / auto count)
/persistent resume         # wake a dormant mission
/persistent off            # stop (same as /sleep)
/sleep [reason]            # put it to sleep
```

Status bar: `♾ active · auto N` (loop running) / `♾ 💤 dormant · reason` (quiet, wakeable). The four stop conditions: mission satisfied with evidence, a workspace boundary hit, required user input, `/sleep` — **no turn caps, no speculative "no progress" breakers**. Transient provider errors back off exponentially (10 s → 5 min) and continue; hard quota/auth errors park the mission dormant until your next message.

## Verification

- **Type + boundary unit checks 41/41** (offline, no model): junction escapes, case-insensitivity, `..` traversal, out-of-drive writes, relative `..` redirections, `$env:TEMP` environment paths, inline interpreter write calls, mutating git subcommands, `rm -rf /`-class commands, URL false-positive and `2>&1` descriptor-duplication pass-through
- **E2E RPC 13/13** (`qwen-local/qwen3.8-27b`, four paths): mission loop, boundary block, steering wake, immediate `/sleep` stop
- **Flow matrix 7/7** (same model): true automatic continuation, `/persistent resume` dispatching immediately, shell relative-path + interpreter escape blocked, continuation after manual compaction, stale tool calls rejected by id after a mid-run mission replacement, zero extension errors, zero delivery resends
- **Crash restore**: an active mission whose process is force-killed auto-resumes after restart and finishes the remaining work
- **Cross-project fork**: forking an active session into another cwd disables the mission and asks for an explicit new one
- Commands: `npm test` (typecheck + guard unit tests); `node test/drive-rpc.mjs`, `node test/probe-qwen-flows.mjs`, `node test/drive-qwen-restore.mjs`, `node test/probe-qwen-fork.mjs` (E2E; default `qwen-local/qwen3.8-27b`, override with `PI_E2E_MODEL`)

## Permissions

- Intercepts `write` / `edit` / `bash` / `powershell` tool calls (block + reason), only while the mode is active
- Appends `persistent-state` custom session entries for state (stored inside the session file; nothing else is written to disk)
- `ui.notify` toasts + `ui.setStatus` status text
- No conversation image access, no network access, no blocking UI primitives
