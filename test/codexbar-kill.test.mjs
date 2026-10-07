import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { clearUsageCache, readUsage } from "../extension/usage.mjs";

test("the codexbar fallback's taskkill on a hung child is bounded by a timeout", async () => {
  clearUsageCache();
  const seen = [];
  const result = await readUsage({ provider: "chatgpt-subscription", account: "default" }, {
    platform: "win32",
    env: { OMO_LIMITLESS_AUTH_PATH: "/a" },
    fs: { readFile: async (p) => { if (p !== "/a") throw new Error("ENOENT"); return JSON.stringify({ "chatgpt-subscription": { access: "t", accountId: "id" } }); } },
    fetch: async () => ({ status: 401, text: async () => "{}" }),
    spawn: () => { const c = new EventEmitter(); c.pid = 4242; c.kill = () => {}; c.stdout = new PassThrough(); return c; },
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    clearTimeout: () => {},
    execFileSync: (cmd, args, opts) => { seen.push({ cmd, args, opts }); },
    now: () => Date.now() + 900000,
  });
  assert.ok(seen.length >= 1, "taskkill invoked");
  assert.equal(seen[0].cmd, "taskkill");
  assert.equal(seen[0].opts.timeout, 5000);
  assert.ok(result === null || result.source !== "codexbar");
});
