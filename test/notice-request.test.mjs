// The park / goal-held notices live in a TUI widget (ctx.ui.setWidget), never in the conversation. senpi's default
// compaction builtin converts EVERY custom message to a role:user message before limitless's own context handler could
// match it, so the only safe notice is one that is never a message. This test builds the model request the way senpi
// does: session messages -> the REAL ExtensionRunner.emitContext with the REAL compaction builtin handler.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHarness } from "./harness.mjs";
import { startLimitless } from "../extension/limitless.mjs";
import { hhmm, senpiDistCandidates } from "../extension/core.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 3600000;
const GOAL = { id: "g1", status: "active", objective: "work" };
const dist = senpiDistCandidates().find((d) => existsSync(join(d, "core", "extensions", "runner.js")));
const skip = dist ? false : "senpi dist not found";

async function realRunner() {
  const load = (p) => import(pathToFileURL(join(dist, p)).href);
  const { ExtensionRunner } = await load("core/extensions/runner.js");
  const { loadExtensionFromFactory, createExtensionRuntime } = await load("core/extensions/loader.js");
  const { createEventBus } = await load("core/event-bus.js");
  const compaction = (await load("core/extensions/builtin/compaction/index.js")).default;
  const bus = createEventBus();
  const runtime = createExtensionRuntime();
  const ext = await loadExtensionFromFactory(compaction, process.cwd(), bus, runtime, "<compaction>");
  const runner = new ExtensionRunner([ext], runtime, process.cwd(), {}, {}, bus);
  runner.createContext = () => ({
    getContextUsage: () => undefined,
    getCompactionSettings: () => ({}),
    model: { contextWindow: 200000, maxTokens: 8000, provider: "anthropic", id: "claude-haiku-4-5" },
    sessionManager: { getEntries: () => [], getBranch: () => [] },
  });
  return runner;
}

// What the session holds: the user's prompt plus every message limitless posted through pi.sendMessage.
const request = async (runner, h) => JSON.stringify(await runner.emitContext([
  { role: "user", content: "hi", timestamp: 1 },
  ...h.sentMessages.map(({ msg }, i) => ({ role: "custom", customType: msg.customType, content: msg.content, display: msg.display, timestamp: 2 + i })),
]));

test("no limitless notice text reaches the request at park start, goal held, or after release", { skip }, async () => {
  const runner = await realRunner();
  const h = createHarness({ now: T0, goal: null });
  try {
    const core = startLimitless(h.pi, h.deps());
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    h.setGoal(GOAL);
    await core.park({ state: "park-wait", window: "five_hour", resetAt: RESET, reason: "5h 95%" });
    const parkText = h.notice();
    assert.match(parkText, /goal을 멈췄고/, "the park notice is shown");
    assert.doesNotMatch(await request(runner, h), /사용량 한도 대기|goal을 멈췄고/);

    h.setGoal({ id: "g2", status: "active", objective: "more" });
    await h.pi.events.emit("goal_store_changed", { threadId: "s1" });
    assert.match(h.notice(), /리셋 뒤 시작합니다/, "the goal-held notice replaces the park notice");
    assert.doesNotMatch(await request(runner, h), /리셋 뒤 시작합니다|goal을 멈췄고|사용량 한도 대기/);

    await core.release({ reason: "test" });
    assert.equal(h.notice(), undefined, "release clears the widget");
    assert.doesNotMatch(await request(runner, h), /리셋 뒤 시작합니다|goal을 멈췄고|사용량 한도 대기/);
    assert.deepEqual(h.sentMessages, []);
  } finally { h.cleanup(); }
});

// F3 P1: a no-goal park posts the same no-goal text into the widget and never a message, so it cannot reach the model.
test("no-goal park notice is widget-only: never a message, never in the request", { skip }, async () => {
  const runner = await realRunner();
  const h = createHarness({ now: T0, goal: null });
  try {
    const core = startLimitless(h.pi, h.deps());
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await core.park({ state: "park-wait", window: "five_hour", resetAt: RESET, reason: "5h 95%" });
    assert.equal(h.notice(), `⏸ 사용량 한도 대기 (five_hour 95%) · ${hhmm(RESET)} 재개. goal이 없어 작업은 그대로 할 수 있습니다.`);
    assert.deepEqual(h.sentMessages, []);
    assert.deepEqual(h.sentUserMessages, []);
    assert.doesNotMatch(await request(runner, h), /사용량 한도 대기|goal이 없어/);
    await core.release({ reason: "test" });
    assert.equal(h.notice(), undefined);
  } finally { h.cleanup(); }
});

test("sanity: the real compaction handler does convert a posted custom message into a plain user message", { skip }, async () => {
  const runner = await realRunner();
  const out = await runner.emitContext([{ role: "custom", customType: "x", content: "LEAK", display: true, timestamp: 1 }]);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].customType, undefined);
});

test("a session shutdown clears the notice widget", async () => {
  const h = createHarness({ now: T0, goal: GOAL });
  try {
    const core = startLimitless(h.pi, h.deps());
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await core.park({ state: "park-wait", window: "five_hour", resetAt: RESET, reason: "5h 95%" });
    assert.ok(h.notice());
    await h.fire("session_shutdown", { type: "session_shutdown" });
    assert.equal(h.notice(), undefined);
  } finally { h.cleanup(); }
});
