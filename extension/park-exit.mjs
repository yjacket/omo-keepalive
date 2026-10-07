// limitless feature module: plan todo 8 "Park-exit with omo-health park record and resume on relaunch".
//
// Exit path (policy says park-exit):
//   background work drained + idle + relauncher confirmed
//   (fresh omo-health daemon that advertises the "park-resume" capability for herdr/orca, or a registered
//   self-launch task for unknown terminals)
//   Background work = every source the runtime publishes on pi.events "wake_source_state" ({source, activeCount}):
//   senpi-task / omo-dag / senpi-task-member children, "senpi-codemode" detached eval cells,
//   "terminal-background-sessions" background bash, "terminal-monitors", and any other. Exiting kills all of it, so
//   ANY source above zero, or a report whose count is unreadable (unknown != zero), holds the exit.
//   -> write <parksDir>/<sid>.<createdAt>.park.json (REPORT 9 D7) -> state parkState "exited"
//   -> goal limitless paused set back to active -> ctx.shutdown().
//   Any missing condition holds the session in park-wait without warming; todo 7 resumes it at reset.
// Relaunch path (session_start with own state parkState "exited"):
//   exclusive start claim <parksDir>/<sid>.<parkId>.start ({pid, startedAt, at}); a live foreign claim -> write
//   nothing, one notification, ctx.shutdown(). Otherwise write the ack file, count re-parks, kick a
//   cap-suppressed goal. After the ack, parkExit.parkId is cleared and parkExit.claimFile names the claim this
//   process holds; the claim file is removed (and claimFile cleared) at session reset/shutdown. A later
//   session_start with claimFile set only checks that one claim (duplicate copy of a running session); a stale
//   one is removed and forgotten.
// A claim is live only when its pid is alive, is not ours, and the pid's process start time matches the
// recorded startedAt. When either start time is unknown, only a claim younger than CLAIM_FRESH_MS counts.
//
// deps used (all optional): pid, isPidAlive(pid), processStartTime(pid) -> ms|null (sync or async), selfLaunch {register({sessionId,cwd,at,parkId}) ->
// {ok, selfTask?, reason?}, unregister({sessionId, selfTask})}. Defaults to ./selflaunch.mjs (todo 14); a register
// that throws or returns ok:false keeps an unknown terminal in park-wait.
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { SPAWN_TOOLS } from "./core.mjs";
import { resolveLauncher as realResolveLauncher, selfLaunch as realSelfLaunch } from "./selflaunch.mjs";
import { readJson, sanitizeId, writeJsonAtomic } from "./state.mjs";

export const DAEMON_STALE_MS = 45_000; // omo-health/extension/sensor.mjs:23,310
export const RELAUNCH_REPARK_LIMIT = 3;
export const PARK_RESUME_CAPABILITY = "park-resume"; // daemon.json capabilities entry: this omo-health collects park records
export const CLAIM_FRESH_MS = 5 * 60_000; // relaunch window: a claim this young counts even without a start time
const START_TOLERANCE_MS = 2000;
const PROBE_TIMEOUT_MS = 5000;
const GOAL_CONTINUATION_CAP = 8; // senpi goal/index.js:140-148
const CHILD_WAKE_SOURCES = new Set(["senpi-task", "omo-dag"]); // omo-rollover/extension/rollover.ts:27
const TIMER = "park-exit";
const GATE_TIMER = "park-exit-gate";
// After a session_start (reload included) limitless is loaded BEFORE the builtin terminal / ask-user / loop-guard and the
// bundled codemode extensions, so its wake map is empty while they re-publish the counts of background work that survived.
// No exit is attempted until the session settled once (turn_end / agent_settled) AND this grace passed on the injected clock.
export const START_GRACE_MS = 5000;

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

// A daemon that only writes a fresh heartbeat (released omo-health) never collects park records: it counts as a
// relauncher only when daemon.json lists the park-resume capability.
export function daemonSupportsParkResume({ env, homeDir, fs = nodeFs }) {
  const healthHome = env.OMO_HEALTH_HOME || join(homeDir, ".omo-health");
  const capabilities = readJson(join(healthHome, "daemon.json"), fs)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(PARK_RESUME_CAPABILITY);
}

// OS process creation time in epoch ms, or null when unknown (probe failed or timed out). Never throws.
export function defaultProcessStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (error, stdout) => {
      const ms = error ? NaN : Date.parse(String(stdout).trim());
      resolve(Number.isFinite(ms) ? ms : null);
    };
    try {
      if (process.platform === "win32") {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, done);
      } else {
        execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: PROBE_TIMEOUT_MS }, done);
      }
    } catch { resolve(null); }
  });
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
  const processStartTime = core.deps.processStartTime ?? defaultProcessStartTime;
  const startTimeOf = async (p) => {
    try {
      const ms = await processStartTime(p);
      return Number.isFinite(ms) ? ms : null;
    } catch { return null; }
  };
  let ownStart; // memoized promise of this process's start time
  const selfLaunch = core.deps.selfLaunch ?? realSelfLaunch;
  const wake = new Map(); // source -> live count, or null when that source's last report was unreadable
  let spawnSeen = false;
  let busy = null;
  let exited = null; // fields re-asserted if anything touches the state after shutdown
  let ownClaim = null;
  const startGraceMs = Number.isFinite(core.deps.parkExitStartGraceMs) ? core.deps.parkExitStartGraceMs : START_GRACE_MS;
  let startGate = null; // {settled, readyAt} from a session_start until it opens; null = open
  let drained = false; // a background count dropped to 0: the exit waits for the next agent_settled (completion notice delivered first)

  const gateOpen = () => {
    if (!startGate) return true;
    if (!startGate.settled || core.now() < startGate.readyAt) return false;
    startGate = null;
    return true;
  };

  const dir = () => parksDir(env, core.homeDir);
  const my = () => {
    if (!core.state.parkExit) core.state.parkExit = {};
    return core.state.parkExit;
  };

  // null = unknown. A session that never issued a spawn call cannot have children, so no report means zero.
  const childCount = (ctx) => {
    let seen = false;
    let sum = 0;
    for (const source of CHILD_WAKE_SOURCES) {
      if (!wake.has(source)) continue;
      if (wake.get(source) === null) return null;
      seen = true;
      sum += wake.get(source);
    }
    if (seen) return sum;
    return spawnSeen || spawnCallsIn(ctx?.sessionManager?.getBranch?.()) ? null : 0;
  };

  // Why exiting now would kill background work, or null when nothing is running. Every non-child source the
  // runtime reports (detached eval cells, background bash, monitors, ...) counts; an unreadable count is busy.
  const busyReason = (ctx) => {
    const children = childCount(ctx);
    if (children === null) return "children-unknown";
    if (children !== 0) return "children-running";
    for (const [source, count] of wake) {
      if (CHILD_WAKE_SOURCES.has(source)) continue;
      if (count === null) return `background-unknown:${source}`;
      if (count > 0) return `background-running:${source}`;
    }
    return null;
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
      const owned = core.ownedGoalId();
      const goal = owned ? await core.readGoal(ctx) : null;
      if (!owned || goal?.id !== owned || goal.status !== "paused") return undefined;
      if (core.isLatecomer()) return undefined; // core contract: canParkExit() is false, the state stays as the core set it
      // Hold in park-wait (not stay in park-exit): T7 only arms its resume timer for park-wait, so a session that never
      // settles still resumes in place at reset. The next settle / the grace timer re-attempts.
      if (drained) return hold("awaiting-settle");
      if (!gateOpen()) return hold("start-gate");
      const background = busyReason(ctx);
      if (background) return hold(background);
      if (ctx?.isIdle?.() !== true || ctx?.hasPendingMessages?.() === true) return hold("busy");
      const sid = core.sessionId;
      const cwd = String(ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd());
      let terminal = detectTerminal(env);
      let selfTask = null;
      let launcher = null;
      if (terminal.kind === "unknown") {
        try { launcher = await (core.deps.resolveLauncher ?? realResolveLauncher)({ env, fs }); } catch { launcher = null; }
        launcher ??= { exe: "omo", args: [] };
        const at = (core.state.resetAt ?? core.now()) + core.config.resumeGraceMs;
        let registered = null;
        try {
          registered = (await selfLaunch.register({ sessionId: sid, cwd, at, launcher })) ?? null;
        } catch (error) {
          core.recordError("park-exit-selflaunch", error);
        }
        if (registered?.launcherWarning) core.recordError("launcher", new Error(registered.launcherWarning));
        if (registered?.ok !== true) return hold("no-relauncher");
        selfTask = registered.selfTask ?? null;
        terminal = { kind: "self" };
      } else if (!daemonFresh({ env, homeDir: core.homeDir, now: core.now(), fs })) {
        return hold("health-daemon-not-fresh");
      } else if (!daemonSupportsParkResume({ env, homeDir: core.homeDir, fs })) {
        return hold("health-daemon-no-park-resume");
      }

      let createdAt = core.now();
      while (fs.existsSync(join(dir(), recordName(sid, createdAt)))) createdAt += 1;
      const parkId = `${sid}-${createdAt}`;
      const record = {
        v: 1, parkId, sessionId: sid, cwd, terminal,
        provider: core.lane?.provider ?? null, account: core.lane?.accounts?.[0] ?? "default",
        window: core.state.window, resetAt: core.state.resetAt, reason: "usage-limit",
        goal: owned ? { id: owned, pausedByLimitless: true } : null,
        status: "pending", createdAt, claim: null, result: null,
        ...(selfTask ? { selfTask, launcher } : {}),
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
        try { await core.setGoalStatus(ctx, "active"); } catch (error) { core.recordError("park-exit-goal", error); }
      }
      ctx.shutdown();
    })().finally(() => { busy = null; });
    return busy;
  }

  // Returns the claim's holder when it is a live foreign process, else null (missing, ours, dead, or a reused pid).
  async function liveHolder(path) {
    const holder = readJson(path, fs);
    if (!Number.isInteger(holder?.pid) || holder.pid === pid || !isPidAlive(holder.pid)) return null;
    const actual = Number.isFinite(holder.startedAt) ? await startTimeOf(holder.pid) : null;
    if (actual !== null) return Math.abs(actual - holder.startedAt) <= START_TOLERANCE_MS ? holder : null;
    const age = core.now() - holder.at;
    return Number.isFinite(age) && age >= 0 && age <= CLAIM_FRESH_MS ? holder : null;
  }

  // {won:true} or {won:false, holder}. Exclusive create ("wx"); a stale claim is replaced once.
  async function takeClaim(path) {
    ownStart ??= startTimeOf(pid);
    const body = JSON.stringify({ pid, startedAt: await ownStart, at: core.now() });
    let holder = null;
    for (let round = 0; round < 2; round++) {
      try {
        const fd = fs.openSync(path, "wx");
        try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
        return { won: true };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      holder = await liveHolder(path);
      if (holder) return { won: false, holder };
      try { fs.unlinkSync(path); } catch {}
    }
    return { won: false, holder };
  }

  function releaseOwnClaim() {
    if (!ownClaim) return;
    try { fs.unlinkSync(join(dir(), ownClaim)); } catch {}
    if (core.state.parkExit?.claimFile === ownClaim) {
      core.state.parkExit.claimFile = null;
      core.persist();
    }
    ownClaim = null;
  }

  const writeOrRecord = (path, data) => {
    const ok = writeJsonAtomic(path, data, fs);
    if (!ok) core.writeFailed(path);
    return ok;
  };

  // Start claim, run by the core BEFORE it persists, polls, parks or pauses anything (core.onBeforeSessionStart).
  // A losing duplicate vetoes: the core writes nothing for the rest of this process, and we shut down.
  let relaunchFrom = null; // prior parkExit of a won relaunch claim, consumed by the session_start boundary
  core.onBeforeSessionStart(async (_event, ctx) => {
    const start = core.startState;
    const prior = start?.parkExit;
    let holder = null;
    if (start?.parkState === "exited" && prior?.parkId) {
      const name = startName(core.sessionId, prior.parkId);
      let won;
      try {
        fs.mkdirSync(dir(), { recursive: true });
        ({ won, holder } = await takeClaim(join(dir(), name)));
      } catch (error) {
        core.recordError("park-exit-claim", error);
        won = true; // the claim is the last line of defence; an unwritable dir must not strand the session
      }
      if (won) { ownClaim = name; relaunchFrom = prior; return undefined; }
    } else {
      // A copy opened while the relaunched session still runs: one live session only. A state written before
      // claimFile existed still carries the parkId of its last relaunch.
      const name = prior?.claimFile ?? (prior?.parkId ? startName(core.sessionId, prior.parkId) : null);
      if (!name) return undefined;
      holder = await liveHolder(join(dir(), name));
      if (!holder) {
        // Crashed or cleanly gone claimant (possibly a reused pid): forget the claim for good.
        try { fs.unlinkSync(join(dir(), name)); } catch {}
        core.state.parkExit = { ...core.state.parkExit, parkId: null, claimFile: null };
        return undefined;
      }
    }
    exited = {};
    core.notify(holder
      ? `limitless: 이 세션은 이미 다른 프로세스(pid ${holder.pid})에서 열려 있어 이 창을 닫습니다.`
      : "limitless: 이 세션의 재실행 시작 권한을 얻지 못해 이 창을 닫습니다.", "warning");
    ctx.shutdown();
    return { veto: true };
  });

  async function onSessionStart(ctx) {
    const prior = relaunchFrom;
    relaunchFrom = null;
    if (!prior) return;
    writeOrRecord(join(dir(), ackName(core.sessionId, prior.createdAt)),
      { v: 1, parkId: prior.parkId, sessionId: core.sessionId, pid, at: core.now() });
    if (prior.terminalKind === "self" && prior.selfTask) {
      try { await selfLaunch.unregister({ sessionId: core.sessionId, selfTask: prior.selfTask }); }
      catch (error) { core.recordError("park-exit-unregister", error); }
    }
    const p = my();
    p.resumedFrom = prior.parkId;
    // The relaunch is done: later starts check only the claim this process holds (cleared at reset).
    p.parkId = null;
    p.claimFile = ownClaim;
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
    writeOrRecord(join(core.homeDir, ".omo", "limitless", "control", `${sanitizeId(core.sessionId)}.json`), { v: 1, mode: "off" });
    core.state.mode = "off";
    await core.release({ reason: "relaunch-loop" });
    await core.releaseOwnedGoal({ reason: "relaunch-loop" });
    core.notify(`limitless: 재실행 직후 ${RELAUNCH_REPARK_LIMIT}번 연속 다시 한도에 걸려 이 세션의 한도 대기를 껐습니다. 다시 켜려면 /limitless on`, "warning");
  }

  core.pi.events?.on?.("wake_source_state", (data) => {
    if (typeof data?.source !== "string" || data.source.length === 0) return undefined;
    const previous = wake.get(data.source);
    const count = Number.isFinite(data.activeCount) ? Math.max(0, data.activeCount) : null;
    wake.set(data.source, count);
    if (count === 0 && previous !== undefined && previous !== 0) drained = true;
    return attempt(core.lastCtx);
  });

  core.pi.on("tool_call", (event) => {
    if (SPAWN_TOOLS.has(event?.toolName)) spawnSeen = true;
    return undefined;
  });

  // session_shutdown or a session switch (core.onSessionReset): release the claim, forget per-session closures.
  core.onSessionReset(() => {
    releaseOwnClaim();
    wake.clear();
    startGate = null;
    drained = false;
    core.timers.clear(GATE_TIMER);
    spawnSeen = false;
    busy = null;
    exited = null;
    relaunchFrom = null;
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
      startGate = { settled: false, readyAt: core.now() + startGraceMs };
      drained = false;
      await onSessionStart(ctx);
      if (exited) return;
    } else {
      if (startGate && !startGate.settled && (kind === "turn_end" || kind === "agent_settled")) {
        startGate.settled = true;
        if (!gateOpen() && wantsExit()) core.timers.set(GATE_TIMER, Math.max(0, startGate.readyAt - core.now()), (c) => attempt(c));
      }
      if (kind === "agent_settled") drained = false;
    }
    await attempt(ctx);
  });
}
