import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { clearUsageCache, listAccounts, readUsage } from "../extension/usage.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/usage/${name}.json`, import.meta.url), "utf8"));
const jsonResponse = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) });
const baseFs = (files = {}) => ({
  readFile: async (path) => {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path];
  },
});
test.beforeEach(() => clearUsageCache());

test("maps Claude response and sends the expected endpoint headers", async () => {
  const body = await fixture("claude");
  const requests = [];
  const result = await readUsage({ provider: "anthropic-subscription", account: "work" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth.json" },
    fs: baseFs({ "/auth.json": JSON.stringify({ "anthropic-subscription": { access: "wrong", accounts: [{ name: "work", access: "account-token" }] } }) }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(body);
    },
    now: () => Date.now() + 100000,
  });
  assert.deepEqual(result, {
    provider: "anthropic-subscription", account: "work",
    windows: [
      { kind: "five_hour", utilization: 7, resetAt: 1791354600000 },
      { kind: "seven_day", utilization: 8, resetAt: 1791892800000 },
    ],
    overageEnabled: false, source: "endpoint",
  });
  assert.equal(requests[0].url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(requests[0].options.headers.Authorization, "Bearer account-token");
  assert.equal(requests[0].options.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.match(requests[0].options.headers["User-Agent"], /^claude-cli\/.+ \(external, cli\)$/);
  assert.equal(requests[1].url, "https://api.anthropic.com/api/oauth/profile");
  assert.equal(requests[1].options.headers.Authorization, "Bearer account-token");
});

test("maps Codex weekly window and tolerates null secondary", async () => {
  const result = await readUsage({ provider: "chatgpt-subscription", account: "default" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth.json" },
    fs: baseFs({ "/auth.json": JSON.stringify({ "chatgpt-subscription": { access: "codex-token", accountId: "acct" } }) }),
    fetch: async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer codex-token");
      assert.equal(options.headers["chatgpt-account-id"], "acct");
      return jsonResponse(await fixture("codex"));
    },
    now: () => Date.now() + 200000,
  });
  assert.deepEqual(result.windows, [{ kind: "seven_day", utilization: 0, resetAt: 1791892800000 }]);
  assert.equal(result.source, "endpoint");
});

test("lists pool names, flat defaults, and missing providers", () => {
  assert.deepEqual(listAccounts({ p: { accounts: [{ name: "a" }, { name: "b" }] } }, "p"), ["a", "b"]);
  assert.deepEqual(listAccounts({ p: { access: "token" } }, "p"), ["default"]);
  assert.deepEqual(listAccounts({}, "p"), []);
});

test("401 uses Claude Code only for a matching account UUID", async () => {
  const usage = await fixture("claude");
  let usageToken;
  let calls = 0;
  const fs = {
    readFile: async (path) => {
      const p = String(path).replaceAll("\\", "/");
      if (p === "/auth.json") return JSON.stringify({ "anthropic-subscription": { accounts: [{ name: "default", access: "senpi-token" }] } });
      if (p.includes("anthropic-")) return JSON.stringify({ uuid: "same" });
      if (p === "/home/.claude/.credentials.json") return JSON.stringify({ claudeAiOauth: { accessToken: "cli-token" } });
      throw new Error("ENOENT");
    },
  };
  const result = await readUsage({ provider: "anthropic-subscription", account: "default" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth.json" }, homeDir: "/home", fs,
    fetch: async (_url, options) => {
      calls++;
      if (calls === 1) return jsonResponse({}, 401);
      if (calls === 2) return jsonResponse({ account: { uuid: "same" } });
      if (calls === 3) {
        usageToken = options.headers.Authorization;
        return jsonResponse(usage);
      }
      return jsonResponse(usage);
    },
    spawnSync: () => { throw new Error("CodexBar should not run"); },
    now: () => Date.now() + 300000,
  });
  assert.equal(result.source, "claude-code");
  assert.equal(usageToken, "Bearer cli-token");
  assert.equal(calls, 3);
});

test("401 falls through Claude Code, CodexBar, then none", async () => {
  let spawnCount = 0;
  const first = await readUsage({ provider: "anthropic-subscription", account: "default" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth-1" },
    fs: baseFs({ "/auth-1": JSON.stringify({ "anthropic-subscription": { access: "token" } }) }),
    fetch: async () => jsonResponse({}, 401),
    spawnSync: () => { spawnCount++; return { status: 0, stdout: JSON.stringify(awaitableError) }; },
    now: () => Date.now() + 400000,
  });
  assert.equal(first.source, "none");
  assert.equal(spawnCount, 1);

  const claudeFallback = await readUsage({ provider: "anthropic-subscription", account: "default" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth-claude-chain" },
    homeDir: "/home", fs: {
      readFile: async (path) => {
        if (path === "/auth-claude-chain") return JSON.stringify({ "anthropic-subscription": { accounts: [{ name: "default", access: "senpi" }] } });
        if (String(path).includes("anthropic-")) return JSON.stringify({ uuid: "known" });
        if (String(path).endsWith(".credentials.json")) return JSON.stringify({ claudeAiOauth: { accessToken: "cli" } });
        throw new Error("ENOENT");
      },
    },
    fetch: async (_url, options) => options.headers.Authorization === "Bearer senpi"
      ? jsonResponse({}, 401)
      : jsonResponse({}, 401),
    spawnSync: () => ({ status: 0, stdout: JSON.stringify(awaitableError) }),
    now: () => Date.now() + 450000,
  });
  assert.equal(claudeFallback.source, "none");

  const codex = await readUsage({ provider: "chatgpt-subscription", account: "default" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth-2" },
    fs: baseFs({ "/auth-2": JSON.stringify({ "chatgpt-subscription": { access: "token", accountId: "id" } }) }),
    fetch: async () => jsonResponse({}, 401),
    spawnSync: () => ({ status: 0, stdout: JSON.stringify(awaitableError) }),
    now: () => Date.now() + 500000,
  });
  assert.equal(codex.source, "none");
});

test("expired credentials skip the endpoint and use the fallback chain", async () => {
  let fetchCalls = 0;
  const result = await readUsage({ provider: "chatgpt-subscription", account: "default" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth-expired" },
    fs: baseFs({ "/auth-expired": JSON.stringify({ "chatgpt-subscription": { access: "expired", accountId: "id", expires: 1 } }) }),
    fetch: async () => { fetchCalls++; throw new Error("expired token must not be sent"); },
    spawnSync: () => ({ status: 1 }),
    now: () => Date.now() + 1000000,
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.source, "none");
  assert.match(result.error, /expired/);
});

const awaitableError = { error: "not usage" };

test("CodexBar successful output is identified as its source", async () => {
  const body = await fixture("codex");
  const result = await readUsage({ provider: "chatgpt-subscription", account: "default" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth-codexbar" },
    fs: baseFs({ "/auth-codexbar": JSON.stringify({ "chatgpt-subscription": { access: "t", accountId: "id" } }) }),
    fetch: async () => jsonResponse({}, 401),
    spawnSync: (command, args, options) => {
      assert.equal(command, "codexbar-cli");
      assert.deepEqual(args, ["usage", "-p", "codex", "--json"]);
      assert.equal(options.timeout, 10000);
      return { status: 0, stdout: JSON.stringify(body) };
    },
    now: () => Date.now() + 600000,
  });
  assert.equal(result.source, "codexbar");
});

test("malformed successful body and string utilization do not fabricate endpoint data", async () => {
  for (const body of [{ error: "temporarily unavailable" }, { five_hour: { utilization: "95", resets_at: 1791354600000 } }]) {
    const result = await readUsage({ provider: "anthropic-subscription", account: `bad-${JSON.stringify(body)}` }, {
      env: { OMO_LIMITLESS_AUTH_PATH: "/auth-bad" },
      fs: baseFs({ "/auth-bad": JSON.stringify({ "anthropic-subscription": { access: "t" } }) }),
      fetch: async () => jsonResponse(body),
      now: () => Date.now() + 700000,
    });
    assert.equal(result.source, "none");
    assert.deepEqual(result.windows, []);
  }
});

test("credential paths are only read and never written", async () => {
  const touched = [];
  const fs = {
    readFile: async (path) => {
      touched.push(["read", path]);
      if (path === "/auth-no-write") return JSON.stringify({ "anthropic-subscription": { access: "t" } });
      throw new Error("ENOENT");
    },
    writeFile: async (...args) => { touched.push(["write", ...args]); },
  };
  await readUsage({ provider: "anthropic-subscription", account: "default" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth-no-write" }, homeDir: "/home", fs,
    fetch: async () => jsonResponse({}, 401),
    spawnSync: () => ({ status: 1 }),
    now: () => Date.now() + 800000,
  });
  assert.ok(touched.every(([op]) => op === "read"));
  assert.ok(touched.some(([, path]) => String(path).endsWith(".credentials.json")));
});

test("fake file returns data without fetching; missing file returns none", async () => {
  const payload = { "anthropic-subscription": { five_hour: { utilization: 95, resetAt: 1791354600000 }, overageEnabled: false } };
  let calls = 0;
  const deps = {
    env: { OMO_LIMITLESS_FAKE_USAGE_FILE: "/fake.json" },
    fs: baseFs({ "/fake.json": JSON.stringify(payload) }),
    fetch: async () => { calls++; throw new Error("network called"); },
    now: () => 1,
  };
  const present = await readUsage({ provider: "anthropic-subscription", account: "any" }, deps);
  assert.equal(present.source, "fake");
  assert.deepEqual(present.windows, [{ kind: "five_hour", utilization: 95, resetAt: 1791354600000 }]);
  deps.fs = baseFs();
  const missing = await readUsage({ provider: "anthropic-subscription", account: "any" }, deps);
  assert.equal(missing.source, "none");
  assert.equal(calls, 0);
});

test("a hung endpoint is aborted at ten seconds and never throws", async () => {
  let timeoutMs;
  let fetchCalled = false;
  const result = await readUsage({ provider: "anthropic-subscription", account: "hung" }, {
    env: { OMO_LIMITLESS_AUTH_PATH: "/auth-hung" },
    fs: baseFs({ "/auth-hung": JSON.stringify({ "anthropic-subscription": { accounts: [{ name: "hung", access: "t" }] } }) }),
    setTimeout: (callback, ms) => { timeoutMs = ms; callback(); return 1; },
    clearTimeout: () => {},
    fetch: async (_url, { signal }) => {
      fetchCalled = true;
      assert.equal(signal.aborted, true);
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
    now: () => Date.now() + 900000,
  });
  assert.equal(timeoutMs, 10000);
  assert.equal(fetchCalled, true);
  assert.equal(result.source, "none");
  assert.match(result.error, /timed out/);
});
