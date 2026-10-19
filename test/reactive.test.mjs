import assert from "node:assert/strict";
import test from "node:test";
import { startKeepalive } from "../extension/keepalive.mjs";
import { createHarness } from "./harness.mjs";

const local = (year, month, day, hour, minute = 0) => new Date(year, month, day, hour, minute).getTime();
const T0 = local(2026, 9, 7, 12);
const MODEL = { provider: "anthropic", api: "claude-sdk-oauth", id: "claude-fake" };
const FAILED = (content) => ({
  type: "message_end",
  message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: content }] },
});

const LOW = { provider: "anthropic-subscription", account: "default", source: "endpoint", windows: [{ kind: "five_hour", utilization: 10, resetAt: T0 + 3600000 }] };
const OVER = { provider: "anthropic-subscription", account: "default", source: "endpoint", windows: [{ kind: "five_hour", utilization: 95, resetAt: T0 + 3600000 }] };

function setup({ env = {}, readUsage } = {}) {
  const h = createHarness({ model: MODEL, now: T0, env });
  h.writeHomeJson(".omo/agent/auth.json", {
    "anthropic-subscription": { accounts: [{ name: "default", blockedUntil: null }] },
  });
  const core = startKeepalive(h.pi, h.deps({ readUsage }));
  return { h, core };
}

test("limit error with blockedUntil parks to that time and never warms", async () => {
  const { h, core } = setup();
  try {
    h.writeHomeJson(".omo/agent/auth.json", {
      "anthropic-subscription": { accounts: [{ name: "default", blockedUntil: T0 + 2 * 3600000 }] },
    });
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("usage limit reached"));
    assert.equal(core.isParked(), true);
    assert.equal(core.state.resetAt, T0 + 2 * 3600000);
    assert.equal(core.state.source, "reactive");
    assert.equal(core.state.warm.on, false);
    assert.equal(core.canWarm(), false);
  } finally { h.cleanup(); }
});

test("blockedUntil alone recognizes a failed assistant limit message", async () => {
  const { h, core } = setup();
  try {
    h.writeHomeJson(".omo/agent/auth.json", {
      "anthropic-subscription": { accounts: [{ name: "default", blockedUntil: T0 + 3600000 }] },
    });
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", { message: { role: "assistant", stopReason: "error", content: "request failed" } });
    assert.equal(core.isParked(), true);
    assert.equal(core.state.resetAt, T0 + 3600000);
  } finally { h.cleanup(); }
});

test("quota diagnostic family plus usage-limit text is recognized", async () => {
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", {
      message: {
        role: "assistant", stopReason: "error", content: "usage limit reached",
        providerDiagnostic: { family: "quota", message: "usage limit reached", resets_at: new Date(T0 + 7200000).toISOString() },
      },
    });
    assert.equal(core.isParked(), true);
    assert.equal(core.state.resetAt, T0 + 7200000);
  } finally { h.cleanup(); }
});

test("reset_after_seconds supplies the reset time", async () => {
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", {
      message: {
        role: "assistant", stopReason: "error", content: "weekly limit",
        error: { reset_after_seconds: 1800 },
      },
    });
    assert.equal(core.state.resetAt, T0 + 1800000);
  } finally { h.cleanup(); }
});

test("usage-limit text parses resets 3:00pm in the injected local timezone", async () => {
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("Your session limit resets 3:00pm"));
    assert.equal(core.isParked(), true);
    assert.equal(core.state.resetAt, local(2026, 9, 7, 15));
  } finally { h.cleanup(); }
});

test("unknown reset rechecks in 30 minutes and releases when usage is low", async () => {
  const { h, core } = setup({
    readUsage: async () => ({
      provider: "anthropic-subscription", account: "default", source: "endpoint",
      windows: [{ kind: "five_hour", utilization: 10, resetAt: T0 + 3600000 }],
    }),
  });
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("weekly limit exceeded"));
    assert.equal(core.isParked(), true);
    assert.deepEqual(h.clock.pendingTimers(), [T0 + 30 * 60000]);
    await h.clock.tick(30 * 60000);
    assert.equal(core.isParked(), false);
    assert.equal(h.statusLines.get("omo-keepalive"), "🔄");
  } finally { h.cleanup(); }
});

test("usage source still none at the 30-minute check releases for the next turn", async () => {
  const { h, core } = setup({ readUsage: async () => ({ source: "none", windows: [] }) });
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("usage_limit_reached"));
    await h.clock.tick(30 * 60000);
    assert.equal(core.isParked(), false);
    assert.equal(h.notifications.filter((notice) => notice.text.includes("대기를 해제했습니다")).length, 0);
  } finally { h.cleanup(); }
});

test("releasing an unknown-reset park clears its recheck timer", async () => {
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("usage limit reached"));
    assert.equal(h.clock.pendingTimers().length, 1);
    await core.release({ reason: "manual" });
    assert.deepEqual(h.clock.pendingTimers(), []);
  } finally { h.cleanup(); }
});

test("six hours of still-over usage rechecks release and notify once", async () => {
  const { h, core } = setup({ readUsage: async () => OVER });
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("usage_limit_reached"));
    await h.clock.tick(6 * 3600000);
    assert.equal(core.isParked(), false);
    assert.equal(h.notifications.filter((notice) => notice.text.includes("대기를 해제했습니다")).length, 1);
  } finally { h.cleanup(); }
});

test("30-minute recheck at 95% keeps the park (policy decides) and rearms; low usage then releases", async () => {
  let usage = LOW;
  const { h, core } = setup({ readUsage: async () => usage });
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("usage limit reached"));
    assert.equal(core.state.source, "reactive");
    usage = OVER;
    await h.clock.tick(30 * 60000);
    assert.equal(core.isParked(), true);
    assert.equal(h.clock.pendingTimers().length >= 1, true);
    // the still-over check made this a known-reset park (reset T0+1h); it ends at reset via resetDue
    assert.equal(core.state.source, "poll");
    usage = LOW;
    await h.clock.tick(35 * 60000);
    assert.equal(core.isParked(), false);
  } finally { h.cleanup(); }
});

test("a past blockedUntil is not a limit recogniser: a plain 500 never parks", async () => {
  const { h, core } = setup();
  try {
    h.writeHomeJson(".omo/agent/auth.json", {
      "anthropic-subscription": { accounts: [{ name: "default", blockedUntil: T0 - 86400000 }] },
    });
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("server error 500"));
    assert.equal(core.isParked(), false);
  } finally { h.cleanup(); }
});

test("known-reset reactive park is released at reset via resetDue with no repeated messages", async () => {
  const { h, core } = setup({ readUsage: async () => LOW });
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", {
      message: { role: "assistant", stopReason: "error", content: "usage limit reached", error: { reset_after_seconds: 3600 } },
    });
    assert.equal(core.isParked(), true);
    assert.equal(core.state.source, "reactive");
    await h.clock.tick(3600000 + 60000);
    assert.equal(core.isParked(), false);
    assert.equal(h.sentUserMessages.length, 0);
    assert.deepEqual(h.clock.pendingTimers(), []);
  } finally { h.cleanup(); }
});

test("reset order: blockedUntil beats resets_at/reset_after_seconds beats text", async () => {
  const body = {
    message: {
      role: "assistant", stopReason: "error", content: "usage limit reached, resets 3pm",
      error: { resets_at: new Date(T0 + 2 * 3600000).toISOString() },
    },
  };
  for (const [blockedUntil, expected] of [[T0 + 4 * 3600000, T0 + 4 * 3600000], [null, T0 + 2 * 3600000]]) {
    const { h, core } = setup();
    try {
      h.writeHomeJson(".omo/agent/auth.json", {
        "anthropic-subscription": { accounts: [{ name: "default", blockedUntil }] },
      });
      await h.fire("session_start", { type: "session_start" });
      await h.fire("message_end", body);
      assert.equal(core.state.resetAt, expected);
    } finally { h.cleanup(); }
  }
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", { message: { ...body.message, error: {} } });
    assert.equal(core.state.resetAt, local(2026, 9, 7, 15));
  } finally { h.cleanup(); }
});

test("resets 3pm (no minutes) is parsed; a bare number is not a time", async () => {
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("Your session limit resets 3pm"));
    assert.equal(core.state.resetAt, local(2026, 9, 7, 15));
  } finally { h.cleanup(); }
  const second = setup();
  try {
    await second.h.fire("session_start", { type: "session_start" });
    await second.h.fire("message_end", FAILED("usage limit resets 3 hours"));
    assert.equal(second.core.isParked(), true);
    assert.equal(second.core.state.resetAt, null);
  } finally { second.h.cleanup(); }
});

test("non-limit assistant failure does not park", async () => {
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("server error 500"));
    assert.equal(core.isParked(), false);
    assert.equal(h.notifications.length, 0);
  } finally { h.cleanup(); }
});

test("missing auth.json does not prevent the text recognizer from parking", async () => {
  const h = createHarness({ model: MODEL, now: T0 });
  const core = startKeepalive(h.pi, h.deps());
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("weekly limit resets 3:00pm"));
    assert.equal(core.isParked(), true);
    assert.equal(core.state.resetAt, local(2026, 9, 7, 15));
  } finally { h.cleanup(); }
});

// ── ROUND 3: owned-goal restart on every reactive release + successful check ends the 6 h cap ──
const NONE = { source: "none", windows: [] };
const goalEmits = (h) => h.eventsEmitted.filter((e) => e.name === "goal_store_changed").length;

async function parkWithGoal({ readUsage, goal = { id: "g1", status: "active" } }) {
  const { h, core } = setup({ readUsage });
  h.setGoal(goal);
  await h.fire("session_start", { type: "session_start" });
  await h.fire("message_end", FAILED("usage limit reached"));
  return { h, core };
}

for (const [name, usage, ms] of [
  ["usage-ok", async () => LOW, 30 * 60000],
  ["usage-unavailable", async () => NONE, 30 * 60000],
  ["6h cap", async () => OVER, 6 * 3600000],
]) {
  test("reactive release (" + name + ") restarts an owned goal once when idle", async () => {
    const { h, core } = await parkWithGoal({ readUsage: usage });
    try {
      assert.equal(core.state.pausedByKeepalive, "g1");
      assert.equal(h.goalStore.goal.status, "paused");
      assert.equal(goalEmits(h), 0);
      await h.clock.tick(ms);
      assert.equal(core.isParked(), false);
      assert.equal(h.goalStore.goal.status, "active");
      assert.equal(goalEmits(h), 1);
      assert.equal(h.sentUserMessages.length, 0);
    } finally { h.cleanup(); }
  });

  test("reactive release (" + name + ") queues no message when busy and restarts the goal once at agent_settled", async () => {
    const { h, core } = await parkWithGoal({ readUsage: usage });
    try {
      h.setIdle(false);
      await h.clock.tick(ms);
      assert.equal(core.isParked(), false);
      assert.equal(h.goalStore.goal.status, "active");
      assert.equal(goalEmits(h), 0);
      assert.equal(h.sentUserMessages.length, 0);
      h.setIdle(true);
      await h.fire("agent_settled", { type: "agent_settled" });
      // The 6 h cap releases with usage still over: the settle boundary re-parks and pauses the goal again.
      assert.equal(goalEmits(h), name === "6h cap" ? 0 : 1);
    } finally { h.cleanup(); }
  });

  test("reactive release (" + name + ") leaves a non-owned (user-paused) goal alone", async () => {
    const { h, core } = await parkWithGoal({ readUsage: usage, goal: { id: "g1", status: "paused" } });
    try {
      assert.equal(core.state.pausedByKeepalive, null);
      await h.clock.tick(ms);
      assert.equal(core.isParked(), false);
      assert.equal(h.goalStore.goal.status, "paused");
      assert.equal(goalEmits(h), 0);
      assert.equal(h.sentUserMessages.length, 0);
    } finally { h.cleanup(); }
  });
}

test("successful recheck still over turns the reactive park into a known-reset park and stops the 6 h cap", async () => {
  const H = 3600000;
  let low = false;
  const usageNow = () => low ? LOW : {
    ...OVER, windows: [{ kind: "five_hour", utilization: 95, resetAt: T0 + (h.clock.now() < T0 + 4 * H ? 4 : 8) * H }],
  };
  let h;
  let core;
  ({ h, core } = await parkWithGoal({ readUsage: async () => usageNow() }));
  try {
    await h.clock.tick(30 * 60000);
    assert.equal(core.isParked(), true);
    assert.equal(core.state.source, "poll");
    assert.equal(core.state.resetAt, T0 + 4 * H);
    assert.equal(core.timers.has("reactive-check"), false);
    // first reset passes still over: core.resetDue re-parks with the next reset; 6.5 h after the limit, no cap release
    await h.clock.tick(3.6 * H);
    assert.equal(core.state.resetAt, T0 + 8 * H);
    await h.clock.tick(2.4 * H);
    assert.equal(core.isParked(), true);
    assert.equal(h.notifications.filter((n) => n.text.includes("대기를 해제했습니다")).length, 0);
    assert.equal(h.goalStore.goal.status, "paused");
    // second reset arrives with usage low: core.resetDue releases and restarts the owned goal once
    low = true;
    await h.clock.tick(1.6 * H);
    assert.equal(core.isParked(), false);
    assert.equal(h.goalStore.goal.status, "active");
    assert.equal(goalEmits(h), 1);
  } finally { h.cleanup(); }
});

test("with no successful check for 6 h the cap still releases", async () => {
  const { h, core } = await parkWithGoal({ readUsage: async () => OVER });
  try {
    await h.clock.tick(6 * 3600000 + 1);
    assert.equal(core.isParked(), false);
    assert.equal(h.notifications.filter((n) => n.text.includes("대기를 해제했습니다")).length, 1);
  } finally { h.cleanup(); }
});

test("ROUND 5: 30-minute recheck at 95% with a PAST reset parks without a deadline - never park-exit, no shutdown", async () => {
  let usage = LOW;
  const { h, core } = setup({ readUsage: async () => usage });
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", FAILED("usage limit reached"));
    assert.equal(core.state.source, "reactive");
    const seen = [];
    core.onTransition((_prev, next) => seen.push(next.parkState));
    const checkAt = T0 + 30 * 60000;
    usage = { ...OVER, windows: [{ kind: "five_hour", utilization: 95, resetAt: checkAt - 60000 }] };
    await h.clock.tick(30 * 60000);
    assert.equal(core.isParked(), true);
    assert.equal(core.state.parkState, "park-wait");
    assert.equal(core.state.resetAt, null);
    assert.equal(core.state.warm.on, false);
    assert.equal(seen.includes("park-exit"), false);
    assert.equal(h.shutdownCalls.length, 0);
    assert.deepEqual(h.clock.pendingTimers(), [checkAt + 60000]);
    assert.equal(h.statusLines.get("omo-keepalive"), "⏸ 한도 대기 · 재개 시각 미정");
    usage = LOW;
    await h.clock.tick(60000);
    assert.equal(core.isParked(), false);
  } finally { h.cleanup(); }
});

test("ROUND 5: a limit error whose resets_at is already past parks without a deadline and keeps the 30-minute check", async () => {
  const { h, core } = setup({ readUsage: async () => LOW });
  try {
    await h.fire("session_start", { type: "session_start" });
    await h.fire("message_end", {
      message: { role: "assistant", stopReason: "error", content: "usage limit reached", error: { resets_at: new Date(T0 - 60000).toISOString() } },
    });
    assert.equal(core.state.parkState, "park-wait");
    assert.equal(core.state.resetAt, null);
    assert.deepEqual(h.clock.pendingTimers(), [T0 + 30 * 60000]);
  } finally { h.cleanup(); }
});

test("epoch seconds (not ms) are accepted for blockedUntil and for resets_at", async () => {
  for (const viaAuth of [true, false]) {
    const { h, core } = setup();
    try {
      const resetSec = Math.floor((T0 + 2 * 3600000) / 1000);
      if (viaAuth) {
        h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { accounts: [{ name: "default", blockedUntil: resetSec }] } });
      }
      await h.fire("session_start", { type: "session_start" });
      await h.fire("message_end", viaAuth ? FAILED("usage limit reached") : {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", content: "usage limit reached", error: { resets_at: resetSec } },
      });
      assert.equal(core.state.resetAt, resetSec * 1000);
    } finally { h.cleanup(); }
  }
});
