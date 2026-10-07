import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { startLimitless } from "../extension/limitless.mjs";

// requireTtlSeconds end to end: real config file (OMO_LIMITLESS_CONFIG) -> loadConfig -> policy -> state.warm -> warm.
const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 2 * 3600000;
const CODEX = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" };
const PRIOR_CODEX = [{ type: "message", message: { role: "assistant", api: "openai-codex-responses", content: [] } }];

async function codexSession({ configTtl, resolverTtl }) {
  const h = createHarness({ model: CODEX, now: T0, branch: PRIOR_CODEX });
  const env = {};
  if (configTtl !== undefined) {
    h.writeHomeJson("cfg/limitless.json", { warm: { "chatgpt-subscription": { requireTtlSeconds: configTtl } } });
    env.OMO_LIMITLESS_CONFIG = `${h.deps().homeDir}/cfg/limitless.json`;
  }
  h.writeHomeJson(".omo/agent/auth.json", { "chatgpt-subscription": { access: "fake", accountId: "id" } });
  const core = startLimitless(h.pi, { ...h.deps({
    readUsage: async () => ({
      provider: "chatgpt-subscription", account: "default", source: "endpoint", overageEnabled: false,
      windows: [{ kind: "five_hour", utilization: 95, resetAt: RESET }],
    }),
    resolvePromptCacheLifetime: () => ({ kind: "ttl", ttlSeconds: resolverTtl }),
  }), env });
  await h.fire("session_start", { type: "session_start", reason: "startup" });
  return { h, core };
}

test("config requireTtlSeconds 3600 with a 3600 s model TTL warms", async () => {
  const { h, core } = await codexSession({ configTtl: 3600, resolverTtl: 3600 });
  try {
    assert.deepEqual(core.configWarnings, []);
    assert.equal(core.lane?.provider, "chatgpt-subscription");
    assert.equal(core.state.parkState, "park-wait");
    assert.equal(core.state.warm?.requireTtlSeconds, 3600);
    assert.equal(core.timers.has("warm"), true);
  } finally { h.cleanup(); }
});

test("config requireTtlSeconds 3600 with an 1800 s model TTL does not warm", async () => {
  const { h, core } = await codexSession({ configTtl: 3600, resolverTtl: 1800 });
  try {
    assert.equal(core.state.parkState, "park-wait");
    assert.equal(core.timers.has("warm"), false);
  } finally { h.cleanup(); }
});

test("no config: the 1800 s default applies end to end", async () => {
  const { h, core } = await codexSession({ resolverTtl: 1800 });
  try {
    assert.equal(core.state.warm?.requireTtlSeconds, 1800);
    assert.equal(core.timers.has("warm"), true);
  } finally { h.cleanup(); }
});
