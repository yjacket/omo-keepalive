// Live-QA regressions: (1) a park released at the end of an automatic run wedged the session in "Working";
// (2) the "goal is held until the reset" notice was overwritten on screen. Real core + harness, handlers run
// sequentially in senpi's event order (turn_end, agent_end, agent_settled).
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, GOAL_CONTINUATION_TEXT } from "./harness.mjs";
import { startKeepalive } from "../extension/keepalive.mjs";
import { hhmm } from "../extension/core.mjs";

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
  const h = createHarness({ model: CLAUDE, branch, goal, now: T0, env: { OMO_KEEPALIVE_WARM_INTERVAL_MS: String(WARM_MS) } });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  const readUsage = async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: util, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  });
  const core = startKeepalive(h.pi, h.deps({ readUsage }));
  h.installFakeGoalExtension();
  return { h, core, setUtil: (value) => { util = value; } };
}

// An automatic run while parked (a monitor or notification turn), started the way senpi starts an extension run
// and left busy (idle=false). Warming itself never starts a run: keepwarm pings outside the conversation.
async function beginAutomatedTurn(h) {
  await h.clock.tick(WARM_MS);
  assert.deepEqual(h.queuedTurns.splice(0), [], "keepalive queues no turn of its own while waiting");
  await h.fire("before_agent_start", { type: "before_agent_start", trigger: "extension", prompt: "monitor event", systemPrompt: "", systemPromptOptions: {} });
  h.setIdle(false);
}

const endRun = async (h) => {
  await h.fire("agent_end", { type: "agent_end", messages: [] });
  h.setIdle(true);
  await h.fire("agent_settled", { type: "agent_settled" });
};

test("release at the turn_end of an automatic run queues no message and restarts the goal once at agent_settled", async () => {
  const { h, core, setUtil } = setup();
  try {
    await h.fire("session_start", start);
    assert.equal(h.goalStore.goal.status, "paused");
    await beginAutomatedTurn(h);
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

test("reset landing between agent_end and agent_settled of an automatic run restarts the goal once", async () => {
  const { h, core, setUtil } = setup();
  try {
    await h.fire("session_start", start);
    await beginAutomatedTurn(h);
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
    await beginAutomatedTurn(h);
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
    await beginAutomatedTurn(h);
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
    await beginAutomatedTurn(h);
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

const HELD = `goal은 ${hhmm(RESET)} 리셋 뒤 시작합니다. 지금 돌리려면 /keepalive resume`;

test("a goal paused by a park refresh after the episode notice was spent still announces it, once, in the notice widget", async () => {
  const { h, core } = setup({ goal: null });
  try {
    await h.fire("session_start", start);
    assert.match(h.notice(), /goal이 없어 작업은 그대로 할 수 있습니다/, "no-goal episode notice in the widget at session start");
    assert.equal(h.notifications.length, 0, "the episode notice is a widget");
    h.setGoal(GOAL);
    h.clock.advance(61000);
    // A boundary poll re-parks (park refresh) and pauses the new goal before any goal_store_changed handler runs.
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(core.ownedGoalId(), "g1");
    assert.equal(h.notice(), HELD);
    await h.pi.events.emit("goal_store_changed", { threadId: "s1" });
    await h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(h.notice(), HELD, "the held goal is announced once");
    assert.deepEqual(h.sentMessages, []);
    assert.equal(h.notifications.length, 0, "no transient status line that the next status could overwrite");
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
    assert.equal(h.notice(), HELD);
  } finally { h.cleanup(); }
});

test("the first park carries the goal in its own episode notice and posts no second one", async () => {
  const { h } = setup();
  try {
    await h.fire("session_start", start);
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(h.notifications.length, 0, "the goal park notice is a persistent message, not a status line");
    assert.match(h.notice(), /goal을 멈췄고/);
    assert.doesNotMatch(h.notice(), /리셋 뒤 시작/);
    assert.deepEqual(h.sentMessages, []);
  } finally { h.cleanup(); }
});

const turnEnd = (h) => h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });

test("notices never steer and waiting sends no conversation message", async () => {
  for (const idle of [true, false]) {
    const { h } = setup({ goal: null });
    try {
      await h.fire("session_start", start);
      h.setIdle(idle);
      h.setGoal(GOAL);
      h.clock.advance(61000);
      await h.fire("agent_settled", { type: "agent_settled" });
      assert.equal(h.notice(), HELD, `held notice shown (idle=${idle})`);
      assert.deepEqual(h.sentMessages, []);
    } finally { h.cleanup(); }
  }
  const { h } = setup();
  try {
    await h.fire("session_start", start);
    await h.clock.tick(WARM_MS * 3);
    assert.match(h.notice(), /goal을 멈췄고/);
    assert.deepEqual(h.sentMessages, [], "warming sends nothing into the conversation");
    assert.deepEqual(h.queuedTurns, []);
  } finally { h.cleanup(); }
});

test("an automatic continuation (agent_start without before_agent_start) owns the restart: no goal_store_changed, no extra turn", async () => {
  const { h, core, setUtil } = setup();
  try {
    await h.fire("session_start", start);
    await beginAutomatedTurn(h);
    setUtil(10);
    h.clock.advance(61000);
    await turnEnd(h);
    assert.equal(core.isParked(), false);
    await h.fire("agent_end", { type: "agent_end", messages: [] });
    await h.fire("agent_start", { type: "agent_start" });
    await turnEnd(h);
    await endRun(h);
    assert.equal(goalEmits(h), 0);
    assert.equal(h.queuedTurns.length, 0);
  } finally { h.cleanup(); }
});

test("a session reset drops the pending restart kick", async () => {
  const { h, core, setUtil } = setup();
  try {
    await h.fire("session_start", start);
    await beginAutomatedTurn(h);
    setUtil(10);
    h.clock.advance(61000);
    await turnEnd(h);
    assert.equal(core.isParked(), false);
    core.handleSessionShutdown();
    await endRun(h);
    assert.equal(goalEmits(h), 0);
  } finally { h.cleanup(); }
});
