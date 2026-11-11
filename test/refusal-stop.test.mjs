import assert from "node:assert/strict";
import test from "node:test";
import { startKeepalive } from "../extension/keepalive.mjs";
import { REFUSAL_STATUS } from "../extension/core.mjs";
import { renderPanel } from "../extension/panel.mjs";
import { createHarness } from "./harness.mjs";

// Issue #13: a goal keepalive restarted after a limit wait stops on a policy refusal (senpi:no-turn-retry,
// stopReason toolUse, the toolCall never gets a result) and senpi sends no continuation.
const T0 = Date.UTC(2026, 10, 9, 5, 0, 0);
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fable-5-1" };
const GOAL = { id: "g1", status: "active", objective: "work" };
const REFUSED = "senpi:no-turn-retry:Claude refused this request (cyber): I can't help with that.";
const snap = (utilization) => ({
  provider: "anthropic-subscription", account: "default",
  windows: [{ kind: "five_hour", utilization, resetAt: T0 + 3600000 }], overageEnabled: false, source: "endpoint",
});
const assistant = (id, extra) => ({
  type: "message", id, message: { role: "assistant", api: "claude-sdk-oauth", content: [], ...extra },
});

function setup({ resumed = true } = {}) {
  const branch = [assistant("a0", { stopReason: "stop", timestamp: T0 - 1000 })];
  const h = createHarness({ model: CLAUDE, branch, goal: GOAL, now: T0, env: { OMO_KEEPALIVE_FAKE_RESET_IN_MS: "1000" } });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fake" } });
  let calls = 0;
  const core = startKeepalive(h.pi, h.deps({ readUsage: async () => snap(resumed && calls++ === 0 ? 95 : 0) }));
  return { h, core, branch };
}

// session_start parks at 95% and pauses the goal; the reset re-poll reads 0% and keepalive restarts the goal.
async function parkAndResume(s) {
  await s.h.fire("session_start", { type: "session_start" });
  assert.equal(s.h.goalStore.goal.status, "paused");
  delete s.core.env.OMO_KEEPALIVE_FAKE_RESET_IN_MS;
  await s.h.clock.tick(61000);
  assert.equal(s.core.isParked(), false);
  assert.equal(s.h.goalStore.goal.status, "active");
}

const refusal = (id, timestamp) => assistant(id, {
  stopReason: "toolUse", errorMessage: REFUSED, timestamp,
  content: [{ type: "toolCall", id: "t1", name: "eval", arguments: {} }],
});

test("a goal keepalive restarted that stops on a refusal is shown and announced once, and nothing is re-sent", async () => {
  const s = setup();
  try {
    await parkAndResume(s);
    const sentBefore = s.h.sentUserMessages.length;
    const emitsBefore = s.h.eventsEmitted.length;
    const statusCallsBefore = s.h.goalStore.setStatusCalls.length;
    s.branch.push(refusal("a1", s.h.clock.now()));
    await s.h.fire("agent_settled", {});
    await s.h.fire("agent_settled", {}); // the same stop settles again: no second notice
    assert.equal(s.core.state.refusalStop?.key, "a1");
    assert.match(s.h.notice() ?? "", /정책 거부로 멈췄습니다/);
    assert.equal(s.h.notifications.filter((n) => n.level === "warning" && /정책 거부/.test(n.text)).length, 1);
    assert.equal(s.h.statusLines.get("omo-keepalive"), REFUSAL_STATUS);
    assert.equal(s.h.sentUserMessages.length, sentBefore);
    assert.equal(s.h.eventsEmitted.length, emitsBefore);
    assert.equal(s.h.goalStore.setStatusCalls.length, statusCallsBefore);
    const panel = renderPanel({
      state: s.core.state, config: s.core.config, home: s.h.tmpHome, now: s.h.clock.now(), hhmm: s.core.hhmm, statusText: "",
    });
    assert.match(panel, /정책 거부로 멈춤/);
  } finally { s.h.cleanup(); }
});

test("typed input clears the refusal stop; keepalive's own rescue text does not", async () => {
  const s = setup();
  try {
    await parkAndResume(s);
    s.branch.push(refusal("a1", s.h.clock.now()));
    await s.h.fire("agent_settled", {});
    await s.h.fire("message_start", { message: { role: "user", content: [{ type: "text", text: s.core.texts.limitRescue }] } });
    assert.ok(s.core.state.refusalStop);
    await s.h.fire("message_start", { message: { role: "user", content: [{ type: "text", text: "계속해" }] } });
    assert.equal(s.core.state.refusalStop, null);
    assert.equal(s.core.state.goalResume, null);
    assert.equal(s.h.notice(), undefined);
    assert.equal(s.h.statusLines.get("omo-keepalive"), "🔄");
    // A later refusal belongs to the user's run, not to a keepalive restart.
    s.branch.push(refusal("a2", s.h.clock.now()));
    await s.h.fire("agent_settled", {});
    assert.equal(s.core.state.refusalStop, null);
  } finally { s.h.cleanup(); }
});

test("no refusal stop without a keepalive restart, for an ordinary stop, or for a refusal older than the restart", async () => {
  const plain = setup({ resumed: false });
  try {
    await plain.h.fire("session_start", { type: "session_start" });
    plain.branch.push(refusal("a1", plain.h.clock.now()));
    await plain.h.fire("agent_settled", {});
    assert.equal(plain.core.state.refusalStop, null);
    assert.equal(plain.h.notice(), undefined);
  } finally { plain.h.cleanup(); }

  const s = setup();
  try {
    await parkAndResume(s);
    s.branch.push(assistant("a1", { stopReason: "stop", timestamp: s.h.clock.now() }));
    await s.h.fire("agent_settled", {});
    assert.equal(s.core.state.refusalStop, null);
    s.branch.push(refusal("a2", T0 - 500)); // stamped before the restart
    await s.h.fire("agent_settled", {});
    assert.equal(s.core.state.refusalStop, null);
    assert.equal(s.h.notifications.some((n) => /정책 거부/.test(n.text)), false);
  } finally { s.h.cleanup(); }
});
