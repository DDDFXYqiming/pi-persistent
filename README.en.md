[简体中文](README.md) | English

# pi-persistent

> Resident autonomous mode for the **Pi Coding Agent**: after `/persistent <mission>` the agent keeps working across settled run boundaries and self-finds in-scope follow-ups until you `/sleep`. **No turn-limit breakers, workspace-confined writes, zero user-blocking.**

**A Pi-native take on OpenAI's unreleased Codex "Persistent" mode** ("Continue working until put to sleep" — public implementation in [codex-rs/core/assets/persistent_mode.md](https://github.com/openai/codex/blob/main/codex-rs/core/assets/persistent_mode.md), coverage by [WIRED](https://www.wired.com/story/openai-is-developing-a-persistent-ai-agent/)). Continuation and persistence mechanics follow the proven patterns of [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions) (MIT); the behavior semantics are rebuilt for Persistent: **no `automaticTurns` / `noProgressTurns` circuit breakers** — the only stop conditions are: mission satisfied (evidence-based), a permission boundary, required user input, or `/sleep`.

## What it does

- **Single-flight settled dispatch**: the next continuation prompt is dispatched only at `agent_settled` + `isIdle()` + no pending messages, so provider retries, compaction and queued follow-ups drain first — never dispatched twice
- **Proactivity after completion**: close open loops, re-verify earlier changes still hold, harden, document; no invented unrelated work, no scope beyond the mission
- **Rules that cannot be lost**: the full rule set rides every plugin-owned message — no matter what compaction, context resets or forks swallow, the newest owned message always restates the complete rules
- **Checkpoint state machine**: `persistent_checkpoint` records the current target, last known state, next check, and stopping condition; state persists across `/reload`, resume and forks via session custom entries
- **Two LLM tools**: `persistent_checkpoint` and `persistent_dormant` (quiet sleep with a concrete reason; the next real user message wakes it automatically)
- **STEERING**: the newest user message is the current top priority — execute it first, then resume the mission (rule 7 + a steering check line in every continuation; verified the model complies)
- **Zero user-blocking**: notifications go through `ui.notify` (a toast) only — `confirm` / `select` / `input` blocking primitives are never called; the loop never waits on the user

## Workspace boundary (enforced while active)

| Layer | Scope | Mechanism |
|---|---|---|
| Deterministic | `write` / `edit` | `tool_call` interception: the target path is realpath-resolved through its deepest existing ancestor (defeats `..` traversal and symlink/junction escapes), case-insensitive on Windows, must land inside the workspace root; the block reason is returned to the model |
| Best-effort | `bash` / `powershell` | a denylist of machine-level destructive operations (`format` / `diskpart` / `bcdedit` / `reg add` / `schtasks` / `rm -rf /` / drive-root deletions…) plus write-shaped tokens (`>` / `>>` / `tee` / `cp` / `mv` / `Set-Content` / `Out-File`…) naming absolute paths outside the root; URLs are stripped before extraction to avoid false positives |
| Allowed | `read` / `grep` / `find` / `ls` | read-only, available everywhere |

The shell scanner is heuristic — it catches mistakes, not adversaries. Missions that need hard isolation belong in a container or WSL; the two layers here are the second net. There are **no approval popups** in this mode — human guidance flows through conversation (wake / steer / replace the mission), never by pausing the loop.

## Install

```bash
# from GitHub (recommended)
pi install git:github.com:DDDFXYqiming/pi-persistent

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

- **Boundary unit checks 29/29** (offline, no model): junction escapes, case-insensitivity, `..` traversal, out-of-drive writes, `rm -rf /`-class commands, URL false-positive guards (`curl https://… -o relative-path` must pass)
- **E2E RPC 13/13** (`minimax-m3/MiniMax-M3`, four paths):
  - mission loop: write → read back → byte-level check → checkpoint → dormant → loop stays quiet
  - boundary: a `C:\…\Temp\escape.txt` write is blocked with the reason surfaced, zero bypass attempts, the escape file never exists
  - steering: dormant → new user instruction → model runs it first ("User explicit instruction - top priority") → resumes
  - `/sleep`: immediate stop, no new runs, stale tool calls become no-ops
- Scripts: `node test/guard-sanity.ts` (offline), `node test/drive-rpc.mjs` (E2E), `node test/install-probe.mjs` (install probe, zero model calls)

## Permissions

- Intercepts `write` / `edit` / `bash` / `powershell` tool calls (block + reason), only while the mode is active
- Appends `persistent-state` custom session entries for state (stored inside the session file; nothing else is written to disk)
- `ui.notify` toasts + `ui.setStatus` status text
- No conversation image access, no network access, no blocking UI primitives
