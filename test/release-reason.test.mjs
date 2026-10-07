import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { startLimitless } from "../extension/limitless.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 2 * 3600000;
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const PRIOR_TURN = [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }];

async function parkedSession() {
  let util = 95;
  const h = createHarness({ model: CLAUDE, now: T0, branch: PRIOR_TURN });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fake" } });
  const core = startLimitless(h.pi, h.deps({ readUsage: async () => ({
    provider: "anthropic-subscription", account: "default", source: "endpoint", overageEnabled: false,
    windows: [{ kind: "five_hour", utilization: util, resetAt: RESET }],
  }) }));
  await h.fire("session_start", { type: "session_start" });
  assert.equal(core.isParked(), true);
  return { h, core, setUtil: (value) => { util = value; } };
}

test("the reset timer's release is recorded as reset", async () => {
  const { h, core, setUtil } = await parkedSession();
  try {
    setUtil(10);
    await h.clock.tick(RESET - T0 + 60000);
    assert.equal(core.isParked(), false);
    assert.equal(core.state.lastRelease.reason, "reset");
  } finally { h.cleanup(); }
});

test("a boundary poll's release stays usage-ok", async () => {
  const { h, core, setUtil } = await parkedSession();
  try {
    setUtil(10);
    h.clock.advance(61_000);
    await h.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] });
    assert.equal(core.isParked(), false);
    assert.equal(core.state.lastRelease.reason, "usage-ok");
  } finally { h.cleanup(); }
});
