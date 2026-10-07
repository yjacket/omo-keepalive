import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { startLimitless } from "../extension/limitless.mjs";

// A timer callback that is already running when its session is reset (session_shutdown, or /new and /resume in one
// process) must apply nothing to the next session's state - or to a dead session after a shutdown.
const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 2 * 3600000;
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR_TURN = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const TIMERS = ["warm", "resume", "reactive-check"];

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function session({ env } = {}) {
  const h = createHarness({ model: CLAUDE, now: T0, branch: PRIOR_TURN, env });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fake" } });
  let sid = "A";
  h.ctx.sessionManager.getSessionId = () => sid;
  const state = { util: 95, gate: null, entered: null, calls: 0 };
  const readUsage = async () => {
    state.calls += 1;
    const snapshot = {
      provider: "anthropic-subscription", account: "default", source: "endpoint", overageEnabled: false,
      windows: [{ kind: "five_hour", utilization: state.util, resetAt: h.clock.now() + 3600000 }],
    };
    if (state.gate) { state.entered.resolve(); await state.gate.promise; }
    return snapshot;
  };
  const core = startLimitless(h.pi, h.deps({ readUsage }));
  const armed = () => TIMERS.filter((name) => core.timers.has(name));
  return { h, core, state, armed, setSid: (value) => { sid = value; } };
}

// Fires the resume timer and holds its usage read open until release().
async function resumeTimerInFlight(s) {
  s.state.gate = deferred();
  s.state.entered = deferred();
  const ticking = s.h.clock.tick(RESET - T0 + 60000);
  await s.state.entered.promise;
  return { ticking, release: () => { s.state.gate.resolve(); s.state.gate = null; } };
}

test("resume callback in flight across a shutdown arms nothing on the dead session", async () => {
  const s = session();
  try {
    await s.h.fire("session_start", { type: "session_start" });
    assert.equal(s.core.timers.has("resume"), true);
    const flight = await resumeTimerInFlight(s);
    await s.h.fire("session_shutdown", { type: "session_shutdown" });
    flight.release();
    await flight.ticking;
    assert.equal(s.core.sessionId, null);
    assert.deepEqual(s.armed(), []);
  } finally { s.h.cleanup(); }
});

test("resume callback in flight across a shutdown and a new session leaves the new session alone", async () => {
  const s = session();
  try {
    await s.h.fire("session_start", { type: "session_start" });
    const flight = await resumeTimerInFlight(s);
    await s.h.fire("session_shutdown", { type: "session_shutdown" });
    s.setSid("B");
    s.state.util = 10;
    const noGate = s.state.gate;
    s.state.gate = null; // session B polls without waiting
    await s.h.fire("session_start", { type: "session_start" });
    assert.equal(s.core.state.parkState, "ok");
    assert.deepEqual(s.armed(), []);
    const decisionB = structuredClone(s.core.state.decision);
    s.state.gate = noGate;
    flight.release(); // A's reading (95%) now returns
    await flight.ticking;
    assert.equal(s.core.sessionId, "B");
    assert.equal(s.core.state.parkState, "ok", "A's decision must not park B");
    assert.deepEqual(s.core.state.decision, decisionB, "A's reading must not overwrite B's decision");
    assert.deepEqual(s.armed(), []);
  } finally { s.h.cleanup(); }
});

test("a timer callback whose control hook is still running at a reset never runs (core guard)", async () => {
  const s = session();
  try {
    await s.h.fire("session_start", { type: "session_start" });
    const hook = deferred();
    const entered = deferred();
    s.core.setControlReader(async (_ctx, kind) => {
      if (kind !== "timer:resume") return;
      entered.resolve();
      await hook.promise;
    });
    const callsBefore = s.state.calls;
    const ticking = s.h.clock.tick(RESET - T0 + 60000);
    await entered.promise;
    await s.h.fire("session_shutdown", { type: "session_shutdown" });
    hook.resolve();
    await ticking;
    assert.equal(s.state.calls, callsBefore, "the resume callback must not poll for a reset session");
  } finally { s.h.cleanup(); }
});

test("a reactive re-check in flight across a shutdown does not re-park the dead session", async () => {
  const h = createHarness({ model: { provider: "anthropic", api: "claude-sdk-oauth", id: "claude-fake" }, now: T0 });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { accounts: [{ name: "default", blockedUntil: null }] } });
  const gate = deferred();
  const entered = deferred();
  let gated = false;
  const over = () => ({
    provider: "anthropic-subscription", account: "default", source: "endpoint",
    windows: [{ kind: "five_hour", utilization: 95, resetAt: T0 + 3600000 }],
  });
  const core = startLimitless(h.pi, h.deps({ readUsage: async () => {
    if (gated) { entered.resolve(); await gate.promise; }
    return over();
  } }));
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "usage limit reached" }] } });
    assert.equal(core.state.source, "reactive");
    gated = true;
    const ticking = h.clock.tick(30 * 60000);
    await entered.promise;
    await h.fire("session_shutdown", { type: "session_shutdown" });
    gate.resolve();
    await ticking;
    assert.equal(core.state.source, "reactive", "the stale re-check must not convert the park to a poll park");
    assert.equal(core.timers.has("resume"), false);
  } finally { h.cleanup(); }
});
