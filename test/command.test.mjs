import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLimitless } from "../extension/limitless.mjs";
import { createHarness } from "./harness.mjs";

async function setup(t, { idle = true } = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "limitless-command-"));
  const h = createHarness({
    sessionId: "command-test", homeDir, idle, now: 1_700_000_000_000,
    model: { api: "claude-sdk-oauth", provider: "anthropic-subscription", id: "claude-sonnet" },
    goal: { id: "goal-1", status: "active" },
    env: { OMO_LIMITLESS_FAKE_USAGE_FILE: join(homeDir, "usage.json") },
  });
  h.writeHomeJson("usage.json", {
    "anthropic-subscription": {
      five_hour: { utilization: 95, resetAt: 1_700_000_060_000 },
      seven_day: { utilization: 10, resetAt: 1_700_000_120_000 },
    },
  });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fixture" } });
  h.installFakeGoalExtension();
  const core = startLimitless(h.pi, h.deps());
  await h.fire("session_start", { type: "session_start" });
  await h.runTurn();
  assert.equal(core.isParked(), true);
  const command = h.commands.get("limitless");
  t.after(() => {
    h.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });
  return { ...h, core, command };
}

test("status prints usage, park state, reset time, and switch", async (t) => {
  const h = await setup(t);
  await h.command.handler("status", h.ctx);
  const text = h.notifications.at(-1).text;
  
  // Verify state is formatted in Korean, not raw
  assert.match(text, /한도 대기\(이 세션 유지\)/);
  
  // Verify window and utilization are formatted
  assert.match(text, /5시간 창 95%/);
  
  // Verify reset time is formatted as HH:MM, not raw epoch
  // Convert resetAt to expected HH:MM using Date methods (timezone-independent)
  const resetDate = new Date(1_700_000_060_000);
  const hours = String(resetDate.getHours()).padStart(2, "0");
  const mins = String(resetDate.getMinutes()).padStart(2, "0");
  const expectedTime = `${hours}:${mins}`;
  assert.match(text, new RegExp(expectedTime));
  
  // Verify no raw epoch milliseconds appear
  assert.doesNotMatch(text, /1700000060000/);
  
  // Verify switch state in Korean
  assert.match(text, /켜짐/);
  
  // Verify Korean labels are present
  assert.match(text, /상태:/);
  assert.match(text, /사용량:/);
  assert.match(text, /리셋:/);
  assert.match(text, /출처:/);
  assert.match(text, /스위치:/);
});

test("status reports parked unknown reset and clears line when not parked", async (t) => {
  const h = await setup(t);
  h.core.state.resetAt = null;
  await h.command.handler("status", h.ctx);
  let lines = h.notifications.at(-1).text.split("\n");
  assert.equal(lines[0], "⏸ 한도 대기 · 재개 시각 미정");
  assert.equal(lines.find((line) => line.startsWith("리셋:")), "리셋: unknown");

  h.core.state.parkState = "ok";
  await h.command.handler("status", h.ctx);
  lines = h.notifications.at(-1).text.split("\n");
  assert.equal(lines[0], "⏸ 한도 대기 없음");
});

test("a user message during park runs normally but keeps goal paused and task blocked", async (t) => {
  const h = await setup(t);
  const result = await h.runTurn({ prompt: "hello", tools: ["task"] });
  assert.deepEqual(result.blocked.map((item) => item.toolName), ["task"]);
  assert.equal(h.goalStore.goal.status, "paused");
  assert.equal(h.core.isParked(), true);
  assert.equal(h.statusLines.get("limitless") !== undefined, true);
});

test("resume, off, and external off each restart an idle owned goal exactly once", async (t) => {
  for (const action of ["resume", "off", "external"]) {
    const h = await setup(t);
    if (action === "external") {
      h.writeHomeJson(".omo/limitless/control/command-test.json", { v: 1, mode: "off" });
      await h.fire("agent_settled", { type: "agent_settled" });
    } else {
      await h.command.handler(action, h.ctx);
    }
    assert.equal(h.goalStore.goal.status, "active", `${action} resumes the owned goal`);
    assert.equal(h.queuedTurns.length, 1, `${action} queues one continuation`);
    assert.equal(h.sentUserMessages.length, 0, `${action} sends no user message`);
    assert.equal(h.eventsEmitted.filter((event) => event.name === "goal_store_changed").length, 1);
    assert.equal(h.core.isParked(), false);
    rmSync(h.tmpHome, { recursive: true, force: true });
  }
});

test("manual park forces park-wait until reset, then off releases it and stops polling", async (t) => {
  const h = await setup(t);
  await h.command.handler("resume", h.ctx);
  h.core.state.decision = { state: "park-wait", window: "five_hour", resetAt: 1_700_000_060_000, reason: "95%" };
  await h.command.handler("park", h.ctx);
  assert.equal(h.core.state.parkState, "park-wait");
  assert.equal(h.core.state.source, "manual");
  h.writeHomeJson("usage.json", {
    "anthropic-subscription": {
      five_hour: { utilization: 10, resetAt: 1_700_000_060_000 },
      seven_day: { utilization: 10, resetAt: 1_700_000_120_000 },
    },
  });
  const continuationsBeforeReset = h.queuedTurns.length;
  await h.clock.tick(60_000 + h.core.config.resumeGraceMs);
  assert.equal(h.core.state.parkState, "ok", "manual park releases after reset when usage is ok");
  assert.equal(h.goalStore.goal.status, "active");
  assert.equal(h.queuedTurns.length - continuationsBeforeReset, 1, "reset queues exactly one continuation");
  assert.equal(h.sentUserMessages.length, 0);
  h.core.state.decision = { state: "park-wait", window: "five_hour", resetAt: h.clock.now() + 60_000, reason: "95%" };
  await h.command.handler("park", h.ctx);
  assert.equal(h.core.state.parkState, "park-wait");
  await h.command.handler("off", h.ctx);
  assert.equal(h.core.state.parkState, "ok");
  const polls = h.core.state.lastPollAt;
  await h.clock.tick(5 * 60_000);
  await h.runTurn();
  assert.equal(h.core.state.lastPollAt, polls);
});

test("external off on the next timer tick releases park and owned goal", async (t) => {
  const h = await setup(t);
  h.writeHomeJson(".omo/limitless/control/command-test.json", { v: 1, mode: "off" });
  await h.clock.tick(120_000);
  assert.equal(h.core.state.mode, "off");
  assert.equal(h.core.isParked(), false);
  assert.equal(h.goalStore.goal.status, "active");
  assert.equal(h.queuedTurns.length, 1);
});

test("invalid subcommand prints usage and changes no state", async (t) => {
  const h = await setup(t);
  const before = structuredClone(h.core.state);
  await h.command.handler("bogus", h.ctx);
  assert.match(h.notifications.at(-1).text, /Usage: \/limitless/);
  assert.deepEqual(h.core.state, before);
});

test("busy release delivers exactly one follow-up", async (t) => {
  const h = await setup(t, { idle: false });
  await h.command.handler("resume", h.ctx);
  assert.equal(h.sentUserMessages.length, 1);
  assert.equal(h.eventsEmitted.filter((event) => event.name === "goal_store_changed").length, 0);
});
