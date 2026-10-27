import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness } from "./harness.mjs";
import { startKeepalive } from "../extension/keepalive.mjs";
import { ackName, CLAIM_FRESH_MS, parksDir, recordName, startName, RELAUNCH_REPARK_LIMIT } from "../extension/park-exit.mjs";
import { resolveLauncher as realResolveLauncher, selfLaunch as realSelfLaunch } from "../extension/selflaunch.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 5 * 3600000; // beyond the 4h Claude wait limit -> park-exit
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR_TURN = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const SPAWNED_BEFORE = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth",
  content: [{ type: "toolCall", id: "t1", name: "task", arguments: {} }] } }];
const GOAL = { id: "g1", status: "active", objective: "work" };
const ORCA = { ORCA_WORKTREE_ID: "wt-1::C:/dev/x", ORCA_TERMINAL_HANDLE: "term_1" };
const RECORD_KEYS = ["account", "claim", "createdAt", "cwd", "goal", "parkId", "provider", "reason", "resetAt",
  "result", "sessionId", "status", "terminal", "v", "window"];

const snap = (utilization, resetAt = RESET) => ({
  provider: "anthropic-subscription", account: "default",
  windows: [{ kind: "five_hour", utilization, resetAt }], overageEnabled: false, source: "endpoint",
});

// One senpi process. `util` may be a function so a test can move usage between polls.
function proc({ util = 95, now = T0, homeDir, env = ORCA, branch = PRIOR_TURN, goal = GOAL, daemon = "fresh",
  pid = 1001, alive = new Set([1001, 1002]), selfLaunch, usage, startOf = (p) => startTime(p), extra = {} } = {}) {
  const h = createHarness({ model: CLAUDE, branch, goal, now, homeDir, env });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  if (daemon === "fresh") h.writeHomeJson(".omo-health/daemon.json", { ts: now - 5000, pid: 77, capabilities: ["park-resume"] });
  if (daemon === "fresh-no-capability") h.writeHomeJson(".omo-health/daemon.json", { ts: now - 5000, pid: 77 }); // released omo-health 0.5.0
  if (daemon === "fresh-other-capability") h.writeHomeJson(".omo-health/daemon.json", { ts: now - 5000, pid: 77, capabilities: ["other"] });
  if (daemon === "stale") h.writeHomeJson(".omo-health/daemon.json", { ts: now - 46000, pid: 77 });
  const goalAtShutdown = [];
  h.ctx.shutdown = () => { h.shutdownCalls.push(true); goalAtShutdown.push(h.goalStore.goal?.status ?? null); };
  const reader = async () => (usage ? usage() : snap(typeof util === "function" ? util() : util));
  const core = startKeepalive(h.pi, h.deps({ readUsage: reader, pid, isPidAlive: (p) => alive.has(p), selfLaunch,
    processStartTime: startOf, resolveLauncher: async () => ({ exe: "omo", args: [] }), parkExitStartGraceMs: 0, ...extra }));
  const dir = parksDir({}, h.tmpHome);
  const records = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".park.json")).sort() : []);
  const listing = () => (existsSync(dir) ? readdirSync(dir).sort() : []);
  const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  // A session_start opens the exit gate only after the session settled once (and the grace passed); grace is 0 here.
  const startOnly = (reason = "startup") => h.fire("session_start", { type: "session_start", reason });
  const settle = () => h.fire("agent_settled", { type: "agent_settled" });
  const start = async () => { await startOnly(); await settle(); };
  const wake = (activeCount, source = "senpi-task") => h.pi.events.emit("wake_source_state", { source, activeCount, channels: [] });
  return { h, core, dir, records, listing, read, start, startOnly, settle, wake, goalAtShutdown };
}

// Fake OS process creation time per pid (the real probe asks PowerShell / ps).
const startTime = (p) => 1_000_000 + p;
const claimOf = (p, at) => ({ pid: p, startedAt: startTime(p), at });

// Minimal omo-health stand-in (todo 11 owns the real one): writes only the episode file it processes,
// by exact name, and completes an episode whose ack carries the same parkId.
function healthTick(dir) {
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".park.json"))) {
    const path = join(dir, name);
    const rec = JSON.parse(readFileSync(path, "utf8"));
    if (rec.status === "completed") continue;
    const ackPath = join(dir, name.replace(/\.park\.json$/, ".ack.json"));
    if (!existsSync(ackPath)) continue;
    const ack = JSON.parse(readFileSync(ackPath, "utf8"));
    if (ack.parkId === rec.parkId) writeFileSync(path, JSON.stringify({ ...rec, status: "completed", ack }));
  }
}
const healthWrite = (dir, name, patch) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
};

test("park-exit writes a D7 record with every key, pauses then re-activates the goal, shuts down once", async () => {
  const p = proc();
  try {
    await p.start();
    assert.equal(p.records().length, 1);
    const name = p.records()[0];
    assert.equal(name, recordName("s1", T0));
    const rec = p.read(name);
    assert.deepEqual(Object.keys(rec).sort(), RECORD_KEYS);
    assert.equal(rec.v, 1);
    assert.equal(rec.parkId, `s1-${T0}`);
    assert.equal(rec.sessionId, "s1");
    assert.equal(rec.cwd, p.h.tmpHome);
    assert.deepEqual(rec.terminal, { kind: "orca", orca: { worktree: ORCA.ORCA_WORKTREE_ID, terminal: ORCA.ORCA_TERMINAL_HANDLE } });
    assert.equal(rec.provider, "anthropic-subscription");
    assert.equal(rec.account, "default");
    assert.equal(rec.window, "five_hour");
    assert.equal(rec.resetAt, RESET);
    assert.equal(rec.reason, "usage-limit");
    assert.deepEqual(rec.goal, { id: "g1", pausedByKeepalive: true });
    assert.equal(rec.status, "pending");
    assert.equal(rec.createdAt, T0);
    assert.equal(rec.claim, null);
    assert.equal(rec.result, null);
    assert.deepEqual(p.h.goalStore.setStatusCalls, ["paused", "active"]);
    assert.deepEqual(p.goalAtShutdown, ["active"]);
    assert.equal(p.h.shutdownCalls.length, 1);
    const state = p.h.readHomeJson(".omo/keepalive/state/s1.json");
    assert.equal(state.parkState, "exited");
    assert.equal(state.parkExit.parkId, `s1-${T0}`);
    // Nothing after shutdown: more boundaries and timers neither write nor shut down again.
    await p.h.runTurn();
    await p.h.clock.tick(3600000);
    assert.equal(p.h.shutdownCalls.length, 1);
    assert.equal(p.records().length, 1);
    assert.equal(p.h.readHomeJson(".omo/keepalive/state/s1.json").parkState, "exited");
  } finally { p.h.cleanup(); }
});

test("herdr terminal from HERDR_* env; qaCommandPrefix copied only when the env hook is set", async () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "p-7", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t",
    OMO_KEEPALIVE_QA_COMMAND_PREFIX: "set OMO_KEEPALIVE_FAKE_USAGE_FILE=C:/tmp/u.json && " };
  const p = proc({ env });
  try {
    await p.start();
    const rec = p.read(p.records()[0]);
    assert.deepEqual(rec.terminal, { kind: "herdr", herdr: { pane: "p-7", workspaceId: "w", tabId: "t" } });
    assert.equal(rec.qaCommandPrefix, env.OMO_KEEPALIVE_QA_COMMAND_PREFIX);
  } finally { p.h.cleanup(); }
});

test("an episode never overwrites an older record with the same timestamp", async () => {
  const p = proc();
  try {
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(join(p.dir, recordName("s1", T0)), JSON.stringify({ parkId: "older", status: "completed" }));
    await p.start();
    assert.deepEqual(p.read(recordName("s1", T0)), { parkId: "older", status: "completed" });
    assert.equal(p.read(recordName("s1", T0 + 1)).parkId, `s1-${T0 + 1}`);
  } finally { p.h.cleanup(); }
});

test("shutdown waits for children: wake count 1 holds park-wait, drain to 0 writes the record and shuts down once", async () => {
  const p = proc();
  try {
    await p.wake(1);
    await p.start();
    assert.equal(p.records().length, 0);
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.state.parkState, "park-wait");
    assert.equal(p.core.canWarm(), false);
    assert.equal(p.core.state.parkExit.holdReason, "children-running");
    await p.wake(0);
    assert.equal(p.records().length, 0, "the exit waits for the next agent_settled");
    await p.settle();
    assert.equal(p.records().length, 1);
    assert.equal(p.h.shutdownCalls.length, 1);
    await p.wake(0);
    await p.h.runTurn();
    assert.equal(p.h.shutdownCalls.length, 1);
  } finally { p.h.cleanup(); }
});

// F3d: a detached eval cell (source "senpi-codemode"), a background bash session and a monitor are all killed by
// an exit, so each one holds it exactly like a child task.
for (const source of ["senpi-codemode", "terminal-background-sessions", "terminal-monitors", "senpi-task-member", "some-future-source"]) {
  test(`${source} running holds park-exit (park-wait, holdReason names it, no record, no shutdown); count 0 exits`, async () => {
    const p = proc();
    try {
      await p.wake(1, source);
      await p.start();
      assert.equal(p.records().length, 0);
      assert.equal(p.h.shutdownCalls.length, 0);
      assert.equal(p.core.state.parkState, "park-wait");
      assert.equal(p.core.state.warm.on, false);
      assert.equal(p.core.state.parkExit.holdReason, `background-running:${source}`);
      // Later boundaries and ticks re-attempt and keep holding while the count stays above zero.
      await p.h.runTurn();
      await p.h.clock.tick(20000); // still inside the daemon freshness window
      assert.equal(p.records().length, 0);
      assert.equal(p.h.shutdownCalls.length, 0);
      assert.equal(p.core.state.parkExit.holdReason, `background-running:${source}`);
      await p.wake(0, source);
      await p.settle();
      assert.equal(p.records().length, 1);
      assert.equal(p.h.shutdownCalls.length, 1);
    } finally { p.h.cleanup(); }
  });
}

test("two background sources: draining one still holds, the second drain exits", async () => {
  const p = proc();
  try {
    await p.wake(1, "senpi-codemode");
    await p.wake(1, "terminal-background-sessions");
    await p.start();
    assert.equal(p.core.state.parkExit.holdReason, "background-running:senpi-codemode");
    await p.wake(0, "senpi-codemode");
    await p.settle();
    assert.equal(p.core.state.parkExit.holdReason, "background-running:terminal-background-sessions");
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.records().length, 0);
    await p.wake(0, "terminal-background-sessions");
    await p.settle();
    assert.equal(p.h.shutdownCalls.length, 1);
    assert.equal(p.records().length, 1);
  } finally { p.h.cleanup(); }
});

test("a cell that starts after the hold began keeps the session from exiting at the next boundary", async () => {
  const p = proc({ daemon: "stale" });
  try {
    await p.start();
    assert.equal(p.core.state.parkExit.holdReason, "health-daemon-not-fresh");
    p.h.writeHomeJson(".omo-health/daemon.json", { ts: T0 - 1000, pid: 77, capabilities: ["park-resume"] });
    await p.wake(1, "senpi-codemode"); // daemon is healthy now, but a detached cell is running
    await p.h.runTurn();
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.state.parkExit.holdReason, "background-running:senpi-codemode");
    await p.wake(0, "senpi-codemode");
    await p.settle();
    assert.equal(p.h.shutdownCalls.length, 1);
  } finally { p.h.cleanup(); }
});

test("an unreadable wake count is unknown, not zero: any source holds until it reports a readable 0", async () => {
  for (const bad of ["x", undefined, NaN, null]) {
    const q = proc();
    try {
      q.h.pi.events.emit("wake_source_state", { source: "senpi-codemode", activeCount: bad });
      await q.start();
      assert.equal(q.records().length, 0, `activeCount ${String(bad)}`);
      assert.equal(q.h.shutdownCalls.length, 0);
      assert.equal(q.core.state.parkState, "park-wait");
      assert.equal(q.core.state.parkExit.holdReason, "background-unknown:senpi-codemode");
      await q.wake(0, "senpi-codemode");
      await q.settle();
      assert.equal(q.h.shutdownCalls.length, 1);
    } finally { q.h.cleanup(); }
  }
});

// N3: keepalive loads before the terminal/ask-user/loop-guard/codemode emitters, so after a reload its wake map is empty
// until they re-publish. No exit is attempted until the session settled once AND the grace passed.
const GRACE = 5000;
async function heldThenReload() {
  const a = proc();
  await a.wake(1, "terminal-background-sessions");
  await a.start();
  assert.equal(a.core.state.parkExit.holdReason, "background-running:terminal-background-sessions");
  const b = proc({ homeDir: a.h.tmpHome, goal: a.h.goalStore.goal, extra: { parkExitStartGraceMs: GRACE } });
  return { a, b };
}

test("N3: reload with a background session alive - no exit until settle + grace, a re-published count keeps holding, then one exit at count 0", async () => {
  const { a, b } = await heldThenReload();
  try {
    await b.startOnly("reload");
    assert.equal(b.h.shutdownCalls.length, 0, "empty wake map at session_start must not exit");
    assert.equal(b.records().length, 0);
    await b.wake(1, "terminal-background-sessions"); // the emitter re-publishes after keepalive
    assert.equal(b.h.shutdownCalls.length, 0);
    await b.settle();
    await b.h.clock.tick(GRACE - 1);
    assert.equal(b.h.shutdownCalls.length, 0, "settled but grace not over");
    await b.h.clock.tick(1);
    assert.equal(b.h.shutdownCalls.length, 0, "gate open, count 1 holds");
    assert.equal(b.core.state.parkExit.holdReason, "background-running:terminal-background-sessions");
    assert.equal(b.records().length, 0);
    await b.wake(0, "terminal-background-sessions");
    await b.settle();
    assert.equal(b.h.shutdownCalls.length, 1);
    assert.equal(b.records().length, 1);
    await b.settle();
    await b.h.clock.tick(60000);
    assert.equal(b.h.shutdownCalls.length, 1, "exactly once");
  } finally { b.h.cleanup(); }
});

test("N3: reload where nothing survived exits once the session settled and the grace passed (grace timer)", async () => {
  const { b } = await heldThenReload();
  try {
    await b.startOnly("reload");
    await b.settle();
    await b.h.clock.tick(0); // drain the zero-delay park timers while the gate is still closed: only the grace timer is left
    assert.equal(b.h.shutdownCalls.length, 0, "settled, grace not over");
    await b.h.clock.tick(GRACE);
    assert.equal(b.h.shutdownCalls.length, 1);
    assert.equal(b.records().length, 1);
  } finally { b.h.cleanup(); }
});

test("N3: grace over but the session never settled -> no exit; the first settle exits", async () => {
  const { b } = await heldThenReload();
  try {
    await b.startOnly("reload");
    await b.h.clock.tick(GRACE * 4);
    assert.equal(b.h.shutdownCalls.length, 0);
    assert.equal(b.records().length, 0);
    await b.settle();
    assert.equal(b.h.shutdownCalls.length, 1);
  } finally { b.h.cleanup(); }
});

// (6) a count drop must not exit before the completion notice run is delivered and saved.
test("count drop to 0: no exit before agent_settled (turn_end and time do not count); after it exactly one exit", async () => {
  const p = proc();
  try {
    await p.wake(1, "senpi-codemode");
    await p.start();
    await p.wake(0, "senpi-codemode");
    assert.equal(p.h.shutdownCalls.length, 0);
    await p.h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
    await p.h.clock.tick(20000);
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.records().length, 0);
    await p.settle();
    assert.equal(p.h.shutdownCalls.length, 1);
    assert.equal(p.records().length, 1);
    await p.settle();
    await p.wake(0, "senpi-codemode");
    assert.equal(p.h.shutdownCalls.length, 1);
  } finally { p.h.cleanup(); }
});

test("count drop to 0 with a queued message (the completion notice) still pending at agent_settled -> held busy, exits after it is delivered", async () => {
  const p = proc();
  try {
    await p.wake(1, "senpi-codemode");
    await p.start();
    await p.wake(0, "senpi-codemode");
    p.h.setPendingMessages(true);
    await p.settle();
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.state.parkExit.holdReason, "busy");
    p.h.setPendingMessages(false);
    await p.settle();
    assert.equal(p.h.shutdownCalls.length, 1);
  } finally { p.h.cleanup(); }
});

test("count drops then another source starts before the settle -> still held at the settle", async () => {
  const p = proc();
  try {
    await p.wake(1, "senpi-codemode");
    await p.start();
    await p.wake(0, "senpi-codemode");
    await p.wake(1, "terminal-monitors");
    await p.settle();
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.state.parkExit.holdReason, "background-running:terminal-monitors");
  } finally { p.h.cleanup(); }
});

// F1: a closed gate / a pending deferral must hold in park-wait (T7 only arms its resume timer for park-wait), never sit in park-exit.
test("F1: fresh start over the limit, no turn ever -> park-wait 'start-gate', T7 armed, resumes in place at reset with the goal active", async () => {
  let util = 95;
  const p = proc({ util: () => util, extra: { parkExitStartGraceMs: GRACE } });
  try {
    await p.startOnly();
    assert.equal(p.core.state.parkState, "park-wait");
    assert.equal(p.core.state.parkExit.holdReason, "start-gate");
    assert.equal(p.core.state.warm.on, false);
    assert.equal(p.core.timers.has("resume"), true, "T7 resume timer armed");
    assert.equal(p.records().length, 0);
    assert.equal(p.h.shutdownCalls.length, 0);
    await p.h.clock.tick(GRACE * 4); // grace over, still no settle
    assert.equal(p.core.state.parkState, "park-wait");
    util = 10;
    await p.h.clock.tick(RESET - T0 + 60000);
    assert.equal(p.core.isParked(), false);
    assert.equal(p.h.goalStore.goal.status, "active");
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.records().length, 0);
  } finally { p.h.cleanup(); }
});

test("F1: the start-gate hold exits normally once the session settles after the grace", async () => {
  const p = proc({ extra: { parkExitStartGraceMs: GRACE } });
  try {
    await p.startOnly();
    assert.equal(p.core.state.parkExit.holdReason, "start-gate");
    await p.settle();
    await p.h.clock.tick(0);
    assert.equal(p.h.shutdownCalls.length, 0, "settled, grace not over");
    await p.h.clock.tick(GRACE);
    assert.equal(p.h.shutdownCalls.length, 1);
    assert.equal(p.records().length, 1);
  } finally { p.h.cleanup(); }
});

// N3: the session settles inside the grace with no exit wanted yet; the park-exit decision then lands off-boundary
// (a poll transition, no turn boundary). The start-gate hold must arm the grace timer, or the exit waits for a boundary.
test("N3: an off-boundary park-exit decision inside the grace exits at the grace deadline (gate timer armed from the hold)", async () => {
  let util = 10;
  const p = proc({ util: () => util, extra: { parkExitStartGraceMs: GRACE } });
  try {
    await p.startOnly();
    await p.settle(); // settled inside the grace; usage is fine, so no exit is wanted at the settle (no gate timer yet)
    assert.equal(p.h.shutdownCalls.length, 0);
    util = 95;
    // The park-exit decision lands off-boundary (no turn boundary): the transition arms the zero-delay park timer.
    p.core.state.decision = { state: "park-exit", window: "five_hour", resetAt: RESET, reason: "five_hour 95%", util: 95, warm: { on: true } };
    await p.core.park({ state: "park-exit", window: "five_hour", resetAt: RESET, reason: "five_hour 95%", util: 95, warm: { on: true } });
    await p.h.clock.tick(0); // drain the zero-delay park timer while the gate is still closed
    assert.equal(p.core.state.parkState, "park-wait");
    assert.equal(p.core.state.parkExit.holdReason, "start-gate");
    assert.equal(p.h.shutdownCalls.length, 0, "still inside the grace");
    assert.equal(p.records().length, 0);
    await p.h.clock.tick(GRACE); // no turn boundary after the decision: only the gate timer armed by the hold can exit
    assert.equal(p.h.shutdownCalls.length, 1);
    assert.equal(p.records().length, 1);
  } finally { p.h.cleanup(); }
});

test("F1: a count drop before the first hold with no run after it -> park-wait 'awaiting-settle', T7 armed; the next settle exits once", async () => {
  const park = async (p) => {
    p.core.state.decision = { state: "park-exit", window: "five_hour", resetAt: RESET, reason: "five_hour 95%", util: 95, warm: { on: true } };
    await p.core.park({ state: "park-exit", window: "five_hour", resetAt: RESET, reason: "five_hour 95%", util: 95, warm: { on: true } });
    await p.h.clock.tick(0);
  };
  let util = 10;
  const p = proc({ util: () => util });
  try {
    await p.start();
    await p.wake(1, "senpi-codemode");
    await p.wake(0, "senpi-codemode"); // drop while not parked: nothing to attempt yet
    util = 95; // the poll at the settle keeps agreeing with the park
    await park(p);
    assert.equal(p.core.state.parkState, "park-wait");
    assert.equal(p.core.state.parkExit.holdReason, "awaiting-settle");
    assert.equal(p.core.timers.has("resume"), true, "T7 resume timer armed");
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.records().length, 0);
    await p.settle();
    assert.equal(p.h.shutdownCalls.length, 1);
    assert.equal(p.records().length, 1);
  } finally { p.h.cleanup(); }
});

test("F1: a count drop with no run ever after it still resumes in place at reset", async () => {
  let util = 10;
  const p = proc({ util: () => util });
  try {
    await p.start();
    await p.wake(1, "senpi-codemode");
    await p.wake(0, "senpi-codemode");
    p.core.state.decision = { state: "park-exit", window: "five_hour", resetAt: RESET, reason: "five_hour 95%", util: 95, warm: { on: true } };
    await p.core.park({ state: "park-exit", window: "five_hour", resetAt: RESET, reason: "five_hour 95%", util: 95, warm: { on: true } });
    await p.h.clock.tick(0);
    assert.equal(p.core.state.parkState, "park-wait");
    await p.h.clock.tick(RESET - T0 + 60000);
    assert.equal(p.core.isParked(), false);
    assert.equal(p.h.goalStore.goal.status, "active");
    assert.equal(p.h.shutdownCalls.length, 0);
  } finally { p.h.cleanup(); }
});

// The gate/deferral hold sits AFTER the owned-goal and latecomer checks: those states stay exactly as the core set them.
test("F1: no owned goal with the start gate closed stays park-exit (IS-1), no hold", async () => {
  const p = proc({ goal: null, extra: { parkExitStartGraceMs: GRACE } });
  try {
    await p.startOnly();
    await p.h.clock.tick(0);
    assert.equal(p.core.state.parkState, "park-exit");
    assert.equal(p.core.state.parkExit?.held ?? false, false);
    assert.equal(p.h.shutdownCalls.length, 0);
  } finally { p.h.cleanup(); }
});

test("F1: a latecomer with the start gate closed is not held and never park-exits", async () => {
  const p = proc({ branch: [], extra: { parkExitStartGraceMs: GRACE } });
  try {
    await p.startOnly();
    await p.h.clock.tick(0);
    assert.equal(p.core.isLatecomer(), true);
    assert.equal(p.core.state.parkExit?.held ?? false, false);
    assert.equal(p.core.state.parkExit?.holdReason ?? null, null);
    assert.equal(p.h.shutdownCalls.length, 0);
  } finally { p.h.cleanup(); }
});

test("QA failure: the wake count stays 1 -> no record and no shutdown within the test window", async () => {
  const p = proc();
  try {
    await p.wake(1);
    await p.start();
    for (let i = 0; i < 6; i++) {
      await p.h.clock.tick(20 * 60000);
      await p.h.runTurn();
    }
    assert.equal(p.records().length, 0);
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.isParked(), true);
  } finally { p.h.cleanup(); }
});

test("unknown wake count (children spawned earlier, no wake report) -> no shutdown; a 0 report then exits", async () => {
  const p = proc({ branch: SPAWNED_BEFORE });
  try {
    await p.start();
    assert.equal(p.records().length, 0);
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.state.parkExit.holdReason, "children-unknown");
    await p.wake(0, "omo-dag");
    assert.equal(p.h.shutdownCalls.length, 1);
  } finally { p.h.cleanup(); }
});

test("a spawn call in this process makes the wake count unknown", async () => {
  const p = proc({ util: () => 10 });
  try {
    await p.start();
    await p.h.runTurn({ tools: ["task"] });
    p.core.state.decision = null;
    await p.core.park({ state: "park-exit", window: "five_hour", resetAt: RESET, reason: "five_hour 95%", util: 95, warm: { on: true } });
    await p.h.clock.tick(0);
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.state.parkExit.holdReason, "children-unknown");
  } finally { p.h.cleanup(); }
});

for (const [label, opts] of [
  ["stale daemon.json (ts older than 45 s)", { daemon: "stale" }],
  ["fresh daemon.json without the park-resume capability (released omo-health)", { daemon: "fresh-no-capability" }],
  ["fresh daemon.json with only another capability", { daemon: "fresh-other-capability" }],
  ["missing daemon.json", { daemon: "none" }],
  ["daemon.json with stoppedMs", { daemon: "none", stopped: true }],
  ["terminal.kind unknown without a self-launcher", { env: {} }],
  ["terminal.kind unknown with a failing self-launcher", { env: {}, selfLaunch: { register: async () => ({ ok: false, reason: "x" }) } }],
]) {
  test(`${label} -> no record, no shutdown, state park-wait without warming`, async () => {
    const p = proc(opts);
    try {
      if (opts.stopped) p.h.writeHomeJson(".omo-health/daemon.json", { ts: T0, stoppedMs: T0 });
      await p.start();
      assert.equal(p.records().length, 0);
      assert.equal(p.h.shutdownCalls.length, 0);
      assert.equal(p.core.state.parkState, "park-wait");
      assert.equal(p.core.state.warm.on, false);
      assert.equal(p.core.canWarm(), false);
      assert.equal(p.h.goalStore.goal.status, "paused");
      assert.equal(p.h.readHomeJson(".omo/keepalive/state/s1.json").parkState, "park-wait");
    } finally { p.h.cleanup(); }
  });
}

test("orca/herdr needs daemon.json capabilities to include park-resume: without it the hold names the missing capability, with it the session exits", async () => {
  const without = proc({ daemon: "fresh-no-capability" });
  try {
    await without.start();
    assert.equal(without.core.state.parkExit.holdReason, "health-daemon-no-park-resume");
    assert.equal(without.records().length, 0);
    assert.equal(without.h.shutdownCalls.length, 0);
    without.h.writeHomeJson(".omo-health/daemon.json", { ts: T0 - 1000, pid: 77, capabilities: ["park-resume"] });
    await without.h.runTurn();
    assert.equal(without.h.shutdownCalls.length, 1);
  } finally { without.h.cleanup(); }
});

test("held park-wait resumes through todo 7 at reset (no stranding)", async () => {
  let util = 95;
  const p = proc({ daemon: "stale", util: () => util });
  try {
    await p.start();
    assert.equal(p.core.state.parkState, "park-wait");
    util = 10;
    await p.h.clock.tick(RESET - T0 + 60000);
    assert.equal(p.core.isParked(), false);
    assert.equal(p.h.goalStore.goal.status, "active");
    assert.equal(p.h.shutdownCalls.length, 0);
  } finally { p.h.cleanup(); }
});

test("harness default: a park-exit decision in an unknown terminal goes to the harness fake, never the real self-launch module", async () => {
  // A valid (8+ character) session id: with "s1" the real module would reject the id before any PowerShell call.
  const h = createHarness({ sessionId: "harness-default", model: CLAUDE, branch: PRIOR_TURN, goal: GOAL, now: T0, env: {} });
  try {
    // Checked before anything runs: with the real module in place the flow below would register a Windows scheduled task.
    for (const deps of [h.deps(), h.deps({ selfLaunch: undefined, resolveLauncher: undefined })]) {
      assert.equal(typeof deps.selfLaunch?.register, "function");
      assert.equal(typeof deps.resolveLauncher, "function");
      assert.notEqual(deps.selfLaunch, realSelfLaunch);
      assert.notEqual(deps.resolveLauncher, realResolveLauncher);
    }
    h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
    const core = startKeepalive(h.pi, h.deps({ readUsage: async () => snap(95), pid: 1001, isPidAlive: () => true,
      processStartTime: startTime, parkExitStartGraceMs: 0 }));
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.ok(h.selfLaunchCalls.length > 0, "the exit path asked for a relauncher");
    assert.ok(h.selfLaunchCalls.every((call) => call.op === "register" && call.sessionId === "harness-default"));
    assert.equal(core.state.parkExit.holdReason, "no-relauncher");
    assert.equal(h.shutdownCalls.length, 0);
  } finally { h.cleanup(); }
});

test("terminal.kind unknown with a registered self-launch -> record kind self + selfTask, shutdown", async () => {
  const calls = [];
  const selfLaunch = {
    register: async (req) => { calls.push(req); return { ok: true, selfTask: "\\omo-keepalive\\omo-keepalive-resume-s1" }; },
  };
  const p = proc({ env: {}, daemon: "none", selfLaunch });
  try {
    await p.start();
    assert.deepEqual(calls, [{ sessionId: "s1", cwd: p.h.tmpHome, at: RESET + 60000, launcher: { exe: "omo", args: [] } }]);
    const rec = p.read(p.records()[0]);
    assert.deepEqual(rec.terminal, { kind: "self" });
    assert.equal(rec.selfTask, "\\omo-keepalive\\omo-keepalive-resume-s1");
    assert.equal(p.h.shutdownCalls.length, 1);
  } finally { p.h.cleanup(); }
});

test("park record stores the resolved launcher and hands it to the self-launch registration", async () => {
  const launcher = { exe: "C:\\Users\\u\\.bun\\bin\\bun.exe", args: ["C:\\Users\\u\\omo.js"] };
  const calls = [];
  const selfLaunch = { register: async (req) => { calls.push(req); return { ok: true, selfTask: "\\omo-keepalive\\omo-keepalive-resume-s1" }; } };
  const p = proc({ env: {}, daemon: "none", selfLaunch, extra: { resolveLauncher: async () => launcher } });
  try {
    await p.start();
    assert.deepEqual(calls[0].launcher, launcher);
    assert.deepEqual(p.read(p.records()[0]).launcher, launcher);
  } finally { p.h.cleanup(); }
});

test("an invalid launcher reported by the registration is recorded as lastError {where:'launcher'}", async () => {
  const selfLaunch = { register: async () => ({ ok: true, selfTask: "\\omo-keepalive\\omo-keepalive-resume-s1", launcherWarning: "invalid launcher, fell back to bare omo" }) };
  const p = proc({ env: {}, daemon: "none", selfLaunch });
  try {
    await p.start();
    assert.equal(p.core.state.lastError?.where, "launcher");
  } finally { p.h.cleanup(); }
});

test("latecomer never park-exits", async () => {
  const p = proc({ branch: [] });
  try {
    await p.start();
    assert.equal(p.core.isLatecomer(), true);
    assert.equal(p.records().length, 0);
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.canParkExit(), false);
    await p.h.runTurn();
    await p.h.clock.tick(0);
    assert.equal(p.records().length, 0);
    assert.equal(p.h.shutdownCalls.length, 0);
  } finally { p.h.cleanup(); }
});

async function exitOnce() {
  const first = proc();
  await first.start();
  assert.equal(first.h.shutdownCalls.length, 1);
  return first;
}

test("relaunch: session_start with parkState exited writes the ack and resumes the goal while health shows claimed", async () => {
  const first = await exitOnce();
  try {
    const name = first.records()[0];
    healthWrite(first.dir, name, { status: "claimed", claim: { at: RESET + 60000, attemptId: "a1", attempt: 1 } });
    const later = RESET + 120000;
    const second = proc({ homeDir: first.h.tmpHome, now: later, util: 10, pid: 1002, goal: first.h.goalStore.goal });
    second.h.installFakeGoalExtension();
    await second.start();
    const ack = JSON.parse(readFileSync(join(first.dir, ackName("s1", T0)), "utf8"));
    assert.deepEqual(ack, { v: 1, parkId: `s1-${T0}`, sessionId: "s1", pid: 1002, at: later });
    assert.equal(second.h.goalStore.goal.status, "active");
    assert.deepEqual(second.h.goalStore.setStatusCalls, []);
    assert.equal(second.h.shutdownCalls.length, 0);
    assert.equal(second.core.state.parkState, "ok");
    assert.equal(second.read(name).status, "claimed"); // keepalive never touches the record after writing it
    assert.ok(existsSync(join(first.dir, startName("s1", `s1-${T0}`))));
    assert.equal(second.records().length, 1);
    // The relaunch is finished: parkId is cleared, the held claim is named, and a clean shutdown drops both.
    const parkExit = second.h.readHomeJson(".omo/keepalive/state/s1.json").parkExit;
    assert.equal(parkExit.parkId, null);
    assert.equal(parkExit.claimFile, startName("s1", `s1-${T0}`));
    await second.h.fire("session_shutdown", { type: "session_shutdown" });
    assert.equal(existsSync(join(first.dir, startName("s1", `s1-${T0}`))), false);
    assert.equal(second.h.readHomeJson(".omo/keepalive/state/s1.json").parkExit.claimFile, null);
    // A later open runs no claim check at all: even a live pid 1002 with any start time cannot veto it.
    const reopen = proc({ homeDir: first.h.tmpHome, now: RESET + 3600000, util: 10, pid: 1003,
      alive: new Set([1002, 1003]), goal: second.h.goalStore.goal });
    await reopen.start();
    assert.equal(reopen.h.shutdownCalls.length, 0);
    assert.equal(reopen.core.isVetoed(), false);
  } finally { first.h.cleanup(); }
});

test("relaunch of a kind self record unregisters the self-launch task exactly once with its own task name", async () => {
  const task = "\\omo-keepalive\\omo-keepalive-resume-s1";
  const first = proc({ env: {}, daemon: "none", selfLaunch: { register: async () => ({ ok: true, selfTask: task }), unregister: async () => ({ ok: true }) } });
  try {
    await first.start();
    assert.equal(first.h.shutdownCalls.length, 1);
    assert.equal(first.read(first.records()[0]).terminal.kind, "self");
    const unregisterCalls = [];
    const second = proc({ env: {}, daemon: "none", homeDir: first.h.tmpHome, now: RESET + 120000, util: 10, pid: 1002,
      goal: first.h.goalStore.goal,
      selfLaunch: { register: async () => ({ ok: false }), unregister: async (req) => { unregisterCalls.push(req); return { ok: true }; } } });
    await second.start();
    assert.deepEqual(unregisterCalls, [{ sessionId: "s1", selfTask: task }]);
    assert.equal(second.core.state.parkState, "ok");
  } finally { first.h.cleanup(); }
});

test("relaunch with a cap-suppressed goal sends one kick message", async () => {
  const first = await exitOnce();
  try {
    const flood = Array.from({ length: 8 }, () => ({ type: "custom_message", customType: "goal-continuation" }));
    const second = proc({ homeDir: first.h.tmpHome, now: RESET + 120000, util: 10, pid: 1002,
      goal: first.h.goalStore.goal, branch: [...PRIOR_TURN, ...flood] });
    await second.start();
    assert.deepEqual(second.h.sentUserMessages.map((m) => m.text), ["[keepalive] 사용량 한도가 리셋됐다. 중단 전 작업을 이어가라."]);
    const third = proc({ homeDir: first.h.tmpHome, now: RESET + 120000, util: 10, pid: 1003, alive: new Set(),
      goal: first.h.goalStore.goal, branch: [...PRIOR_TURN, ...flood.slice(1)] });
    await third.start();
    assert.equal(third.h.shutdownCalls.length, 0);
    assert.equal(third.h.sentUserMessages.length, 0);
  } finally { first.h.cleanup(); }
});

test("two instances for the same sid and parkId (sequential): the first claims and resumes, the second shuts down and writes nothing", async () => {
  const first = await exitOnce();
  try {
    // One goal store shared by both processes; B sees usage over the limit, so any core work in B would
    // persist the state file, park and pause the goal.
    const shared = first.h.goalStore;
    const stateFile = join(first.h.tmpHome, ".omo/keepalive/state/s1.json");
    const opts = { homeDir: first.h.tmpHome, now: RESET + 120000, extra: { goalStore: shared } };
    const a = proc({ ...opts, util: 10, pid: 1001 });
    const b = proc({ ...opts, util: 95, pid: 1002 });
    await a.start();
    assert.equal(shared.goal.status, "active");
    const before = Object.fromEntries(a.listing().map((f) => [f, readFileSync(join(a.dir, f), "utf8")]));
    const stateBefore = readFileSync(stateFile, "utf8");
    const setStatusBefore = shared.setStatusCalls.length;
    await b.start();
    const after = Object.fromEntries(b.listing().map((f) => [f, readFileSync(join(b.dir, f), "utf8")]));
    assert.deepEqual(after, before);
    assert.equal(readFileSync(stateFile, "utf8"), stateBefore, "duplicate rewrote the state file");
    assert.equal(shared.goal.status, "active", "duplicate touched the goal");
    assert.equal(shared.setStatusCalls.length, setStatusBefore);
    assert.equal(b.core.isVetoed(), true);
    assert.equal(b.core.isParked(), false);
    assert.equal(a.h.shutdownCalls.length, 0);
    assert.equal(b.h.shutdownCalls.length, 1);
    assert.equal(JSON.parse(before[ackName("s1", T0)]).pid, 1001);
    assert.deepEqual(JSON.parse(before[startName("s1", `s1-${T0}`)]), claimOf(1001, RESET + 120000));
    assert.deepEqual(b.h.notifications.map((n) => n.level), ["warning"], "a veto shuts down with one notification");
    assert.match(b.h.notifications[0].text, /pid 1001/);
  } finally { first.h.cleanup(); }
});

test("duplicate start while the relaunched session runs and usage rose: vetoed before the core writes or pauses; A resumes at reset", async () => {
  const first = await exitOnce();
  try {
    const shared = first.h.goalStore;
    const stateFile = join(first.h.tmpHome, ".omo/keepalive/state/s1.json");
    let u = 10;
    const usage = () => snap(u, RESET + 5 * 3600000);
    const a = proc({ homeDir: first.h.tmpHome, now: RESET + 120000, pid: 1002, usage, extra: { goalStore: shared } });
    await a.start();
    assert.equal(shared.goal.status, "active");
    assert.equal(a.h.shutdownCalls.length, 0);
    u = 95;
    const stateBefore = readFileSync(stateFile, "utf8");
    const b = proc({ homeDir: first.h.tmpHome, now: RESET + 240000, pid: 1003, alive: new Set([1002, 1003]),
      usage: () => snap(u, RESET + 3 * 3600000 + 120000), extra: { goalStore: shared } });
    await b.start();
    assert.equal(b.h.shutdownCalls.length, 1, "duplicate shuts down");
    assert.equal(readFileSync(stateFile, "utf8"), stateBefore, "duplicate wrote the state file");
    assert.equal(shared.goal.status, "active", "duplicate paused the live session's goal");
    // A parks at its next boundary (it owns the pause), then usage resets -> goal active again.
    await a.h.clock.tick(5 * 60000); await a.h.runTurn();
    assert.equal(a.core.state.pausedByKeepalive, "g1");
    u = 10; await a.h.clock.tick(4 * 3600000); await a.h.runTurn(); await a.h.clock.tick(0);
    assert.equal(a.core.isParked(), false);
    assert.equal(shared.goal.status, "active", "goal stranded paused after reset");
  } finally { first.h.cleanup(); }
});

test("two instances start concurrently: exactly one claims and acks, the other shuts down", async () => {
  const first = await exitOnce();
  try {
    const opts = { homeDir: first.h.tmpHome, now: RESET + 120000, util: 10, goal: first.h.goalStore.goal };
    const a = proc({ ...opts, pid: 1001 });
    const b = proc({ ...opts, pid: 1002 });
    await Promise.all([a.start(), b.start()]);
    assert.equal(a.h.shutdownCalls.length + b.h.shutdownCalls.length, 1);
    const winner = a.h.shutdownCalls.length === 0 ? 1001 : 1002;
    assert.equal(JSON.parse(readFileSync(join(a.dir, ackName("s1", T0)), "utf8")).pid, winner);
    assert.deepEqual(JSON.parse(readFileSync(join(a.dir, startName("s1", `s1-${T0}`)), "utf8")), claimOf(winner, RESET + 120000));
    const loser = winner === 1001 ? b : a;
    assert.equal(loser.h.notifications.filter((n) => n.level === "warning").length, 1);
  } finally { first.h.cleanup(); }
});

test("a start claim held by a dead pid is replaced", async () => {
  const first = await exitOnce();
  try {
    writeFileSync(join(first.dir, startName("s1", `s1-${T0}`)), JSON.stringify({ pid: 4242 }));
    const b = proc({ homeDir: first.h.tmpHome, now: RESET + 120000, util: 10, pid: 1002, goal: first.h.goalStore.goal });
    await b.start();
    assert.equal(b.h.shutdownCalls.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(b.dir, startName("s1", `s1-${T0}`)), "utf8")), claimOf(1002, RESET + 120000));
    assert.equal(JSON.parse(readFileSync(join(b.dir, ackName("s1", T0)), "utf8")).pid, 1002);
  } finally { first.h.cleanup(); }
});

// N1: the relaunched session crashed (no session_shutdown, so its .start file and claimFile stay) and Windows
// reused its pid for an unrelated live process.
async function crashedRelaunch() {
  const first = await exitOnce();
  const relaunched = proc({ homeDir: first.h.tmpHome, now: RESET + 120000, util: 10, pid: 1002, goal: first.h.goalStore.goal });
  await relaunched.start(); // acks, holds the claim; then "crashes" without session_shutdown
  assert.equal(relaunched.h.readHomeJson(".omo/keepalive/state/s1.json").parkExit.claimFile, startName("s1", `s1-${T0}`));
  return { first, relaunched, claim: join(first.dir, startName("s1", `s1-${T0}`)) };
}

test("N1: a crashed relaunch's claim whose pid was reused (start time differs) is stale: the session opens and forgets it", async () => {
  const { first, relaunched, claim } = await crashedRelaunch();
  try {
    const reopen = proc({ homeDir: first.h.tmpHome, now: RESET + 3 * 3600000, util: 10, pid: 1003,
      alive: new Set([1002, 1003]), startOf: (p) => (p === 1002 ? 42 : startTime(p)), goal: relaunched.h.goalStore.goal });
    await reopen.start();
    assert.equal(reopen.h.shutdownCalls.length, 0);
    assert.equal(reopen.core.isVetoed(), false);
    assert.equal(existsSync(claim), false, "stale claim removed");
    const parkExit = reopen.h.readHomeJson(".omo/keepalive/state/s1.json").parkExit;
    assert.equal(parkExit.claimFile, null);
    assert.equal(parkExit.parkId, null);
  } finally { first.h.cleanup(); }
});

test("N1: a claim whose live pid matches its start time still vetoes a duplicate, with one notification", async () => {
  const { first, relaunched, claim } = await crashedRelaunch();
  try {
    const dup = proc({ homeDir: first.h.tmpHome, now: RESET + 3 * 3600000, util: 10, pid: 1003,
      alive: new Set([1002, 1003]), goal: relaunched.h.goalStore.goal });
    await dup.start();
    assert.equal(dup.h.shutdownCalls.length, 1);
    assert.equal(dup.h.notifications.length, 1);
    assert.equal(existsSync(claim), true);
  } finally { first.h.cleanup(); }
});

test("N1: unknown start time -> a claim counts only inside the relaunch window", async () => {
  const { first, relaunched, claim } = await crashedRelaunch();
  try {
    const unknown = { startOf: () => null, alive: new Set([1002, 1003]), util: 10, pid: 1003, homeDir: first.h.tmpHome,
      goal: relaunched.h.goalStore.goal };
    const young = proc({ ...unknown, now: RESET + 120000 + CLAIM_FRESH_MS });
    await young.start();
    assert.equal(young.h.shutdownCalls.length, 1, "young claim with unknown start time is live");
    const old = proc({ ...unknown, now: RESET + 120000 + CLAIM_FRESH_MS + 1 });
    await old.start();
    assert.equal(old.h.shutdownCalls.length, 0, "old claim with unknown start time is stale");
    assert.equal(existsSync(claim), false);
  } finally { first.h.cleanup(); }
});

test("N6: a failed ack write is recorded in state.lastError {where:'write', path}", async () => {
  const first = await exitOnce();
  try {
    const ackPath = join(first.dir, ackName("s1", T0));
    const failing = { ...nodeFs, renameSync: (from, to) => {
      if (to === ackPath) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return nodeFs.renameSync(from, to);
    } };
    const second = proc({ homeDir: first.h.tmpHome, now: RESET + 120000, util: 10, pid: 1002,
      goal: first.h.goalStore.goal, extra: { fs: failing } });
    await second.start();
    assert.equal(existsSync(ackPath), false);
    const lastError = second.h.readHomeJson(".omo/keepalive/state/s1.json").lastError;
    assert.equal(lastError?.where, "write");
    assert.equal(lastError?.path, ackPath);
  } finally { first.h.cleanup(); }
});

test("interleaving: ack A, re-park as B and exit, late health write marks A launched -> B untouched pending, A completed", async () => {
  const first = await exitOnce();
  try {
    const nameA = first.records()[0];
    healthWrite(first.dir, nameA, { status: "claimed" });
    const t1 = RESET + 120000;
    const second = proc({ homeDir: first.h.tmpHome, now: t1, pid: 1002, goal: first.h.goalStore.goal,
      usage: () => snap(95, t1 + 5 * 3600000) }); // still over, new reset beyond the wait limit
    await second.start();
    assert.ok(existsSync(join(first.dir, ackName("s1", T0))));
    assert.equal(second.h.shutdownCalls.length, 1);
    const nameB = recordName("s1", t1);
    assert.deepEqual(second.records(), [nameA, nameB].sort());
    const bBefore = readFileSync(join(first.dir, nameB), "utf8");
    assert.equal(JSON.parse(bBefore).status, "pending");
    assert.equal(JSON.parse(bBefore).parkId, `s1-${t1}`);
    assert.equal(second.h.readHomeJson(".omo/keepalive/state/s1.json").parkExit.parkId, `s1-${t1}`);
    healthWrite(first.dir, nameA, { status: "launched" }); // the late health write
    healthTick(first.dir);
    assert.equal(readFileSync(join(first.dir, nameB), "utf8"), bBefore);
    assert.equal(JSON.parse(readFileSync(join(first.dir, nameB), "utf8")).status, "pending");
    assert.equal(second.read(nameA).status, "completed");
    assert.equal(second.read(nameA).ack.parkId, `s1-${T0}`);
  } finally { first.h.cleanup(); }
});

test(`after ${RELAUNCH_REPARK_LIMIT} consecutive re-parks right after relaunch, the next relaunch stops re-parking and notifies once`, async () => {
  const first = await exitOnce();
  try {
    let t = RESET + 120000;
    let goal = first.h.goalStore.goal;
    for (let i = 1; i <= RELAUNCH_REPARK_LIMIT; i++) {
      const resetAt = t + 5 * 3600000;
      const p = proc({ homeDir: first.h.tmpHome, now: t, pid: 2000 + i, alive: new Set(), goal, usage: () => snap(95, resetAt) });
      await p.start();
      assert.equal(p.h.shutdownCalls.length, 1, `relaunch ${i} re-parks and exits`);
      assert.equal(p.h.readHomeJson(".omo/keepalive/state/s1.json").parkExit.relaunchReparks, i);
      goal = p.h.goalStore.goal;
      t += 6 * 3600000;
    }
    const lastReset = t + 5 * 3600000;
    const last = proc({ homeDir: first.h.tmpHome, now: t, pid: 3000, alive: new Set(), goal, usage: () => snap(95, lastReset) });
    await last.start();
    assert.equal(last.h.shutdownCalls.length, 0);
    assert.equal(last.core.isParked(), false);
    assert.equal(last.core.enabled(), false);
    assert.equal(last.h.goalStore.goal.status, "active");
    assert.equal(last.h.notifications.filter((n) => n.text.startsWith("keepalive: 재실행 직후")).length, 1);
    assert.deepEqual(last.h.readHomeJson(".omo/keepalive/control/s1.json"), { v: 1, mode: "off" });
    await last.h.runTurn({ tools: ["task"] });
    assert.equal(last.h.shutdownCalls.length, 0);
    assert.equal(last.h.notifications.filter((n) => n.text.startsWith("keepalive: 재실행 직후")).length, 1);
  } finally { first.h.cleanup(); }
});

test("IS-1: a parked session without a goal is never park-exited; after a goal is paused it exits as before", async () => {
  const p = proc({ goal: null });
  try {
    await p.start();
    assert.equal(p.core.state.parkState, "park-exit");
    assert.equal(p.core.ownedGoalId(), null);
    await p.h.clock.tick(0);
    await p.h.runTurn();
    assert.equal(p.records().length, 0);
    assert.equal(p.h.shutdownCalls.length, 0);
    p.h.setGoal({ ...GOAL });
    await p.h.runTurn();
    assert.equal(p.records().length, 1);
    assert.equal(p.h.shutdownCalls.length, 1);
    assert.deepEqual(p.h.goalStore.setStatusCalls, ["paused", "active"]);
  } finally { p.h.cleanup(); }
});

test("E1: removing the owned goal while parked prevents park record and shutdown", async () => {
  const p = proc();
  try {
    await p.wake(1);
    await p.start();
    assert.equal(p.core.ownedGoalId(), "g1");
    p.h.setGoal(null);
    await p.wake(0);
    await p.h.runTurn();
    await p.h.clock.tick(0);
    assert.equal(p.records().length, 0);
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.state.parkState, "park-wait");
  } finally { p.h.cleanup(); }
});

test("E1 replacement: active replacement goal is paused by core and park-exits", async () => {
  const p = proc();
  try {
    await p.wake(1);
    await p.start();
    assert.equal(p.core.ownedGoalId(), "g1");
    assert.equal(p.core.sessionId, "s1");
    assert.equal(p.core.enabled(), true);
    assert.equal(p.core.isParked(), true);
    p.h.setGoal({ id: "g2", status: "active", objective: "replacement" });
    await p.wake(0);
    assert.equal(p.h.goalStore.goal.status, "active");
    assert.equal(p.records().length, 0);
    assert.equal(p.h.shutdownCalls.length, 0);
    assert.equal(p.core.ownedGoalId(), "g1");
    await p.core.handleGoalStoreChanged({ threadId: "s1" });
    assert.equal(p.h.goalStore.goal.status, "paused");
    assert.equal(p.core.ownedGoalId(), "g2");
    await p.wake(0);
    await p.settle();
    assert.equal(p.h.goalStore.goal.status, "active");
    assert.equal(p.core.ownedGoalId(), null);
    assert.equal(p.records().length, 1);
    assert.equal(p.h.shutdownCalls.length, 1);
    assert.deepEqual(p.h.goalStore.setStatusCalls, ["paused", "paused", "active"]);
  } finally { p.h.cleanup(); }
});

for (const [name, failure] of [
  ["powershell timeout", { ok: false, reason: "powershell-timeout" }],
  ["non-zero exit", { ok: false, reason: "powershell-exit-1: boom" }],
  ["registration not confirmed", { ok: false, reason: "registration-not-confirmed" }],
]) {
  test(`failed registration (${name}) records lastError {where:'launcher'} only when the launcher was invalid`, async () => {
    const withWarning = proc({ env: {}, daemon: "none", selfLaunch: { register: async () => ({ ...failure, launcherWarning: "invalid launcher, fell back to bare omo" }) } });
    const clean = proc({ env: {}, daemon: "none", selfLaunch: { register: async () => ({ ...failure }) } });
    try {
      await withWarning.start();
      assert.equal(withWarning.core.state.lastError?.where, "launcher");
      assert.equal(withWarning.h.shutdownCalls.length, 0, "a failed registration never shuts down");
      await clean.start();
      assert.notEqual(clean.core.state.lastError?.where, "launcher");
    } finally { withWarning.h.cleanup(); clean.h.cleanup(); }
  });
}

// #4: a late report or an in-flight attempt after session_shutdown must not write a record without a session id.
test("a background count reported after session_shutdown writes no park record", async () => {
  const p = proc();
  try {
    await p.wake(1, "terminal-background-sessions");
    await p.start();
    assert.equal(p.core.state.parkExit.holdReason, "background-running:terminal-background-sessions");
    await p.h.fire("session_shutdown", { type: "session_shutdown" });
    await p.wake(0, "terminal-background-sessions");
    await p.h.clock.tick(3600000);
    assert.deepEqual(p.listing(), []);
    assert.equal(p.h.shutdownCalls.length, 0);
  } finally { p.h.cleanup(); }
});

test("an exit attempt still reading the goal when the session shuts down writes no park record", async () => {
  const p = proc({ daemon: "stale" });
  try {
    await p.start();
    assert.equal(p.core.state.parkExit.holdReason, "health-daemon-not-fresh");
    p.h.writeHomeJson(".omo-health/daemon.json", { ts: T0 - 5000, pid: 77, capabilities: ["park-resume"] });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const read = p.h.goalStore.read.bind(p.h.goalStore);
    p.h.goalStore.read = async (...args) => { await gate; return read(...args); };
    const settling = p.settle();
    await p.h.fire("session_shutdown", { type: "session_shutdown" });
    release();
    await settling;
    assert.deepEqual(p.listing(), []);
    assert.equal(p.h.shutdownCalls.length, 0);
  } finally { p.h.cleanup(); }
});
