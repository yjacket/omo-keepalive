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

test("text settings list, update thresholds, reject invalid values, and complete", async (t) => {
  const h = await setup(t);
  const definition = h.commands.get("keepalive");
  await h.command.handler("set", h.ctx);
  assert.match(h.notifications.at(-1).text, /threshold 5h/);
  await h.command.handler("set threshold 7d 97", h.ctx);
  assert.equal(h.readHomeJson(".omo/keepalive/config.json").thresholds.sevenDay, 97);
  assert.match(h.notifications.at(-1).text, /^keepalive: 7일 임계치 97%/);
  await h.command.handler("set threshold 5h 120", h.ctx);
  assert.equal(h.notifications.at(-1).level, "warning");
  assert.equal(h.core.config.thresholds.fiveHour, 90);
  assert.ok(definition.getArgumentCompletions("set th").some((x) => x.value === "set threshold"));
  assert.ok(definition.getArgumentCompletions("").some((x) => x.value === "set"));
  const habit = definition.getArgumentCompletions("set habit ");
  assert.ok(habit.some((x) => x.value === "set habit p"));
  assert.ok(habit.some((x) => x.value === "set habit manual"));
  assert.equal(habit.filter((x) => x.value === "set habit auto").length, 1);
});

test("text prefix lists settings and a threshold change releases a park", async (t) => {
  const h = await setup(t);
  await h.command.handler("set threshold", h.ctx);
  assert.ok(h.notifications.at(-1).text.startsWith("keepalive 설정 · 바꾸기: /keepalive set <항목> <값>"));
  await h.command.handler("set threshold 5h 96", h.ctx);
  assert.equal(h.core.isParked(), false);
});

test("habit manual freezes effective values on a fresh home", async (t) => {
  const h = await setup(t);
  await h.command.handler("set habit manual", h.ctx);
  assert.deepEqual(h.readHomeJson(".omo-keepwarm/config.json").habit, {
    p: 0.81, medianMinutes: 10.5, t90Minutes: 140,
  });
  // A median at or past the 90% time moves the 90% time up, as the screen does.
  await h.command.handler("set habit m 3h", h.ctx);
  assert.deepEqual(h.readHomeJson(".omo-keepwarm/config.json").habit, {
    p: 0.81, medianMinutes: 180, t90Minutes: 240,
  });
  await h.command.handler("set expiry claude-subscription", h.ctx);
  assert.match(h.notifications.at(-1).text, /^usage: \/keepalive set expiry/);
});

test("TUI settings screen opens, saves a threshold, and focuses expiry", async (t) => {
  const h = await setup(t);
  const calls = [];
  let component;
  let closed = false;
  const tui = { requestRender() {} };
  const theme = { bold: (s) => s, fg: (_c, s) => s };
  const ctx = {
    ...h.ctx, mode: "tui",
    ui: { ...h.ctx.ui, custom: async (factory, opts) => {
      calls.push(opts);
      component = await factory(tui, theme, { matches: () => false }, (r) => { closed = r ?? true; });
    } },
  };
  await h.command.handler("set", ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].overlay, true);
  let rendered = component.render(80).join("\n");
  assert.match(rendered, /keepalive 설정/);
  assert.match(rendered, /5시간 임계치/);
  assert.match(rendered, /90%  \(지금 95%\)/);
  component.handleInput("\x1b[C");
  component.handleInput("s");
  assert.equal(h.readHomeJson(".omo/keepalive/config.json").thresholds.fiveHour, 91);
  assert.equal(h.core.config.thresholds.fiveHour, 91);
  // Usage is 95%: raising the threshold to 96 from the screen releases this session's park, with no watcher event.
  const released = new Promise((resolve) => h.core.onTransition((_prev, next) => { if (next.parkState === "ok") resolve(); }));
  for (let i = 0; i < 5; i++) component.handleInput("\x1b[C");
  component.handleInput("s");
  assert.equal(h.core.config.thresholds.fiveHour, 96);
  await released;
  assert.equal(h.core.isParked(), false);
  component.handleInput("q");
  assert.equal(closed, true);
  await h.command.handler("set expiry", ctx);
  rendered = component.render(100).join("\n");
  assert.match(rendered, /▸ claude-subscription/);
});

test("a tall terminal shows every setting row without scrolling", async (t) => {
  const h = await setup(t);
  let component;
  const theme = { bold: (s) => s, fg: (_c, s) => s };
  const open = async (rows) => {
    const ctx = {
      ...h.ctx, mode: "tui",
      ui: { ...h.ctx.ui, custom: async (factory) => { component = await factory({ terminal: { rows }, requestRender() {} }, theme, { matches: () => false }, () => {}); } },
    };
    await h.command.handler("set", ctx);
    return component.render(120).join("\n");
  };
  const tall = await open(50);
  assert.match(tall, /5시간 임계치/);
  assert.match(tall, /90% 복귀/);
  const short = await open(24);
  assert.match(short, /5시간 임계치/);
  assert.doesNotMatch(short, /90% 복귀/);
  assert.ok(short.split("\n").length <= Math.floor(24 * 0.8), "the screen fits in 80% of a 24-row terminal");
});

test("registered habit text aliases and setting write failures", async (t) => {
  const h = await setup(t);
  h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on", habit: { futureKey: 7, p: 0.8, medianMinutes: 10, t90Minutes: 140 } });
  await h.command.handler("set habit p 0.7", h.ctx);
  assert.equal(h.notifications.at(-1).text, "keepalive: 돌아오는 비율 70%");
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").habit.p, 0.7);
  assert.equal(h.notifications.at(-1).text, "keepalive: 돌아오는 비율 70%");
  await h.command.handler("set habit m 15m", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").habit.medianMinutes, 15);
  await h.command.handler("set habit manual", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").habit.p, 0.7);
  await h.command.handler("set habit auto", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").habit, "auto");
  assert.match(h.notifications.at(-1).text, /habit default/);
  h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on", habit: { futureKey: 7, p: 0.8, medianMinutes: 10, t90Minutes: 140 } });
  await h.command.handler("set habit --return-rate 0.5 --median 20m --t90 3h", h.ctx);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json").habit.futureKey, 7);
  h.writeHomeJson(".omo-keepwarm/config.json", "not-json");
  await h.command.handler("set mode on", h.ctx);
  assert.equal(h.notifications.at(-1).level, "warning");
  assert.match(h.notifications.at(-1).text, /^keepalive: 설정을 저장하지 못했습니다/);
  assert.equal(h.readHomeJson(".omo-keepwarm/config.json"), null);
});
