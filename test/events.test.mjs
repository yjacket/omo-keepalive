import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import test from "node:test";
import { startLimitless } from "../extension/limitless.mjs";
import { install } from "../extension/events.mjs";
import { createHarness } from "./harness.mjs";

const config = {
  thresholds: { fiveHour: 90, sevenDay: 95 },
  waitLimitMs: { "anthropic-subscription": 4 * 60 * 60 * 1000 },
  warm: { "anthropic-subscription": { on: true, intervalMs: 3300000 } },
  enabled: true,
  pollMinIntervalMs: 60000,
  resumeGraceMs: 60000,
};

function snapshot(utilization, resetAt) {
  return {
    provider: "anthropic-subscription",
    account: "default",
    windows: [{ kind: "five_hour", utilization, resetAt }],
    overageEnabled: false,
    source: "test",
  };
}

test("publishes each park-state transition and persists parkState", async (t) => {
  const h = createHarness({
    model: { provider: "anthropic", api: "claude-sdk-oauth" },
    env: { OMO_LIMITLESS_AUTH_PATH: "unused" },
    now: 1000,
  });
  t.after(() => h.cleanup());
  let usage = snapshot(95, 2000);
  const core = startLimitless(h.pi, h.deps({
    fs: {
      readFileSync(path) {
        if (String(path).endsWith("unused")) return JSON.stringify({
          "anthropic-subscription": { access: "fake" },
        });
        return nodeFs.readFileSync(path);
      },
      writeFileSync: nodeFs.writeFileSync,
      renameSync: nodeFs.renameSync,
      mkdirSync: nodeFs.mkdirSync,
      unlinkSync: nodeFs.unlinkSync,
    },
    readUsage: async () => usage,
  }), [{ install }]);

  await h.fire("session_start", { type: "session_start" });
  usage = snapshot(50, 3000);
  await h.clock.tick(60000);
  await h.fire("turn_end", { type: "turn_end" });

  assert.deepEqual(h.eventsEmitted.filter((e) => e.name === "limitless:park").map((e) => e.payload), [
    { sessionId: "s1", state: "park-wait", resetAt: 2000 },
    { sessionId: "s1", state: "ok", resetAt: null },
  ]);
  assert.equal(h.readHomeJson(".omo/limitless/state/s1.json").parkState, "ok");
  assert.equal(core.state.parkState, "ok");
});

test("no pi.events listeners does not throw", async (t) => {
  const h = createHarness({ model: { provider: "anthropic", api: "claude-sdk-oauth" }, now: 1000 });
  t.after(() => h.cleanup());
  h.pi.events = undefined;
  const { install } = await import("../extension/events.mjs");
  const transitions = [];
  install({ onTransition: (fn) => transitions.push(fn), pi: h.pi, sessionId: "s1" });
  assert.doesNotThrow(() => transitions[0]({}, { parkState: "park-wait", resetAt: 2000 }));
});
