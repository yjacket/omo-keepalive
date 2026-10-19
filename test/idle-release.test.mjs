import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { startKeepalive } from "../extension/keepalive.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const GOAL = { id: "g1", status: "active", objective: "work" };

function setup(extra = {}) {
  const h = createHarness({ now: T0, goal: GOAL, ...extra });
  const core = startKeepalive(h.pi, h.deps());
  return { h, core };
}

test("release while idle with senpi's queued messages pending: no emit until the draining run, whose agent_start owns the restart", async () => {
  const { h, core } = setup();
  try {
    h.installFakeGoalExtension();
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await core.pauseActiveGoal();
    assert.equal(h.goalStore.goal.status, "paused");
    h.setIdle(true);
    h.setPendingMessages(true);
    assert.equal(await core.releaseOwnedGoal({ reason: "test" }), true);
    const emits = () => h.eventsEmitted.filter((e) => e.name === "goal_store_changed").length;
    assert.equal(emits(), 0, "idle but pending: no emit (the fake goal extension would decline anyway)");
    assert.deepEqual(h.sentUserMessages, []);
    // senpi's scheduled continuation drains the queue: agent_start, run, agent_settled.
    h.setIdle(false);
    h.setPendingMessages(false);
    await h.fire("agent_start", { type: "agent_start" });
    await h.fire("agent_end", { type: "agent_end", messages: [] });
    h.setIdle(true);
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(emits(), 0, "the draining run owns the restart; the goal extension's own agent_end re-queues");
    assert.equal(h.goalStore.goal.status, "active");
  } finally { h.cleanup(); }
});

test("release while idle with pending messages and no run starting still emits once at agent_settled", async () => {
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await core.pauseActiveGoal();
    h.setIdle(true);
    h.setPendingMessages(true);
    await core.releaseOwnedGoal({ reason: "test" });
    h.setPendingMessages(false);
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(h.eventsEmitted.filter((e) => e.name === "goal_store_changed").length, 1);
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(h.eventsEmitted.filter((e) => e.name === "goal_store_changed").length, 1);
  } finally { h.cleanup(); }
});
