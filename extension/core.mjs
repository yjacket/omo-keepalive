// keepalive core (plan todo 5): park gate + the shared API every Wave-2 feature module plugs into.
//
// keepalive.mjs creates the core, wires senpi events to the core's `handle*` methods, then calls
// `install(core)` of each feature module in a fixed order (events, command, resume, warm, park-exit,
// reactive). Core handlers are registered BEFORE feature handlers, so on every event the core runs first.
//
// ── CORE API ──────────────────────────────────────────────────────────────────────────────────────
// core.pi, core.deps, core.config            senpi ExtensionAPI, injected deps, merged config (config.mjs)
// core.sessionId                             null until the first session_start, then ctx's session id
// core.lane                                  last resolveLane() result {provider, accounts}
// core.lastCtx                               ctx of the most recent senpi event (use it inside timers)
// core.state                                 persisted session state (mutate, then call core.persist()):
//     parkState "ok"|"park-wait"|"park-exit" (features may write other values, e.g. todo 8 "exited")
//     armed, source ("poll"|"manual"|"reactive"|...), window, util, resetAt, reason, warm {on,intervalMs,...}
//     decision (last policy result incl. state "unknown" when usage was unavailable), snapshots, lastPollAt
//     episode (counter), parkedAt, episodeNotified, latecomer, hadPriorTurns
//     pausedByKeepalive (goal id paused by keepalive, or null), blocked (count), mode ("on"|"off")
//     lastError {at, where, message}, lastRelease {at, reason}
//     Features keep their own data under a key named after the feature (state.warm is the policy's warm).
// core.keepwarm                            {controller, isInert}, set by warm.mjs (keepwarm runtime handle, unset until install)
// core.backstop                           {status() -> {holding, tripped}}, set by backstop.mjs (unset until install): holds senpi's goal backstop while goal-wait warming is live
// core.startState                            frozen copy of the state file as loaded at session_start, or null
//                                            (todo 8 reads parkState:"exited" here; the core never writes it)
// core.persist()                             write state to <home>/.omo/keepalive/state/<sid>.json (temp+rename);
//                                            a failed write sets state.lastError {at, where:"write", path, message}
// core.getPolicy()                           last decision (same as core.state.decision)
// core.poll({force})                         usage + policy; throttled to pollMinIntervalMs unless force.
//                                            Applies the result: park -> park(); ok -> release a poll park and
//                                            releaseOwnedGoal(); unknown (reader threw / source none) -> nothing.
//                                            A boundary poll never releases a manual/reactive park. Returns the decision.
//                                            A park decision whose resetAt is null or <= now is normalized to
//                                            park-wait with resetAt null and warm off (never park-exit).
// core.resetDue()                            THE reset path: todo 7's resume timer calls it (todo 17 may call it for a
//                                            reactive park with a known reset). Forced re-poll, then for ANY park
//                                            source (poll, manual, reactive):
//                                              still over -> re-park (source "poll") with the new resetAt and warm
//                                              ok         -> release() + releaseOwnedGoal({text: texts.resetResume})
//                                              unknown (usage source none, reader threw, no lane) -> same as ok
//                                            It sends NO message of its own: work restarts only through
//                                            releaseOwnedGoal when keepalive un-paused the goal it owns. No owned
//                                            goal (no goal, or a user-paused goal) -> park and status cleared, zero
//                                            messages, zero emits. Returns the decision (no-op when not parked).
// core.readUsage(provider, account)          production usage reader (usage.mjs, or deps.readUsage) behind the shared
//                                            per-account snapshot cache (fresh < pollMinIntervalMs -> no endpoint
//                                            call). Never throws: a reader error is recorded in state.lastError and
//                                            returned as {source:"none", windows:[], error}.
// core.park(decision, {source})              enter/refresh park: armed, status line, one notice per episode,
//                                            pauses an active goal, latecomer marking on a new episode.
//                                            decision: {state:"park-wait"|"park-exit", window, resetAt, reason, warm, util?}
//                                            resetAt null/NaN/<= now is normalized HERE for every caller to
//                                            park-wait, resetAt null, warm off (never park-exit, never self-launch);
//                                            status "⏸ 한도 대기 · 재개 시각 미정", no clock time in any text.
// core.release({reason})                     leave park: parkState ok, status cleared. Does NOT touch the goal;
//                                            call releaseOwnedGoal() after it to un-pause and restart work.
// core.isParked(), core.isLatecomer()        flags; core.canWarm() / core.canParkExit() are the gates todo 6 /
//                                            todo 8 must check (both false for a latecomer)
// core.enabled()                             config.enabled && state.mode !== "off" (todo 9 sets state.mode)
// core.ownedGoalId()                         state.pausedByKeepalive
// core.pauseActiveGoal({notice})             pause the goal only when it is active; records pausedByKeepalive;
//                                            returns the goal id or null. notice=true posts the "goal은 HH:MM ..." notice (announceGoalHeld).
// core.releaseOwnedGoal({reason})            un-pause only if the goal is paused and its id === pausedByKeepalive,
//                                            then restart work exactly once: idle -> pi.events.emit(
//                                            "goal_store_changed", {threadId}); busy -> remember it and emit at
//                                            agent_settled unless a run starts first (the goal extension continues by itself). Returns true when it un-paused. When it
//                                            returns false it sent nothing and emitted nothing - callers must NOT
//                                            send a fallback message (plan todo 9 restart-once rule).
// core.onBeforeSessionStart(fn(event, ctx))  pre-start gate (todo 8's start claim). Runs at session_start after
//                                            the state file is LOADED (core.sessionId, core.state, core.startState
//                                            are set) but before the core persists, sets the status, polls, parks or
//                                            pauses a goal. fn returning {veto:true} (sync or async) makes the core
//                                            write nothing and do nothing for the rest of the process (every
//                                            handler becomes a no-op, persist() returns false); the hook itself calls
//                                            ctx.shutdown(). core.isVetoed() reports it. A throwing hook is not a veto.
// core.onTransition(fn(prev, next))          after every parkState/resetAt/source change; prev/next = {parkState,
//                                            resetAt, window, source, reason, warm} where warm is the policy's
//                                            {on, intervalMs, requireTtlSeconds} for that park (null when ok).
//                                            park() without decision.warm keeps the last policy decision's warm.
// core.onSessionReset(fn())                  per-session teardown: runs on session_shutdown and when the session id
//                                            changes inside one process (/new, /resume), while core.state is still
//                                            the OLD session's. Features reset their closures there; the core then
//                                            clears every timer and its own per-session state. After a shutdown
//                                            core.sessionId is null (nothing persists until the next session loads).
// core.onBoundary(fn(ctx, kind))             after the core's own work at kind "session_start"|"turn_end"|"agent_settled"
// core.timers.set(name, ms, fn(ctx, stale)) / clear(name) / has(name)
//                                            one timer per name on the injected clock (deps.setTimeout); every
//                                            tick runs the control hook first, errors land in state.lastError.
//                                            stale() turns true once the session was reset (core.sessionEpoch moved)
//                                            after the callback started: a callback that awaits must check it and
//                                            drop its effects instead of acting on the next session's state.
// core.markExtensionTurn(kind)               mark the current agent run as a goal-race or warm turn (call from
//                                            before_agent_start). core.blockAllToolsInTurn() -> boolean, core.turn -> {kind}
// run marking (goalRun)                      every run the user did not start (goalRun means "not user-started"):
//                                            before_agent_start with any trigger other than "prompt" — a typed prompt
//                                            defaults to "prompt" (runner.js:1717) while "extension" and "delivery" are
//                                            automatic (agent-session.js:4293) — or a
//                                            custom-role message_start in a run no user message started (a followUp
//                                            run has no before_agent_start; the user message precedes the custom
//                                            messages of a typed prompt, agent-session.js:3770-3790). Cleared by a
//                                            user-role message_start (which also marks the run user-started), the final
//                                            agent_end (willRetry keeps it), agent_settled and session reset. Every
//                                            tool_call is blocked only while parked AND keepalive holds the goal
//                                            paused; a user run blocks only task/task_create.
// core.setControlReader(fn(ctx, kind))       control-file hook (todo 9): awaited at the start of every boundary
//                                            and timer tick; it may change state.mode or call release()
// core.now(), core.hhmm(ms)                  injected clock; HH:MM today, M/D HH:MM on another local day
// core.setStatus(text|undefined), core.notify(text, level), core.recordError(where, err)
// core.blockReason()                         "keepalive: usage limit <window> <util>% - resumes <HH:MM>"
// core.texts                                 {resetResume, raceNote, goalHeld(hhmm)}
//
// deps: {env, homeDir, fs (sync node:fs subset), now, setTimeout, clearTimeout, readUsage, goalStore}
//   goalStore: {read(ctx) -> goal|null, setStatus(ctx, status) -> goal}; default loads senpi's goal store.
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decide, overWindows } from "./policy.mjs";
import { readAuthJson, resolveLane } from "./lane.mjs";
import { readUsage as defaultReadUsage } from "./usage.mjs";
import { loadState, readSharedSnapshot, saveState, statePath, writeSharedSnapshot } from "./state.mjs";
import { configPath, configStamp, loadConfig } from "./config.mjs";

export const STATUS_KEY = "omo-keepalive";
// Shown in the status slot while keepalive is on and not parked, so the user can see it is watching. A natively
// wide emoji: the terminal reserves the two cells it draws (a narrow one like ♾️ overflows its single cell).
export const IDLE_STATUS = "🔄";
export const SPAWN_TOOLS = new Set(["task", "task_create"]);
export const NOTICE_WIDGET_KEY = "keepalive-notice";
export const GOAL_CONTINUATION_PREFIX = "Continue working toward the active thread goal.";
const SUBSCRIPTION = new Set(["anthropic-subscription", "chatgpt-subscription"]);
const PARKED = new Set(["park-wait", "park-exit"]);
const MAX_TIMER_MS = 2147483647;

export const TEXTS = {
  resetResume: "[keepalive] 사용량 한도가 리셋됐다. 중단 전 작업을 이어가라.",
  raceNote: "사용량 한도 대기 중. 도구를 쓰지 말고 한 줄로 끝내라",
  goalHeld: (hhmm) => hhmm === null
    ? "goal은 리셋 시각을 아직 몰라 한도가 풀리면 시작합니다. 지금 돌리려면 /keepalive resume"
    : `goal은 ${hhmm} 리셋 뒤 시작합니다. 지금 돌리려면 /keepalive resume`,
};

const knownTime = (ms) => typeof ms === "number" && Number.isFinite(ms);

// THE reset-time formatter (status bar, notices, /keepalive status). Shows HH:MM today, prefixed with M/D when `now` is
// given and the reset falls on another local day; "--:--" for an unknown time (null/NaN must never render as a
// clock, new Date(null) is 1970).
export function hhmm(ms, now) {
  const d = new Date(ms);
  if (!knownTime(ms) || !Number.isFinite(d.getTime())) return "--:--";
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (!knownTime(now) || d.toDateString() === new Date(now).toDateString()) return clock;
  return `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

export const statusText = (resetAt, now) => knownTime(resetAt) ? `⏸ 한도 대기 · ${hhmm(resetAt, now)} 재개` : "⏸ 한도 대기 · 재개 시각 미정";
// THE park notice formatter (persistent widget). goalOwned=true when keepalive paused a goal for this park; false
// for a session whose goal was not paused by keepalive (no goal, or a user-paused one), which stays free to work.
const parkNoticeText = (state, now, goalOwned = true) => {
  const when = knownTime(state.resetAt) ? `${hhmm(state.resetAt, now)} 재개.` : "리셋 시각을 아직 몰라 재개 시각 미정.";
  const tail = goalOwned ? "goal을 멈췄고 새 서브에이전트는 막힙니다." : "goal이 없어 작업은 그대로 할 수 있습니다.";
  return `⏸ 사용량 한도 대기 (${state.window ?? "?"} ${state.util ?? "?"}%) · ${when} ${tail}`;
};

const freshState = () => ({
  v: 1, parkState: "ok", armed: false, source: null, window: null, util: null, resetAt: null, reason: null,
  warm: null, decision: null, snapshots: [], lastPollAt: null, episode: 0, parkedAt: null, episodeNotified: false,
  latecomer: false, hadPriorTurns: false, pausedByKeepalive: null, blocked: 0, mode: "on", lastError: null,
  lastRelease: null, resumeHold: null, usageHistory: [],
});

const USAGE_HISTORY_MS = 3 * 3600_000;

// Highest utilization per window over every account, appended to a 3-hour history for the /keepalive forecast.
export function appendUsageHistory(history, snapshots, t) {
  const util = {};
  for (const s of snapshots ?? []) {
    for (const w of s?.windows ?? []) {
      const kind = w?.kind ?? w?.window;
      const value = w?.utilization ?? w?.used_percent;
      if (typeof kind === "string" && Number.isFinite(value)) util[kind] = Math.max(util[kind] ?? 0, value);
    }
  }
  const kept = (Array.isArray(history) ? history : []).filter((e) => Number.isFinite(e?.t) && t - e.t <= USAGE_HISTORY_MS && e.t <= t);
  if (Object.keys(util).length > 0) kept.push({ t, util });
  return kept.slice(-120);
}

const errText = (error) => String(error instanceof Error ? error.message : error);

const GOAL_REL = ["core", "extensions", "builtin", "goal"];

// Where senpi's dist can be. The bundled senpi runs `<senpi>/dist/bundle/cli.js` (argv[1] is NOT directly in dist),
// the older unbundled one `<senpi>/dist/cli.js`; omo's launcher also exports OMO_BIN=<omo-ai>/bin/omo.js, whose
// senpi sits either under omo-ai/node_modules or hoisted next to omo-ai in the global node_modules.
export function senpiDistCandidates({ env = process.env, argv1 = process.argv[1] } = {}) {
  const out = [];
  const add = (path) => { if (path && !out.includes(path)) out.push(path); };
  const fromBin = (bin) => {
    const pkg = join("@code-yeongyu", "senpi", "dist");
    add(join(dirname(dirname(bin)), "node_modules", pkg));
    add(join(dirname(dirname(dirname(bin))), pkg));
  };
  if (argv1) {
    let dir = dirname(argv1);
    for (let i = 0; i < 3; i += 1, dir = dirname(dir)) add(dir);
    fromBin(argv1);
  }
  if (env.OMO_BIN) fromBin(env.OMO_BIN);
  return out;
}

// senpi's goal store (dist/core/extensions/builtin/goal/{store,store-ref}.js), loaded by deriving the dist path the
// way omo-rollover does, widened for the bundled layout (argv[1] = dist/bundle/cli.js). The store is file-backed with
// its own lock, so this module instance and senpi's bundled copy see the same goal. Never throws on load.
export function createSenpiGoalStore({ env = process.env, argv1 = process.argv[1], fs = nodeFs } = {}) {
  let loading;
  const load = () => loading ??= (async () => {
    try {
      const main = await import("@code-yeongyu/senpi");
      if (typeof main?.readGoal === "function" && typeof main?.updateGoal === "function" && typeof main?.goalStoreRef === "function") {
        return { store: main, ref: main };
      }
    } catch {}
    for (const dist of senpiDistCandidates({ env, argv1 })) {
      const goal = join(dist, ...GOAL_REL);
      if (!fs.existsSync(join(goal, "store.js")) || !fs.existsSync(join(goal, "store-ref.js"))) continue;
      try {
        return {
          store: await import(pathToFileURL(join(goal, "store.js")).href),
          ref: await import(pathToFileURL(join(goal, "store-ref.js")).href),
        };
      } catch {}
    }
    return null;
  })().then((loaded) => {
    if (loaded === null) loading = undefined; // not cached: a later call may find it
    return loaded;
  });
  const refOf = (loaded, ctx) => loaded.ref.goalStoreRef(ctx.sessionManager, ctx.cwd ?? ctx.sessionManager?.getCwd?.() ?? process.cwd());
  return {
    async read(ctx) {
      const loaded = await load();
      if (!loaded) throw new Error("senpi goal store unavailable");
      return loaded.store.readGoal(refOf(loaded, ctx));
    },
    async setStatus(ctx, status) {
      const loaded = await load();
      if (!loaded) throw new Error("senpi goal store unavailable");
      return loaded.store.updateGoal(refOf(loaded, ctx), { status }, "user");
    },
  };
}

export function createCore(pi, { config, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? homedir();
  const fs = deps.fs ?? nodeFs;
  const settingsPath = configPath({ env, homeDir });
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeout ?? globalThis.setTimeout;
  const clearT = deps.clearTimeout ?? globalThis.clearTimeout;
  const readUsage = deps.readUsage ?? defaultReadUsage;
  const goalStore = deps.goalStore ?? createSenpiGoalStore({ env });
  const transitionFns = [];
  const configReloadFns = [];
  const configAppliedFns = [];
  const boundaryFns = [];
  const beforeStartFns = [];
  const resetFns = [];
  let vetoed = false;
  const timerHandles = new Map();
  let controlReader = null;
  let loadedConfigStamp = configStamp(settingsPath, fs);
  let configWatcher = null;
  let lastPollAt = null;
  let holding = null;
  let staleOwnedGoal = false;
  let holdingNotice = false;
  // releaseOwnedGoal un-paused the goal while a run was active: emit goal_store_changed at agent_settled unless a run
  // starts first (then the goal extension's own agent_end continuation owns the restart).
  let pendingKick = false;
  let goalRun = false; // the current agent run was not started by the user (any custom message / extension trigger)
  // Prompts that extensions send with pi.sendUserMessage (/loop ticks, Stop-hook follow-ups, ask-user answers) run as
  // trigger "prompt" exactly like typed input and count as user-started: the user's own prompt (and the custom
  // messages of its run) must never lose its tools (IS-6).
  let userRun = false; // a user message started or joined the current run: its custom messages do not mark it (IS-6)

  const core = {
    pi, deps, config, env, homeDir,
    sessionId: null,
    lane: null,
    lastCtx: undefined,
    state: freshState(),
    startState: null,
    turn: null,
    sessionEpoch: 0, // bumped by every session reset (shutdown, /new, /resume)
    texts: TEXTS,
    now: () => now(),
    hhmm: (ms) => hhmm(ms, now()),

    persist() {
      if (core.sessionId === null || vetoed) return false;
      const ok = saveState({ homeDir, sessionId: core.sessionId, state: core.state, fs });
      if (!ok) core.writeFailed(statePath(homeDir, core.sessionId));
      return ok;
    },
    // Records a failed file write (writeJsonAtomic/saveState returned false). In memory only: the caller's
    // next successful persist() carries it to disk.
    writeFailed(path) {
      core.state.lastError = { at: now(), where: "write", path, message: "write failed" };
    },
    recordError(where, error) {
      core.state.lastError = { at: now(), where, message: errText(error) };
      core.persist();
    },
    // undefined means "not parked": the idle mark while on, cleared while off or vetoed.
    setStatus(text) {
      try {
        const ui = core.lastCtx?.ui;
        const idle = !vetoed && core.enabled() ? (ui?.theme?.fg?.("dim", IDLE_STATUS) ?? IDLE_STATUS) : undefined;
        ui?.setStatus?.(STATUS_KEY, text ?? idle);
      } catch (error) { core.state.lastError = { at: now(), where: "status", message: errText(error) }; }
    },
    // The persistent park / goal-held notice: one TUI widget (ctx.ui.setWidget, senpi extensions/types.d.ts:153), text
    // replaced per state, undefined clears. A widget is UI chrome, never a session entry or an LLM message, so it can
    // never reach a model request (custom messages are converted to role:user by every compaction/btw path).
    refreshStatus() {
      core.setStatus(core.isParked() ? statusText(core.state.resetAt, now()) : undefined);
    },
    setNotice(text) {
      try { core.lastCtx?.ui?.setWidget?.(NOTICE_WIDGET_KEY, text === undefined ? undefined : [text]); } catch (error) { core.state.lastError = { at: now(), where: "notice", message: errText(error) }; }
    },
    notify(text, level = "info") {
      try { core.lastCtx?.ui?.notify?.(text, level); } catch (error) { core.state.lastError = { at: now(), where: "notify", message: errText(error) }; }
    },

    getPolicy: () => core.state.decision,
    enabled: () => config.enabled !== false && core.state.mode !== "off",
    isParked: () => PARKED.has(core.state.parkState) && core.state.armed === true,
    isLatecomer: () => core.state.latecomer === true,
    canWarm: () => core.isParked() && core.state.parkState === "park-wait" && !core.isLatecomer()
      && core.state.warm?.on === true && core.state.source !== "reactive",
    canParkExit: () => core.isParked() && core.state.parkState === "park-exit" && !core.isLatecomer(),
    ownedGoalId: () => core.state.pausedByKeepalive ?? null,
    blockReason() {
      const { window, util, resetAt } = core.state;
      return `keepalive: usage limit ${window ?? "unknown"} ${util ?? "?"}% - resumes ${knownTime(resetAt) ? hhmm(resetAt, now()) : "when the reset time is known (not known yet)"}`;
    },

    onTransition(fn) { transitionFns.push(fn); },
    onConfigReload(fn) { configReloadFns.push(fn); },
    onConfigApplied(fn) { configAppliedFns.push(fn); },
    onBoundary(fn) { boundaryFns.push(fn); },
    onBeforeSessionStart(fn) { beforeStartFns.push(fn); },
    onSessionReset(fn) { resetFns.push(fn); },
    isVetoed: () => vetoed,
    reloadConfig() {
      const stamp = configStamp(settingsPath, fs);
      if (stamp === loadedConfigStamp) return { changed: false, warnings: [] };
      loadedConfigStamp = stamp;
      const loaded = loadConfig({ env, homeDir, fs });
      for (const key of ["thresholds", "waitLimitMs", "warm", "pollMinIntervalMs", "resumeGraceMs"]) config[key] = loaded.config[key];
      for (const fn of configReloadFns) {
        try { fn(loaded.warnings); } catch (error) { core.recordError("config-reload", error); }
      }
      return { changed: true, warnings: loaded.warnings };
    },
    async applyConfigChange() {
      const result = core.reloadConfig();
      if (result.changed) await core.applyReloadedConfig();
      return { changed: result.changed };
    },
    // Re-decide the park and tell the features after reloadConfig() reported a change.
    async applyReloadedConfig() {
      if (core.sessionId === null || vetoed) return;
      if (core.enabled()) await core.poll({ force: true });
      await notifyConfigApplied();
    },

    async readUsage(provider, account) {
      const t = now();
      try {
        return await snapshotFor(provider, account, t);
      } catch (error) {
        core.recordError("usage", error);
        return { provider, account, windows: [], overageEnabled: false, source: "none", error: errText(error) };
      }
    },
    setControlReader(fn) { controlReader = fn; },

    markExtensionTurn(kind) { core.turn = { kind, blockAll: true }; },
    blockAllToolsInTurn: () => core.turn?.blockAll === true,

    timers: {
      set(name, ms, fn) {
        core.timers.clear(name);
        if (vetoed) return;
        const handle = setT(() => {
          timerHandles.delete(name);
          const epoch = core.sessionEpoch;
          const stale = () => epoch !== core.sessionEpoch;
          return (async () => {
            try {
              await runControl(core.lastCtx, `timer:${name}`);
              if (stale()) return;
              await fn(core.lastCtx, stale);
            } catch (error) {
              core.recordError(`timer:${name}`, error);
            }
          })();
        }, Math.min(Math.max(0, ms), MAX_TIMER_MS));
        handle?.unref?.();
        timerHandles.set(name, handle);
      },
      clear(name) {
        if (!timerHandles.has(name)) return;
        clearT(timerHandles.get(name));
        timerHandles.delete(name);
      },
      has: (name) => timerHandles.has(name),
    },

    async readGoal(ctx = core.lastCtx) {
      if (!ctx) return null;
      try {
        return (await goalStore.read(ctx)) ?? null;
      } catch (error) {
        core.recordError("goal-read", error);
        return null;
      }
    },

    // The one goal-status writer (park-exit re-activates through it too).
    setGoalStatus: (ctx, status) => goalStore.setStatus(ctx, status),

    // The "goal은 HH:MM 리셋 뒤 시작합니다" notice: replaces the park notice in the one notice widget.
    announceGoalHeld() {
      core.setNotice(TEXTS.goalHeld(knownTime(core.state.resetAt) ? hhmm(core.state.resetAt, now()) : null));
    },

    async pauseActiveGoal({ notice = false } = {}) {
      // Single flight: concurrent callers (goal_store_changed, before_agent_start, tool_call) share one pause; a joiner
      // that wants the notice makes the shared pause post it.
      if (holding) {
        holdingNotice ||= notice;
        return holding;
      }
      holdingNotice = notice;
      const run = (async () => {
        const ctx = core.lastCtx;
        const goal = await core.readGoal(ctx);
        if (goal?.status !== "active") return null;
        try {
          await goalStore.setStatus(ctx, "paused");
        } catch (error) {
          core.recordError("goal-pause", error);
          return null;
        }
        core.state.pausedByKeepalive = goal.id;
        core.persist();
        if (holdingNotice) core.announceGoalHeld();
        return goal.id;
      })();
      holding = run.finally(() => { holding = null; });
      return holding;
    },

    async releaseOwnedGoal({ reason = "release" } = {}) {
      const owned = core.state.pausedByKeepalive;
      if (!owned) return false;
      const ctx = core.lastCtx;
      const goal = await core.readGoal(ctx);
      core.state.pausedByKeepalive = null;
      if (goal?.status !== "paused" || goal.id !== owned) {
        core.persist();
        return false;
      }
      try {
        await goalStore.setStatus(ctx, "active");
      } catch (error) {
        core.state.pausedByKeepalive = owned;
        core.recordError("goal-resume", error);
        return false;
      }
      core.state.lastRelease = { at: now(), reason };
      core.persist();
      // hasPendingMessages() counts senpi's queued steer/follow-up user text (agent-session.js pendingMessageCount =
      // _steeringMessages + _followUpMessages; pushed at :1745 while a run streams, removed at that message's
      // message_start :2034-2047). Pending with the session idle is a transient between agent_end and the continuation
      // senpi always schedules for it (_scheduleContinuationAfterCurrentEvent at :6881, :6721 after compaction), which
      // fires agent_start and so clears pendingKick (that run owns the restart; the goal extension's agent_end re-queues).
      // If no run starts, pendingKick still emits at the next agent_settled.
      const idle = ctx?.isIdle?.() === true && ctx?.hasPendingMessages?.() !== true;
      // Busy: no message is queued. A followUp queued from a turn_end/agent_end handler lands after the agent core's
      // last queue poll, is never drained, and its pending state also blocks the goal extension's own continuation
      // (senpi agent-session.js _processAgentEvent / pi-agent-core runWithLifecycle), wedging the session in "Working".
      if (idle) await pi.events?.emit?.("goal_store_changed", { threadId: core.sessionId });
      else pendingKick = true;
      return true;
    },

    async park(input, { source = "poll" } = {}) {
      // Every caller is normalized here: a reset that is unknown or already past never parks with a deadline,
      // never park-exits and never warms. It becomes park-wait with resetAt null; resume.mjs (non-reactive
      // source) or reactive.mjs (reactive source) arms the re-check.
      const decision = knownTime(input.resetAt) && input.resetAt > now() ? input
        : { ...input, state: "park-wait", resetAt: null, warm: { ...(input.warm ?? {}), on: false } };
      const prev = parkView();
      const wasParked = core.isParked();
      const s = core.state;
      s.parkState = decision.state;
      s.armed = true;
      s.source = source;
      s.window = decision.window ?? null;
      s.resetAt = decision.resetAt ?? null;
      s.reason = decision.reason ?? null;
      s.util = decision.util ?? utilFrom(decision.reason);
      s.warm = decision.warm ?? core.state.decision?.warm ?? null;
      if (!wasParked) {
        s.episode = (s.episode ?? 0) + 1;
        s.parkedAt = now();
        s.latecomer = s.hadPriorTurns !== true;
        s.episodeNotified = false;
      }
      core.setStatus(statusText(s.resetAt, now()));
      core.persist();
      // The episode notice below covers a goal paused on the first park; later pauses (episode notice spent) announce themselves.
      const pausedNow = core.enabled() ? await core.pauseActiveGoal({ notice: s.episodeNotified }) : null;
      if (!s.episodeNotified) {
        s.episodeNotified = true;
        // One persistent notice per episode, for a parked goal and for a goal-less (or user-paused-goal) session
        // alike: a transient status line is overwritten by the next setStatus, so the no-goal text must live in the
        // same widget. A later goal pause replaces it with the goal notice (announceGoalHeld).
        const goalOwned = pausedNow !== null || s.pausedByKeepalive !== null;
        core.setNotice(parkNoticeText(s, now(), goalOwned));
      }
      core.persist();
      await emitTransition(prev);
    },

    async release({ reason = "release" } = {}) {
      const prev = parkView();
      const s = core.state;
      s.parkState = "ok";
      s.armed = false;
      s.latecomer = false;
      s.source = null;
      s.window = null;
      s.util = null;
      s.resetAt = null;
      s.reason = null;
      s.warm = null;
      s.episodeNotified = false;
      s.lastRelease = { at: now(), reason };
      core.setStatus(undefined);
      core.setNotice(undefined);
      core.persist();
      await emitTransition(prev);
    },

    async resetDue() {
      if (vetoed || !core.isParked()) return core.state.decision;
      const epoch = core.sessionEpoch;
      const decision = await core.poll({ force: true, anySource: true, releaseReason: "reset" });
      if (epoch !== core.sessionEpoch) return core.state.decision;
      if (decision?.state !== "park-wait" && decision?.state !== "park-exit" && core.isParked()) {
        await core.release({ reason: "reset" });
        await core.releaseOwnedGoal({ reason: "reset" });
      }
      return decision;
    },

    async poll({ force = false, anySource = false, releaseReason = "usage-ok" } = {}) {
      const t = now();
      if (!force && lastPollAt !== null && t >= lastPollAt && t - lastPollAt < config.pollMinIntervalMs) return core.state.decision;
      lastPollAt = t;
      const epoch = core.sessionEpoch;
      const decision = await measure(t);
      // The session was reset while the usage read was in flight: that reading belongs to the old session and
      // must not park, release, arm a timer or touch the state of the next one (or of none).
      if (epoch !== core.sessionEpoch) return core.state.decision;
      core.state.decision = decision;
      core.state.lastPollAt = t;
      core.state.usageHistory = appendUsageHistory(core.state.usageHistory, core.state.snapshots, t);
      expireResumeHold();
      core.persist();
      const hold = core.state.resumeHold;
      // /keepalive resume holds the SAME window until its resetAt; any over window outside the held set, or an already parked session, is not held.
      const over = hold ? overWindows({ snapshots: core.state.snapshots, config }) : null;
      const held = Boolean(hold) && !core.isParked() && over.size > 0 && [...over.keys()].every((kind) => kind in hold.windows);
      if (!held && (decision.state === "park-wait" || decision.state === "park-exit")) {
        await core.park(decision, { source: "poll" });
      } else if (decision.state === "ok" && (core.isParked() ? (anySource || core.state.source === "poll") : staleOwnedGoal)) {
        if (core.isParked()) await core.release({ reason: releaseReason });
        staleOwnedGoal = false;
        await core.releaseOwnedGoal({ reason: releaseReason });
      }
      return decision;
    },

    // ── senpi event handlers (wired by keepalive.mjs) ──
    async handleSessionStart(event, ctx) {
      if (vetoed) return;
      core.lastCtx = ctx;
      const loaded = loadSession(ctx);
      for (const fn of beforeStartFns) {
        let verdict;
        try { verdict = await fn(event, ctx); } catch (error) { core.state.lastError = { at: now(), where: "before-session-start", message: errText(error) }; }
        if (verdict?.veto === true) {
          vetoed = true;
          for (const name of [...timerHandles.keys()]) core.timers.clear(name);
          return;
        }
      }
      if (loaded) applySession();
      if (!configWatcher) openConfigWatcher();
      await boundary(ctx, "session_start");
      core.refreshStatus();
    },
    handleSessionShutdown() {
      if (vetoed || core.sessionId === null) return;
      closeConfigWatcher();
      resetSession();
      core.sessionId = null;
    },
    async handleTurnEnd(event, ctx) {
      if (vetoed) return;
      core.lastCtx = ctx;
      startSession(ctx);
      core.state.hadPriorTurns = true;
      await boundary(ctx, "turn_end");
    },
    async handleAgentSettled(event, ctx) {
      if (vetoed) return;
      core.lastCtx = ctx;
      core.turn = null;
      goalRun = false;
      userRun = false;
      startSession(ctx);
      await boundary(ctx, "agent_settled");
      if (pendingKick) {
        pendingKick = false;
        if (!core.isParked()) await pi.events?.emit?.("goal_store_changed", { threadId: core.sessionId });
      }
    },
    // senpi emits agent_start (not before_agent_start) for automatic continuations: a run that starts owns the restart.
    handleAgentStart() {
      if (vetoed) return;
      pendingKick = false;
    },
    // agent_end.willRetry (senpi agent-abort-provenance.js:50-54, set at agent-session.js:2054/2068): the run is retried
    // through agent.continue() after a provider error, with no new message_start / before_agent_start, so the mark
    // must survive until the final agent_end (or agent_settled / the next before_agent_start / a session reset).
    async handleAgentEnd(event, ctx) {
      if (vetoed) return;
      core.lastCtx = ctx;
      if (event?.willRetry === true) return;
      core.turn = null;
      goalRun = false;
      userRun = false;
    },
    async handleBeforeAgentStart(event, ctx) {
      if (event?.preview === true || vetoed) return undefined;
      core.turn = null;
      pendingKick = false;
      core.lastCtx = ctx;
      startSession(ctx);
      const continuation = event?.trigger === "extension" && typeof event.prompt === "string"
        && event.prompt.startsWith(GOAL_CONTINUATION_PREFIX);
      // trigger "extension" (triggerTurn custom message) and "delivery" (another session's message, agent-session.js:4294)
      // are not user prompts; every "prompt" trigger run is user-started (typed input and pi.sendUserMessage prompts
      // such as /loop ticks, Stop-hook follow-ups and ask-user answers alike).
      goalRun = event?.trigger !== "prompt";
      userRun = !goalRun;
      if (!core.enabled() || !core.isParked()) return undefined;
      if (!(await raceBlock(ctx, continuation))) return undefined;
      return { message: { customType: "keepalive-park-note", content: TEXTS.raceNote, display: false } };
    },
    // senpi emits no before_agent_start for a run started from the followUp queue (agent-session.js
    // _scheduleContinuationAfterCurrentEvent :6733; before_agent_start only at :3790 for a prompt and :4293 for an idle
    // sendMessage), and agent_start carries no payload. Such a run starts with a custom message (goal-continuation,
    // senpi.todo-owed, an extension notification, ...) that senpi announces with message_start before the run's first
    // tool call: any custom message in a run the user did not start marks it (a user-role message: IS-6, never blocked).
    async handleMessageStart(event, ctx) {
      if (vetoed) return;
      if (event?.message?.role === "user") {
        // IS-6: a user message delivered into a running wait turn (steer / followUp into the same run: no
        // before_agent_start) ends the goal-run and wait-turn treatment; only task/task_create stay blocked for it.
        goalRun = false;
        userRun = true;
        if (core.turn?.kind === "goal-race" || core.turn?.kind === "warm") core.turn = null;
      }
      if (event?.message?.role !== "custom" || userRun) return;
      goalRun = true; // a park landing later in this run blocks its remaining tool calls (handleToolCall)
      core.lastCtx = ctx;
      startSession(ctx);
      if (!core.enabled() || !core.isParked() || core.blockAllToolsInTurn()) return;
      await raceBlock(ctx, true);
    },
    async handleToolCall(event, ctx) {
      if (vetoed) return undefined;
      core.lastCtx = ctx;
      // A goal-driven run that is still looping when a park lands stops here: no autonomous goal work after the park,
      // but only while keepalive holds the goal paused (IS-1: a session without such a goal is never gated).
      if (core.blockAllToolsInTurn() || (goalRun && core.enabled() && core.isParked() && core.ownedGoalId() !== null)) {
        const reason = core.isParked() ? `${core.blockReason()} - tools are disabled in this wait turn` : "keepalive: tools are disabled in this wait turn";
        return { block: true, reason };
      }
      if (!SPAWN_TOOLS.has(event?.toolName) || !core.enabled() || !core.isParked()) return undefined;
      if (!(await gated(ctx))) return undefined;
      core.state.blocked = (core.state.blocked ?? 0) + 1;
      core.persist();
      return { block: true, reason: core.blockReason() };
    },
    async handleGoalStoreChanged(data) {
      if (vetoed || !data || data.threadId !== core.sessionId) return;
      if (core.enabled() && core.isParked()) await core.pauseActiveGoal({ notice: true });
    },
  };

  // Pauses an active goal while parked and, for a goal continuation turn, marks the run so every tool_call is blocked
  // (until agent_end). Returns true when the run was marked.
  async function raceBlock(ctx, continuation) {
    const goal = await core.readGoal(ctx);
    if (goal?.status === "active") await core.pauseActiveGoal({ notice: true });
    else if (continuation && !(goal?.status === "paused" && goal.id === core.state.pausedByKeepalive)) return false;
    if (!continuation) return false;
    core.markExtensionTurn("goal-race");
    return true;
  }

  function parkView() {
    const { parkState, resetAt, window, source, reason } = core.state;
    const w = core.state.warm;
    const warm = w ? { on: w.on === true, intervalMs: w.intervalMs ?? null, requireTtlSeconds: w.requireTtlSeconds ?? null } : null;
    return { parkState, resetAt, window, source, reason, warm };
  }

  async function emitTransition(prev) {
    const next = parkView();
    // A source change (reactive -> poll with the same park-wait/null) is a transition too: the new owner of
    // the park (resume.mjs for non-reactive sources) must arm its re-check.
    if (prev.parkState === next.parkState && prev.resetAt === next.resetAt && prev.source === next.source) return;
    for (const fn of transitionFns) {
      try { await fn(prev, next); } catch (error) { core.recordError("transition", error); }
    }
  }

  async function runControl(ctx, kind) {
    if (!controlReader) return;
    try { await controlReader(ctx, kind); } catch (error) { core.recordError("control", error); }
  }

  async function notifyConfigApplied() {
    for (const fn of configAppliedFns) {
      try { await fn(); } catch (error) { core.recordError("config-applied", error); }
    }
  }

  function openConfigWatcher() {
    try {
      configWatcher = (deps.watch ?? nodeFs.watch)(dirname(settingsPath), (_event, filename) => {
        if (filename != null && String(filename) !== basename(settingsPath)) return;
        core.timers.set("config-reload", 0, async (_ctx, stale) => {
          if (!stale()) await core.applyConfigChange();
        });
      });
      configWatcher.unref?.();
    } catch (error) { core.recordError("config-watch", error); }
  }

  function closeConfigWatcher() {
    configWatcher?.close?.();
    configWatcher = null;
  }

  // IS-1: while parked, a session with an active goal never spawns. The block does not depend on the pause landing
  // (a failed pause still blocks) nor on the goal being readable (a keepalive-owned pause is remembered in state).
  async function gated(ctx) {
    let goal = null;
    try {
      goal = (await goalStore.read(ctx)) ?? null;
    } catch (error) {
      core.recordError("goal-read", error);
      return core.state.pausedByKeepalive !== null;
    }
    if (goal?.status === "paused" && goal.id === core.state.pausedByKeepalive) return true;
    if (goal?.status !== "active") return false;
    await core.pauseActiveGoal({ notice: true });
    return true;
  }

  function expireResumeHold() {
    // resumeHold = {windows: {kind: resetAt}}: each held window expires at its own resetAt; an empty set is no hold.
    const hold = core.state.resumeHold;
    if (!hold) return;
    const live = Object.fromEntries(Object.entries(hold.windows ?? {}).filter(([, resetAt]) => Number.isFinite(resetAt) && resetAt > now()));
    core.state.resumeHold = Object.keys(live).length > 0 ? { windows: live } : null;
  }

  function startSession(ctx) {
    if (loadSession(ctx)) applySession();
  }

  // Loads the session's state into memory only (no file write, no UI). Returns true for a newly seen session.
  function loadSession(ctx) {
    const sid = ctx?.sessionManager?.getSessionId?.();
    if (typeof sid !== "string" || sid === core.sessionId) return false;
    if (core.sessionId !== null) resetSession(); // /new or /resume inside one process
    core.sessionId = sid;
    lastPollAt = null;
    const loaded = loadState({ homeDir, sessionId: sid, fs });
    core.startState = loaded ? Object.freeze(structuredClone(loaded)) : null;
    core.state = { ...freshState(), ...(loaded ?? {}), v: 1 };
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    if (Array.isArray(branch) && branch.some((e) => e?.type === "message" && e.message?.role === "assistant")) {
      core.state.hadPriorTurns = true;
    }
    expireResumeHold();
    if (PARKED.has(core.state.parkState) && core.state.armed) {
      if (!(Number.isFinite(core.state.resetAt) && core.state.resetAt > now())) {
        // A park whose reset already passed is not re-applied; only a fresh decision can park again.
        Object.assign(core.state, { parkState: "ok", armed: false, latecomer: false, source: null, window: null,
          util: null, resetAt: null, reason: null, warm: null, episodeNotified: false });
        staleOwnedGoal = core.state.pausedByKeepalive !== null;
      }
    }
    return true;
  }

  // Tears down everything owned by the current session: feature closures first (core.state is still the
  // old session's, so a feature may persist), then every timer and the core's own per-session state.
  function resetSession() {
    core.sessionEpoch += 1;
    core.setNotice(undefined);
    for (const fn of resetFns) {
      try { fn(); } catch (error) { core.state.lastError = { at: now(), where: "session-reset", message: errText(error) }; }
    }
    for (const name of [...timerHandles.keys()]) core.timers.clear(name);
    closeConfigWatcher();
    holding = null;
    holdingNotice = false;
    pendingKick = false;
    staleOwnedGoal = false;
    lastPollAt = null;
    core.turn = null;
    goalRun = false;
    userRun = false;
  }

  function applySession() {
    if (core.isParked()) {
      core.setStatus(statusText(core.state.resetAt, now())); // restart mid-park: the park survives
      core.setNotice(parkNoticeText(core.state, now(), core.state.pausedByKeepalive !== null));
    } else {
      core.setStatus(undefined);
      core.setNotice(undefined);
    }
    core.persist();
  }

  async function boundary(ctx, kind) {
    await runControl(ctx, kind);
    const reload = core.reloadConfig();
    if (core.enabled()) {
      const decision = await core.poll({ force: reload.changed });
      if (staleOwnedGoal && decision?.state === "unknown" && !core.isParked()) {
        staleOwnedGoal = false;
        await core.releaseOwnedGoal({ reason: "stale-park" });
      }
      if (core.isParked()) await core.pauseActiveGoal({ notice: true });
    }
    for (const fn of boundaryFns) {
      try { await fn(ctx, kind); } catch (error) { core.recordError(`boundary:${kind}`, error); }
    }
    if (reload.changed) await notifyConfigApplied();
  }

  async function snapshotFor(provider, account, t) {
    // Test-only fake usage source: never read nor write the shared per-account snapshot.
    const fakeMode = Boolean(env?.OMO_KEEPALIVE_FAKE_USAGE_FILE);
    const shared = fakeMode ? null : readSharedSnapshot({ homeDir, provider, account, fs });
    // A shared snapshot whose window already reset is stale whatever its age: read the endpoint instead.
    const pastReset = (shared?.snapshot?.windows ?? []).some((w) => Number.isFinite(w?.resetAt) && w.resetAt <= t);
    if (shared && !pastReset && t >= shared.observedAt && t - shared.observedAt < config.pollMinIntervalMs) return shared.snapshot;
    const snapshot = await readUsage({ provider, account }, { env, homeDir, now, pollMinIntervalMs: config.pollMinIntervalMs });
    if (snapshot && snapshot.source !== "none" && snapshot.source !== "fake" && !fakeMode) writeSharedSnapshot({ homeDir, snapshot, observedAt: t, fs });
    return snapshot;
  }

  async function measure(t) {
    const epoch = core.sessionEpoch;
    const ctx = core.lastCtx;
    let lane;
    try {
      lane = resolveLane({
        model: ctx?.model,
        branch: ctx?.sessionManager?.getBranch?.() ?? [],
        authJson: readAuthJson({ env, homeDir, fs }),
      });
    } catch (error) {
      core.state.lastError = { at: t, where: "lane", message: errText(error) };
      return { state: "unknown", reason: "lane unavailable" };
    }
    core.lane = lane;
    if (!SUBSCRIPTION.has(lane.provider) || lane.accounts.length === 0) {
      return { state: "ok", reason: `lane ${lane.provider} without subscription accounts` };
    }
    const snapshots = [];
    for (const account of lane.accounts) {
      try {
        snapshots.push(await snapshotFor(lane.provider, account, t));
      } catch (error) {
        if (epoch !== core.sessionEpoch) return { state: "unknown", reason: "session reset" };
        core.state.lastError = { at: t, where: "usage", message: errText(error) };
        return { state: "unknown", reason: "usage reader failed" };
      }
    }
    if (epoch !== core.sessionEpoch) return { state: "unknown", reason: "session reset" };
    const fakeReset = Number(env.OMO_KEEPALIVE_FAKE_RESET_IN_MS);
    const usable = snapshots.map((s) => env.OMO_KEEPALIVE_FAKE_RESET_IN_MS && Number.isFinite(fakeReset)
      ? { ...s, windows: (s?.windows ?? []).map((w) => ({ ...w, resetAt: t + fakeReset })) }
      : s);
    core.state.snapshots = usable;
    const missing = usable.find((s) => !s || s.source === "none" || !Array.isArray(s.windows));
    if (missing) {
      core.state.lastError = { at: t, where: "usage", message: missing?.error ?? "usage unavailable" };
      return { state: "unknown", reason: "usage unavailable" };
    }
    core.state.lastError = null;
    const decision = decide({ snapshots: usable, config, now: t });
    if ((decision.state === "park-wait" || decision.state === "park-exit")
      && !(Number.isFinite(decision.resetAt) && decision.resetAt > t)) {
      // Over threshold but the reset is unknown or already past (stale reader): never park-exit on that, and
      // never warm. Park without a deadline; resume.mjs arms a re-check that forces a fresh poll.
      return { ...decision, state: "park-wait", resetAt: null, warm: { ...(decision.warm ?? {}), on: false },
        util: utilFrom(decision.reason) };
    }
    return { ...decision, util: utilFrom(decision.reason) };
  }

  pi.on?.("session_shutdown", () => core.handleSessionShutdown());
  return core;
}

function utilFrom(reason) {
  const match = /(\d+(?:\.\d+)?)%/.exec(String(reason ?? ""));
  return match ? Number(match[1]) : null;
}
