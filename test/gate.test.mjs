import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, GOAL_CONTINUATION_TEXT } from "./harness.mjs";
import { startLimitless } from "../extension/limitless.mjs";
import { hhmm, statusText, STATUS_KEY, IDLE_STATUS, TEXTS } from "../extension/core.mjs";
import { snapshotPath, statePath, writeSharedSnapshot } from "../extension/state.mjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 2 * 3600000;
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR_TURN = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const GOAL = { id: "g1", status: "active", objective: "work" };

const snap = (utilization, resetAt = RESET, source = "endpoint") => ({
  provider: "anthropic-subscription", account: "default",
  windows: [{ kind: "five_hour", utilization, resetAt }], overageEnabled: false, source,
});

function setup({ util = 95, branch = [], goal = null, shared, readUsage, homeDir, env = {}, beforeStart, features, resetAt } = {}) {
  const h = createHarness({ model: CLAUDE, branch, goal, now: T0, homeDir, env });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  if (shared) writeSharedSnapshot({ homeDir: h.tmpHome, snapshot: shared.snapshot, observedAt: shared.observedAt });
  const usageCalls = [];
  const reader = readUsage ?? (async (request) => {
    usageCalls.push(request);
    return snap(typeof util === "function" ? util() : util, typeof resetAt === "function" ? resetAt() : RESET);
  });
  beforeStart?.(h);
  const core = startLimitless(h.pi, h.deps({ readUsage: reader }), features);
  const state = () => h.readHomeJson(`.omo/limitless/state/s1.json`);
  return { h, core, usageCalls, state };
}

test("session_start with a fresh shared 95% snapshot sets the status line before input and calls no endpoint", async () => {
  const { h, core, usageCalls } = setup({ shared: { snapshot: snap(95), observedAt: T0 - 10000 } });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(usageCalls.length, 0);
    assert.equal(h.statusLines.get(STATUS_KEY), statusText(RESET));
    assert.equal(h.statusLines.get(STATUS_KEY), `⏸ 한도 대기 · ${hhmm(RESET)} 재개`);
    assert.equal(core.isParked(), true);
    assert.equal(core.state.parkState, "park-wait");
  } finally { h.cleanup(); }
});

test("empty branch + ctx.model claude-sdk-oauth + shared 95% -> lane at session_start, status + notice before input, latecomer", async () => {
  const { h, core, usageCalls } = setup({ branch: [], shared: { snapshot: snap(95), observedAt: T0 - 1000 } });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(core.lane, { provider: "anthropic-subscription", accounts: ["default"] });
    assert.equal(usageCalls.length, 0);
    assert.ok(h.statusLines.get(STATUS_KEY).startsWith("⏸ 한도 대기"));
    assert.match(h.notice(), /goal이 없어 작업은 그대로 할 수 있습니다/);
    assert.equal(h.notifications.length, 0, "the no-goal notice is a widget, not a transient status line");
    assert.equal(core.isLatecomer(), true);
  } finally { h.cleanup(); }
});

test("no active goal + parked: task allowed, one notice, no pause", async () => {
  const { h, core } = setup({ branch: PRIOR_TURN });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.match(h.notice(), /goal이 없어 작업은 그대로 할 수 있습니다/);
    const first = await h.runTurn({ tools: ["task", "task_create", "read"] });
    h.clock.advance(61000);
    const second = await h.runTurn({ tools: ["task"] });
    assert.equal(core.isParked(), true);
    assert.deepEqual(first.executed, ["task", "task_create", "read"]);
    assert.deepEqual(second.executed, ["task"]);
    assert.equal(h.notifications.length, 0, "the episode notice is a widget");
    assert.deepEqual(h.goalStore.setStatusCalls, []);
  } finally { h.cleanup(); }
});

// F3 P1: the no-goal park notice must live in the same persistent widget as the goal notice, so it survives the next
// setStatus instead of being overwritten (the old core.notify path was invisible when the park started mid-session).
test("no-goal park: the widget shows the exact no-goal text, a later setStatus leaves it, release clears it", async () => {
  const { h, core } = setup({ branch: PRIOR_TURN });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(core.isParked(), true);
    const text = h.notice();
    assert.equal(text, `⏸ 사용량 한도 대기 (five_hour 95%) · ${hhmm(RESET)} 재개. goal이 없어 작업은 그대로 할 수 있습니다.`);
    assert.equal(h.notifications.length, 0, "no transient status-line notification");
    core.setStatus("some other status");
    assert.equal(h.notice(), text, "the widget is not the status line: setStatus cannot overwrite it");
    h.clock.advance(61000);
    await core.poll({ force: true }); // same-episode refresh must not post a second notice
    assert.equal(h.notice(), text, "one notice per park episode");
    assert.deepEqual(h.sentMessages, [], "never a conversation message");
    assert.deepEqual(h.sentUserMessages, []);
    await core.release({ reason: "test" });
    assert.equal(h.notice(), undefined, "release clears the no-goal notice");
  } finally { h.cleanup(); }
});

test("process restart mid-park restores the no-goal notice", async () => {
  const first = setup({ branch: PRIOR_TURN });
  try {
    await first.h.fire("session_start", { type: "session_start", reason: "startup" });
    const liveNotice = first.h.notice();
    assert.match(liveNotice, /goal이 없어 작업은 그대로 할 수 있습니다/);
    const second = setup({ branch: PRIOR_TURN, homeDir: first.h.tmpHome });
    second.h.clock.advance(5 * 60000);
    await second.h.fire("session_start", { type: "session_start", reason: "resume" });
    assert.equal(second.core.isParked(), true);
    assert.equal(second.h.notice(), liveNotice, "restart mid-park restores the no-goal notice");
    assert.equal(second.h.notifications.length, 0);
  } finally { first.h.cleanup(); }
});

test("goal activated during the park is paused in the same tick with pausedByLimitless and the exact notice", async () => {
  const { h, core, state } = setup();
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.match(h.notice(), /goal이 없어 작업은 그대로 할 수 있습니다/, "no-goal park notice first");
    h.setGoal(GOAL);
    await h.pi.events.emit("goal_store_changed", { threadId: "s1" });
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(core.ownedGoalId(), "g1");
    assert.equal(state().pausedByLimitless, "g1");
    assert.deepEqual(h.sentMessages, [], "no conversation message");
    assert.equal(h.notice(), `goal은 ${hhmm(RESET)} 리셋 뒤 시작합니다. 지금 돌리려면 /limitless resume`, "the goal text replaces the no-goal text");
    assert.doesNotMatch(h.notice(), /goal이 없어/);
    assert.equal(h.notifications.length, 0, "the goal-held notice is a widget, not a status line that the next status overwrites");
    const turn = await h.runTurn({ tools: ["task"] });
    assert.deepEqual(turn.executed, []);
  } finally { h.cleanup(); }
});

test("latecomer gets no warm turn and no park-exit; a session with prior turns may warm", async () => {
  const late = setup({ branch: [] });
  const prior = setup({ branch: PRIOR_TURN });
  const lateExit = setup({ branch: [], util: 95, readUsage: async () => snap(95, T0 + 10 * 3600000) });
  try {
    for (const s of [late, prior, lateExit]) await s.h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(late.core.isLatecomer(), true);
    assert.equal(late.core.canWarm(), false);
    assert.equal(late.state().latecomer, true);
    assert.equal(prior.core.isLatecomer(), false);
    assert.equal(prior.core.canWarm(), true);
    assert.equal(lateExit.core.state.parkState, "park-exit");
    assert.equal(lateExit.core.canParkExit(), false);
  } finally { for (const s of [late, prior, lateExit]) s.h.cleanup(); }
});

test("running goal at park: task blocked with limitless: prefix, read allowed, goal paused once and persisted", async () => {
  const { h, core, state } = setup({ branch: PRIOR_TURN, goal: GOAL });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const results = await h.fire("tool_call", { type: "tool_call", toolName: "task", toolCallId: "t1", input: {} });
    const block = results.find((r) => r?.block);
    assert.equal(block.block, true);
    assert.ok(block.reason.startsWith("limitless:"));
    assert.equal(block.reason, `limitless: usage limit five_hour 95% - resumes ${hhmm(RESET)}`);
    const readResults = await h.fire("tool_call", { type: "tool_call", toolName: "read", toolCallId: "t2", input: {} });
    assert.equal(readResults.some((r) => r?.block), false);
    await h.runTurn({ tools: ["read", "bash", "task_create"] });
    h.clock.advance(61000);
    await h.runTurn({ tools: ["task"] });
    assert.deepEqual(h.goalStore.setStatusCalls, ["paused"]);
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(state().pausedByLimitless, "g1");
    assert.equal(core.isLatecomer(), false);
    assert.equal(h.notifications.length, 0, "the goal park notice is a persistent message");
    assert.match(h.notice(), /goal을 멈췄고/);
    assert.deepEqual(h.sentMessages, []);
  } finally { h.cleanup(); }
});

test("polls are throttled to pollMinIntervalMs and N sessions share one poll through the snapshot file", async () => {
  const a = setup({ util: 50, branch: PRIOR_TURN });
  try {
    await a.h.fire("session_start", { type: "session_start", reason: "startup" });
    await a.h.runTurn();
    a.h.clock.advance(30000);
    await a.h.runTurn();
    assert.equal(a.usageCalls.length, 1);
    const shared = JSON.parse((await import("node:fs")).readFileSync(snapshotPath(a.h.tmpHome, "anthropic-subscription", "default"), "utf8"));
    assert.equal(shared.observedAt, T0);
    const b = setup({ util: 50, homeDir: a.h.tmpHome });
    b.h.clock.advance(30000);
    await b.h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(b.usageCalls.length, 0);
    a.h.clock.advance(31000);
    await a.h.runTurn();
    assert.equal(a.usageCalls.length, 2, "a snapshot older than pollMinIntervalMs is re-polled");
  } finally { a.h.cleanup(); }
});

for (const order of ["goal-handler-first", "limitless-handler-first"]) {
  test(`race (${order}): goal continuation while parked runs zero tool calls and the goal ends paused`, async () => {
    const { h, core } = setup({
      beforeStart: (harness) => { if (order === "goal-handler-first") harness.installFakeGoalExtension(); },
    });
    try {
      if (order === "limitless-handler-first") h.installFakeGoalExtension();
      await h.fire("session_start", { type: "session_start", reason: "startup" });
      h.setGoal(GOAL);
      await h.pi.events.emit("goal_store_changed", { threadId: "s1" });
      const turns = await h.runQueuedTurns(["task", "read", "bash", "edit"]);
      assert.ok(turns.length <= 1);
      assert.equal(turns.flatMap((t) => t.executed).length, 0);
      assert.equal(h.goalStore.goal.status, "paused");
      assert.deepEqual(h.goalStore.setStatusCalls, ["paused"]);
      assert.equal(core.ownedGoalId(), "g1");
    } finally { h.cleanup(); }
  });
}

test("race without a store event (/goal path): continuation turn pauses the goal and blocks every tool", async () => {
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    h.setGoal(GOAL);
    const turn = await h.runTurn({ trigger: "extension", prompt: GOAL_CONTINUATION_TEXT, tools: ["read", "task"] });
    assert.deepEqual(turn.executed, []);
    const marker = turn.before.find(Boolean).message;
    assert.equal(marker.content, TEXTS.raceNote);
    assert.equal(marker.display, false);
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(core.blockAllToolsInTurn(), false, "turn mark clears at agent_end");
    const userTurn = await h.runTurn({ tools: ["read", "task"] });
    assert.deepEqual(userTurn.executed, ["read"]);
  } finally { h.cleanup(); }
});

test("releaseOwnedGoal: idle emits goal_store_changed once, busy queues nothing and emits once at agent_settled, foreign pause untouched", async () => {
  const idle = setup({ branch: PRIOR_TURN, goal: GOAL });
  const busy = setup({ branch: PRIOR_TURN, goal: GOAL });
  const foreign = setup({ branch: PRIOR_TURN, goal: { ...GOAL, status: "paused" } });
  try {
    idle.h.installFakeGoalExtension();
    for (const s of [idle, busy, foreign]) await s.h.fire("session_start", { type: "session_start", reason: "startup" });
    await idle.core.release({ reason: "test" });
    assert.equal(await idle.core.releaseOwnedGoal({ reason: "test" }), true);
    assert.equal(idle.h.goalStore.goal.status, "active");
    assert.deepEqual(idle.h.eventsEmitted.filter((e) => e.name === "goal_store_changed"), [{ name: "goal_store_changed", payload: { threadId: "s1" } }]);
    assert.equal(idle.h.queuedTurns.length, 1, "exactly one continuation turn queued");
    assert.equal(idle.h.sentUserMessages.length, 0);
    assert.equal(await idle.core.releaseOwnedGoal({ reason: "again" }), false);

    busy.h.setIdle(false);
    await busy.core.release({ reason: "test" });
    assert.equal(await busy.core.releaseOwnedGoal({ reason: "test" }), true);
    assert.deepEqual(busy.h.sentUserMessages, []);
    assert.deepEqual(busy.h.sentMessages.filter((m) => m.opts?.triggerTurn !== false), []);
    assert.equal(busy.h.eventsEmitted.filter((e) => e.name === "goal_store_changed").length, 0);
    busy.h.setIdle(true);
    await busy.h.fire("agent_settled", { type: "agent_settled" });
    assert.equal(busy.h.eventsEmitted.filter((e) => e.name === "goal_store_changed").length, 1);

    assert.equal(foreign.core.ownedGoalId(), null);
    assert.equal(await foreign.core.releaseOwnedGoal({}), false);
    assert.equal(foreign.h.goalStore.goal.status, "paused");
    assert.deepEqual(foreign.h.goalStore.setStatusCalls, []);
  } finally { for (const s of [idle, busy, foreign]) s.h.cleanup(); }
});

test("usage reader throws: no park, no block, error recorded in the state file", async () => {
  const { h, core, state } = setup({ goal: GOAL, readUsage: async () => { throw new Error("boom endpoint"); } });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const turn = await h.runTurn({ tools: ["task"] });
    assert.deepEqual(turn.executed, ["task"]);
    assert.equal(core.isParked(), false);
    assert.equal(h.statusLines.get(STATUS_KEY), IDLE_STATUS);
    assert.equal(h.goalStore.goal.status, "active");
    assert.equal(state().lastError.message, "boom endpoint");
    assert.equal(state().parkState, "ok");
  } finally { h.cleanup(); }
});

test("corrupt state and snapshot files are treated as absent", async () => {
  const { h, core, usageCalls } = setup({
    beforeStart: (harness) => {
      for (const path of [statePath(harness.tmpHome, "s1"), snapshotPath(harness.tmpHome, "anthropic-subscription", "default")]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "{not json");
      }
    },
  });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(usageCalls.length, 1);
    assert.equal(core.isParked(), true);
  } finally { h.cleanup(); }
});

test("process restart mid-park restores the park from the state file", async () => {
  const first = setup({ branch: PRIOR_TURN, goal: GOAL });
  try {
    await first.h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(first.core.isParked(), true);
    const liveNotice = first.h.notice();
    const second = setup({ branch: PRIOR_TURN, homeDir: first.h.tmpHome, goal: { ...GOAL, status: "paused" },
      readUsage: async () => snap(0, 0, "none") });
    second.h.clock.advance(5 * 60000);
    await second.h.fire("session_start", { type: "session_start", reason: "resume" });
    assert.equal(second.core.isParked(), true);
    assert.equal(second.h.statusLines.get(STATUS_KEY), statusText(RESET));
    assert.equal(second.core.ownedGoalId(), "g1");
    assert.equal(second.h.notice(), liveNotice);
    const turn = await second.h.runTurn({ tools: ["task", "read"] });
    assert.deepEqual(turn.executed, ["read"]);
    assert.equal(second.h.notifications.length, 0, "same episode, no second notice");
  } finally { first.h.cleanup(); }
});

test("process restart with a non-parked state clears a stale notice widget", async () => {
  const { h } = setup({
    util: 10, // below threshold: no fresh park that would set a new notice
    beforeStart: (harness) => {
      harness.writeHomeJson(".omo/limitless/state/s1.json", { v: 1, parkState: "ok", armed: false });
    },
  });
  try {
    h.ctx.ui.setWidget("limitless-notice", ["stale notice"]);
    await h.fire("session_start", { type: "session_start", reason: "resume" });
    assert.equal(h.notice(), undefined);
  } finally { h.cleanup(); }
});

test("a state file whose reset already passed does not re-park; the owned goal resumes once", async () => {
  for (const reader of [async () => snap(10), async () => snap(0, 0, "none")]) {
    const { h, core } = setup({
      branch: PRIOR_TURN, goal: { ...GOAL, status: "paused" }, readUsage: reader,
      beforeStart: (harness) => harness.writeHomeJson(".omo/limitless/state/s1.json", {
        v: 1, parkState: "park-wait", armed: true, source: "poll", window: "five_hour", util: 95,
        resetAt: T0 - 1000, pausedByLimitless: "g1", episode: 1, episodeNotified: true,
      }),
    });
    try {
      await h.fire("session_start", { type: "session_start", reason: "resume" });
      assert.equal(core.isParked(), false);
      assert.equal(h.statusLines.get(STATUS_KEY), IDLE_STATUS);
      assert.equal(h.goalStore.goal.status, "active");
      assert.deepEqual(h.goalStore.setStatusCalls, ["active"]);
      assert.equal(h.eventsEmitted.filter((e) => e.name === "goal_store_changed").length, 1);
    } finally { h.cleanup(); }
  }
});

test("usage drop below threshold at a boundary releases a poll park and resumes the owned goal", async () => {
  let util = 95;
  const { h, core } = setup({ branch: PRIOR_TURN, goal: GOAL, util: () => util });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(h.goalStore.goal.status, "paused");
    util = 10;
    h.clock.advance(61000);
    h.setIdle(false);
    await h.runTurn();
    assert.equal(core.isParked(), false);
    assert.equal(h.goalStore.goal.status, "active");
    assert.equal(h.sentUserMessages.length, 0);
  } finally { h.cleanup(); }
});

test("real usage reader through OMO_LIMITLESS_FAKE_USAGE_FILE parks without any network", async () => {
  const h = createHarness({ model: CLAUDE, now: T0, goal: GOAL, branch: PRIOR_TURN });
  try {
    h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
    const file = h.writeHomeJson("usage.json", { "anthropic-subscription": { five_hour: { utilization: 95, resetAt: RESET }, seven_day: { utilization: 10, resetAt: RESET + 86400000 } } });
    const core = startLimitless(h.pi, h.deps({ env: { OMO_LIMITLESS_FAKE_USAGE_FILE: file }, fetch: undefined }));
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(core.isParked(), true);
    assert.equal(core.state.snapshots[0].source, "fake");
    assert.equal(h.goalStore.goal.status, "paused");
  } finally { h.cleanup(); }
});

test("child sessions stay inert under startLimitless; the integrated main session registers only /limitless", () => {
  const child = createHarness();
  const main = createHarness();
  try {
    assert.equal(startLimitless(child.pi, child.deps({ env: { SENPI_TASK_MEMBER: "1" } })), null);
    assert.equal(child.handlers.size, 0);
    assert.equal(child.commands.size, 0);
    const core = startLimitless(main.pi, main.deps());
    assert.ok(core);
    assert.deepEqual([...main.commands.keys()], ["limitless"]);
    for (const name of ["session_start", "before_agent_start", "tool_call", "turn_end", "agent_settled", "event:goal_store_changed"]) {
      assert.ok(main.handlers.has(name), name);
    }
  } finally { child.cleanup(); main.cleanup(); }
});

test("timers run on the injected clock and the control hook runs first", async () => {
  const { h, core } = setup({ util: 10 });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const seen = [];
    core.setControlReader(async (_ctx, kind) => { seen.push(kind); });
    core.timers.set("probe", 1000, async () => { seen.push("fired"); });
    await h.clock.tick(999);
    assert.deepEqual(seen, []);
    await h.clock.tick(1);
    assert.deepEqual(seen, ["timer:probe", "fired"]);
    core.timers.set("probe", 1000, async () => { seen.push("never"); });
    core.timers.clear("probe");
    await h.clock.tick(5000);
    assert.equal(seen.includes("never"), false);
  } finally { h.cleanup(); }
});

// ── ROUND 2: reset path, restart rule, owner check, warm in transitions, pre-start gate, core.readUsage ──
// These drive the real core through startLimitless with no feature modules (features = []), so the core
// contract is tested on its own; the feature modules call these same entry points.
const CORE_ONLY = [];
const WARM_DECISION = { state: "park-wait", window: "five_hour", resetAt: RESET, reason: "five_hour 95%", util: 95 };
const goalEmits = (h) => h.eventsEmitted.filter((e) => e.name === "goal_store_changed");

for (const source of ["poll", "manual", "reactive"]) {
  test(`resetDue releases a ${source} park at reset when usage is ok and restarts the owned goal exactly once`, async () => {
    let util = 95;
    const { h, core } = setup({ branch: PRIOR_TURN, goal: GOAL, util: () => util, features: CORE_ONLY });
    try {
      h.installFakeGoalExtension();
      await h.fire("session_start", { type: "session_start", reason: "startup" });
      if (source !== "poll") await core.park({ ...WARM_DECISION }, { source });
      assert.equal(core.state.source, source);
      assert.equal(h.goalStore.goal.status, "paused");
      util = 10;
      h.clock.advance(61000);
      await h.runTurn();
      assert.equal(core.isParked(), source !== "poll", "a boundary poll releases only a poll park");
      if (source !== "poll") {
        h.clock.advance(RESET + 60000 - h.clock.now());
        await core.resetDue();
      }
      assert.equal(core.isParked(), false);
      assert.equal(h.statusLines.get(STATUS_KEY), IDLE_STATUS);
      assert.equal(h.goalStore.goal.status, "active");
      assert.deepEqual(h.goalStore.setStatusCalls, ["paused", "active"]);
      assert.equal(goalEmits(h).length, 1);
      assert.equal(h.queuedTurns.length, 1, "exactly one continuation turn");
      assert.equal(h.sentUserMessages.length, 0);
      assert.equal(core.ownedGoalId(), null);
      assert.equal(h.readHomeJson(".omo/limitless/state/s1.json").parkState, "ok");
    } finally { h.cleanup(); }
  });
}

test("resetDue with the usage source none releases a manual park too (a park never outlives its reset)", async () => {
  let none = false;
  const { h, core } = setup({ branch: PRIOR_TURN, goal: null, features: CORE_ONLY,
    readUsage: async () => none ? snap(0, 0, "none") : snap(10) });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await core.park({ ...WARM_DECISION }, { source: "manual" });
    none = true;
    h.clock.advance(RESET + 60000 - h.clock.now());
    await core.resetDue();
    assert.equal(core.isParked(), false);
    assert.equal(h.sentUserMessages.length + h.sentMessages.length + goalEmits(h).length, 0);
  } finally { h.cleanup(); }
});

test("resetDue still over: re-parks with the new resetAt and the transition payload carries the policy warm", async () => {
  const RESET2 = RESET + 3600000;
  let reset = RESET;
  const { h, core } = setup({ branch: PRIOR_TURN, goal: GOAL, util: 95, resetAt: () => reset, features: CORE_ONLY });
  const seen = [];
  core.onTransition((prev, next) => { seen.push({ prev, next }); });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const policyWarm = core.getPolicy().warm;
    assert.equal(policyWarm.on, true);
    const expectedWarm = { on: true, intervalMs: policyWarm.intervalMs ?? null, requireTtlSeconds: policyWarm.requireTtlSeconds ?? null };
    assert.deepEqual(seen.at(-1).next.warm, expectedWarm, "boundary park carries warm");
    reset = RESET2;
    h.clock.advance(RESET + 60000 - h.clock.now());
    await core.resetDue();
    assert.equal(core.isParked(), true);
    assert.equal(core.state.resetAt, RESET2);
    assert.equal(seen.at(-1).next.resetAt, RESET2);
    assert.deepEqual(seen.at(-1).next.warm, expectedWarm, "timer re-park keeps warm");
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(h.sentUserMessages.length + goalEmits(h).length, 0);
    // a manual park outside any boundary (decision without warm) keeps the last policy warm
    await core.release({ reason: "test" });
    await core.park({ state: "park-wait", window: "five_hour", resetAt: RESET2 + 1000, reason: "manual", util: 95 }, { source: "manual" });
    assert.deepEqual(seen.at(-1).next.warm, expectedWarm, "manual park keeps warm");
    assert.equal(seen.at(-2).next.warm, null, "release payload has no warm");
  } finally { h.cleanup(); }
});

test("reset with a goal the user paused (other id, paused before the park, or no goal): stays paused, zero messages, zero emits", async () => {
  const cases = {
    "replaced by a user-paused goal": { goal: GOAL, after: (h) => h.setGoal({ id: "g2", status: "paused", objective: "other" }) },
    "paused by the user before the park": { goal: { ...GOAL, status: "paused" } },
    "no goal": { goal: null },
  };
  for (const [name, c] of Object.entries(cases)) {
    let util = 95;
    const { h, core } = setup({ branch: PRIOR_TURN, goal: c.goal, util: () => util, features: CORE_ONLY });
    try {
      h.installFakeGoalExtension();
      await h.fire("session_start", { type: "session_start", reason: "startup" });
      await core.park({ ...WARM_DECISION }, { source: "manual" });
      c.after?.(h);
      const callsBefore = [...h.goalStore.setStatusCalls];
      util = 10;
      h.clock.advance(RESET + 60000 - h.clock.now());
      await core.resetDue();
      assert.equal(core.isParked(), false, name);
      assert.equal(h.statusLines.get(STATUS_KEY), IDLE_STATUS, name);
      if (c.goal) assert.equal(h.goalStore.goal.status, "paused", name);
      assert.deepEqual(h.goalStore.setStatusCalls, callsBefore, `${name}: no un-pause`);
      assert.equal(h.sentUserMessages.length, 0, name);
      assert.equal(h.sentMessages.filter((m) => m.opts?.triggerTurn !== false).length, 0, name);
      assert.equal(goalEmits(h).length, 0, name);
      assert.equal(h.queuedTurns.length, 0, name);
    } finally { h.cleanup(); }
  }
});

test("releaseOwnedGoal never resumes a paused goal whose id differs from pausedByLimitless", async () => {
  const { h, core } = setup({ branch: PRIOR_TURN, goal: GOAL, features: CORE_ONLY });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(core.ownedGoalId(), "g1");
    h.setGoal({ id: "g2", status: "paused", objective: "user" });
    await core.release({ reason: "test" });
    assert.equal(await core.releaseOwnedGoal({ reason: "test" }), false);
    assert.equal(h.goalStore.goal.status, "paused");
    assert.deepEqual(h.goalStore.setStatusCalls, ["paused"]);
    assert.equal(h.sentUserMessages.length + goalEmits(h).length, 0);
  } finally { h.cleanup(); }
});

test("onBeforeSessionStart veto: the core writes nothing, polls nothing, pauses nothing, and stays inert", async () => {
  const seenAtHook = [];
  const vetoer = { install(core) {
    core.onBeforeSessionStart((_event, ctx) => {
      seenAtHook.push({ sid: core.sessionId, start: core.startState?.marker ?? null });
      ctx.shutdown();
      return { veto: true };
    });
  } };
  const prior = JSON.stringify({ v: 1, parkState: "ok", armed: false, marker: "from-previous-process" });
  const { h, core, usageCalls } = setup({ branch: PRIOR_TURN, goal: GOAL, features: [vetoer],
    beforeStart: (harness) => harness.writeHomeJson(".omo/limitless/state/s1.json", prior) });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(seenAtHook, [{ sid: "s1", start: "from-previous-process" }]);
    assert.equal(core.isVetoed(), true);
    assert.equal(h.shutdownCalls.length, 1);
    assert.equal(readFileSync(statePath(h.tmpHome, "s1"), "utf8"), prior, "state file untouched");
    assert.equal(usageCalls.length, 0);
    assert.equal(core.isParked(), false);
    assert.deepEqual(h.goalStore.setStatusCalls, []);
    assert.equal(h.statusLines.size + h.notifications.length, 0);
    const turn = await h.runTurn({ tools: ["task"] });
    assert.deepEqual(turn.executed, ["task"]);
    assert.equal(readFileSync(statePath(h.tmpHome, "s1"), "utf8"), prior, "still untouched after a turn");
    assert.equal(usageCalls.length, 0);
    assert.deepEqual(h.goalStore.setStatusCalls, []);
  } finally { h.cleanup(); }
});

test("onBeforeSessionStart without veto runs before the core persists or polls, then the core proceeds", async () => {
  const atHook = [];
  const calls = [];
  const observer = { install(core) {
    core.onBeforeSessionStart(() => {
      atHook.push({ stateFile: existsSync(statePath(core.homeDir, "s1")), polls: calls.length, paused: core.ownedGoalId() });
    });
  } };
  const { h, core, state } = setup({ branch: PRIOR_TURN, goal: GOAL, features: [observer],
    readUsage: async (r) => { calls.push(r); return snap(95); } });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(atHook, [{ stateFile: false, polls: 0, paused: null }]);
    assert.equal(core.isParked(), true);
    assert.equal(h.goalStore.goal.status, "paused");
    assert.equal(state().parkState, "park-wait");
  } finally { h.cleanup(); }
});

test("core.readUsage goes through the shared snapshot cache and never throws", async () => {
  const { h, core, usageCalls } = setup({ util: 77, features: CORE_ONLY, shared: { snapshot: snap(42), observedAt: T0 - 1000 } });
  try {
    const cached = await core.readUsage("anthropic-subscription", "default");
    assert.equal(cached.windows[0].utilization, 42);
    assert.equal(usageCalls.length, 0);
    h.clock.advance(61000);
    const polled = await core.readUsage("anthropic-subscription", "default");
    assert.equal(polled.windows[0].utilization, 77);
    assert.equal(usageCalls.length, 1);
    assert.equal(JSON.parse(readFileSync(snapshotPath(h.tmpHome, "anthropic-subscription", "default"), "utf8")).observedAt, T0 + 61000);
  } finally { h.cleanup(); }
  const bad = setup({ features: CORE_ONLY, readUsage: async () => { throw new Error("boom reader"); } });
  try {
    await bad.h.fire("session_start", { type: "session_start", reason: "startup" });
    const r = await bad.core.readUsage("anthropic-subscription", "default");
    assert.equal(r.source, "none");
    assert.equal(r.error, "boom reader");
    assert.equal(bad.state().lastError.message, "boom reader");
  } finally { bad.h.cleanup(); }
});

test("core.readUsage with production deps (no injected reader) uses usage.mjs: fake usage file, no network", async () => {
  const h = createHarness({ model: CLAUDE, now: T0, branch: PRIOR_TURN });
  try {
    h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
    const file = h.writeHomeJson("usage.json", { "anthropic-subscription": { five_hour: { utilization: 95, resetAt: RESET } } });
    const core = startLimitless(h.pi, h.deps({ env: { OMO_LIMITLESS_FAKE_USAGE_FILE: file }, fetch: undefined }), CORE_ONLY);
    const r = await core.readUsage("anthropic-subscription", "default");
    assert.equal(r.source, "fake");
    assert.equal(r.windows[0].utilization, 95);
  } finally { h.cleanup(); }
});

// ── ROUND 5: unknown reset never renders a clock, never park-exits; config warnings surface ──
const CLOCK = /\d{1,2}:\d{2}/;

test("core.park with a past resetAt (any caller) normalizes to park-wait/null, re-check at now+60s, no shutdown", async () => {
  const { h, core } = setup({ util: 10, branch: PRIOR_TURN });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(core.isParked(), false);
    const seen = [];
    core.onTransition((_prev, next) => seen.push(next.parkState));
    await core.park({ state: "park-exit", window: "five_hour", resetAt: T0 - 60000, reason: "5h 95%", warm: { on: true, intervalMs: 3300000 } }, { source: "manual" });
    assert.equal(core.state.parkState, "park-wait");
    assert.equal(core.state.resetAt, null);
    assert.equal(core.state.warm.on, false);
    assert.equal(core.canParkExit(), false);
    assert.equal(core.canWarm(), false);
    assert.deepEqual(seen, ["park-wait"]);
    assert.deepEqual(h.clock.pendingTimers(), [T0 + 60000]);
    await core.park({ state: "park-exit", window: "five_hour", resetAt: Number.NaN, reason: "5h 95%" });
    assert.equal(core.state.parkState, "park-wait");
    assert.equal(core.state.resetAt, null);
    assert.equal(h.shutdownCalls.length, 0);
    assert.equal(h.statusLines.get(STATUS_KEY), statusText(null));
  } finally { h.cleanup(); }
});

test("unknown reset: status line is exactly the no-time text and no notice/goal/block text carries a clock time", async () => {
  const { h, core } = setup({ util: 10, branch: PRIOR_TURN, goal: GOAL });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await core.park({ state: "park-wait", window: "five_hour", resetAt: null, reason: "5h 95%" });
    assert.equal(statusText(null), "⏸ 한도 대기 · 재개 시각 미정");
    assert.equal(h.statusLines.get(STATUS_KEY), "⏸ 한도 대기 · 재개 시각 미정");
    assert.equal(h.goalStore.goal.status, "paused");
    h.setGoal({ id: "g2", status: "active", objective: "more" });
    await h.pi.events.emit("goal_store_changed", { threadId: "s1" });
    assert.ok(h.notice().includes("리셋 시각을 아직 몰라"));
    for (const notice of h.notifications) assert.doesNotMatch(notice.text, CLOCK);
    assert.doesNotMatch(h.notice(), CLOCK);
    assert.doesNotMatch(core.blockReason(), CLOCK);
    assert.doesNotMatch(TEXTS.goalHeld(null), CLOCK);
    assert.equal(hhmm(null), "--:--");
  } finally { h.cleanup(); }
});

test("config warnings: one warning notification at session_start, one line per key, max 3 then 외 N개", async () => {
  const { h } = setup({
    util: 10,
    beforeStart: (h) => h.writeHomeJson(".omo/limitless/config.json", {
      thresholds: { fiveHour: "x" }, warm: { "anthropic-subscription": { on: 3 } }, enabled: "no", pollMinIntervalMs: -1,
    }),
  });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const warnings = h.notifications.filter((n) => n.text.startsWith("limitless 설정 오류"));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, "warning");
    assert.deepEqual(warnings[0].text.split("\n"), [
      "limitless 설정 오류: thresholds.fiveHour 값이 잘못돼 기본값(90)을 씁니다",
      "limitless 설정 오류: warm.anthropic-subscription.on 값이 잘못돼 기본값(true)을 씁니다",
      "limitless 설정 오류: enabled 값이 잘못돼 기본값(true)을 씁니다",
      "외 1개",
    ]);
    await h.fire("session_start", { type: "session_start", reason: "resume" });
    assert.equal(h.notifications.filter((n) => n.text.startsWith("limitless 설정 오류")).length, 1);
  } finally { h.cleanup(); }
});

test("valid config: no config warning notification", async () => {
  const { h } = setup({ util: 10, beforeStart: (h) => h.writeHomeJson(".omo/limitless/config.json", { thresholds: { fiveHour: 80 } }) });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(h.notifications.filter((n) => n.text.startsWith("limitless 설정 오류")).length, 0);
  } finally { h.cleanup(); }
});
