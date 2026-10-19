// keepalive feature module: hold senpi's goal backstop while a goal wait is kept warm and omo-health can watch it.
//
// senpi parks a goal that waits on background work (a monitor timer, "goal_continuation_timer_state" armed, kind
// "monitor") and fires its own backstop when that timer runs out. While keepwarm is warming exactly that wait AND
// omo-health is ready to wake the session if the wait leaks, this module publishes
// continuation_hold_state {source: "omo-keepalive", active: true} so senpi parks its timer. Any condition lost
// releases the hold on the next event (or within RECHECK_MS).
//
// Bus channels consumed (shapes are senpi's, never redefined here):
//   goal_continuation_timer_state {armed, kind}   goal_continuation_resumed {wakeCause}
//   wake_source_state {source, activeCount}       terminal_monitor_state {activeCount} (source "terminal-monitors")
//   continuation_hold_state {source, active}
// Self-check: senpi emits armed:false BEFORE goal_continuation_resumed. A hold that was active at the disarm and is
// followed by a resumed with wakeCause "timer" means senpi fired its backstop anyway: the hold is not honoured, so
// it is released for good and the panel says so (core.backstop.status().tripped).
//
// Health ready = fresh daemon + capability "goal-liveness" + daemon.json goalLiveness.wakeReady + this session in
// goalLiveness.actionScope (null/empty = every session) + a fresh sensor heartbeat that writes goalLivenessSchema 1.
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { createConfigSource } from "./keepwarm/config.mjs";
import { daemonFresh } from "./park-exit.mjs";
import { readJson, sanitizeId } from "./state.mjs";

export const HOLD_SOURCE = "omo-keepalive";
export const GOAL_LIVENESS_CAPABILITY = "goal-liveness";
export const SENSOR_STALE_MS = 45_000; // omo-health/extension/sensor.mjs heartbeat staleness, same as DAEMON_STALE_MS
export const RECHECK_MS = 10_000;
const TIMER = "backstop-recheck";
const ASK_USER = "ask-user";
const TERMINAL_MONITORS = "terminal-monitors";

export function install(core) {
  const fs = core.deps.fs ?? nodeFs;
  const env = core.env;
  const config = createConfigSource({ home: env.OMO_KEEPWARM_HOME || join(core.homeDir, ".omo-keepwarm"), now: core.now });
  const wake = new Map(); // source -> live count
  let armedMonitor = false;
  let goalWait = false; // last value handed to controller.setGoalWait
  let holding = false;
  let tripped = false;
  let heldAtDisarm = false;

  const healthHome = () => env.OMO_HEALTH_HOME || join(core.homeDir, ".omo-health");

  function healthReady() {
    const sid = core.sessionId;
    if (typeof sid !== "string" || sid.length === 0) return false;
    const now = core.now();
    if (!daemonFresh({ env, homeDir: core.homeDir, now, fs })) return false;
    const daemon = readJson(join(healthHome(), "daemon.json"), fs);
    if (!Array.isArray(daemon?.capabilities) || !daemon.capabilities.includes(GOAL_LIVENESS_CAPABILITY)) return false;
    if (daemon.goalLiveness?.wakeReady !== true) return false;
    const scope = daemon.goalLiveness.actionScope;
    if (scope !== null && scope !== undefined) {
      if (!Array.isArray(scope)) return false;
      if (scope.length > 0 && !scope.includes(sid)) return false;
    }
    const sensor = readJson(join(healthHome(), "sensors", `${sanitizeId(sid)}.json`), fs);
    return Number.isFinite(sensor?.ts) && now - sensor.ts <= SENSOR_STALE_MS && sensor.goalLivenessSchema === 1;
  }

  function emitHold(active) {
    const sent = core.pi.events?.emit?.("continuation_hold_state", { source: HOLD_SOURCE, active });
    if (sent && typeof sent.catch === "function") sent.catch((error) => core.recordError("backstop-emit", error));
  }

  function setHolding(next) {
    if (next === holding) return;
    holding = next;
    emitHold(next);
  }

  function setGoalWait(next, kw) {
    if (next === goalWait) return;
    goalWait = next;
    if (kw) kw.controller.setGoalWait(next);
  }

  function evaluate() {
    try {
      const kw = core.keepwarm;
      const usable = Boolean(kw?.controller) && kw.isInert?.() !== true;
      const enabled = core.enabled() && !core.isVetoed();
      let total = 0;
      for (const count of wake.values()) total += count;
      const signal = enabled && usable && armedMonitor && total > 0 && !((wake.get(ASK_USER) ?? 0) > 0);
      setGoalWait(signal, usable ? kw : null);
      setHolding(signal && !tripped && kw.controller.snapshot()?.goalWait?.warm === true
        && config.get().backstop !== "off" && healthReady());
    } catch (error) {
      setHolding(false);
      core.recordError("backstop", error);
    }
    if (armedMonitor && !core.isVetoed()) {
      if (!core.timers.has(TIMER)) core.timers.set(TIMER, RECHECK_MS, () => evaluate());
    } else core.timers.clear(TIMER);
  }

  const count = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);
  const on = (name, handler) => core.pi.events?.on?.(name, (data) => {
    try { handler(data ?? {}); } catch (error) { core.recordError("backstop", error); }
    return undefined;
  });

  on("goal_continuation_timer_state", (data) => {
    const monitor = data.armed === true && data.kind === "monitor";
    if (data.armed === false && armedMonitor) heldAtDisarm = holding;
    if (monitor && !armedMonitor) heldAtDisarm = false;
    armedMonitor = monitor;
    evaluate();
  });
  on("goal_continuation_resumed", (data) => {
    const fired = heldAtDisarm && data.wakeCause === "timer";
    heldAtDisarm = false;
    if (fired) {
      tripped = true;
      core.recordError("backstop-hold", new Error("senpi fired its backstop while held"));
    }
    evaluate();
  });
  on("wake_source_state", (data) => {
    if (typeof data.source === "string" && data.source.length > 0) wake.set(data.source, count(data.activeCount));
    evaluate();
  });
  on("terminal_monitor_state", (data) => {
    wake.set(TERMINAL_MONITORS, count(data.activeCount));
    evaluate();
  });
  on("continuation_hold_state", (data) => {
    if (data.source !== HOLD_SOURCE) evaluate();
  });

  // Session shutdown, /new, /resume: release, stop asking keepwarm for goal-wait warming, forget the old session.
  core.onSessionReset(() => {
    const kw = core.keepwarm;
    armedMonitor = false;
    wake.clear();
    heldAtDisarm = false;
    // tripped stays: a senpi that ignored the hold once is not trusted again in this process.
    try {
      setHolding(false);
      const usable = Boolean(kw?.controller) && kw.isInert?.() !== true;
      setGoalWait(false, usable ? kw : null);
    } catch (error) { core.recordError("backstop", error); }
    core.timers.clear(TIMER);
  });

  core.backstop = { status: () => ({ holding, tripped }) };
}
