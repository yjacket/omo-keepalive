import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../extension/config.mjs";

test("all env hooks unset = defaults", () => {
  const result = loadConfig({
    env: {},
    homeDir: "C:/missing-limitless-home",
    fs: { readFileSync() { const error = new Error("missing"); error.code = "ENOENT"; throw error; } },
  });
  assert.deepEqual(result.config, {
    thresholds: { fiveHour: 90, sevenDay: 95 },
    waitLimitMs: { "anthropic-subscription": 14400000, "chatgpt-subscription": 7200000 },
    warm: {
      "anthropic-subscription": { on: true, intervalMs: 3300000 },
      "chatgpt-subscription": { on: true, intervalMs: 1620000, requireTtlSeconds: 1800 },
    },
    enabled: true,
    pollMinIntervalMs: 60000,
    resumeGraceMs: 60000,
  });
  assert.deepEqual(result.warnings, []);
});

test("zero wait limit is valid", () => {
  const result = loadConfig({
    env: { OMO_LIMITLESS_CONFIG: "config.json" },
    homeDir: "unused",
    fs: { readFileSync: () => JSON.stringify({ waitLimitMs: { "anthropic-subscription": 0 } }) },
  });
  assert.equal(result.config.waitLimitMs["anthropic-subscription"], 0);
  assert.equal(result.warnings.some((warning) => warning.includes("waitLimitMs.anthropic-subscription")), false);
});

test("invalid nested values fall back and name their key", () => {
  const result = loadConfig({
    env: { OMO_LIMITLESS_CONFIG: "config.json" },
    homeDir: "unused",
    fs: { readFileSync: () => JSON.stringify({ thresholds: { fiveHour: "abc" }, warm: { "chatgpt-subscription": null } }) },
  });
  assert.equal(result.config.thresholds.fiveHour, 90);
  assert.ok(result.warnings.some((warning) => warning.includes("thresholds.fiveHour")));
  assert.ok(result.warnings.some((warning) => warning.includes("warm.chatgpt-subscription")));
});

test("malformed JSON preserves all defaults without throwing", () => {
  const result = loadConfig({
    env: { OMO_LIMITLESS_CONFIG: "bad.json" }, homeDir: "unused",
    fs: { readFileSync: () => "not JSON" },
  });
  assert.equal(result.config.thresholds.fiveHour, 90);
  assert.equal(result.config.thresholds.sevenDay, 95);
  assert.equal(result.config.waitLimitMs["anthropic-subscription"], 14400000);
  assert.equal(result.config.waitLimitMs["chatgpt-subscription"], 7200000);
  assert.equal(result.config.warm["anthropic-subscription"].intervalMs, 3300000);
  assert.equal(result.config.warm["chatgpt-subscription"].intervalMs, 1620000);
  assert.equal(result.config.warm["chatgpt-subscription"].requireTtlSeconds, 1800);
  assert.equal(result.config.enabled, true);
  assert.equal(result.config.pollMinIntervalMs, 60000);
  assert.equal(result.config.resumeGraceMs, 60000);
  assert.equal(result.warnings.length, 1);
});
