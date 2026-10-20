import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startKeepalive } from "../extension/keepalive.mjs";
import { createHarness } from "./harness.mjs";

async function setup(t, { idle = true } = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "keepalive-command-"));
  const h = createHarness({
    sessionId: "command-test", homeDir, idle, now: 1_700_000_000_000,
    model: { api: "claude-sdk-oauth", provider: "anthropic-subscription", id: "claude-sonnet" },
    goal: { id: "goal-1", status: "active" },
    env: { OMO_KEEPALIVE_FAKE_USAGE_FILE: join(homeDir, "usage.json") },
  });
  h.writeHomeJson("usage.json", {
    "anthropic-subscription": {
      five_hour: { utilization: 95, resetAt: 1_700_000_060_000 },
      seven_day: { utilization: 10, resetAt: 1_700_000_120_000 },
    },
  });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fixture" } });
  h.installFakeGoalExtension();
  const core = startKeepalive(h.pi, h.deps());
  await h.fire("session_start", { type: "session_start" });
  await h.runTurn();
  assert.equal(core.isParked(), true);
  const command = h.commands.get("keepalive");
  t.after(async () => {
    await h.fire("session_shutdown", { type: "session_shutdown" });
    h.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });
  return { ...h, core, command };
}

test("status shows the park, usage bars and reset times", async (t) => {
  const h = await setup(t);
  await h.command.handler("status", h.ctx);
  const text = h.notifications.at(-1).text;
  const at = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const lines = text.split("\n");
  assert.equal(lines[0], `한도  ⏸ 한도 대기 · ${at(1_700_000_060_000)} 재개 (1분 뒤)`);
  assert.equal(lines[1], `      5시간 ${"█".repeat(19)}░ 95%   리셋 ${at(1_700_000_060_000)}`);
  assert.equal(lines[2], `      7일   ██${"░".repeat(18)} 10%   리셋 ${at(1_700_000_120_000)}`);
  assert.doesNotMatch(text, /1700000060000/);
});

test("status reports parked unknown reset and the watch state when not parked", async (t) => {
  const h = await setup(t);
  h.core.state.resetAt = null;
  await h.command.handler("status", h.ctx);
  assert.equal(h.notifications.at(-1).text.split("\n")[0], "한도  ⏸ 한도 대기 · 재개 시각 미정");
  h.core.state.parkState = "ok";
  await h.command.handler("status", h.ctx);
  assert.equal(h.notifications.at(-1).text.split("\n")[0], "한도  🔄 감시 중");
});

test("status slot: idle mark when not parked, cleared by off, back on on", async (t) => {
  const h = await setup(t);
  await h.command.handler("resume", h.ctx);
  assert.equal(h.statusLines.get("omo-keepalive"), "🔄");
  await h.command.handler("off", h.ctx);
  assert.equal(h.statusLines.has("omo-keepalive"), false);
  h.writeHomeJson("usage.json", { "anthropic-subscription": { five_hour: { utilization: 10, resetAt: 1_700_000_060_000 } } });
  await h.command.handler("on", h.ctx);
  assert.equal(h.core.isParked(), false);
  assert.equal(h.statusLines.get("omo-keepalive"), "🔄");
});

test("a user message during park runs normally but keeps goal paused and task blocked", async (t) => {
  const h = await setup(t);
  const result = await h.runTurn({ prompt: "hello", tools: ["task"] });
  assert.deepEqual(result.blocked.map((item) => item.toolName), ["task"]);
  assert.equal(h.goalStore.goal.status, "paused");
  assert.equal(h.core.isParked(), true);
  assert.equal(h.statusLines.get("omo-keepalive") !== undefined, true);
});

test("resume, off, and external off each restart an idle owned goal exactly once", async (t) => {
  for (const action of ["resume", "off", "external"]) {
    const h = await setup(t);
    if (action === "external") {
      h.writeHomeJson(".omo/keepalive/control/command-test.json", { v: 1, mode: "off" });
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
  h.writeHomeJson(".omo/keepalive/control/command-test.json", { v: 1, mode: "off" });
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
  assert.match(h.notifications.at(-1).text, /Usage: \/keepalive/);
  assert.deepEqual(h.core.state, before);
});

test("busy release queues no message and restarts the goal once at agent_settled", async (t) => {
  const h = await setup(t, { idle: false });
  await h.command.handler("resume", h.ctx);
  assert.equal(h.sentUserMessages.length, 0);
  assert.equal(h.eventsEmitted.filter((event) => event.name === "goal_store_changed").length, 0);
  h.setIdle(true);
  await h.fire("agent_settled", { type: "agent_settled" });
  assert.equal(h.eventsEmitted.filter((event) => event.name === "goal_store_changed").length, 1);
});

test("manual park under the threshold parks nothing and prints one Korean line saying so", async (t) => {
  const h = await setup(t);
  await h.command.handler("resume", h.ctx);
  h.core.state.decision = { state: "ok", window: null, resetAt: null, reason: null };
  const before = h.notifications.length;
  await h.command.handler("park", h.ctx);
  assert.equal(h.core.state.parkState, "ok");
  assert.equal(h.notifications.length - before, 1);
  assert.match(h.notifications.at(-1).text, /^keepalive: 지금은 사용량이 임계치 아래/);
});

test("the bare command shows the three groups: limit, cache, records", async (t) => {
  const h = await setup(t);
  h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on" });
  await h.command.handler("", h.ctx);
  const lines = h.notifications.at(-1).text.split("\n");
  assert.deepEqual(lines.filter((l) => !l.startsWith(" ")).map((l) => l.slice(0, 2)), ["한도", "캐시", "기록"]);
  // This fixture parks before the session's first turn, so it is a latecomer and keepalive forbids warming.
  assert.equal(h.core.isLatecomer(), true);
  assert.equal(lines.find((l) => l.startsWith("캐시")), "캐시  🩵 새 세션");
  assert.equal(lines.find((l) => l.startsWith("기록")), "기록  오늘 ping 0 · 적중 0 · 아낌 0");
  assert.equal(lines.at(-1), "      7일 식은 복귀 0/0 · 아낌 0");
});

test("without a cache-warming config the screen says warming is off", async (t) => {
  const h = await setup(t);
  await h.command.handler("status", h.ctx);
  assert.ok(h.notifications.at(-1).text.split("\n").includes("캐시  🩵 꺼짐"));
});

test("set expiry and set habit change the cache-warming config", async (t) => {
  const h = await setup(t);
  h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on" });
  await h.command.handler("set expiry claude-subscription 4h", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").expiry["claude-subscription"], 240);
  await h.command.handler("set habit --return-rate 0.5 --median 20m --t90 3h", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").habit.p, 0.5);
  await h.command.handler("set habit auto", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").habit, "auto");
  await h.command.handler("set nothing 1", h.ctx);
  assert.match(h.notifications.at(-1).text, /^Usage: \/keepalive/);
});

test("set expiry and set habit without a value show the current values and write nothing", async (t) => {
  const h = await setup(t);
  await h.command.handler("set expiry", h.ctx);
  assert.match(h.notifications.at(-1).text, /^claude-subscription {2}TTL .*\n.*\n {2}steps: 0 · 1h · .*\[5h\]/);
  await h.command.handler("set expiry claude-subscription", h.ctx);
  assert.match(h.notifications.at(-1).text, /\nclaude-subscription steps: 0 · 1h · 2h/);
  await h.command.handler("set habit", h.ctx);
  assert.match(h.notifications.at(-1).text, /^habit default \(p /);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json"), null);
});

test("set mode changes the cache-warming config", async (t) => {
  const h = await setup(t);
  await h.command.handler("set mode shadow", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").mode, "shadow");
  await h.command.handler("set mode on", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").mode, "on");
  assert.equal(h.notifications.at(-1).text, "keepalive: 캐시 데우기 on");
});

test("set backstop off then on writes the cache-warming config", async (t) => {
  const h = await setup(t);
  h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on" });
  await h.command.handler("set backstop off", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").backstop, "off");
  assert.equal(h.notifications.at(-1).text, "keepalive: backstop 붙잡기 off");
  await h.command.handler("set backstop on", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").backstop, "on");
  assert.equal(h.notifications.at(-1).text, "keepalive: backstop 붙잡기 on");
});

test("invalid set backstop prints usage and leaves config unchanged", async (t) => {
  const h = await setup(t);
  h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on" });
  const before = h.readHomeJson(".omo-keepwarm/config.json");
  await h.command.handler("set backstop maybe", h.ctx);
  const text = h.notifications.at(-1).text;
  assert.match(text, /^Usage: \/keepalive/);
  assert.match(text, /set backstop on\|off/);
  assert.deepEqual(h.readHomeJson(".omo-keepwarm/config.json"), before);
});

test("invalid set mode prints usage and leaves config unchanged", async (t) => {
  const h = await setup(t);
  h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on" });
  const before = h.readHomeJson(".omo-keepwarm/config.json");
  await h.command.handler("set mode maybe", h.ctx);
  assert.match(h.notifications.at(-1).text, /^Usage: \/keepalive/);
  assert.deepEqual(h.readHomeJson(".omo-keepwarm/config.json"), before);
});

test("status identifies an inert cache-warming instance", async (t) => {
  const h = await setup(t);
  h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on" });
  h.core.keepwarm = { controller: { snapshot: () => ({}) }, isInert: () => true };
  await h.command.handler("status", h.ctx);
  assert.ok(h.notifications.at(-1).text.split("\n").includes("캐시  🩵 다른 인스턴스"));
});
