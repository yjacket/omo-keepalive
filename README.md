# omo-keepalive

English | [한국어](README.ko.md)

A Senpi/OMO extension that parks a goal-running OMO session when it hits a
subscription usage limit, then resumes it at the reset time. It also keeps the
prompt cache warm while you are away and while a park waits, without adding
anything to the conversation (formerly omo-keepwarm).

## Install

```sh
omo install git:github.com/yjacket/omo-keepalive
```

omo clones the repository into `~/.omo/agent/git/github.com/yjacket/omo-keepalive` and adds it to `packages` in `~/.omo/agent/settings.json`. Type `/reload` in running sessions.

From a local checkout: `omo install C:/path/to/omo-keepalive`.

**Update:** `omo update --extensions` (every installed package) or `omo update git:github.com/yjacket/omo-keepalive`, then `/reload`.

If you installed with the old copy scripts, delete `~/.omo/agent/extensions/omo-limitless/`, or it loads next to the package.

## Migrating from omo-limitless and omo-keepwarm

1. Run `omo remove git:github.com/yjacket/omo-limitless`.
2. Delete the file `~/.omo/agent/extensions/omo-keepwarm.ts` by hand.
3. Don't run the old `omo-keepwarm uninstall`. It writes `mode: off` and cache warming stops. Never use `--purge` either, it deletes your records.
4. Install omo-keepalive as shown above, then type `/reload`.
5. In `~/.omo/agent/statusbar.json`, replace `limitless` with `omo-keepalive`.
6. Remove the scheduled tasks the old version left: `Get-ScheduledTask -TaskPath \omo-limitless\ | Unregister-ScheduledTask -Confirm:$false`.

The first time it loads, it moves `~/.omo/limitless` to `~/.omo/keepalive` (only when `~/.omo/keepalive` does not exist yet). Cache-warming data stays in `~/.omo-keepwarm`.

## What it does

- While keepalive is on and not parked, the status line shows `🔄`. It disappears after `/keepalive off`.
- While a goal runs, it parks at the next turn boundary once the 5h window reaches 90% or the 7d window reaches 95%. The status line then shows `⏸ 한도 대기 · HH:MM 재개` today, or `⏸ 한도 대기 · M/D HH:MM 재개` when the reset is on another day.
- If the reset is within the lane's `waitLimitMs`, it waits in the session. Otherwise it writes a park record, exits, and gets relaunched at reset.
- While waiting it keeps the prompt cache warm until the reset with pings that are not conversation turns and leave no record. At 99% utilization or more it does not warm. See [Cache warming](#cache-warming).
- After the reset time (plus `resumeGraceMs`) it resumes the goal.
- If the provider returns a limit error before a poll catches it, it parks reactively. When that error carries no reset time, the status line shows `⏸ 한도 대기 · 재개 시각 미정` ("resume time unknown") and keepalive checks usage 30 minutes later. If the limit has cleared, or usage can't be read, it releases the park. If usage still shows the limit, the park becomes a normal usage park, which resumes at the reset time or, when the reset is still unknown, re-checks every `pollMinIntervalMs` (at least 60 s). A failed check retries every 30 minutes, and after 6 hours without a successful check keepalive releases the park.
- A limit on one model family (`You've reached your Fable limit`, or a future `modelBlocks` entry in auth.json for the failing model) does not park: other models still work and OMO's fallback moves on. `All ... accounts ... are currently blocked` parks only when the account itself has a future `blockedUntil`.
- When goal auto-continuation stops at its cap (8 in a row; newer OMO also marks the goal blocked) and the last turn ended in a limit error, keepalive sets the goal back to active and sends one user message so it goes on with a model that still works. OMO clears its fallback tried list only on a user message, and a message sent by an extension does not unblock a goal. One message per stop; after 3 in a row with no successful turn keepalive stops and notifies. Not while parked.
- While keepalive holds your goal paused, automatic runs (goal continuation, todo reminder, notifications, messages from other sessions) run no tools; a message you type - and prompts that `/loop` or hooks send on your behalf - keeps every tool except spawning subagents (`task`, `task_create`). Work already running in the background when the park starts is not stopped.

## Config

`~/.omo/keepalive/config.json`. Missing keys use the default. Invalid values fall back to the default, and one warning notification at session start lists the bad keys (up to 3, then `외 N개`, "N more").
Values can be changed with `/keepalive set`; file edits reach every running session except changes to `enabled`.

| Key | Default | Meaning |
|---|---|---|
| `thresholds.fiveHour` | `90` | 5h window usage (%) that triggers a park |
| `thresholds.sevenDay` | `95` | 7d window usage (%) that triggers a park |
| `waitLimitMs.anthropic-subscription` | `14400000` | Wait in session if reset is within this (ms), else exit and relaunch |
| `waitLimitMs.chatgpt-subscription` | `7200000` | Same, for the ChatGPT subscription |
| `warm.anthropic-subscription.on` | `true` | Keep the cache warm during a park-wait |
| `warm.chatgpt-subscription.on` | `true` | Same, for the ChatGPT subscription |
| `enabled` | `true` | Global switch |
| `pollMinIntervalMs` | `60000` | Minimum usage poll interval (ms) |
| `resumeGraceMs` | `60000` | Grace after reset before resuming (ms) |

## Cache warming

Claude and Codex subscription sessions are kept warm while you are away, so the first turn after you return reads the cache.

- **Pings that leave no record.** Claude: the session's Claude Code session is resumed as a fork that is not persisted. Codex: the last request is re-sent with `store:false` under the same cache key. Nothing reaches the conversation, the transcript or other extensions.
- **Interval.** From the last request (yours, a goal's or another extension's turn): Claude every 55 minutes, Codex every 15 minutes. The Codex subscription cache has no guaranteed lifetime and was gone after 25-30 minutes.
- **How long.** Normally until the time set from your return habit; during a park-wait until the reset. One miss can be transient, so the next ping still goes out; a second miss in a row stops warming for that stretch.
- **Settings and records.** `mode` in `~/.omo-keepwarm/config.json`: `on` sends pings, `shadow` only records decisions, `off` or no file does nothing. Records stay in the same folder.
- After a senpi update, check the ping hits once: the last-7-days line of `/keepalive` and the `ping` records under `~/.omo-keepwarm/records`. If senpi changes how it builds requests, pings miss and warming stops after the second miss in a row.

### omo-ai preview-safe patch

Senpi builds the cache-warm ping from a preview of the prompt, and it skips the whole ping when an extension's `before_agent_start` handler is not marked `previewSafe`. Two of omo-ai's handlers (gateway rules and onboarding) are not marked, so keepalive patches `plugin/extensions/omo.js` in the installed omo-ai, adding `{previewSafe:!0}` to those two registrations, so the ping can be built. The patch runs once per process, is idempotent, and changes nothing when the bundle shape is unknown (it reports the reason instead). The original is kept at `omo.js.before-previewsafe`. It is re-applied after omo-ai updates, and takes effect at the next launch. Set `OMO_KEEPALIVE_PREVIEW_SAFE=off` to skip it.

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
`\omo-keepalive\` that relaunches the session at reset. If it can't register the task, the
session stays parked in place instead. The relaunched session deletes the task; the task
doesn't delete itself. If the session never comes back, a task can be left over. Remove it with:

```powershell
Get-ScheduledTask -TaskPath \omo-keepalive\ | Unregister-ScheduledTask -Confirm:$false
```

## Per-session switch

`/keepalive off` and `/keepalive on` affect only the current session. The state lives in
`~/.omo/keepalive/control/<sid>.json`:

```json
{"v":1,"mode":"off"}
```

## The screen

Bare `/keepalive` shows one screen in three groups, labelled in Korean:

- **한도 (limit).** `🔄 감시 중` (watching), the status line text while parked with the time left, or `⏹ 꺼짐 (이 세션)` when off for this session. Below it, a usage bar per window with its reset time. When not parked, a forecast line can say when a window reaches its threshold at the last hour's rate.
- **캐시 (cache).** ❤️‍🔥 means warming, followed by how long (until a time, or 재개까지 "until resume") and the next ping. 🩵 means not warming, followed by one reason word. When not parked, a forecast line can give the chance you return while warming still runs.
- **기록 (records).** Today's pings, hits and saved tokens, then the last 7 days' cold returns and saved tokens.

No forecast line is shown while parked. While parked, the 🩵 word is the park hold's reason. Otherwise the reason words are: 시간 끝, 캐시 놓침, 맥락 작음, 시간 0, 이미 식음, 기준 없음, 대상 아님, 중복, 맥락 바뀜, 모델 바뀜, 정리 중, 횟수 끝, 상한, 오류 뒤, 취소 뒤, 취소, 실패, 맥락 모름, 꺼짐, 세션 닫힘, 시계 이상, 늦음, 다른 확장, 판단만 기록, 다른 인스턴스, 작업 중, 준비 중.

## Goal waits and senpi's backstop

When a goal is waiting on something (a terminal monitor, a background task, a workflow), senpi arms a backstop: about once an hour it sends a hidden continuation so a stuck wait can't stall the goal forever. Each of those turns is a real model call, and after an idle hour the prompt cache is usually cold.

keepalive watches senpi's `goal_continuation_timer_state` and `wake_source_state` events. While a goal waits, it keeps the cache warm until the next turn. It also holds the backstop (it publishes `continuation_hold_state` with source `omo-keepalive`), but only when all of these are true:

- warming is actually live for this session (worth it, eligible, armed or pinging),
- the wait isn't a user grace period or an ask-user wait,
- omo-health is running fresh, declares `goal-liveness`, can wake this session, and its sensor heartbeat in this session is recent and carries the goal-liveness schema,
- the backstop setting is on.

While the hold is in place, omo-health does the liveness job: if the wait turns out to be leaked or silent, it wakes the session itself. Everything else falls back to today's behaviour. If any condition drops, keepalive releases the hold and senpi's hourly backstop runs as before.

There's a self-check. If keepalive holds the backstop but senpi fires it anyway, keepalive marks the backstop as tripped, stops holding until this omo process exits (a new session in the same process included), and the screen says so.

Settings: `/keepalive set backstop on|off` (on by default). The hold also ends after maxHoldMinutes (default 360, valid 30 to 1440), and the cache line then shows 시간 끝.

During a goal wait the 캐시 group on the screen shows these lines:

- `❤️‍🔥 다음 턴까지` plus the next ping time, with no forecast line, while warming is live.
- `🩵` plus a reason word when it isn't: 이득 없음 (not worth it), 맥락 모름, 대상 아님, 꺼짐, 시간 끝, 준비 중, or a stop word from the list above.
- `대기  backstop 멈춤 · 확인은 omo-health` while the backstop is held.
- `대기  backstop 그대로 · senpi 바뀜` when the self-check tripped.

Rollback: run `/keepalive set backstop off`. keepalive then never holds the backstop, and senpi's hourly continuation works exactly as it does without keepalive.

## Commands

| Command | Does |
|---|---|
| `/keepalive` | Show the screen described above (`/keepalive status` does the same) |
| `/keepalive resume` | Lift the park and resume now. While still over threshold it does not re-park until the windows that were over at resume reset (you are deliberately spending the remaining quota; a window over threshold with an unknown reset time is not held); any other window crossing the threshold, `/keepalive park`, `off` then `on`, or a real limit error still parks |
| `/keepalive park` | Park in the session now, but only if the current usage already calls for a park. Otherwise (usage under the threshold, or no usage decision yet) it parks nothing and prints one Korean line saying so |
| `/keepalive off` / `on` | Turn off / on for this session |
| `/keepalive set` | Open the settings screen; outside the terminal UI, print the settings list |
| `/keepalive set <item> <value>` | Change one setting; item is the left column of the list. E.g. `set threshold 5h 95`, `set wait claude 3h`, `set usd day 5` |
| `/keepalive set expiry <lane> <step\|auto>` | Set per-lane warming time (`0` means no warming; `auto` uses the return habit) |
| `/keepalive set habit auto` / `--return-rate <0-1> --median <dur> --t90 <dur>` | Let the return habit be learned, or set it yourself: share of absences you return from, median return time, time by which 90% return (e.g. `--return-rate 0.8 --median 10m --t90 2h`) |
| `/keepalive set mode on\|shadow\|off` | Set cache warming: `on` sends pings, `shadow` only records decisions, `off` does nothing |
| `/keepalive set backstop on\|off` | Let keepalive hold senpi's goal backstop while warming is live (`on`, default) or never hold it (`off`) |

## Settings screen

The settings screen has four groups:
- **한도 (limits):** 5h and 7d thresholds, how long to keep the session open waiting for a reset, and warming while it waits.
- **캐시 (cache):** warming mode, goal backstop, maximum hold, and daily and per-episode USD limits.
- **자리 비운 뒤 데우는 시간 (warming after you step away):** how long each subscription or API lane is kept warm after you step away.
- **복귀 습관 (return habit):** automatic or manual return-rate, median, and 90th-percentile times.

Keys: `↑↓` move, `←→` change, `Enter`/`Space` next value, `r` restore default, `s` save, `q`/`Esc` close (press twice when there are unsaved changes).

Every keepalive config value except `enabled` reaches every running session as soon as the file is saved, including thresholds, in-session wait limits, warming during a park, and hand edits to `pollMinIntervalMs` or `resumeGraceMs`. Cache settings (the 캐시, 자리 비운 뒤 데우는 시간 and 복귀 습관 groups) reach running sessions within 5 seconds. Only `enabled` requires a file edit and `/reload`. An unreadable settings file is never overwritten.

## Rollback

1. Run `omo remove git:github.com/yjacket/omo-keepalive` (or your local path), then `omo install git:github.com/yjacket/omo-limitless`. The old version reads `~/.omo/limitless`, so move `~/.omo/keepalive` back to `~/.omo/limitless` before starting it.
2. Recreate `~/.omo/agent/extensions/omo-keepwarm.ts` from `~/.omo-keepwarm/app/releases/<version>/extension/stub.ts.tpl`, replacing `__STUB_FORMAT__` with `1`.
3. Type `/reload`.

## What it never does

- No token refresh.
- No fallback to another provider.
- No paid overage spill.
- No tools.
