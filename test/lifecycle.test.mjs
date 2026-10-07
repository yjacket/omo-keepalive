import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { createHarness } from "./harness.mjs";
import { startLimitless } from "../extension/limitless.mjs";
import { statePath } from "../extension/state.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const snapshot = (utilization, resetAt) => ({
  provider: "anthropic-subscription", account: "default", source: "endpoint", overageEnabled: false,
  windows: [{ kind: "five_hour", utilization, resetAt }],
});
const LIMIT_ERROR = { type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "weekly limit exceeded" }] } };
const warms = (h) => h.sentMessages.filter((item) => item.msg?.customType === "limitless-warm").length;

// One senpi process whose current session id can change (/new, /resume). readUsage(sid) answers per session.
function proc({ readUsage, goal = { id: "g1", status: "active", objective: "work" }, deps = {} } = {}) {
  const h = createHarness({ model: CLAUDE, branch: PRIOR, goal, now: T0 });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fake" } });
  let sid = "A";
  h.ctx.sessionManager.getSessionId = () => sid;
  const calls = [];
  const core = startLimitless(h.pi, h.deps({
    readUsage: async () => { calls.push(sid); return readUsage(sid); },
    resolvePromptCacheLifetime: () => ({ kind: "ttl", ttlSeconds: 1800 }),
    ...deps,
  }));
  const start = () => h.fire("session_start", { type: "session_start" });
  return { h, core, calls, start, switchTo: (next) => { sid = next; return start(); } };
}

test("session switch: A's warm/resume timers are cleared and A's failed warm does not leak into parked B", async () => {
  const resetA = T0 + 3 * 3600_000;
  const resetB = T0 + 4 * 3600_000;
  const p = proc({ readUsage: (sid) => snapshot(95, sid === "A" ? resetA : resetB) });
  try {
    await p.start();
    assert.equal(p.core.state.parkState, "park-wait");
    await p.h.clock.tick(55 * 60_000);
    assert.equal(warms(p.h), 1);
    await p.h.fire("before_agent_start", { trigger: "extension", prompt: p.h.queuedTurns[0]?.prompt });
    await p.h.fire("agent_end", { messages: [{ role: "assistant", provider: "anthropic-subscription", stopReason: "error" }] });
    assert.equal(p.core.timers.has("warm"), false, "A's warm failed and stopped");
    const timersOfA = p.h.clock.pendingTimers();
    assert.ok(timersOfA.length > 0, "A still has its resume timer");
    // B was parked earlier with warm on (restart mid-park); same goal store.
    const stateA = p.h.readHomeJson(".omo/limitless/state/A.json");
    p.h.writeHomeJson(".omo/limitless/state/B.json", { ...stateA, sessionId: "B", resetAt: resetB, warmTurn: null, warmStopReason: null });
    await p.switchTo("B");
    assert.equal(p.core.sessionId, "B");
    for (const at of timersOfA) assert.equal(p.h.clock.pendingTimers().includes(at), false, `A timer at ${at} still pending`);
    assert.equal(p.core.timers.has("warm"), true, "B warms: A's warmFailed was reset");
    await p.h.clock.tick(56 * 60_000);
    assert.equal(warms(p.h), 2);
  } finally { p.h.cleanup(); }
});

test("session switch: A's reactive re-check never fires in B; B starts clean", async () => {
  const p = proc({ readUsage: () => snapshot(10, T0 + 3600_000) });
  try {
    await p.start();
    await p.h.fire("message_end", LIMIT_ERROR);
    assert.equal(p.core.state.source, "reactive");
    assert.deepEqual(p.h.clock.pendingTimers(), [T0 + 30 * 60_000]);
    await p.switchTo("B");
    assert.equal(p.core.isParked(), false);
    assert.deepEqual(p.h.clock.pendingTimers(), []);
    const callsBefore = p.calls.length;
    await p.h.clock.tick(31 * 60_000);
    assert.equal(p.calls.length, callsBefore, "no usage read from A's reactive timer");
    assert.equal(p.h.readHomeJson(".omo/limitless/state/B.json").lastRelease, null);
  } finally { p.h.cleanup(); }
});

test("session_shutdown clears every timer and stops persisting", async () => {
  const p = proc({ readUsage: () => snapshot(95, T0 + 3 * 3600_000) });
  try {
    await p.start();
    assert.ok(p.h.clock.pendingTimers().length >= 2, "warm + resume armed");
    await p.h.fire("session_shutdown", { type: "session_shutdown" });
    assert.deepEqual(p.h.clock.pendingTimers(), []);
    assert.equal(p.core.sessionId, null);
    assert.equal(p.core.persist(), false);
  } finally { p.h.cleanup(); }
});

test("N2: an off session shows no reactive park status or notice and arms no timer", async () => {
  const p = proc({ readUsage: () => snapshot(10, T0 + 3600_000) });
  try {
    await p.start(); // on: the lane is known
    assert.equal(p.core.lane?.provider, "anthropic-subscription");
    p.h.writeHomeJson(".omo/limitless/control/A.json", { v: 1, mode: "off" });
    await p.h.runTurn();
    assert.equal(p.core.enabled(), false);
    await p.h.fire("message_end", LIMIT_ERROR);
    assert.equal(p.core.isParked(), false);
    assert.equal(p.h.statusLines.has("limitless"), false);
    assert.deepEqual(p.h.notifications, []);
    assert.deepEqual(p.h.clock.pendingTimers(), []);
  } finally { p.h.cleanup(); }
});

test("N6: a failed state write is recorded in state.lastError {where:'write', path}", async () => {
  let fail = true;
  const fs = { ...nodeFs, renameSync: (from, to) => {
    if (fail && /[\\/]state[\\/]A\.json$/.test(to)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return nodeFs.renameSync(from, to);
  } };
  const p = proc({ readUsage: () => snapshot(10, T0 + 3600_000), deps: { fs } });
  try {
    await p.start();
    assert.equal(p.core.state.lastError?.where, "write");
    assert.equal(p.core.state.lastError?.path, statePath(p.h.tmpHome, "A"));
    fail = false;
    assert.equal(p.core.persist(), true);
    assert.equal(p.h.readHomeJson(".omo/limitless/state/A.json").lastError.where, "write");
  } finally { p.h.cleanup(); }
});
