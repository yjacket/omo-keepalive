import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness } from "./harness.mjs";
import { startKeepalive } from "../extension/keepalive.mjs";
import { writeSharedSnapshot } from "../extension/state.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 2 * 3600000;
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR_TURN = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const GOAL = { id: "g1", status: "active", objective: "work" };
const snap = (utilization) => ({
  provider: "anthropic-subscription", account: "default",
  windows: [{ kind: "five_hour", utilization, resetAt: RESET }], overageEnabled: false, source: "endpoint",
});

function fakeSession(util, homeDir) {
  const h = createHarness({ model: CLAUDE, now: T0, goal: GOAL, branch: PRIOR_TURN, homeDir });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  const file = h.writeHomeJson("usage.json", { "anthropic-subscription": { five_hour: { utilization: util, resetAt: RESET }, seven_day: { utilization: 10, resetAt: RESET + 86400000 } } });
  const core = startKeepalive(h.pi, h.deps({ env: { OMO_KEEPALIVE_FAKE_USAGE_FILE: file }, fetch: undefined }));
  return { h, core };
}
const usageDir = (h) => join(h.tmpHome, ".omo", "keepalive", "usage");
const usageFiles = (h) => (existsSync(usageDir(h)) ? readdirSync(usageDir(h)) : []);

test("fake-source session polls without creating any shared usage snapshot", async () => {
  const { h, core } = fakeSession(95);
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(core.isParked(), true);
    assert.equal(core.state.snapshots[0].source, "fake");
    assert.deepEqual(usageFiles(h), []);
  } finally { h.cleanup(); }
});

test("fake 95% parks even when a fresh real shared 10% snapshot exists", async () => {
  const h0 = createHarness({ model: CLAUDE, now: T0 });
  h0.cleanup();
  const { h, core } = fakeSession(95);
  try {
    writeSharedSnapshot({ homeDir: h.tmpHome, snapshot: snap(10), observedAt: T0 - 1000 });
    const before = usageFiles(h);
    assert.equal(before.length, 1);
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(core.isParked(), true);
    assert.equal(core.state.snapshots[0].source, "fake");
    assert.deepEqual(usageFiles(h), before);
  } finally { h.cleanup(); }
});

test("a real session without the fake env is unaffected by an earlier fake session", async () => {
  const a = fakeSession(95);
  try {
    await a.h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(a.core.isParked(), true);
    const b = createHarness({ model: CLAUDE, now: T0, goal: GOAL, branch: PRIOR_TURN, homeDir: a.h.tmpHome });
    const calls = [];
    try {
      b.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
      const coreB = startKeepalive(b.pi, b.deps({ readUsage: async (r) => { calls.push(r); return snap(10); } }));
      await b.fire("session_start", { type: "session_start", reason: "startup" });
      assert.equal(calls.length, 1);
      assert.equal(coreB.isParked(), false);
      assert.equal(usageFiles(a.h).length, 1);
    } finally { /* shares a's home; a cleans it */ }
  } finally { a.h.cleanup(); }
});
