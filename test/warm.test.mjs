// keepalive warm feature: a park-wait is handed to the keepwarm controller (warm until the reset, or not at all);
// keepalive itself never sends a warm turn.
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { startKeepalive } from "../extension/keepalive.mjs";
import { hostConvert } from "../extension/warm.mjs";
import { join } from "node:path";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 2 * 3600000;
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];
const GOAL = { id: "g1", status: "active", objective: "work" };

function setup({ util = 95, config } = {}) {
  let current = util;
  const h = createHarness({ model: CLAUDE, branch: PRIOR, goal: GOAL, now: T0 });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fake" } });
  if (config) h.writeHomeJson(".omo/keepalive/config.json", config);
  const readUsage = async () => ({
    provider: "anthropic-subscription", account: "default", source: "endpoint", overageEnabled: false,
    windows: [{ kind: "five_hour", utilization: current, resetAt: RESET }],
  });
  const core = startKeepalive(h.pi, h.deps({ readUsage, keepwarm: { piAi: {}, convertToLlm: (m) => m } }));
  const hold = () => {
    const h = core.keepwarm.controller.snapshot().limitHold;
    return h && { untilMs: h.untilMs, warm: h.warm, reason: h.reason };
  };
  return { h, core, hold, setUtil: (v) => { current = v; } };
}

test("a park-wait hands keepwarm the reset time and a release takes it back", async () => {
  const { h, core, hold } = setup();
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(core.state.parkState, "park-wait");
    assert.deepEqual(hold(), { untilMs: RESET, warm: true, reason: null });
    await core.release({ reason: "test" });
    assert.equal(hold(), null);
  } finally { h.cleanup(); }
});

test("99% utilization: keepwarm is told not to warm", async () => {
  const { h, hold } = setup({ util: 99 });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(hold(), { untilMs: RESET, warm: false, reason: "policy" });
  } finally { h.cleanup(); }
});

test("warm off for the lane in keepalive config: keepwarm is told not to warm", async () => {
  const { h, hold } = setup({ config: { warm: { "anthropic-subscription": { on: false } } } });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(hold(), { untilMs: RESET, warm: false, reason: "off" });
  } finally { h.cleanup(); }
});

test("keepalive sends no warm turn while waiting", async () => {
  const { h, core } = setup();
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.clock.tick(110 * 60_000);
    assert.equal(core.state.parkState, "park-wait");
    assert.deepEqual(h.sentMessages, []);
    assert.deepEqual(h.queuedTurns, []);
  } finally { h.cleanup(); }
});

test("host-module guard: a convert call before senpi's convertToLlm loads throws the named error", () => {
  assert.throws(() => hostConvert(() => null, []), { message: "keepalive: senpi host modules are not loaded yet" });
});

test("host-module guard: once loaded it converts", () => {
  assert.equal(hostConvert(() => (messages) => messages.length, [1, 2]), 2);
});

const STUB_NOTE = "옛 omo-keepwarm 스텁";
function stubSetup({ agentDirEnv = true } = {}) {
  const env = {};
  const h = createHarness({ model: CLAUDE, branch: PRIOR, goal: GOAL, now: T0, env });
  if (agentDirEnv) env.OMO_CODING_AGENT_DIR = join(h.tmpHome, "agent");
  const readUsage = async () => ({
    provider: "anthropic-subscription", account: "default", source: "endpoint", overageEnabled: false,
    windows: [{ kind: "five_hour", utilization: 10, resetAt: RESET }],
  });
  startKeepalive(h.pi, h.deps({ readUsage, keepwarm: { piAi: {}, convertToLlm: (m) => m } }));
  return h;
}

test("old-stub detector: silent when the stub is absent", async () => {
  const h = stubSetup();
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.deepEqual(h.notifications.filter((n) => n.text.includes(STUB_NOTE)), []);
  } finally { h.cleanup(); }
});

test("old-stub detector: one warning naming the stub path, however many session starts", async () => {
  const h = stubSetup();
  try {
    const stub = h.writeHomeJson("agent/extensions/omo-keepwarm.ts", "// stub");
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const warnings = h.notifications.filter((n) => n.text.includes(STUB_NOTE));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, "warning");
    assert.ok(warnings[0].text.includes(stub));
  } finally { h.cleanup(); }
});

test("old-stub detector: without an agent-dir env var it looks under the injected home, not the real one", async () => {
  const h = stubSetup({ agentDirEnv: false });
  try {
    const stub = h.writeHomeJson(".omo/agent/extensions/omo-keepwarm.ts", "// stub");
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    const warnings = h.notifications.filter((n) => n.text.includes(STUB_NOTE));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].text.includes(stub));
  } finally { h.cleanup(); }
});

test("not parked: no hold", async () => {
  const { h, hold } = setup({ util: 10 });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(hold(), null);
  } finally { h.cleanup(); }
});
