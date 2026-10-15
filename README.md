# omo-limitless

English | [한국어](README.ko.md)

A Senpi/OMO extension that parks a goal-running OMO session when it hits a
subscription usage limit, then resumes it at the reset time.

## Install

One line, no clone needed. Windows (PowerShell 5.1):

```powershell
irm https://raw.githubusercontent.com/yjacket/omo-limitless/master/install.ps1 | iex
```

Linux, macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/yjacket/omo-limitless/master/install.sh | sh
```

The script downloads this repository's `master` branch and installs its `extension/` folder as `~/.omo/agent/extensions/omo-limitless/` (or under the folder named by `OMO_CODING_AGENT_DIR`). It builds the new folder beside the old one and swaps it in, so an update never mixes old and new files. Run from a clone (`.\install.ps1` or `sh install.sh`), it copies the local files instead. Then type `/reload` in running omo sessions.

On Windows use the PowerShell line: Git Bash's curl may fail with certificate error 60 because it does not read the Windows certificate store.

**Update:** run the same line again.

## What it does

- While limitless is on and not parked, the status line shows `🔄`. It disappears after `/limitless off`.
- While a goal runs, it parks at the next turn boundary once the 5h window reaches 90% or the 7d window reaches 95%. The status line then shows `⏸ 한도 대기 · HH:MM 재개` today, or `⏸ 한도 대기 · M/D HH:MM 재개` when the reset is on another day.
- If the reset is within the lane's `waitLimitMs`, it waits in the session. Otherwise it writes a park record, exits, and gets relaunched at reset.
- While waiting it sends warm turns so the prompt cache stays alive.
- After the reset time (plus `resumeGraceMs`) it resumes the goal.
- If the provider returns a limit error before a poll catches it, it parks reactively. When that error carries no reset time, the status line shows `⏸ 한도 대기 · 재개 시각 미정` ("resume time unknown") and limitless checks usage 30 minutes later. If the limit has cleared, or usage can't be read, it releases the park. If usage still shows the limit, the park becomes a normal usage park, which resumes at the reset time or, when the reset is still unknown, re-checks every `pollMinIntervalMs` (at least 60 s). A failed check retries every 30 minutes, and after 6 hours without a successful check limitless releases the park.
- While limitless holds your goal paused, automatic runs (goal continuation, todo reminder, notifications, messages from other sessions) run no tools; a message you type - and prompts that `/loop` or hooks send on your behalf - keeps every tool except spawning subagents (`task`, `task_create`). Work already running in the background when the park starts is not stopped.

## Config

`~/.omo/limitless/config.json`. Missing keys use the default. Invalid values fall back to the default, and one warning notification at session start lists the bad keys (up to 3, then `외 N개`, "N more").

| Key | Default | Meaning |
|---|---|---|
| `thresholds.fiveHour` | `90` | 5h window usage (%) that triggers a park |
| `thresholds.sevenDay` | `95` | 7d window usage (%) that triggers a park |
| `waitLimitMs.anthropic-subscription` | `14400000` | Wait in session if reset is within this (ms), else exit and relaunch |
| `waitLimitMs.chatgpt-subscription` | `7200000` | Same, for the ChatGPT subscription |
| `warm.anthropic-subscription.on` | `true` | Send warm turns while waiting |
| `warm.anthropic-subscription.intervalMs` | `3300000` | Warm turn interval (ms) |
| `warm.chatgpt-subscription.on` | `true` | Send warm turns while waiting |
| `warm.chatgpt-subscription.intervalMs` | `1620000` | Warm turn interval (ms) |
| `warm.chatgpt-subscription.requireTtlSeconds` | `1800` | A Codex model warms only when its prompt-cache TTL equals this value (in seconds). Models with any other TTL don't warm |
| `enabled` | `true` | Global switch |
| `pollMinIntervalMs` | `60000` | Minimum usage poll interval (ms) |
| `resumeGraceMs` | `60000` | Grace after reset before resuming (ms) |

## omo-health

The exit-and-relaunch path writes a park record under `~/.omo-health/parks`.
omo-health reads it at reset and relaunches the session in Orca or herdr.

It never exits while background work is running. These hold the exit:

- running subagents and DAG nodes
- background eval cells
- background shell sessions
- monitors
- a pending ask-user question
- a loop-guard hard stop
- a waiting omo-desk board
- any other source whose count it can't read

It waits in place and exits only after all of them are done and the session has handled the
finish notice (the next agent_settled). A reload never forces the exit: after a reload it waits
until the session has settled once and a short grace has passed, so work that survived the
reload is counted first. While it waits (and if the session never settles) it stays in the normal
wait and resumes in place at reset.

If the terminal is Orca or herdr but no fresh omo-health daemon is running, it doesn't exit.
Relaunch in Orca or herdr also needs an omo-health version that supports park resume (its
`daemon.json` lists the `park-resume` capability); otherwise the session waits in place.
The session stays parked where it is and resumes in place at reset.

## Self-launch fallback

When the terminal is neither Orca nor herdr, it registers a one-shot scheduled task under
`\omo-limitless\` that relaunches the session at reset. If it can't register the task, the
session stays parked in place instead. The relaunched session deletes the task; the task
doesn't delete itself. If the session never comes back, a task can be left over. Remove it with:

```powershell
Get-ScheduledTask -TaskPath \omo-limitless\ | Unregister-ScheduledTask -Confirm:$false
```

## Per-session switch

`/limitless off` and `/limitless on` affect only the current session. The state lives in
`~/.omo/limitless/control/<sid>.json`:

```json
{"v":1,"mode":"off"}
```

## Commands

| Command | Does |
|---|---|
| `/limitless status` | Print six lines in Korean: the status line (`⏸ 한도 대기 없음` when not parked), `상태:` park state, `사용량:` usage per window, `리셋:` reset time (HH:MM, M/D HH:MM on another day, or `unknown`), `출처:` usage source, `스위치:` 켜짐/꺼짐 |
| `/limitless resume` | Lift the park and resume now. While still over threshold it does not re-park until the windows that were over at resume reset (you are deliberately spending the remaining quota; a window over threshold with an unknown reset time is not held); any other window crossing the threshold, `/limitless park`, `off` then `on`, or a real limit error still parks |
| `/limitless park` | Park in the session now, but only if the current usage already calls for a park. Otherwise (usage under the threshold, or no usage decision yet) it parks nothing and prints one Korean line saying so |
| `/limitless off` / `on` | Turn off / on for this session |

## What it never does

- No token refresh.
- No fallback to another provider.
- No paid overage spill.
- No tools.
