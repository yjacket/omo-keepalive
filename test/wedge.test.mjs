// Live-QA regressions: (1) a park released at the end of a warm turn wedged the session in "Working";
// (2) the "goal is held until the reset" notice was overwritten on screen. Real core + harness, handlers run
// sequentially in senpi's event order (turn_end, agent_end, agent_settled).
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, GOAL_CONTINUATION_TEXT } from "./harness.mjs";
import { startLimitless } from "../extension/limitless.mjs";
import { GOAL_HELD_NOTICE_TYPE, hhmm } from "../extension/core.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 2 * 3600000;
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR_TURN = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const GOAL = { id: "g1", status: "active", objective: "work" };
const WARM_MS = 600000;
const goalEmits = (h) => h.eventsEmitted.filter((e) => e.name === "goal_store_changed").length;
const start = { type: "session_start", reason: "startup" };

function setup({ goal = GOAL, branch = PRIOR_TURN } = {}) {
  let util = 95;
  const h = createHarness({ model: CLAUDE, branch, goal, now: T0, env: { OMO_LIMITLESS_WARM_INTERVAL_MS: String(WARM_MS) } });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  const readUsage = async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: util, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  });
  const core = startLimitless(h.pi, h.deps({ readUsage }));
  h.installFakeGoalExtension();
  return { h, core, setUtil: (value) => { util = value; } };
}

// The agent starts the queued warm turn the way senpi does and leaves the run busy (idle=false).
async function beginWarmTurn(h) {
  await h.clock.tick(WARM_MS);
  const [warm] = h.queuedTurns.splice(0);
  assert.ok(warm, "the warm timer queued a warm turn");
  await h.fire("before_agent_start", { type: "before_agent_start", trigger: warm.trigger, prompt: warm.prompt, systemPrompt: "", systemPromptOptions: {} });
  h.setIdle(false);
}

const endRun = async (h) => {
  await h.fire("agent_end", { type: "agent_end", messages: [] });
  h.setIdle(true);
  await h.fire("agent_settled", { type: "agent_settled" });
};

test("release at the turn_end of a warm turn queues no message and restarts the goal once at agent_settled", async () => {
  const { h, core, setUtil } = setup();
  try {
    await h.fire("session_start", start);
    assert.equal(h.goalStore.goal.status, "paused");
    await beginWarmTurn(h);
    setUtil(10);
    h.clock.advance(61000);
    await h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
    assert.equal(core.isParked(), false);
    assert.equal(h.goalStore.goal.status, "active");
    // A followUp queued from turn_end lands after the agent core's last queue poll and is never drained (live wedge).
    assert.deepEqual(h.sentUserMessages, []);
    assert.deepEqual(h.sentMessages.filter((m) => m.opts?.deliverAs === "followUp"), []);
    assert.equal(goalEmits(h), 0, "no goal_store_changed while the run is active");
    await h.fire("agent_end", { type: "agent_end", messages: [] });
    assert.equal(goalEmits(h), 0);
    h.setIdle(true);
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(goalEmits(h), 1);
    assert.equal(h.queuedTurns.length, 1, "the goal extension queued its continuation turn");
    assert.equal(h.queuedTurns[0].prompt, GOAL_CONTINUATION_TEXT);
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(goalEmits(h), 1, "the restart is delivered once");
  } finally { h.cleanup(); }
});

test("reset landing between agent_end and agent_settled of a warm turn restarts the goal once", async () => {
  const { h, core, setUtil } = setup();
  try {
    await h.fire("session_start", start);
    await beginWarmTurn(h);
    await h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
    await h.fire("agent_end", { type: "agent_end", messages: [] });
    setUtil(10);
    h.clock.advance(61000);
    await core.resetDue();
    assert.equal(h.goalStore.goal.status, "active");
    assert.deepEqual(h.sentUserMessages, []);
    assert.equal(goalEmits(h), 0);
    h.setIdle(true);
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(goalEmits(h), 1);
    assert.equal(h.queuedTurns.length, 1);
  } finally { h.cleanup(); }
});

test("reset landing after agent_settled restarts the goal immediately and a later settle adds nothing", async () => {
  const { h, core, setUtil } = setup();
  try {
    await h.fire("session_start", start);
    await beginWarmTurn(h);
    await h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
    await endRun(h);
    setUtil(10);
    h.clock.advance(61000);
    await core.resetDue();
    assert.equal(goalEmits(h), 1);
    assert.equal(h.queuedTurns.length, 1);
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(goalEmits(h), 1);
  } finally { h.cleanup(); }
});

test("a run that starts before agent_settled owns the restart: no extra goal_store_changed", async () => {
  const { h, core, setUtil } = setup();
  try {
    await h.fire("session_start", start);
    await beginWarmTurn(h);
    setUtil(10);
    h.clock.advance(61000);
    await h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
    assert.equal(core.isParked(), false);
    // The goal extension's own agent_end continuation starts the next run before the settle.
    await h.fire("agent_end", { type: "agent_end", messages: [] });
    await h.fire("before_agent_start", { type: "before_agent_start", trigger: "extension", prompt: GOAL_CONTINUATION_TEXT, systemPrompt: "", systemPromptOptions: {} });
    h.setIdle(true);
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(goalEmits(h), 0);
  } finally { h.cleanup(); }
});

test("a release that is re-parked before agent_settled does not restart the goal", async () => {
  const { h, core, setUtil } = setup();
  try {
    await h.fire("session_start", start);
    await beginWarmTurn(h);
    setUtil(10);
    h.clock.advance(61000);
    await h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
    assert.equal(h.goalStore.goal.status, "active");
    setUtil(95);
    h.clock.advance(61000);
    await h.fire("agent_end", { type: "agent_end", messages: [] });
    h.setIdle(true);
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(core.isParked(), true);
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(goalEmits(h), 0);
  } finally { h.cleanup(); }
});

const HELD = `goal은 ${hhmm(RESET)} 리셋 뒤 시작합니다. 지금 돌리려면 /limitless resume`;
const heldNotices = (h) => h.sentMessages.filter((m) => m.msg.customType === GOAL_HELD_NOTICE_TYPE);

test("a goal paused by a park refresh after the episode notice was spent still announces it, once, as a persistent message", async () => {
  const { h, core } = setup({ goal: null });
  try {
    await h.fire("session_start", start);
    assert.equal(h.notifications.length, 1, "episode notice at session start");
    h.setGoal(GOAL);
    h.clock.advance(61000);
    // A boundary poll re-parks (park refresh) and pauses the new goal before any goal_store_changed handler runs.
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(core.ownedGoalId(), "g1");
    assert.deepEqual(heldNotices(h).map((m) => [m.msg.content, m.msg.display]), [[HELD, true]]);
    await h.pi.events.emit("goal_store_changed", { threadId: "s1" });
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(heldNotices(h).length, 1, "the held goal is announced once");
    assert.equal(h.notifications.length, 1, "no transient status line that the next status could overwrite");
  } finally { h.cleanup(); }
});

test("concurrent pause callers share one pause and the notice is posted when any of them wants it", async () => {
  const { h, core } = setup({ goal: null });
  try {
    await h.fire("session_start", start);
    h.setGoal(GOAL);
    const [a, b] = await Promise.all([core.pauseActiveGoal({ notice: false }), core.pauseActiveGoal({ notice: true })]);
    assert.equal(a, "g1");
    assert.equal(b, "g1");
    assert.deepEqual(h.goalStore.setStatusCalls, ["paused"]);
    assert.equal(heldNotices(h).length, 1);
  } finally { h.cleanup(); }
});

test("the first park carries the goal in its own episode notice and posts no second one", async () => {
  const { h } = setup();
  try {
    await h.fire("session_start", start);
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0].text, /goal을 멈췄고/);
    assert.equal(heldNotices(h).length, 0);
  } finally { h.cleanup(); }
});
