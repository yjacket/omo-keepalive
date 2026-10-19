import assert from "node:assert/strict";
import test from "node:test";
import { startKeepalive } from "../extension/keepalive.mjs";
import { writeSharedSnapshot } from "../extension/state.mjs";
import { createHarness } from "./harness.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR_TURN = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const GOAL = { id: "g1", status: "active", objective: "work" };
const MAX_CALLS = 20; // runaway guard: past it the reader throws, so a loop ends instead of hanging the run
const snap = (utilization, resetAt) => ({
  provider: "anthropic-subscription", account: "default",
  windows: [{ kind: "five_hour", utilization, resetAt }], overageEnabled: false, source: "endpoint",
});

function setup(resetOf) {
  const h = createHarness({ model: CLAUDE, branch: PRIOR_TURN, goal: GOAL, now: T0, env: {} });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fake" } });
  const polls = [];
  const core = startKeepalive(h.pi, h.deps({
    readUsage: async () => {
      const at = h.clock.now();
      polls.push(at);
      if (polls.length > MAX_CALLS) throw new Error("runaway polling");
      return polls.length <= 3 ? snap(95, resetOf(at)) : snap(10, at + 3600000);
    },
  }));
  return { h, core, polls };
}

// Parked with the owned goal paused => exactly one pending timer, and it lies in the future.
function assertInvariant(s, label) {
  const pending = s.h.clock.pendingTimers();
  assert.ok(pending.length <= 1, `${label}: at most one timer, got ${pending.length}`);
  if (s.core.isParked()) {
    assert.notEqual(s.core.state.parkState, "park-exit", `${label}: past/null reset never park-exits`);
    assert.equal(s.core.timers.has("resume"), true, `${label}: parked without a resume/re-check timer`);
    assert.ok(pending[0] > s.h.clock.now(), `${label}: timer armed for <= now`);
  }
  if (s.h.goalStore.goal.status === "paused" && s.core.ownedGoalId() === "g1") {
    assert.equal(pending.length, 1, `${label}: owned goal paused without a pending timer`);
  }
}

for (const [name, resetOf] of [["resetAt 1 min in the past", (at) => at - 60000], ["resetAt null (reset unknown)", () => null]]) {
  test(`over threshold with ${name}: re-checks once per minute, no loop, released once at the 10% poll`, async () => {
    const s = setup(resetOf);
    try {
      s.h.installFakeGoalExtension();
      await s.h.fire("session_start", { type: "session_start" });
      assert.equal(s.core.isParked(), true);
      assert.equal(s.core.state.parkState, "park-wait");
      assert.equal(s.core.state.resetAt, null);
      assert.equal(s.h.goalStore.goal.status, "paused");
      assertInvariant(s, "after session_start");
      // 10 min in 5 s steps, with turn_end + agent_settled boundaries at every step.
      let releasedAt = null;
      for (let step = 1; step <= 120; step++) {
        await s.h.clock.tick(5000);
        assertInvariant(s, `t+${step * 5}s tick`);
        await s.h.fire("turn_end", { type: "turn_end" });
        await s.h.fire("agent_settled", { type: "agent_settled" });
        assertInvariant(s, `t+${step * 5}s boundaries`);
        if (s.polls.length < 4) assert.equal(s.core.isParked(), true, `released before the 10% poll at t+${step * 5}s`);
        if (releasedAt === null && !s.core.isParked()) releasedAt = s.h.clock.now() - T0;
        // Bounded: one poll at start, then at most one per elapsed minute.
        assert.ok(s.polls.length <= 1 + Math.floor((step * 5000) / 60000), `t+${step * 5}s: ${s.polls.length} polls`);
      }
      // Parked: start + 3 one-minute re-checks; the 4th (10%) releases. Later polls are ordinary unparked boundaries.
      assert.deepEqual(s.polls.slice(0, 4).map((at) => at - T0), [0, 60000, 120000, 180000]);
      assert.equal(releasedAt, 180000);
      assert.equal(s.core.isParked(), false);
      assert.equal(s.h.goalStore.goal.status, "active");
      assert.deepEqual(s.h.goalStore.setStatusCalls, ["paused", "active"]);
      assert.equal(s.h.eventsEmitted.filter((e) => e.name === "goal_store_changed").length, 1);
      assert.equal(s.h.eventsEmitted.filter((e) => e.name === "keepalive:park" && e.payload.state === "ok").length, 1);
      assert.deepEqual(s.h.sentUserMessages, []);
      assert.deepEqual(s.h.clock.pendingTimers(), []);
      assert.deepEqual(s.h.shutdownCalls, []);
    } finally { s.h.cleanup(); }
  });
}

test("a fresh shared snapshot whose reset already passed is bypassed for an endpoint read", async () => {
  const h = createHarness({ model: CLAUDE, branch: PRIOR_TURN, goal: GOAL, now: T0, env: {} });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fake" } });
  writeSharedSnapshot({ homeDir: h.tmpHome, snapshot: snap(95, T0 - 60000), observedAt: T0 });
  let calls = 0;
  const core = startKeepalive(h.pi, h.deps({ readUsage: async () => { calls++; return snap(10, T0 + 3600000); } }));
  try {
    await h.fire("session_start", { type: "session_start" });
    assert.equal(calls, 1);
    assert.equal(core.isParked(), false);
    assert.equal(h.goalStore.goal.status, "active");
  } finally { h.cleanup(); }
});
