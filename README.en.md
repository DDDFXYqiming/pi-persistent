[简体中文](README.md) | English

# pi-persistent

`pi-persistent` adds an opt-in persistent mission mode to the Pi Coding Agent. Start a mission with `/persistent <mission>` and Pi can continue across settled run boundaries, record checkpoints, and schedule another check. The mode ends when you run `/sleep` or when progress needs user input or authorization that the agent cannot obtain.

Continuation and persistence follow the patterns used by [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions) (MIT). The behavior also follows the documented shape of OpenAI Codex persistent mode. The plugin requires Pi `0.80.6+`, which provides the `agent_settled` event.

## What it does

- **Single-flight continuation.** A new prompt is sent only after `agent_settled`, an idle host, and an empty message queue. Provider retries, compaction, and queued follow-ups are allowed to finish before dispatch. A delivery watchdog retries failed dispatches with exponential backoff.
- **Mission follow-ups.** After the requested work is complete, the agent can recheck earlier changes, close related open loops, and document the result while staying inside the mission scope.
- **Timed waiting.** `persistent_wait(wait_seconds, check_next)` keeps the mission active and schedules a wake prompt. The status bar shows the pending wait and its remaining time.
- **Durable rules and checkpoints.** Each plugin-owned prompt carries the current rules. `persistent_checkpoint` stores the target, known state, next check, and stopping condition in immutable session custom entries, so reload, resume, and fork operations can restore it.
- **Mission-scoped tools.** `persistent_checkpoint`, `persistent_wait`, and `persistent_dormant` are active only while a mission is active. Calls include the current `persistent_id`, which rejects stale calls after a mission replacement.
- **User steering.** The newest user message is handled before the mission resumes. Toast notifications use `ui.notify`; the loop does not call blocking `confirm`, `select`, or `input` primitives.
- **Lifecycle recovery.** Manual compaction, `/persistent resume`, process restart, and session-tree navigation restore or reschedule the active mission. A fork into another workspace disables the mission until a new one is started.
- **Compaction guard.** In `persistent` mode, long missions use a bounded handoff for `session_before_compact`. The guard can condense an oversized summary, merge new turns, retry an overlong response, and fall back to deterministic local truncation. Full history remains in the session file.

When a workspace boundary rejects a tool call, the rejection applies to that call. The mission remains active and the returned reason asks the agent to move that operation inside the workspace. Provider errors back off before the mission is parked dormant; a later user message can wake it.

## Workspace boundary

The boundary is enforced while a mission is active.

| Layer | Scope | Mechanism |
|---|---|---|
| Deterministic | `write` / `edit` | Resolve the target through its deepest existing ancestor, reject `..` traversal and symlink or junction escapes, and require the result to stay under the workspace root. Windows comparisons are case-insensitive. |
| Best effort | `bash` / `powershell` | Scan destructive commands, write-shaped tokens, inline interpreter writes, mutating git commands, and targets outside the workspace. URLs are removed before target extraction so ordinary URL text does not trigger a block. |
| Allowed | `read` / `grep` / `find` / `ls` | Read-only access remains available. |

The shell scan is a safety net rather than a sandbox. Use a container or WSL when a mission needs hard isolation.

## Compaction guard configuration

The optional `~/.pi/agent/pi-persistent.json` file uses these defaults when it is absent. Unknown keys are ignored.

```jsonc
{
  "compaction": {
    "mode": "persistent",     // persistent, always, or off
    "targetTokens": 3000,
    "maxInputChars": 24000,
    "maxOutputTokens": 16384,
    "timeoutMs": 180000,
    "provider": "",
    "model": ""
  }
}
```

`persistent` guards sessions with a mission. `always` applies the guard to ordinary sessions as well, and `off` restores Pi's default compaction. Guard requests use fresh routing session IDs, do not write the prompt cache, and do not send a thinking level.

## Install

```bash
# from GitHub
pi install git:github.com/DDDFXYqiming/pi-persistent

# local fallback
git clone https://github.com/DDDFXYqiming/pi-persistent.git
pi install <absolute-path>

# try without installing
pi -e <absolute-path>\index.ts
```

There is no build step. Pi runs the TypeScript source through jiti and resolves `typebox` through its bundled extension modules.

## Usage

```text
/persistent <mission>      # start a mission, up to 4000 characters
/persistent                # show mission, workspace, and auto count
/persistent resume         # wake a dormant mission
/persistent off            # stop the mission
/sleep [reason]            # stop the mission with an optional reason
```

Without a mission, the plugin leaves the ordinary tool list, prompts, boundary checks, and compaction path unchanged. `/persistent` activates the three mission tools; `/sleep` removes them again.

## Verification

`npm test` runs type checks and offline tests for the workspace boundary, compaction guard, and tool scope. The scripts in `test/` cover RPC continuation, timed wake-up, crash recovery, cross-project forks, and manual compaction. Set `PI_E2E_MODEL` and `PI_E2E_THINKING` when running the end-to-end scripts.

## Permissions

- Intercepts `write`, `edit`, `bash`, and `powershell` calls only while a mission is active.
- Stores immutable `persistent-state` snapshots in the Pi session file.
- Uses `ui.notify` and `ui.setStatus` for status updates.
- Sends auxiliary model requests only for the compaction guard, using fresh routing session IDs without prompt-cache writes or a reasoning option.
- Adds or removes only its own three tools. It does not modify built-in tools, skills, prompt templates, themes, context files, keyboard shortcuts, or CLI flags.
- Does not read conversation images. Outside the compaction guard, it does not access the network.
