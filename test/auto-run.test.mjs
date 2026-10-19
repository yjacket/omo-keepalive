import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { startKeepalive } from "../extension/keepalive.mjs";

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
  const core = startKeepalive(h.pi, h.deps({ readUsage }));
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
  startKeepalive(h.pi, h.deps({ readUsage: async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: 10, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  }) }));
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const run = await h.runAutoRun({ kind: "goal", tools: TOOLS });
    assert.deepEqual(run.executed, TOOLS);
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
  const core = startKeepalive(h.pi, h.deps({ readUsage: async () => ({
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
    await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "keepalive-warm", content: "warm", display: false } });
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
  startKeepalive(h.pi, h.deps({ readUsage: async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: 10, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  }) }));
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const run = await h.runAutoRun({ kind: "todo-owed", tools: TOOLS });
    assert.deepEqual(run.executed, TOOLS);
  } finally { h.cleanup(); }
});

// P6 (IS-1): the automatic-run tool block only applies while keepalive holds the goal paused.
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
      const core = startKeepalive(h.pi, h.deps({ readUsage: async () => ({
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

// Any run the user did not start is blocked while keepalive holds the goal paused (F3c bug 1).
for (const customType of ["senpi-codemode:notification", "senpi-terminal:notification", "ttsr-injection", "loop-guard:recovery"]) {
  test(`a run started by a ${customType} message while owned-parked runs zero tools`, async () => {
    const { h } = await parked();
    try {
      const run = await h.runAutoRun({ kind: "custom", customType, tools: TOOLS });
      assert.deepEqual(run.executed, []);
      assert.equal(run.blocked.length, TOOLS.length);
    } finally { h.cleanup(); }
  });
  test(`a run started by a ${customType} message while keepalive does not hold the goal runs every tool`, async () => {
    const h = createHarness({ model: CLAUDE, now: T0, branch: PRIOR_TURN, goal: null });
    h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
    const core = startKeepalive(h.pi, h.deps({ readUsage: async () => ({
      provider: "anthropic-subscription", account: "default",
      windows: [{ kind: "five_hour", utilization: 95, resetAt: RESET }], overageEnabled: false, source: "endpoint",
    }) }));
    try {
      await h.fire("session_start", { type: "session_start", reason: "startup" });
      assert.equal(core.ownedGoalId(), null);
      const run = await h.runAutoRun({ kind: "custom", customType, tools: TOOLS });
      assert.deepEqual(run.executed, TOOLS);
    } finally { h.cleanup(); }
  });
}

test("an extension-triggered before_agent_start run while owned-parked runs zero tools", async () => {
  const { h } = await parked();
  try {
    const run = await h.runTurn({ trigger: "extension", prompt: "background cell finished", tools: TOOLS });
    assert.deepEqual(run.executed, []);
  } finally { h.cleanup(); }
});

test("a typed prompt run while owned-parked blocks only task/task_create, even with extension messages after the user message", async () => {
  const { h } = await parked();
  try {
    const call = async (toolName) => (await h.fire("tool_call", { type: "tool_call", toolName, toolCallId: toolName, input: {} }))
      .some((result) => result?.block === true);
    await h.fire("before_agent_start", { type: "before_agent_start", trigger: "prompt", prompt: "hi", systemPrompt: "", systemPromptOptions: {} });
    await h.fire("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "ttsr-injection", content: "rule", display: false } });
    assert.equal(await call("read"), false);
    assert.equal(await call("bash"), false);
    assert.equal(await call("task"), true);
    await h.fire("agent_end", { type: "agent_end", messages: [] });
  } finally { h.cleanup(); }
});

test("a user message steered into a notification-started run clears the block, and later custom messages do not re-mark it", async () => {
  const { h } = await parked();
  try {
    const call = async (toolName) => (await h.fire("tool_call", { type: "tool_call", toolName, toolCallId: toolName, input: {} }))
      .some((result) => result?.block === true);
    await h.fire("agent_start", { type: "agent_start" });
    await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "senpi-codemode:notification", content: "x", display: false } });
    assert.equal(await call("read"), true);
    await h.fire("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "steer" }] } });
    await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "senpi-terminal:notification", content: "y", display: false } });
    assert.equal(await call("read"), false);
    assert.equal(await call("task"), true);
  } finally { h.cleanup(); }
});

// Round 2: trigger "delivery", extension-sourced user prompts (input.source), the agent_end clear of the user mark.
const callTool = (h) => async (toolName) => (await h.fire("tool_call", { type: "tool_call", toolName, toolCallId: toolName, input: {} }))
  .some((result) => result?.block === true);
const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });
async function unownedParked() {
  const h = createHarness({ model: CLAUDE, now: T0, branch: PRIOR_TURN, goal: null });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  const core = startKeepalive(h.pi, h.deps({ readUsage: async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: 95, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  }) }));
  await h.fire("session_start", { type: "session_start", reason: "startup" });
  assert.equal(core.ownedGoalId(), null);
  return h;
}
const DELIVERY = { role: "custom", customType: "session_control_delivery", content: "from another session", display: false, details: { delivery_id: "d1" } };

test("P8.1: an idle session_control_delivery run (before_agent_start trigger delivery) while owned-parked runs zero tools", async () => {
  const { h } = await parked();
  try {
    await h.fire("before_agent_start", { type: "before_agent_start", trigger: "delivery", prompt: "from another session", systemPrompt: "", systemPromptOptions: {} });
    await h.fire("agent_start", { type: "agent_start" });
    await h.fire("message_start", { type: "message_start", message: DELIVERY });
    const call = callTool(h);
    assert.equal(await call("read"), true);
    assert.equal(await call("bash"), true);
  } finally { h.cleanup(); }
});

test("P8.1 control: the same delivery run when keepalive does not hold the goal runs every tool", async () => {
  const h = await unownedParked();
  try {
    const run = await h.runTurn({ trigger: "delivery", prompt: "from another session", tools: TOOLS });
    assert.deepEqual(run.executed, TOOLS);
  } finally { h.cleanup(); }
});

test("P8.2: a queued session_control_delivery followUp run (no before_agent_start) while owned-parked runs zero tools; not owned runs all", async () => {
  const { h } = await parked();
  try {
    const run = await h.runAutoRun({ kind: "custom", customType: "session_control_delivery", tools: TOOLS });
    assert.deepEqual(run.executed, []);
  } finally { h.cleanup(); }
  const free = await unownedParked();
  try {
    const run = await free.runAutoRun({ kind: "custom", customType: "session_control_delivery", tools: TOOLS });
    assert.deepEqual(run.executed, TOOLS);
  } finally { free.cleanup(); }
});

async function promptRun(h, source) {
  await h.fire("input", { type: "input", inputId: "s1:1", text: "go", source });
  await h.fire("before_agent_start", { type: "before_agent_start", trigger: "prompt", prompt: "go", systemPrompt: "", systemPromptOptions: {} });
  await h.fire("agent_start", { type: "agent_start" });
  await h.fire("message_start", { type: "message_start", message: userMsg("go") });
  const call = callTool(h);
  return { read: await call("read"), bash: await call("bash"), task: await call("task") };
}

test("P8.3: prompts from any input source (typed, rpc, extension sendUserMessage) while owned-parked keep non-task tools", async () => {
  for (const source of ["interactive", "rpc", "extension"]) {
    const { h } = await parked();
    try { assert.deepEqual(await promptRun(h, source), { read: false, bash: false, task: true }, source); } finally { h.cleanup(); }
  }
});

test("P8.3 control: an extension-sourced prompt when keepalive does not hold the goal runs every tool", async () => {
  const h = await unownedParked();
  try { assert.deepEqual(await promptRun(h, "extension"), { read: false, bash: false, task: false }); } finally { h.cleanup(); }
});

// Q1-Q3 (verifier round 7): inputs queued while a notification-started run is busy; the user's own message keeps
// read and bash in every drain order.
const busyAutoRun = async (h) => {
  await h.fire("agent_start", { type: "agent_start" });
  await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "senpi-codemode:notification", content: "cell done", display: false } });
  assert.equal(await callTool(h)("read"), true, "the notification run is blocked until a user message arrives");
};
const queueInput = (h, source, text, streamingBehavior) => h.fire("input", { type: "input", inputId: `q:${text}`, text, source, streamingBehavior });
const userKeepsTools = async (h) => {
  const call = callTool(h);
  assert.equal(await call("read"), false);
  assert.equal(await call("bash"), false);
  assert.equal(await call("task"), true);
};

test("Q1: ext prompt then typed message queued and drained into the same run: both keep non-task tools", async () => {
  const { h } = await parked();
  try {
    await busyAutoRun(h);
    await queueInput(h, "extension", "loop tick", "followUp");
    await queueInput(h, "interactive", "typed", "followUp");
    await h.fire("message_start", { type: "message_start", message: userMsg("loop tick") });
    await userKeepsTools(h);
    await h.fire("message_start", { type: "message_start", message: userMsg("typed") });
    await userKeepsTools(h);
  } finally { h.cleanup(); }
});

test("Q1b/Q2: queued ext prompt and typed message drained in new followUp runs, either order, keep non-task tools", async () => {
  for (const order of [["extension", "interactive"], ["interactive", "extension"]]) {
    const { h } = await parked();
    try {
      await busyAutoRun(h);
      for (const source of order) await queueInput(h, source, source, "followUp");
      await h.fire("agent_end", { type: "agent_end", messages: [] });
      for (const source of order) {
        await h.fire("agent_start", { type: "agent_start" });
        await h.fire("message_start", { type: "message_start", message: userMsg(source) });
        await userKeepsTools(h);
        await h.fire("agent_end", { type: "agent_end", messages: [] });
      }
    } finally { h.cleanup(); }
  }
});

test("Q3: a user steer into a blocked automatic run keeps non-task tools even with an ext prompt queued behind it", async () => {
  const { h } = await parked();
  try {
    await busyAutoRun(h);
    await queueInput(h, "interactive", "stop and do Y", "steer");
    await queueInput(h, "extension", "loop tick", "followUp");
    await h.fire("message_start", { type: "message_start", message: userMsg("stop and do Y") });
    await userKeepsTools(h);
  } finally { h.cleanup(); }
});

test("P8.8: an automatic followUp run right after a user run (no agent_settled between) is blocked", async () => {
  const { h } = await parked();
  try {
    await promptRun(h, "interactive");
    await h.fire("agent_end", { type: "agent_end", messages: [] });
    await h.fire("agent_start", { type: "agent_start" });
    await h.fire("message_start", { type: "message_start", message: { role: "custom", customType: "senpi-terminal:notification", content: "x", display: false } });
    assert.equal(await callTool(h)("read"), true);
  } finally { h.cleanup(); }
});
