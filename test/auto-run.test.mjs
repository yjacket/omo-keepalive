import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { startLimitless } from "../extension/limitless.mjs";

// Senpi starts an automatic goal continuation from its followUp queue with agent_start and message_start but no
// before_agent_start (agent-session.js _scheduleContinuationAfterCurrentEvent :6733). These tests use that order.
const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 2 * 3600000;
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const GOAL = { id: "g1", status: "active", objective: "work" };
const TOOLS = ["read", "bash", "edit", "task"];

const PRIOR_TURN = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];

async function parked() {
  const h = createHarness({ model: CLAUDE, now: T0, branch: PRIOR_TURN });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  const readUsage = async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: 95, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  });
  const core = startLimitless(h.pi, h.deps({ readUsage }));
  await h.fire("session_start", { type: "session_start", reason: "startup" });
  assert.equal(core.isParked(), true);
  h.setGoal(GOAL);
  await h.pi.events.emit("goal_store_changed", { threadId: "s1" });
  assert.equal(h.goalStore.goal.status, "paused");
  return { h, core };
}

test("a goal continuation that starts automatically after the park runs zero tools", async () => {
  const { h } = await parked();
  try {
    const run = await h.runAutoRun({ kind: "goal", tools: TOOLS });
    assert.deepEqual(run.executed, []);
    assert.equal(run.blocked.length, TOOLS.length);
  } finally { h.cleanup(); }
});

test("an automatic goal continuation that finds the goal still active pauses it and runs zero tools", async () => {
  const { h } = await parked();
  try {
    h.setGoal(GOAL);
    const run = await h.runAutoRun({ kind: "goal", tools: TOOLS });
    assert.deepEqual(run.executed, []);
    assert.equal(h.goalStore.goal.status, "paused");
  } finally { h.cleanup(); }
});

test("a user chat turn during the park still runs non-task tools, and the goal block ends with its run", async () => {
  const { h, core } = await parked();
  try {
    const goalRun = await h.runAutoRun({ kind: "goal", tools: ["read"] });
    assert.deepEqual(goalRun.executed, []);
    assert.equal(core.blockAllToolsInTurn(), false, "the mark clears at agent_end");
    const queuedUser = await h.runAutoRun({ kind: "user", tools: TOOLS });
    assert.deepEqual(queuedUser.executed, ["read", "bash", "edit"]);
    assert.deepEqual(queuedUser.blocked.map((b) => b.toolName), ["task"]);
    const typed = await h.runTurn({ tools: TOOLS });
    assert.deepEqual(typed.executed, ["read", "bash", "edit"]);
  } finally { h.cleanup(); }
});

test("an automatic goal continuation while not parked is untouched", async () => {
  const h = createHarness({ model: CLAUDE, now: T0 });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  startLimitless(h.pi, h.deps({ readUsage: async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: 10, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  }) }));
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const run = await h.runAutoRun({ kind: "goal", tools: TOOLS });
    assert.deepEqual(run.executed, TOOLS);
  } finally { h.cleanup(); }
});

test("a warm timer callback already running when the session shuts down drops its effects (real core)", async () => {
  const { h, core } = await parked();
  try {
    assert.ok(core.timers.has("warm"), "park-wait on Claude arms the warm timer");
    let entered;
    const reading = new Promise((resolve) => { entered = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const realRead = h.goalStore.read;
    h.goalStore.read = async (...args) => { entered(); await gate; return realRead(...args); };
    const ticking = h.clock.tick(55 * 60_000); // the warm callback starts and parks inside the goal read
    await reading;
    await h.fire("session_shutdown", { type: "session_shutdown" });
    release();
    await ticking;
    assert.deepEqual(h.sentMessages.filter((m) => m.msg.customType === "limitless-warm"), []);
    assert.equal(core.timers.has("warm"), false);
  } finally { h.cleanup(); }
});

test("a goal run retried after a provider error (agent_end.willRetry) keeps its tool block until the final agent_end", async () => {
  const { h, core } = await parked();
  try {
    const call = async (toolName) => (await h.fire("tool_call", { type: "tool_call", toolName, toolCallId: toolName, input: {} }))
      .some((result) => result?.block === true);
    await h.fire("agent_start", { type: "agent_start" });
    await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "goal-continuation", content: "go", display: false } });
    assert.equal(await call("read"), true);
    // senpi agent_end carries willRetry (agent-abort-provenance.js:50-54); the retry is agent.continue(): agent_start only.
    await h.fire("agent_end", { type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error", content: [] }] });
    await h.fire("agent_start", { type: "agent_start" });
    assert.equal(await call("read"), true, "the retried run is still the goal's run");
    await h.fire("agent_end", { type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
    assert.equal(core.blockAllToolsInTurn(), false);
    assert.equal(await call("read"), false);
  } finally { h.cleanup(); }
});

// F3b s4: the goal's run was already looping tool calls when the park landed at a turn boundary.
async function midRunPark(kind, { steer = false, afterPark } = {}) {
  let util = 10;
  const h = createHarness({ model: CLAUDE, now: T0, branch: PRIOR_TURN, goal: GOAL });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  const core = startLimitless(h.pi, h.deps({ readUsage: async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: util, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  }) }));
  await h.fire("session_start", { type: "session_start", reason: "startup" });
  assert.equal(core.isParked(), false);
  const call = async (toolName) => (await h.fire("tool_call", { type: "tool_call", toolName, toolCallId: toolName, input: {} }))
    .some((result) => result?.block === true);
  await h.fire("agent_start", { type: "agent_start" });
  const message = kind === "goal"
    ? { role: "custom", customType: "goal-continuation", content: "go", display: false }
    : { role: "user", content: [{ type: "text", text: "keep editing" }] };
  await h.fire("message_start", { type: "message_start", message });
  if (steer) await h.fire("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "steer" }] } });
  const blocked = [];
  const turn = async (toolName) => {
    blocked.push(await call(toolName));
    await h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
  };
  await turn("edit");
  await turn("edit");
  util = 95; // the park lands at the next boundary, after the 2nd tool call
  h.clock.advance(61_000);
  await h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
  assert.equal(core.isParked(), true);
  await afterPark?.(h);
  await turn("edit");
  await turn("bash");
  const task = await call("task");
  return { h, blocked, task };
}

test("park landing mid-run stops a goal-driven run: the 3rd and later tool calls are blocked", async () => {
  const { h, blocked, task } = await midRunPark("goal");
  try {
    assert.deepEqual(blocked, [false, false, true, true]);
    assert.equal(task, true);
  } finally { h.cleanup(); }
});

test("park landing mid-run leaves a user-initiated run's non-task tools alone", async () => {
  const { h, blocked, task } = await midRunPark("user");
  try {
    assert.deepEqual(blocked, [false, false, false, false]);
    assert.equal(task, true, "task stays blocked while parked");
  } finally { h.cleanup(); }
});

test("a user message steered into a goal run (not yet parked) keeps non-task tools after the park (IS-6)", async () => {
  const { h, blocked, task } = await midRunPark("goal", { steer: true });
  try {
    assert.deepEqual(blocked, [false, false, false, false]);
    assert.equal(task, true);
  } finally { h.cleanup(); }
});

test("a goal run whose retry never ran (willRetry then agent_settled) no longer blocks tools", async () => {
  const { h, blocked } = await midRunPark("goal", { afterPark: async (harness) => {
    await harness.fire("agent_end", { type: "agent_end", willRetry: true, messages: [] });
    await harness.fire("agent_settled", { type: "agent_settled" });
  } });
  try {
    assert.deepEqual(blocked, [false, false, false, false]);
  } finally { h.cleanup(); }
});

test("a user message steered into a blocked goal wait run (parked before it started) keeps non-task tools", async () => {
  const { h, core } = await parked();
  try {
    const call = async (toolName) => (await h.fire("tool_call", { type: "tool_call", toolName, toolCallId: toolName, input: {} }))
      .some((result) => result?.block === true);
    await h.fire("agent_start", { type: "agent_start" });
    await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "goal-continuation", content: "go", display: false } });
    assert.equal(await call("read"), true, "the goal wait turn is blocked before any user message");
    await h.fire("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "steer" }] } });
    assert.equal(core.blockAllToolsInTurn(), false);
    assert.equal(await call("read"), false);
    assert.equal(await call("bash"), false);
    assert.equal(await call("task"), true, "task stays blocked while parked");
  } finally { h.cleanup(); }
});

test("a user message steered into a warm turn keeps non-task tools; the warm turn blocks everything before it", async () => {
  const { h, core } = await parked();
  try {
    const call = async (toolName) => (await h.fire("tool_call", { type: "tool_call", toolName, toolCallId: toolName, input: {} }))
      .some((result) => result?.block === true);
    core.markExtensionTurn("warm");
    assert.equal(await call("read"), true);
    await h.fire("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "steer" }] } });
    assert.equal(await call("read"), false);
    assert.equal(await call("bash"), false);
    assert.equal(await call("task"), true);
  } finally { h.cleanup(); }
});

test("P5: a warm turn ends ok, then senpi's todo-owed backstop starts a run: zero tools run while parked", async () => {
  const { h, core } = await parked();
  try {
    core.markExtensionTurn("warm");
    await h.fire("agent_start", { type: "agent_start" });
    await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "limitless-warm", content: "warm", display: false } });
    await h.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
    await h.fire("agent_settled", { type: "agent_settled" });
    const run = await h.runAutoRun({ kind: "todo-owed", tools: TOOLS });
    assert.deepEqual(run.executed, []);
    assert.equal(run.blocked.length, TOOLS.length);
  } finally { h.cleanup(); }
});

test("a user message steered into a todo-owed run while parked keeps non-task tools", async () => {
  const { h, core } = await parked();
  try {
    const call = async (toolName) => (await h.fire("tool_call", { type: "tool_call", toolName, toolCallId: toolName, input: {} }))
      .some((result) => result?.block === true);
    await h.fire("agent_start", { type: "agent_start" });
    await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "senpi.todo-owed", content: "todo", display: false } });
    assert.equal(await call("read"), true);
    await h.fire("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "steer" }] } });
    assert.equal(core.blockAllToolsInTurn(), false);
    assert.equal(await call("read"), false);
    assert.equal(await call("task"), true);
  } finally { h.cleanup(); }
});

test("control: a todo-owed run while not parked runs tools normally", async () => {
  const h = createHarness({ model: CLAUDE, now: T0, goal: GOAL, branch: PRIOR_TURN });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  startLimitless(h.pi, h.deps({ readUsage: async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: 10, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  }) }));
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const run = await h.runAutoRun({ kind: "todo-owed", tools: TOOLS });
    assert.deepEqual(run.executed, TOOLS);
  } finally { h.cleanup(); }
});

// P6 (IS-1): the automatic-run tool block only applies while limitless holds the goal paused.
for (const [label, goal] of [
  ["no goal", null],
  ["a goal the user paused", { id: "g2", status: "paused", objective: "w" }],
  ["a completed goal", { id: "g3", status: "complete", objective: "w" }],
  ["a blocked goal", { id: "g4", status: "blocked", objective: "w" }],
]) {
  for (const kind of ["todo-owed", "goal"]) {
    test(`P6: parked with ${label}, an automatic ${kind} run runs every tool`, async () => {
      const h = createHarness({ model: CLAUDE, now: T0, branch: PRIOR_TURN, goal });
      h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
      const core = startLimitless(h.pi, h.deps({ readUsage: async () => ({
        provider: "anthropic-subscription", account: "default",
        windows: [{ kind: "five_hour", utilization: 95, resetAt: RESET }], overageEnabled: false, source: "endpoint",
      }) }));
      try {
        await h.fire("session_start", { type: "session_start", reason: "startup" });
        assert.equal(core.isParked(), true);
        assert.equal(core.ownedGoalId(), null);
        const run = await h.runAutoRun({ kind, tools: TOOLS });
        assert.deepEqual(run.executed, TOOLS);
      } finally { h.cleanup(); }
    });
  }
}
