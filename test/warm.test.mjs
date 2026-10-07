import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startLimitless } from "../extension/limitless.mjs";
import { resolverStartDirectory, install } from "../extension/warm.mjs";
import { createHarness } from "./harness.mjs";

function fixture({
  provider = "anthropic-subscription", intervalMs = 55 * 60_000, warmOn = true,
  model = { provider: "openai-codex-responses", id: "gpt-5.6-sol" },
  resolvePromptCacheLifetime = () => ({ kind: "ttl", ttlSeconds: 1800 }),
    idle = true, latecomer = false, env = {}, requireTtlSeconds,
} = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "limitless-warm-"));
  const handlers = new Map();
  const boundaries = [];
  const transitions = [];
  const timers = new Map();
  const sent = [];
  let now = 0;
  const ctx = { isIdle: () => idle };
  const core = {
    deps: { resolvePromptCacheLifetime }, env, homeDir, sessionId: "warm-test",
    lane: { provider, accounts: ["default"] }, lastCtx: { model, isIdle: ctx.isIdle },
    pi: {
      on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
      sendMessage(message, options) { sent.push({ message, options }); },
    },
    state: { parkState: "park-wait", source: "poll", resetAt: 100_000_000, warm: { on: warmOn, intervalMs, ...(requireTtlSeconds === undefined ? {} : { requireTtlSeconds }) } },
    now: () => now, enabled: () => true, ownedGoalId: () => "g1", canWarm() { return core.state.parkState === "park-wait" && core.state.warm?.on === true && core.state.source !== "reactive"; },
    readGoal: async () => ({ id: "g1", status: "paused" }),
    isLatecomer: () => latecomer, persist() {}, recordError(where, error) { core.lastError = { where, message: String(error) }; },
    markExtensionTurn(kind) { core.turn = { kind, blockAll: true }; },
    timers: {
      set(name, ms, fn) { timers.set(name, { at: now + ms, fn }); },
      clear(name) { timers.delete(name); },
      has(name) { return timers.has(name); },
    },
    onBoundary(fn) { boundaries.push(fn); }, onTransition(fn) { transitions.push(fn); },
  };
  install(core);
  return {
    core, ctx, handlers, boundaries, transitions, timers, sent, homeDir,
    async boundary(kind = "turn_end") { for (const fn of boundaries) await fn(ctx, kind); },
    async fireTimer() {
      const timer = timers.get("warm");
      assert.ok(timer, "warm timer exists");
      timers.delete("warm");
      now = timer.at;
      await timer.fn(ctx);
    },
    async runQueuedWarm({ usage, provider = core.lane.provider, aborted = false, toolNames = [] } = {}) {
      await Promise.all((handlers.get("before_agent_start") ?? []).map((fn) =>
        fn({ type: "before_agent_start", trigger: "extension", prompt: sent.at(-1).message.content })));
      assert.equal(core.turn?.kind, "warm", "warm turn recognized");
      const blocks = (await Promise.all(toolNames.map((toolName) =>
        Promise.all((handlers.get("tool_call") ?? []).map((fn) => fn({ toolName })))))).flat();
      await Promise.all((handlers.get("agent_end") ?? []).map((fn) => fn({
        type: "agent_end", aborted, abortSource: aborted ? "provider" : undefined, messages: [{
          role: "assistant", provider, stopReason: aborted ? "error" : "stop", usage,
          content: toolNames.map((name) => ({ type: "toolCall", name })),
        }],
      })));
      return { blocks };
    },
    setNow(value) { now = value; },
    cleanup() { rmSync(homeDir, { recursive: true, force: true }); },
  };
}

const warmUsage = { input: 100, cacheRead: 1000, cacheWrite: 20, output: 8 };

test("Claude warm timer repeats at the configured interval", async (t) => {
  const h = fixture();
  t.after(() => h.cleanup());
  await Promise.all(h.transitions.map((fn) => fn({}, h.core.state)));
  await h.fireTimer();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].message, {
    customType: "limitless-warm",
    content: "[limitless] 사용량 한도 대기 중. 도구를 쓰지 말고 ok 한 단어로만 답하라.",
    display: false,
  });
  const run = await h.runQueuedWarm({ usage: warmUsage, toolNames: ["exec", "task"] });
  assert.deepEqual(run.blocks, [], "tool blocking in a warm turn is the core's job (real-core test below)");
  assert.equal(h.timers.get("warm").at, 110 * 60_000);
  const rows = readFileSync(join(h.homeDir, ".omo", "limitless", "events.jsonl"), "utf8").trim().split("\n");
  assert.deepEqual(JSON.parse(rows[0]), {
    input: 100, cacheRead: 1000, cacheWrite: 20, output: 8, toolCalls: 2,
    provider: "anthropic-subscription", sessionId: "warm-test", at: 55 * 60_000,
  });
  await h.fireTimer();
  assert.equal(h.sent.length, 2, "a second interval produces a second warm turn");
});

test("warm off, 99% no-warm policy, latecomer, reactive park, and non-idle state prevent sends", async (t) => {
  for (const options of [
    { warmOn: false }, { warmOn: true, latecomer: true },
    { warmOn: true, provider: "anthropic-subscription", idle: false },
  ]) {
    const h = fixture(options);
    t.after(() => h.cleanup());
    await h.boundary("session_start");
    if (options.idle === false) {
      await h.fireTimer();
      assert.equal(h.sent.length, 0);
    } else assert.equal(h.timers.size, 0);
    assert.equal(h.sent.length, 0);
  }
  const h = fixture();
  t.after(() => h.cleanup());
  h.core.state.warm.on = false; // policy's >=99% no-warm result
  await h.boundary();
  assert.equal(h.timers.size, 0);
  h.core.state.warm.on = true;
  h.core.state.source = "reactive";
  await Promise.all(h.transitions.map((fn) => fn({}, h.core.state)));
  assert.equal(h.timers.size, 0);
});

test("Codex warms on a 1800-second model TTL but not a 300-second TTL", async (t) => {
  const good = fixture({ provider: "chatgpt-subscription", intervalMs: 27 * 60_000 });
  t.after(() => good.cleanup());
  await good.boundary("session_start");
  assert.equal(good.timers.get("warm").at, 27 * 60_000);

  const bad = fixture({
    provider: "chatgpt-subscription", intervalMs: 27 * 60_000,
    model: { provider: "openai-codex-responses", id: "gpt-5.4" },
    resolvePromptCacheLifetime: () => ({ kind: "ttl", ttlSeconds: 300 }),
  });
  t.after(() => bad.cleanup());
  await bad.boundary("session_start");
  assert.equal(bad.timers.size, 0);
});

test("a user turn at minute 40 moves Claude's warm to minute 95", async (t) => {
  const h = fixture();
  t.after(() => h.cleanup());
  await h.boundary("session_start");
  h.setNow(40 * 60_000);
  await h.boundary("turn_end");
  assert.equal(h.timers.get("warm").at, 95 * 60_000);
});

test("a provider limit error on the first warm attempt marks the lane cold and stops", async (t) => {
  const h = fixture();
  t.after(() => h.cleanup());
  await h.boundary("session_start");
  await h.fireTimer();
  await h.runQueuedWarm({ aborted: true });
  assert.equal(h.sent.length, 1);
  assert.equal(h.core.state.warmTurn, "cold");
  assert.equal(h.timers.size, 0);
});

test("cold cache and provider mismatch both stop further warm turns", async (t) => {
  const cold = fixture();
  t.after(() => cold.cleanup());
  await cold.boundary("session_start");
  await cold.fireTimer();
  await cold.runQueuedWarm({ usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 1 } });
  assert.equal(cold.core.state.warmTurn, "cold");
  assert.equal(cold.timers.size, 0);

  const mismatch = fixture();
  t.after(() => mismatch.cleanup());
  await mismatch.boundary("session_start");
  await mismatch.fireTimer();
  await mismatch.runQueuedWarm({ usage: warmUsage, provider: "other-provider" });
  assert.equal(mismatch.core.state.warmStopReason, "provider mismatch");
  assert.equal(mismatch.timers.size, 0);
});

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const snapshot = (utilization, resetAt) => ({
  provider: "anthropic-subscription", account: "default", source: "endpoint", overageEnabled: false,
  windows: [{ kind: "five_hour", utilization, resetAt }],
});
function realCore({ readUsage, goal = { id: "g1", status: "active", objective: "work" }, homeDir, now = T0 } = {}) {
  const h = createHarness({ model: CLAUDE, branch: PRIOR, goal, homeDir, now });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fake" } });
  const core = startLimitless(h.pi, h.deps({
    readUsage: async () => readUsage(),
    resolvePromptCacheLifetime: () => ({ kind: "ttl", ttlSeconds: 1800 }),
  }));
  return { h, core };
}

test("real core re-parking with a new resetAt keeps the warm timer armed", async (t) => {
  let resetAt = T0 + 2 * 3600_000;
  const { h, core } = realCore({ readUsage: () => snapshot(95, resetAt) });
  t.after(() => h.cleanup());
  await h.fire("session_start", {});
  assert.equal(core.state.parkState, "park-wait");
  resetAt = T0 + 3 * 3600_000;
  await core.park({
    state: "park-wait", window: "five_hour", resetAt, reason: "5h 95%", util: 95,
    warm: { on: true, intervalMs: 10 * 60_000 },
  }, { source: "poll" });
  assert.equal(core.state.resetAt, resetAt);
  assert.ok(core.timers.has("warm"), "re-park schedules a warm timer");
  await h.clock.tick(11 * 60_000);
  assert.equal(h.sentMessages.filter((item) => item.msg?.customType === "limitless-warm").length, 1);
});

test("real core resets warm failure for a later park episode", async (t) => {
  let utilization = 95;
  const { h, core } = realCore({ readUsage: () => snapshot(utilization, T0 + 3 * 3600_000) });
  t.after(() => h.cleanup());
  await h.fire("session_start", {});
  await h.clock.tick(55 * 60_000);
  await h.fire("before_agent_start", { trigger: "extension", prompt: h.queuedTurns[0]?.prompt });
  await h.fire("agent_end", { messages: [{ role: "assistant", provider: "anthropic-subscription", stopReason: "error" }] });
  assert.equal(core.state.warmTurn, "cold");
  await core.release({ reason: "test episode end" });
  assert.equal(core.isParked(), false);
  utilization = 95;
  await core.park({
    state: "park-wait", window: "five_hour", resetAt: T0 + 5 * 3600_000, reason: "5h 95%", util: 95,
    warm: { on: true, intervalMs: 55 * 60_000 },
  }, { source: "poll" });
  assert.equal(core.isParked(), true);
  assert.ok(core.timers.has("warm"), "new park episode schedules warming again");
  await h.clock.tick(56 * 60_000);
  assert.equal(h.sentMessages.filter((item) => item.msg?.customType === "limitless-warm").length, 2);
});

test("real core keeps a failed warm stopped when the same park episode gets a new resetAt", async (t) => {
  const { h, core } = realCore({ readUsage: () => snapshot(95, T0 + 3 * 3600_000) });
  t.after(() => h.cleanup());
  await h.fire("session_start", {});
  await h.clock.tick(55 * 60_000);
  await h.fire("before_agent_start", { trigger: "extension", prompt: h.queuedTurns[0]?.prompt });
  await h.fire("agent_end", { messages: [{ role: "assistant", provider: "anthropic-subscription", stopReason: "error" }] });
  assert.equal(core.state.warmTurn, "cold");
  await core.park({
    state: "park-wait", window: "five_hour", resetAt: T0 + 4 * 3600_000, reason: "5h 95%", util: 95,
    warm: { on: true, intervalMs: 10 * 60_000 },
  }, { source: "poll" });
  assert.equal(core.timers.has("warm"), false, "same-episode reset does not clear the error stop");
  await h.clock.tick(11 * 60_000);
  assert.equal(h.sentMessages.filter((item) => item.msg?.customType === "limitless-warm").length, 1);
});

test("resolver start directory is an absolute Windows path without a doubled drive", () => {
  const warmModuleUrl = new URL("../extension/warm.mjs", import.meta.url);
  const modulePath = fileURLToPath(warmModuleUrl);
  const startDirectory = resolverStartDirectory();
  assert.equal(startDirectory, dirname(modulePath));
  assert.equal(win32.isAbsolute(startDirectory), true);
  assert.equal(startDirectory.startsWith("C:\\C:\\"), false);
  assert.doesNotMatch(startDirectory, /^[A-Za-z]:\\[A-Za-z]:\\/);
  assert.equal(win32.normalize(startDirectory), startDirectory);
  assert.equal(isAbsolute(modulePath), true);
});

test("IS-1: a parked session without a goal is never warmed; once a goal is paused by limitless it is", async (t) => {
  const { h, core } = realCore({ readUsage: () => snapshot(95, T0 + 3.99 * 3600_000), goal: null });
  t.after(() => h.cleanup());
  const warms = () => h.sentMessages.filter((item) => item.msg?.customType === "limitless-warm").length;
  await h.fire("session_start", {});
  assert.equal(core.state.parkState, "park-wait");
  assert.equal(core.ownedGoalId(), null);
  for (let i = 0; i < 18; i++) await h.clock.tick(10 * 60_000);
  assert.equal(warms(), 0, "no warm over 3 h without a goal");
  h.setGoal({ id: "g9", status: "active", objective: "work" });
  await h.runTurn();
  assert.equal(h.goalStore.goal.status, "paused");
  assert.equal(core.ownedGoalId(), "g9");
  await h.clock.tick(56 * 60_000);
  assert.ok(warms() >= 1, "warm applies once limitless gates the session");
});

test("E1: removing the owned goal while parked stops further warm turns", async (t) => {
  const { h, core } = realCore({ readUsage: () => snapshot(95, T0 + 3.99 * 3600_000) });
  t.after(() => h.cleanup());
  await h.fire("session_start", {});
  assert.equal(core.ownedGoalId(), "g1");
  await h.clock.tick(55 * 60_000);
  assert.equal(h.sentMessages.filter((item) => item.msg?.customType === "limitless-warm").length, 1);
  h.setGoal(null);
  await h.clock.tick(55 * 60_000);
  assert.equal(h.sentMessages.filter((item) => item.msg?.customType === "limitless-warm").length, 1);
  h.setGoal({ id: "g2", status: "active", objective: "replacement" });
  await h.runTurn();
  assert.equal(h.goalStore.goal.status, "paused");
  assert.equal(core.ownedGoalId(), "g2");
  await h.clock.tick(55 * 60_000);
  assert.equal(h.sentMessages.filter((item) => item.msg?.customType === "limitless-warm").length, 2);
});

test("real core blocks every tool in a warm turn (no warm.mjs tool_call handler needed)", async (t) => {
  const { h } = realCore({ readUsage: () => snapshot(95, T0 + 3 * 3600_000) });
  t.after(() => h.cleanup());
  await h.fire("session_start", {});
  await h.clock.tick(55 * 60_000);
  assert.equal(h.queuedTurns.length, 1, "a warm turn is queued");
  const [turn] = await h.runQueuedTurns(["exec", "task"]);
  assert.deepEqual(turn.executed, []);
  assert.deepEqual(turn.blocked.map((item) => item.toolName), ["exec", "task"]);
});

test("Codex warm honors the policy's requireTtlSeconds and defaults to 1800", async (t) => {
  const long = fixture({
    provider: "chatgpt-subscription", intervalMs: 27 * 60_000, requireTtlSeconds: 3600,
    resolvePromptCacheLifetime: () => ({ kind: "ttl", ttlSeconds: 3600 }),
  });
  t.after(() => long.cleanup());
  await long.boundary("session_start");
  assert.equal(long.timers.get("warm").at, 27 * 60_000, "a 3600 s requirement accepts a 3600 s TTL");

  const mismatch = fixture({
    provider: "chatgpt-subscription", intervalMs: 27 * 60_000, requireTtlSeconds: 3600,
    resolvePromptCacheLifetime: () => ({ kind: "ttl", ttlSeconds: 1800 }),
  });
  t.after(() => mismatch.cleanup());
  await mismatch.boundary("session_start");
  assert.equal(mismatch.timers.size, 0, "a 1800 s TTL no longer satisfies a 3600 s requirement");

  const unset = fixture({
    provider: "chatgpt-subscription", intervalMs: 27 * 60_000,
    resolvePromptCacheLifetime: () => ({ kind: "ttl", ttlSeconds: 3600 }),
  });
  t.after(() => unset.cleanup());
  await unset.boundary("session_start");
  assert.equal(unset.timers.size, 0, "without a configured requirement the default stays 1800");
});

test("a warm turn is skipped while senpi has pending messages and retried on the next interval", async (t) => {
  const h = fixture();
  t.after(() => h.cleanup());
  await h.boundary("session_start");
  let pending = true;
  h.ctx.hasPendingMessages = () => pending;
  await h.fireTimer();
  assert.equal(h.sent.length, 0);
  assert.ok(h.timers.has("warm"), "rescheduled");
  pending = false;
  await h.fireTimer();
  assert.equal(h.sent.length, 1);
});

test("a warm timer callback running across a session reset sends nothing and reschedules nothing", async (t) => {
  const h = fixture();
  t.after(() => h.cleanup());
  await h.boundary("session_start");
  let epoch = 0;
  const stale = () => epoch !== 0;
  h.core.readGoal = async () => { epoch = 1; return { id: "g1", status: "paused" }; }; // the reset lands during the read
  const timer = h.timers.get("warm");
  h.timers.delete("warm");
  await timer.fn(h.ctx, stale);
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.has("warm"), false);
});
