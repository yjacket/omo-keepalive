// limitless core (plan todo 5): park gate + the shared API every Wave-2 feature module plugs into.
//
// limitless.mjs creates the core, wires senpi events to the core's `handle*` methods, then calls
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
//     pausedByLimitless (goal id limitless paused, or null), blocked (count), mode ("on"|"off")
//     lastError {at, where, message}, lastRelease {at, reason}
//     Features keep their own data under a key named after the feature (state.warm is the policy's warm).
// core.startState                            frozen copy of the state file as loaded at session_start, or null
//                                            (todo 8 reads parkState:"exited" here; the core never writes it)
// core.persist()                             write state to <home>/.omo/limitless/state/<sid>.json (temp+rename)
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
//                                            releaseOwnedGoal when limitless un-paused the goal it owns. No owned
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
// core.ownedGoalId()                         state.pausedByLimitless
// core.pauseActiveGoal({notice})             pause the goal only when it is active; records pausedByLimitless;
//                                            returns the goal id or null. notice=true posts the "goal은 HH:MM ..." notice.
// core.releaseOwnedGoal({reason, text})      un-pause only if the goal is paused and its id === pausedByLimitless,
//                                            then restart work exactly once: idle -> pi.events.emit(
//                                            "goal_store_changed", {threadId}); busy -> pi.sendUserMessage(text,
//                                            {deliverAs:"followUp"}). Returns true when it un-paused. When it
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
// core.onBoundary(fn(ctx, kind))             after the core's own work at kind "session_start"|"turn_end"|"agent_settled"
// core.timers.set(name, ms, fn(ctx)) / clear(name) / has(name)
//                                            one timer per name on the injected clock (deps.setTimeout); every
//                                            tick runs the control hook first, errors land in state.lastError
// core.markExtensionTurn(kind)               mark the current agent run (call from before_agent_start): every
//                                            tool_call in it is blocked; cleared at the next before_agent_start /
//                                            agent_end. core.blockAllToolsInTurn() -> boolean, core.turn -> {kind}
// core.setControlReader(fn(ctx, kind))       control-file hook (todo 9): awaited at the start of every boundary
//                                            and timer tick; it may change state.mode or call release()
// core.now(), core.hhmm(ms)                  injected clock; local HH:MM
// core.setStatus(text|undefined), core.notify(text, level), core.recordError(where, err)
// core.blockReason()                         "limitless: usage limit <window> <util>% - resumes <HH:MM>"
// core.texts                                 {resetResume, manualResume, raceNote, goalHeld(hhmm)}
//
// deps: {env, homeDir, fs (sync node:fs subset), now, setTimeout, clearTimeout, readUsage, goalStore}
//   goalStore: {read(ctx) -> goal|null, setStatus(ctx, status) -> goal}; default loads senpi's goal store.
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decide } from "./policy.mjs";
import { readAuthJson, resolveLane } from "./lane.mjs";
import { readUsage as defaultReadUsage } from "./usage.mjs";
import { loadState, readSharedSnapshot, saveState, writeSharedSnapshot } from "./state.mjs";

export const STATUS_KEY = "limitless";
export const SPAWN_TOOLS = new Set(["task", "task_create"]);
export const GOAL_CONTINUATION_PREFIX = "Continue working toward the active thread goal.";
const SUBSCRIPTION = new Set(["anthropic-subscription", "chatgpt-subscription"]);
const PARKED = new Set(["park-wait", "park-exit"]);
const MAX_TIMER_MS = 2147483647;

export const TEXTS = {
  resetResume: "[limitless] 사용량 한도가 리셋됐다. 중단 전 작업을 이어가라.",
  manualResume: "[limitless] 사용량 한도 대기가 풀렸다. 중단 전 작업을 이어가라.",
  raceNote: "사용량 한도 대기 중. 도구를 쓰지 말고 한 줄로 끝내라",
  goalHeld: (hhmm) => hhmm === null
    ? "goal은 리셋 시각을 아직 몰라 한도가 풀리면 시작합니다. 지금 돌리려면 /limitless resume"
    : `goal은 ${hhmm} 리셋 뒤 시작합니다. 지금 돌리려면 /limitless resume`,
};

const knownTime = (ms) => typeof ms === "number" && Number.isFinite(ms);

// Local HH:MM; "--:--" for an unknown time (null/NaN must never render as a clock, new Date(null) is 1970).
export function hhmm(ms) {
  const d = new Date(ms);
  return knownTime(ms) && Number.isFinite(d.getTime())
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : "--:--";
}

export const statusText = (resetAt) => knownTime(resetAt) ? `⏸ 한도 대기 · ${hhmm(resetAt)} 재개` : "⏸ 한도 대기 · 재개 시각 미정";

const freshState = () => ({
  v: 1, parkState: "ok", armed: false, source: null, window: null, util: null, resetAt: null, reason: null,
  warm: null, decision: null, snapshots: [], lastPollAt: null, episode: 0, parkedAt: null, episodeNotified: false,
  latecomer: false, hadPriorTurns: false, pausedByLimitless: null, blocked: 0, mode: "on", lastError: null,
  lastRelease: null,
});

const errText = (error) => String(error instanceof Error ? error.message : error);

// senpi's goal store, loaded the same way as omo-rollover/extension/rollover.ts:234-257. Never throws on load.
export function createSenpiGoalStore({ env = process.env, argv1 = process.argv[1], fs = nodeFs } = {}) {
  let loading;
  const load = () => loading ??= (async () => {
    try {
      const main = await import("@code-yeongyu/senpi");
      if (typeof main?.readGoal === "function" && typeof main?.updateGoal === "function" && typeof main?.goalStoreRef === "function") {
        return { store: main, ref: main };
      }
    } catch {}
    const fromBin = (bin) => join(dirname(dirname(bin)), "node_modules", "@code-yeongyu", "senpi", "dist");
    const candidates = [...(argv1 ? [dirname(argv1), fromBin(argv1)] : []), ...(env.OMO_BIN ? [fromBin(env.OMO_BIN)] : [])];
    for (const dist of candidates) {
      const goal = join(dist, "core", "extensions", "builtin", "goal");
      if (!fs.existsSync(join(goal, "store.js")) || !fs.existsSync(join(goal, "store-ref.js"))) continue;
      try {
        return {
          store: await import(pathToFileURL(join(goal, "store.js")).href),
          ref: await import(pathToFileURL(join(goal, "store-ref.js")).href),
        };
      } catch {}
    }
    return null;
  })();
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
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeout ?? globalThis.setTimeout;
  const clearT = deps.clearTimeout ?? globalThis.clearTimeout;
  const readUsage = deps.readUsage ?? defaultReadUsage;
  const goalStore = deps.goalStore ?? createSenpiGoalStore({ env });
  const transitionFns = [];
  const boundaryFns = [];
  const beforeStartFns = [];
  let vetoed = false;
  const timerHandles = new Map();
  let controlReader = null;
  let lastPollAt = null;
  let holding = null;
  let staleOwnedGoal = false;

  const core = {
    pi, deps, config, env, homeDir,
    sessionId: null,
    lane: null,
    lastCtx: undefined,
    state: freshState(),
    startState: null,
    turn: null,
    texts: TEXTS,
    now: () => now(),
    hhmm,

    persist() {
      if (core.sessionId === null || vetoed) return false;
      return saveState({ homeDir, sessionId: core.sessionId, state: core.state, fs });
    },
    recordError(where, error) {
      core.state.lastError = { at: now(), where, message: errText(error) };
      core.persist();
    },
    setStatus(text) {
      try { core.lastCtx?.ui?.setStatus?.(STATUS_KEY, text); } catch (error) { core.state.lastError = { at: now(), where: "status", message: errText(error) }; }
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
    ownedGoalId: () => core.state.pausedByLimitless ?? null,
    blockReason() {
      const { window, util, resetAt } = core.state;
      return `limitless: usage limit ${window ?? "unknown"} ${util ?? "?"}% - resumes ${knownTime(resetAt) ? hhmm(resetAt) : "when the reset time is known (not known yet)"}`;
    },

    onTransition(fn) { transitionFns.push(fn); },
    onBoundary(fn) { boundaryFns.push(fn); },
    onBeforeSessionStart(fn) { beforeStartFns.push(fn); },
    isVetoed: () => vetoed,

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
          return (async () => {
            try {
              await runControl(core.lastCtx, `timer:${name}`);
              await fn(core.lastCtx);
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

    async pauseActiveGoal({ notice = false } = {}) {
      // Single flight: concurrent callers (goal_store_changed, before_agent_start, tool_call) share one pause.
      if (holding) return holding;
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
        core.state.pausedByLimitless = goal.id;
        core.persist();
        if (notice) core.notify(TEXTS.goalHeld(knownTime(core.state.resetAt) ? hhmm(core.state.resetAt) : null), "info");
        return goal.id;
      })();
      holding = run.finally(() => { holding = null; });
      return holding;
    },

    async releaseOwnedGoal({ reason = "release", text = TEXTS.manualResume } = {}) {
      const owned = core.state.pausedByLimitless;
      if (!owned) return false;
      const ctx = core.lastCtx;
      const goal = await core.readGoal(ctx);
      core.state.pausedByLimitless = null;
      if (goal?.status !== "paused" || goal.id !== owned) {
        core.persist();
        return false;
      }
      try {
        await goalStore.setStatus(ctx, "active");
      } catch (error) {
        core.state.pausedByLimitless = owned;
        core.recordError("goal-resume", error);
        return false;
      }
      core.state.lastRelease = { at: now(), reason };
      core.persist();
      const idle = ctx?.isIdle?.() === true && ctx?.hasPendingMessages?.() !== true;
      if (idle) await pi.events?.emit?.("goal_store_changed", { threadId: core.sessionId });
      else pi.sendUserMessage(text, { deliverAs: "followUp" });
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
      core.setStatus(statusText(s.resetAt));
      core.persist();
      const pausedNow = core.enabled() ? await core.pauseActiveGoal({ notice: false }) : null;
      if (!s.episodeNotified) {
        s.episodeNotified = true;
        const when = knownTime(s.resetAt) ? `${hhmm(s.resetAt)} 재개.` : "리셋 시각을 아직 몰라 재개 시각 미정.";
        const head = `⏸ 사용량 한도 대기 (${s.window ?? "?"} ${s.util ?? "?"}%) · ${when}`;
        const goalOwned = pausedNow !== null || s.pausedByLimitless !== null;
        core.notify(goalOwned
          ? `${head} goal을 멈췄고 새 서브에이전트는 막힙니다.`
          : `${head} goal이 없어 작업은 그대로 할 수 있습니다.`, "info");
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
      core.persist();
      await emitTransition(prev);
    },

    async resetDue() {
      if (vetoed || !core.isParked()) return core.state.decision;
      const decision = await core.poll({ force: true, anySource: true });
      if (decision?.state !== "park-wait" && decision?.state !== "park-exit" && core.isParked()) {
        await core.release({ reason: "reset" });
        await core.releaseOwnedGoal({ reason: "reset", text: TEXTS.resetResume });
      }
      return decision;
    },

    async poll({ force = false, anySource = false } = {}) {
      const t = now();
      if (!force && lastPollAt !== null && t >= lastPollAt && t - lastPollAt < config.pollMinIntervalMs) return core.state.decision;
      lastPollAt = t;
      const decision = await measure(t);
      core.state.decision = decision;
      core.state.lastPollAt = t;
      core.persist();
      if (decision.state === "park-wait" || decision.state === "park-exit") {
        await core.park(decision, { source: "poll" });
      } else if (decision.state === "ok" && (core.isParked() ? (anySource || core.state.source === "poll") : staleOwnedGoal)) {
        if (core.isParked()) await core.release({ reason: "usage-ok" });
        staleOwnedGoal = false;
        await core.releaseOwnedGoal({ reason: "usage-ok", text: TEXTS.resetResume });
      }
      return decision;
    },

    // ── senpi event handlers (wired by limitless.mjs) ──
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
      await boundary(ctx, "session_start");
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
      startSession(ctx);
      await boundary(ctx, "agent_settled");
    },
    async handleAgentEnd(event, ctx) {
      if (vetoed) return;
      core.lastCtx = ctx;
      core.turn = null;
    },
    async handleBeforeAgentStart(event, ctx) {
      if (event?.preview === true || vetoed) return undefined;
      core.turn = null;
      core.lastCtx = ctx;
      startSession(ctx);
      if (!core.enabled() || !core.isParked()) return undefined;
      const goal = await core.readGoal(ctx);
      const continuation = event?.trigger === "extension" && typeof event.prompt === "string"
        && event.prompt.startsWith(GOAL_CONTINUATION_PREFIX);
      if (goal?.status === "active") await core.pauseActiveGoal({ notice: true });
      else if (continuation && !(goal?.status === "paused" && goal.id === core.state.pausedByLimitless)) return undefined;
      if (!continuation) return undefined;
      core.markExtensionTurn("goal-race");
      return { message: { customType: "limitless-park-note", content: TEXTS.raceNote, display: false } };
    },
    async handleToolCall(event, ctx) {
      if (vetoed) return undefined;
      core.lastCtx = ctx;
      if (core.blockAllToolsInTurn()) {
        const reason = core.isParked() ? `${core.blockReason()} - tools are disabled in this wait turn` : "limitless: tools are disabled in this wait turn";
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

  async function gated(ctx) {
    const goal = await core.readGoal(ctx);
    if (goal?.status === "paused" && goal.id === core.state.pausedByLimitless) return true;
    if (goal?.status !== "active") return false;
    await core.pauseActiveGoal({ notice: true });
    return true;
  }

  function startSession(ctx) {
    if (loadSession(ctx)) applySession();
  }

  // Loads the session's state into memory only (no file write, no UI). Returns true for a newly seen session.
  function loadSession(ctx) {
    const sid = ctx?.sessionManager?.getSessionId?.();
    if (typeof sid !== "string" || sid === core.sessionId) return false;
    core.sessionId = sid;
    lastPollAt = null;
    const loaded = loadState({ homeDir, sessionId: sid, fs });
    core.startState = loaded ? Object.freeze(structuredClone(loaded)) : null;
    core.state = { ...freshState(), ...(loaded ?? {}), v: 1 };
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    if (Array.isArray(branch) && branch.some((e) => e?.type === "message" && e.message?.role === "assistant")) {
      core.state.hadPriorTurns = true;
    }
    if (PARKED.has(core.state.parkState) && core.state.armed) {
      if (!(Number.isFinite(core.state.resetAt) && core.state.resetAt > now())) {
        // A park whose reset already passed is not re-applied; only a fresh decision can park again.
        Object.assign(core.state, { parkState: "ok", armed: false, latecomer: false, source: null, window: null,
          util: null, resetAt: null, reason: null, warm: null, episodeNotified: false });
        staleOwnedGoal = core.state.pausedByLimitless !== null;
      }
    }
    return true;
  }

  function applySession() {
    if (core.isParked()) core.setStatus(statusText(core.state.resetAt)); // restart mid-park: the park survives
    core.persist();
  }

  async function boundary(ctx, kind) {
    await runControl(ctx, kind);
    if (core.enabled()) {
      const decision = await core.poll();
      if (staleOwnedGoal && decision?.state === "unknown" && !core.isParked()) {
        staleOwnedGoal = false;
        await core.releaseOwnedGoal({ reason: "stale-park", text: TEXTS.resetResume });
      }
      if (core.isParked()) await core.pauseActiveGoal({ notice: true });
    }
    for (const fn of boundaryFns) {
      try { await fn(ctx, kind); } catch (error) { core.recordError(`boundary:${kind}`, error); }
    }
  }

  async function snapshotFor(provider, account, t) {
    const shared = readSharedSnapshot({ homeDir, provider, account, fs });
    // A shared snapshot whose window already reset is stale whatever its age: read the endpoint instead.
    const pastReset = (shared?.snapshot?.windows ?? []).some((w) => Number.isFinite(w?.resetAt) && w.resetAt <= t);
    if (shared && !pastReset && t >= shared.observedAt && t - shared.observedAt < config.pollMinIntervalMs) return shared.snapshot;
    const snapshot = await readUsage({ provider, account }, { env, homeDir, now, pollMinIntervalMs: config.pollMinIntervalMs });
    if (snapshot && snapshot.source !== "none") writeSharedSnapshot({ homeDir, snapshot, observedAt: t, fs });
    return snapshot;
  }

  async function measure(t) {
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
        core.state.lastError = { at: t, where: "usage", message: errText(error) };
        return { state: "unknown", reason: "usage reader failed" };
      }
    }
    const fakeReset = Number(env.OMO_LIMITLESS_FAKE_RESET_IN_MS);
    const usable = snapshots.map((s) => env.OMO_LIMITLESS_FAKE_RESET_IN_MS && Number.isFinite(fakeReset)
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

  return core;
}

function utilFrom(reason) {
  const match = /(\d+(?:\.\d+)?)%/.exec(String(reason ?? ""));
  return match ? Number(match[1]) : null;
}
