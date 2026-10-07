import assert from "node:assert/strict";
import test from "node:test";
import { startLimitless } from "../extension/limitless.mjs";
import { createHarness } from "./harness.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR_TURN = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const GOAL = { id: "g1", status: "active", objective: "work" };
const snap = (utilization, resetAt = T0 + 3600000, source = "endpoint") => ({
  provider: "anthropic-subscription", account: "default",
  windows: [{ kind: "five_hour", utilization, resetAt }], overageEnabled: false, source,
});

function setup({ util = 0, goal = null, env = { OMO_LIMITLESS_FAKE_RESET_IN_MS: "1000" }, readUsage } = {}) {
  const h = createHarness({ model: CLAUDE, branch: PRIOR_TURN, goal, now: T0, env });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fake" } });
  let calls = 0;
  const core = startLimitless(h.pi, h.deps({
    readUsage: readUsage ?? (async () => { calls++; return snap(typeof util === "function" ? util() : util); }),
  }));
  return { h, core, calls: () => calls };
}

test("reset re-poll OK releases park and sends resume message", async () => {
  let calls = 0;
  const s = setup({ util: () => calls++ === 0 ? 95 : 0 });
  try {
    await s.h.fire("session_start", { type: "session_start" });
    assert.equal(s.core.isParked(), true);
    delete s.core.env.OMO_LIMITLESS_FAKE_RESET_IN_MS;
    await s.h.clock.tick(61000);
    assert.equal(s.core.isParked(), false);
    assert.deepEqual(s.h.sentUserMessages, []);
    assert.equal(s.h.statusLines.has("limitless"), false);
  } finally { s.h.cleanup(); }
});

test("reset while still over threshold re-parks for the newly reported reset and sends no message", async () => {
  const s = setup({
    util: 95,
    readUsage: async () => snap(95, T0 + 3 * 3600000),
  });
  try {
    await s.h.fire("session_start", { type: "session_start" });
    delete s.core.env.OMO_LIMITLESS_FAKE_RESET_IN_MS;
    await s.h.clock.tick(61000);
    assert.equal(s.core.isParked(), true);
    assert.equal(s.core.state.resetAt, T0 + 3 * 3600000);
    assert.deepEqual(s.h.sentUserMessages, []);
    assert.ok(s.h.clock.pendingTimers().includes(T0 + 3 * 3600000 + s.core.config.resumeGraceMs));
  } finally { s.h.cleanup(); }
});

test("reset leaves a goal paused by the user and does not restart autonomous work", async () => {
  let calls = 0;
  const s = setup({ util: () => calls++ === 0 ? 95 : 0, goal: GOAL });
  try {
    s.h.installFakeGoalExtension();
    await s.h.fire("session_start", { type: "session_start" });
    delete s.core.env.OMO_LIMITLESS_FAKE_RESET_IN_MS;
    assert.equal(s.h.goalStore.goal.status, "paused");
    // User pause relinquishes the extension's ownership mark.
    s.core.state.pausedByLimitless = null;
    s.core.persist();
    await s.h.clock.tick(61000);
    assert.equal(s.h.goalStore.goal.status, "paused");
    assert.deepEqual(s.h.sentUserMessages, []);
    assert.deepEqual(s.h.eventsEmitted.filter((event) => event.name === "limitless:park").map((event) => ({
      state: event.payload.state, resetAt: event.payload.resetAt,
    })), [
      { state: "park-wait", resetAt: T0 + 1000 },
      { state: "ok", resetAt: null },
    ]);
    assert.equal(s.h.queuedTurns.length, 0);
  } finally { s.h.cleanup(); }
});

test("manual known-reset park releases at reset when usage is ok, without restarting an unowned goal", async () => {
  const s = setup({ util: 0, goal: GOAL });
  try {
    await s.h.fire("session_start", { type: "session_start" });
    await s.core.park({ state: "park-wait", window: "five_hour", resetAt: T0 + 1000, reason: "manual" }, { source: "manual" });
    assert.equal(s.core.isParked(), true);
    await s.h.clock.tick(60001);
    assert.equal(s.core.isParked(), false);
    assert.equal(s.h.goalStore.goal.status, "active");
    assert.equal(s.h.sentUserMessages.length, 0);
  } finally { s.h.cleanup(); }
});

test("source none resumes optimistically and does not unpause an unowned goal", async () => {
  const s = setup({
    util: 95,
    readUsage: (() => {
      let calls = 0;
      return async () => calls++ === 0 ? snap(95) : snap(0, 0, "none");
    })(),
  });
  try {
    await s.h.fire("session_start", { type: "session_start" });
    delete s.core.env.OMO_LIMITLESS_FAKE_RESET_IN_MS;
    await s.h.clock.tick(61000);
    assert.equal(s.core.isParked(), false);
    assert.deepEqual(s.h.sentUserMessages, []);
  } finally { s.h.cleanup(); }
});

test("reset with an owned goal delegates exactly-once restart and sends no duplicate message", async () => {
  const s = setup({ util: 95, goal: GOAL, readUsage: (() => {
    let calls = 0;
    return async () => snap(calls++ === 0 ? 95 : 0);
  })() });
  try {
    s.h.installFakeGoalExtension();
    await s.h.fire("session_start", { type: "session_start" });
    delete s.core.env.OMO_LIMITLESS_FAKE_RESET_IN_MS;
    await s.h.clock.tick(61000);
    assert.equal(s.h.goalStore.goal.status, "active");
    assert.equal(s.h.queuedTurns.length, 1);
    assert.equal(s.h.sentUserMessages.length, 0);
    assert.deepEqual(s.h.eventsEmitted.filter((event) => event.name === "goal_store_changed").map((event) => event.payload),
      [{ threadId: "s1" }]);
  } finally { s.h.cleanup(); }
});
