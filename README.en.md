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
- **Three LLM tools, visible only inside the mode.** `persistent_checkpoint`, `persistent_wait` and `persistent_dormant`, all requiring the `persistent_id` shown in the latest persistent prompt. After a mission is replaced mid-run, stale leftover tool calls from the old run are rejected by id. Dormancy sleeps quietly with a concrete reason and the next real user message wakes it; both the prompt and the tool descriptions state explicitly that a blocked call, an unchanged/pending result, or having answered the original ask once are **not** dormant reasons.
- **Context footprint stays with the mission.** pi activates every tool an extension registers, and each active tool ships in the tool list and the system prompt of every request in that session. The plugin therefore toggles the three mission tools with the mission itself: with no mission, an ordinary session's tool list and system prompt match a plugin-free one, and `/persistent` arms them again (since `v0.4.1`).
- **STEERING.** The newest user message is the current top priority. The model executes it first, then resumes the mission. This is rule 7 plus a steering check line in every continuation, and the model was verified to comply.
- **Zero user-blocking.** Notifications go through `ui.notify` (a toast) only. The `confirm` / `select` / `input` blocking primitives are never called, and the loop never waits on the user.
- **Lifecycle self-healing.** `/persistent resume` and a successful manual `/compact` schedule the next continuation immediately, and finishing a manual compaction is not treated as a user interruption. An active mission restored after a crash or restart auto-resumes, and an unexpired `persistent_wait` is re-armed for its remaining time. Session tree navigation reloads state from the selected branch. Forking into a different workspace disables the mission and asks for an explicit new one.
- **Compaction guard (v0.4.0).** Long missions reliably outgrow pi's default compaction: under "preserve all existing information" the chained summary grows monotonically while the summarization call's output budget is the constant `min(0.8 × reserveTokens, model.maxTokens)`. Once the summary lands on that ceiling every compaction fails with "hit the token cap", the context never shrinks and the session deadlocks at the threshold. By default (`mode: "persistent"`) the plugin answers `session_before_compact` **only in sessions that have a mission**, replacing that behavior with a bounded, explicitly lossy handoff: an oversized previous summary is condensed first, then merged with the new turns; the auxiliary request never carries a thinking level; an overshoot or a `length` stop triggers one compression pass, and a failing model path falls back to a deterministic local truncation. Compaction always returns a result, and the full history stays in the session file.
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

## Compaction guard configuration

Optional file `~/.pi/agent/pi-persistent.json`; these are the defaults when it is absent, unknown keys are ignored:

```jsonc
{
  "compaction": {
    "mode": "persistent",     // persistent (default) guards only sessions with a mission; always guards every session; off restores pi's default
    "targetTokens": 3000,     // target size of the produced summary
    "maxInputChars": 24000,   // serialization budget for the new turns
    "maxOutputTokens": 16384, // auxiliary request output cap, clamped to the model's own cap
    "timeoutMs": 180000,
    "provider": "",           // optional fixed summarizer, paired with model; empty reuses the session model
    "model": ""
  }
}
```

Guard requests use fresh routing session ids, never write the prompt cache, and never send a reasoning option.

The reach is scoped to the mode by default: a session that never ran `/persistent` keeps pi's own compaction untouched. The summary-chain ceiling and its deadlock are indeed independent of persistent mode, so any long session can hit them - if you want the guard everywhere, set `"mode": "always"` knowingly (the guard produces a lossy summary), or `"mode": "off"` to opt out completely.

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

Installing registers two commands, `/persistent` and `/sleep`. With no mission running the plugin does not intervene at all: the three mission tools are absent from the tool list and the system prompt, no tool call is screened, and compaction stays with pi - an ordinary session sends the same request body as a plugin-free one (since `v0.4.1`, measured below). To extend the compaction guard to ordinary sessions, set `"mode": "always"` as described above.

```
/persistent <mission>      # start (mission ≤ 4000 chars; put long instructions in a file)
/persistent                # status (mission / workspace / auto count)
/persistent resume         # wake a dormant mission
/persistent off            # stop (same as /sleep)
/sleep [reason]            # put it to sleep
```

The status bar shows `♾ active · auto N` (loop running), `♾ ⏳ waiting 27s · auto N` (a `persistent_wait` is in flight and will self-wake) or `♾ 💤 dormant · reason` (quiet, wakeable). There are effectively **two** stops: you run `/sleep`, or the model calls `persistent_dormant` because progress genuinely needs user input or authorization it cannot obtain. There are no turn caps and no speculative "no progress" breakers; finishing the mission is not a stop, running out of useful in-scope follow-ups is. Transient provider errors back off exponentially (10 s → 5 min) and then continue. Quota/auth hard errors back off and notify first, and only after two in a row does the mission park dormant until your next message.

## Verification

`npm test` runs type checking and offline tests for write boundaries, compaction and tool scope.

The scripts in `test/` cover RPC continuation, timed wake-up, crash recovery, cross-project forks and manual compaction. Use isolated session directories and select an available model with `PI_E2E_MODEL` and `PI_E2E_THINKING`.

Boundary tests verify that rejected writes do not weaken subsequent checks. Scope tests compare sessions with and without a mission, ensuring that inactive sessions keep their original tools and compaction behavior and that stopping restores those defaults.

## Permissions

- Intercepts `write` / `edit` / `bash` / `powershell` tool calls (block plus reason), only while the mode is active
- Appends `persistent-state` custom session entries for state (immutable snapshots, including the pending `persistent_wait` deadline), stored inside the session file with nothing else written to disk
- `ui.notify` toasts plus `ui.setStatus` status text
- Answers `session_before_compact` only while a mission exists (or with an explicit `mode: "always"`), issuing auxiliary model requests then (fresh routing session ids, no prompt-cache writes, no reasoning option)
- Otherwise changes no pi default behavior: no keyboard shortcuts, no CLI flags, no `resources_discover`, and nothing touching skills, prompt templates, themes or context files
- Adds and removes only its own three tools in the active tool set (`getActiveTools` / `setActiveTools`); built-in tools and other extensions' tools are left alone
- No conversation image access, no blocking UI primitives; no network beyond the auxiliary summarization requests
