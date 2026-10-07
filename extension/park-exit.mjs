// limitless feature module: plan todo 8 "Park-exit with omo-health park record and resume on relaunch".
//
// Exit path (policy says park-exit):
//   children drained (wake_source_state, unknown != zero) + idle + relauncher confirmed
//   (fresh omo-health daemon for herdr/orca, or a registered self-launch task for unknown terminals)
//   -> write <parksDir>/<sid>.<createdAt>.park.json (REPORT 9 D7) -> state parkState "exited"
//   -> goal limitless paused set back to active -> ctx.shutdown().
//   Any missing condition holds the session in park-wait without warming; todo 7 resumes it at reset.
// Relaunch path (session_start with own state parkState "exited"):
//   exclusive start claim <parksDir>/<sid>.<parkId>.start ({pid}); a live foreign claim -> write nothing,
//   ctx.shutdown(). Otherwise write the ack file, count re-parks, kick a cap-suppressed goal.
//
// deps used (all optional): pid, isPidAlive(pid), selfLaunch {register({sessionId,cwd,at,parkId}) ->
// {ok, selfTask?, reason?}, unregister({sessionId, selfTask})}. Defaults to ./selflaunch.mjs (todo 14); a register
// that throws or returns ok:false keeps an unknown terminal in park-wait.
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { createSenpiGoalStore } from "./core.mjs";
import { selfLaunch as realSelfLaunch } from "./selflaunch.mjs";
import { readJson, sanitizeId, writeJsonAtomic } from "./state.mjs";

export const DAEMON_STALE_MS = 45_000; // omo-health/extension/sensor.mjs:23,310
export const RELAUNCH_REPARK_LIMIT = 3;
const GOAL_CONTINUATION_CAP = 8; // senpi goal/index.js:140-148
const CHILD_WAKE_SOURCES = new Set(["senpi-task", "omo-dag"]); // omo-rollover/extension/rollover.ts:27
const SPAWN_TOOLS = new Set(["task", "task_create"]);
const TIMER = "park-exit";

export const parksDir = (env, homeDir) => join(env.OMO_HEALTH_HOME || join(homeDir, ".omo-health"), "parks");
export const recordName = (sid, createdAt) => `${sanitizeId(sid)}.${createdAt}.park.json`;
export const ackName = (sid, createdAt) => `${sanitizeId(sid)}.${createdAt}.ack.json`;
export const startName = (sid, parkId) => `${sanitizeId(sid)}.${sanitizeId(parkId)}.start`;

export function detectTerminal(env) {
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
    return { kind: "herdr", herdr: { pane: env.HERDR_PANE_ID, workspaceId: env.HERDR_WORKSPACE_ID ?? null, tabId: env.HERDR_TAB_ID ?? null } };
  }
  if (env.ORCA_WORKTREE_ID || env.ORCA_TERMINAL_HANDLE) {
    return { kind: "orca", orca: { worktree: env.ORCA_WORKTREE_ID ?? null, terminal: env.ORCA_TERMINAL_HANDLE ?? null } };
  }
  return { kind: "unknown" };
}

export function daemonFresh({ env, homeDir, now, fs = nodeFs }) {
  const healthHome = env.OMO_HEALTH_HOME || join(homeDir, ".omo-health");
  if (fs.existsSync(join(healthHome, "stopped"))) return false;
  const daemon = readJson(join(healthHome, "daemon.json"), fs);
  return Boolean(daemon) && Number.isFinite(daemon.ts) && now - daemon.ts <= DAEMON_STALE_MS && !daemon.stoppedMs;
}

function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

const spawnCallsIn = (branch) => (Array.isArray(branch) ? branch : []).some((entry) =>
  entry?.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)
  && entry.message.content.some((part) => part?.type === "toolCall" && SPAWN_TOOLS.has(part.name)));

function trailingContinuations(branch) {
  let count = 0;
  const entries = Array.isArray(branch) ? branch : [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") break;
    if (entry?.type === "custom_message" && entry.customType === "goal-continuation") count += 1;
  }
  return count;
}

export function install(core) {
  const fs = core.deps.fs ?? nodeFs;
  const env = core.env;
  const pid = core.deps.pid ?? process.pid;
  const isPidAlive = core.deps.isPidAlive ?? defaultPidAlive;
  const goalStore = core.deps.goalStore ?? createSenpiGoalStore({ env });
  const selfLaunch = core.deps.selfLaunch ?? realSelfLaunch;
  const wake = new Map();
  let spawnSeen = false;
  let busy = null;
  let exited = null; // fields re-asserted if anything touches the state after shutdown
  let ownClaim = null;

  const dir = () => parksDir(env, core.homeDir);
  const my = () => {
    if (!core.state.parkExit) core.state.parkExit = {};
    return core.state.parkExit;
  };

  // null = unknown. A session that never issued a spawn call cannot have children, so no report means zero.
  const childCount = (ctx) => {
    let seen = false;
    let sum = 0;
    for (const source of CHILD_WAKE_SOURCES) if (wake.has(source)) { seen = true; sum += wake.get(source); }
    if (seen) return sum;
    return spawnSeen || spawnCallsIn(ctx?.sessionManager?.getBranch?.()) ? null : 0;
  };

  const wantsExit = () => core.enabled() && core.isParked() && (core.state.parkState === "park-exit"
    || (my().held && core.state.decision?.state === "park-exit"));

  // Stay parked in park-wait without warming; todo 7 resumes at reset.
  async function hold(reason) {
    const s = core.state;
    my().held = true;
    my().holdReason = reason;
    if (s.parkState === "park-exit") {
      await core.park({ state: "park-wait", window: s.window, resetAt: s.resetAt, reason: s.reason, util: s.util,
        warm: { ...(s.warm ?? {}), on: false } }, { source: s.source ?? "poll" });
    }
    core.persist();
  }

  async function attempt(ctx = core.lastCtx) {
    if (exited || busy || !wantsExit()) return;
    busy = (async () => {
      if (core.isLatecomer()) return undefined; // core contract: canParkExit() is false, the state stays as the core set it
      const children = childCount(ctx);
      if (children === null) return hold("children-unknown");
      if (children !== 0) return hold("children-running");
      if (ctx?.isIdle?.() !== true) return hold("busy");
      const sid = core.sessionId;
      const cwd = String(ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd());
      let terminal = detectTerminal(env);
      let selfTask = null;
      if (terminal.kind === "unknown") {
        const at = (core.state.resetAt ?? core.now()) + core.config.resumeGraceMs;
        let registered = null;
        try {
          registered = (await selfLaunch.register({ sessionId: sid, cwd, at })) ?? null;
        } catch (error) {
          core.recordError("park-exit-selflaunch", error);
        }
        if (registered?.ok !== true) return hold("no-relauncher");
        selfTask = registered.selfTask ?? null;
        terminal = { kind: "self" };
      } else if (!daemonFresh({ env, homeDir: core.homeDir, now: core.now(), fs })) {
        return hold("health-daemon-not-fresh");
      }

      const owned = core.ownedGoalId();
      const goal = owned ? await core.readGoal(ctx) : null;
      let createdAt = core.now();
      while (fs.existsSync(join(dir(), recordName(sid, createdAt)))) createdAt += 1;
      const parkId = `${sid}-${createdAt}`;
      const record = {
        v: 1, parkId, sessionId: sid, cwd, terminal,
        provider: core.lane?.provider ?? null, account: core.lane?.accounts?.[0] ?? "default",
        window: core.state.window, resetAt: core.state.resetAt, reason: "usage-limit",
        goal: owned ? { id: owned, pausedByLimitless: true } : null,
        status: "pending", createdAt, claim: null, result: null,
        ...(selfTask ? { selfTask } : {}),
        ...(env.OMO_LIMITLESS_QA_COMMAND_PREFIX ? { qaCommandPrefix: env.OMO_LIMITLESS_QA_COMMAND_PREFIX } : {}),
      };
      if (!writeJsonAtomic(join(dir(), recordName(sid, createdAt)), record, fs)) {
        if (selfTask) { try { await selfLaunch.unregister({ sessionId: sid, selfTask }); } catch {} }
        core.recordError("park-exit-record", new Error("park record write failed"));
        return hold("record-write-failed");
      }

      // Not parked any more from the core's view, so nothing re-pauses the goal we re-activate below.
      exited = { parkState: "exited", armed: false, pausedByLimitless: null };
      Object.assign(core.state, exited);
      Object.assign(my(), { held: false, holdReason: null, parkId, createdAt, terminalKind: terminal.kind,
        selfTask, goalId: owned ?? null, exitedAt: core.now() });
      core.timers.clear(TIMER);
      core.persist();
      if (goal?.status === "paused" && goal.id === owned) {
        try { await goalStore.setStatus(ctx, "active"); } catch (error) { core.recordError("park-exit-goal", error); }
      }
      ctx.shutdown();
    })().finally(() => { busy = null; });
    return busy;
  }

  function takeClaim(path) {
    for (let round = 0; round < 2; round++) {
      try {
        const fd = fs.openSync(path, "wx");
        try { fs.writeSync(fd, JSON.stringify({ pid })); } finally { fs.closeSync(fd); }
        return true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const holder = readJson(path, fs);
      if (Number.isInteger(holder?.pid) && holder.pid !== pid && isPidAlive(holder.pid)) return false;
      try { fs.unlinkSync(path); } catch {}
    }
    return false;
  }

  function liveForeignClaim(path) {
    const holder = readJson(path, fs);
    return Number.isInteger(holder?.pid) && holder.pid !== pid && isPidAlive(holder.pid);
  }

  // Start claim, run by the core BEFORE it persists, polls, parks or pauses anything (core.onBeforeSessionStart).
  // A losing duplicate vetoes: the core writes nothing for the rest of this process, and we shut down.
  let relaunchFrom = null; // prior parkExit of a won relaunch claim, consumed by the session_start boundary
  core.onBeforeSessionStart((_event, ctx) => {
    const start = core.startState;
    const prior = start?.parkExit;
    if (!prior?.parkId) return undefined;
    const claimPath = join(dir(), startName(core.sessionId, prior.parkId));
    let won;
    if (start.parkState !== "exited") {
      // A copy opened while the relaunched session still runs: one live session only.
      won = !liveForeignClaim(claimPath);
    } else {
      try {
        fs.mkdirSync(dir(), { recursive: true });
        won = takeClaim(claimPath);
      } catch (error) {
        core.recordError("park-exit-claim", error);
        won = true; // the claim is the last line of defence; an unwritable dir must not strand the session
      }
      if (won) { ownClaim = claimPath; relaunchFrom = prior; }
    }
    if (won) return undefined;
    exited = {};
    ctx.shutdown();
    return { veto: true };
  });

  async function onSessionStart(ctx) {
    const prior = relaunchFrom;
    relaunchFrom = null;
    if (!prior) return;
    writeJsonAtomic(join(dir(), ackName(core.sessionId, prior.createdAt)),
      { v: 1, parkId: prior.parkId, sessionId: core.sessionId, pid, at: core.now() }, fs);
    if (prior.terminalKind === "self" && prior.selfTask) {
      try { await selfLaunch.unregister({ sessionId: core.sessionId, selfTask: prior.selfTask }); }
      catch (error) { core.recordError("park-exit-unregister", error); }
    }
    const p = my();
    p.resumedFrom = prior.parkId;
    if (core.state.parkState === "exited") core.state.parkState = "ok";
    if (core.isParked()) {
      const count = Number(prior.relaunchReparks) || 0;
      if (count >= RELAUNCH_REPARK_LIMIT) {
        p.relaunchReparks = 0;
        core.persist();
        await stopReparking();
        return;
      }
      p.relaunchReparks = count + 1;
      core.persist();
      return;
    }
    p.relaunchReparks = 0;
    core.persist();
    const goal = await core.readGoal(ctx);
    if (goal?.status === "active" && trailingContinuations(ctx?.sessionManager?.getBranch?.()) >= GOAL_CONTINUATION_CAP) {
      core.pi.sendUserMessage(core.texts.resetResume);
    }
  }

  // After RELAUNCH_REPARK_LIMIT consecutive re-parks right after relaunch: switch limitless off for this
  // session through the control file (todo 9 contract), release the park, and notify once.
  async function stopReparking() {
    writeJsonAtomic(join(core.homeDir, ".omo", "limitless", "control", `${sanitizeId(core.sessionId)}.json`), { v: 1, mode: "off" }, fs);
    core.state.mode = "off";
    await core.release({ reason: "relaunch-loop" });
    await core.releaseOwnedGoal({ reason: "relaunch-loop", text: core.texts.resetResume });
    core.notify(`limitless: 재실행 직후 ${RELAUNCH_REPARK_LIMIT}번 연속 다시 한도에 걸려 이 세션의 한도 대기를 껐습니다. 다시 켜려면 /limitless on`, "warning");
  }

  core.pi.events?.on?.("wake_source_state", (data) => {
    if (typeof data?.source !== "string" || !Number.isFinite(data.activeCount)) return undefined;
    wake.set(data.source, Math.max(0, data.activeCount));
    return CHILD_WAKE_SOURCES.has(data.source) ? attempt(core.lastCtx) : undefined;
  });

  core.pi.on("tool_call", (event) => {
    if (SPAWN_TOOLS.has(event?.toolName)) spawnSeen = true;
    return undefined;
  });

  core.pi.on("session_shutdown", () => {
    if (!ownClaim) return;
    try { fs.unlinkSync(ownClaim); } catch {}
    ownClaim = null;
  });

  core.onTransition((_prev, next) => {
    if (exited) {
      if (exited.parkState) { Object.assign(core.state, exited); core.persist(); }
      return;
    }
    if (next.parkState === "ok") { my().held = false; my().holdReason = null; }
    if (next.parkState === "park-exit") core.timers.set(TIMER, 0, (ctx) => attempt(ctx));
  });

  core.onBoundary(async (ctx, kind) => {
    if (exited) return;
    if (kind === "session_start") {
      await onSessionStart(ctx);
      if (exited) return;
    }
    await attempt(ctx);
  });
}
