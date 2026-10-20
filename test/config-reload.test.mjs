import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startKeepalive } from "../extension/keepalive.mjs";
import { createHarness } from "./harness.mjs";

async function setup(t, utilization = 95, warm = true) {
  const homeDir = mkdtempSync(join(tmpdir(), "keepalive-config-reload-"));
  const h = createHarness({
    sessionId: "config-reload", homeDir, now: 1_700_000_000_000,
    model: { api: "claude-sdk-oauth", provider: "anthropic-subscription", id: "claude-sonnet" },
    goal: { id: "goal-1", status: "active" },
    env: { OMO_KEEPALIVE_FAKE_USAGE_FILE: join(homeDir, "usage.json") },
  });
  h.writeHomeJson("usage.json", { "anthropic-subscription": {
    five_hour: { utilization, resetAt: 1_700_003_600_000 },
    seven_day: { utilization: 10, resetAt: 1_700_100_000_000 },
  } });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fixture" } });
  const core = startKeepalive(h.pi, h.deps({ readUsage: async () => ({
    provider: "anthropic-subscription", account: "default", source: "endpoint", overageEnabled: false,
    windows: [
      { kind: "five_hour", utilization, resetAt: 1_700_003_600_000 },
      { kind: "seven_day", utilization: 10, resetAt: 1_700_100_000_000 },
    ],
  }), keepwarm: { piAi: {}, convertToLlm: (messages) => messages } }));
  await h.fire("session_start", { type: "session_start" });
  t.after(async () => {
    await h.fire("session_shutdown", { type: "session_shutdown" });
    h.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  });
  return { ...h, core };
}

test("watcher reloads threshold changes and releases or parks immediately", async (t) => {
  const h = await setup(t);
  assert.equal(h.core.isParked(), true);
  h.writeHomeJson(".omo/keepalive/config.json", { thresholds: { fiveHour: 96 } });
  h.fireConfigWatch();
  await h.clock.tick(0);
  assert.equal(h.core.config.thresholds.fiveHour, 96);
  assert.equal(h.core.isParked(), false);
  assert.equal(h.goalStore.goal.status, "active");
});

test("watcher parks a session when a lower threshold is loaded", async (t) => {
  const h = await setup(t, 85);
  assert.equal(h.core.isParked(), false);
  h.writeHomeJson(".omo/keepalive/config.json", { thresholds: { fiveHour: 80 } });
  h.fireConfigWatch();
  await h.clock.tick(0);
  assert.equal(h.core.isParked(), true);
});

test("boundary reload forces policy decision and watcher duplicate does not repoll", async (t) => {
  const h = await setup(t);
  h.writeHomeJson(".omo/keepalive/config.json", { thresholds: { fiveHour: 96 } });
  await h.fire("agent_settled", { type: "agent_settled" });
  assert.equal(h.core.isParked(), false);
  const polledAt = h.core.state.lastPollAt;
  h.fireConfigWatch();
  await h.clock.tick(0);
  assert.equal(h.core.state.lastPollAt, polledAt);
  assert.equal(h.core.isParked(), false);
});

test("invalid config warns once and falls back to default threshold", async (t) => {
  const h = await setup(t, 95);
  const before = h.notifications.length;
  h.writeHomeJson(".omo/keepalive/config.json", { thresholds: { fiveHour: 120 } });
  h.fireConfigWatch();
  await h.clock.tick(0);
  const warnings = h.notifications.slice(before).filter((n) => n.text.includes("keepalive 설정 오류: thresholds.fiveHour"));
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.equal(h.core.config.thresholds.fiveHour, 90);
});

test("unchanged and unrelated watcher events do nothing", async (t) => {
  const h = await setup(t);
  const polledAt = h.core.state.lastPollAt;
  h.fireConfigWatch("other.json");
  await h.clock.tick(0);
  h.fireConfigWatch();
  await h.clock.tick(0);
  assert.equal(h.core.state.lastPollAt, polledAt);
});

test("session shutdown closes the config watcher", async (t) => {
  const h = await setup(t);
  assert.equal(h.watchers.length, 1);
  await h.fire("session_shutdown", { type: "session_shutdown" });
  assert.equal(h.watchers[0].closed, true);
});

test("warm-only config reload reaches keepwarm despite unchanged park transition", async (t) => {
  const h = await setup(t, 95);
  assert.equal(h.core.isParked(), true);
  const calls = [];
  h.core.keepwarm.controller.setLimitHold = (value) => calls.push(value);
  const previous = structuredClone(h.core.state);
  h.writeHomeJson(".omo/keepalive/config.json", {
    thresholds: { fiveHour: 90 },
    warm: { "anthropic-subscription": { on: false } },
  });
  h.fireConfigWatch();
  await h.clock.tick(0);
  assert.equal(h.core.state.parkState, previous.parkState);
  assert.equal(h.core.state.resetAt, previous.resetAt);
  assert.equal(h.core.state.source, previous.source);
  assert.equal(calls.at(-1).warm, false);
});
