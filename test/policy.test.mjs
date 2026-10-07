import { test } from "node:test";
import * as assert from "node:assert/strict";
import { decide } from "../extension/policy.mjs";

// Default config for tests
const defaultConfig = {
  thresholds: { fiveHour: 90, sevenDay: 95 },
  waitLimitMs: {
    "anthropic-subscription": 14400000, // 4h
    "chatgpt-subscription": 7200000     // 2h
  },
  warm: {
    "anthropic-subscription": { on: true, intervalMs: 3300000 },
    "chatgpt-subscription": { on: true, intervalMs: 1620000, requireTtlSeconds: 1800 }
  }
};

const now = 1000000;

test("policy.mjs table tests", async (t) => {
  // Row 1: Below fiveHour threshold (89.9%) -> ok
  await t.test("row 1: 89.9% five_hour -> ok", () => {
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 89.9, resetAt: now + 100000 }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "ok");
  });

  // Row 2: At fiveHour threshold (90%) -> park
  await t.test("row 2: 90% five_hour -> park-wait (within 4h)", () => {
    const resetAt = now + 7200000; // 2h away
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 90, resetAt }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-wait");
    assert.equal(result.window, "five_hour");
    assert.equal(result.resetAt, resetAt);
  });

  // Row 3: Below sevenDay threshold (94.9%) -> ok
  await t.test("row 3: 94.9% seven_day -> ok", () => {
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [
          { kind: "five_hour", utilization: 50, resetAt: now + 100000 },
          { kind: "seven_day", utilization: 94.9, resetAt: now + 200000 }
        ],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "ok");
  });

  // Row 4: At sevenDay threshold (95%) -> park
  await t.test("row 4: 95% seven_day -> park-wait", () => {
    const resetAt = now + 7200000;
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [
          { kind: "five_hour", utilization: 50, resetAt: now + 100000 },
          { kind: "seven_day", utilization: 95, resetAt }
        ],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-wait");
    assert.equal(result.window, "seven_day");
  });

  // Row 5: Both windows over -> use latest resetAt
  await t.test("row 5: both windows over -> use latest resetAt", () => {
    const resetAt5h = now + 3600000;  // 1h
    const resetAt7d = now + 7200000;  // 2h
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [
          { kind: "five_hour", utilization: 91, resetAt: resetAt5h },
          { kind: "seven_day", utilization: 96, resetAt: resetAt7d }
        ],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-wait");
    assert.equal(result.window, "seven_day"); // Latest resetAt is 7d
    assert.equal(result.resetAt, resetAt7d);
  });

  // Row 6: Claude wait boundary - exactly 4h away -> park-wait
  await t.test("row 6: Claude exactly 4h away -> park-wait", () => {
    const resetAt = now + 14400000; // Exactly 4h
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 90, resetAt }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-wait");
  });

  // Row 7: Claude 4h + 1ms away -> park-exit
  await t.test("row 7: Claude 4h + 1ms away -> park-exit", () => {
    const resetAt = now + 14400001; // 4h + 1ms
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 90, resetAt }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-exit");
  });

  // Row 8: Codex 2h boundary
  await t.test("row 8: Codex exactly 2h away -> park-wait", () => {
    const resetAt = now + 7200000; // Exactly 2h
    const result = decide({
      snapshots: [{
        provider: "chatgpt-subscription",
        account: "default",
        windows: [{ kind: "seven_day", utilization: 95, resetAt }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-wait");
  });

  // Row 9: Codex 2h + 1ms -> park-exit
  await t.test("row 9: Codex 2h + 1ms away -> park-exit", () => {
    const resetAt = now + 7200001; // 2h + 1ms
    const result = decide({
      snapshots: [{
        provider: "chatgpt-subscription",
        account: "default",
        windows: [{ kind: "seven_day", utilization: 95, resetAt }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-exit");
  });

  // Row 10: Multi-account - one over, one under -> ok
  await t.test("row 10: multi-account one-over-one-under -> ok", () => {
    const result = decide({
      snapshots: [
        {
          provider: "anthropic-subscription",
          account: "account-a",
          windows: [{ kind: "five_hour", utilization: 85, resetAt: now + 100000 }],
          overageEnabled: false,
          source: "endpoint"
        },
        {
          provider: "anthropic-subscription",
          account: "account-b",
          windows: [{ kind: "five_hour", utilization: 92, resetAt: now + 200000 }],
          overageEnabled: false,
          source: "endpoint"
        }
      ],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "ok");
  });

  // Row 11: Multi-account - both over -> park with earliest resetAt
  await t.test("row 11: multi-account both-over -> park with earliest resetAt", () => {
    const resetAtA = now + 3600000;  // 1h
    const resetAtB = now + 7200000;  // 2h
    const result = decide({
      snapshots: [
        {
          provider: "anthropic-subscription",
          account: "account-a",
          windows: [{ kind: "five_hour", utilization: 91, resetAt: resetAtA }],
          overageEnabled: false,
          source: "endpoint"
        },
        {
          provider: "anthropic-subscription",
          account: "account-b",
          windows: [{ kind: "five_hour", utilization: 92, resetAt: resetAtB }],
          overageEnabled: false,
          source: "endpoint"
        }
      ],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-wait");
    assert.equal(result.resetAt, resetAtA); // Earliest
  });

  // Row 12: 99% utilization -> park but warm.on = false
  await t.test("row 12: 99% utilization -> warm.on = false", () => {
    const resetAt = now + 7200000;
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 99, resetAt }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-wait");
    assert.equal(result.warm.on, false);
  });

  // Row 13: 100% with overage enabled -> warm.on = false
  await t.test("row 13: 100% with overage enabled -> warm.on = false", () => {
    const resetAt = now + 7200000;
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 100, resetAt }],
        overageEnabled: true,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-wait");
    assert.equal(result.warm.on, false);
  });

  // Row 14: Unknown provider -> ok
  await t.test("row 14: unknown provider -> ok", () => {
    const result = decide({
      snapshots: [{
        provider: "unknown-provider",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 95, resetAt: now + 100000 }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "ok");
  });

  // Row 15 (ROUND 2): waitLimitMs = 0, over threshold -> park-exit
  await t.test("row 15: waitLimitMs 0 with 90% -> park-exit", () => {
    const configWith0 = {
      ...defaultConfig,
      waitLimitMs: { "anthropic-subscription": 0, "chatgpt-subscription": 7200000 }
    };
    const resetAt = now + 7200000;
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 90, resetAt }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: configWith0,
      now
    });
    assert.equal(result.state, "park-exit");
  });

  // Row 16 (ROUND 2): waitLimitMs = 0, under threshold -> ok
  await t.test("row 16: waitLimitMs 0 with 85% -> ok", () => {
    const configWith0 = {
      ...defaultConfig,
      waitLimitMs: { "anthropic-subscription": 0, "chatgpt-subscription": 7200000 }
    };
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 85, resetAt: now + 100000 }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: configWith0,
      now
    });
    assert.equal(result.state, "ok");
  });
});

test("adversarial inputs", async (t) => {
  // NaN utilization
  await t.test("NaN utilization -> ok", () => {
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: NaN, resetAt: now + 100000 }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "ok");
  });

  // Undefined utilization
  await t.test("undefined utilization -> ok", () => {
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: undefined, resetAt: now + 100000 }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "ok");
  });

  // Missing windows
  await t.test("missing windows -> ok", () => {
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "ok");
  });

  // resetAt in the past
  await t.test("resetAt in past -> park-exit", () => {
    const resetAt = now - 1000; // 1 second in past
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 90, resetAt }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "park-exit");
  });
});

test("edge cases", async (t) => {
  // Empty snapshots
  await t.test("empty snapshots -> ok", () => {
    const result = decide({
      snapshots: [],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "ok");
  });

  // source "none"
  await t.test("source none -> ok", () => {
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 95, resetAt: now + 100000 }],
        overageEnabled: false,
        source: "none"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.state, "ok");
  });

  // reason field format
  await t.test("reason field format", () => {
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 92, resetAt: now + 100000 }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.match(result.reason, /^(5h|7d) \d+%$/);
  });

  // warm.intervalMs passed through
  await t.test("warm config passed through", () => {
    const result = decide({
      snapshots: [{
        provider: "anthropic-subscription",
        account: "default",
        windows: [{ kind: "five_hour", utilization: 90, resetAt: now + 7200000 }],
        overageEnabled: false,
        source: "endpoint"
      }],
      config: defaultConfig,
      now
    });
    assert.equal(result.warm.intervalMs, 3300000);
    assert.equal(result.warm.on, true);
  });
});
