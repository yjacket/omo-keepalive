// Fake usage snapshots are keyed by provider, e.g.
// {"anthropic-subscription":{"five_hour":{"utilization":95,"resetAt":1234567890000},"seven_day":{"utilization":10,"resetAt":1234567890000},"overageEnabled":false},"chatgpt-subscription":{...}}.
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_URL = {
  "anthropic-subscription": "https://api.anthropic.com/api/oauth/usage",
  "chatgpt-subscription": "https://chatgpt.com/backend-api/wham/usage",
};
const cache = new Map();
const profileUuids = new Map();

function parsedJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function accountEntry(auth, provider, account) {
  const providerAuth = auth?.[provider];
  if (Array.isArray(providerAuth?.accounts)) {
    return providerAuth.accounts.find((entry) => entry?.name === account) ?? null;
  }
  return account === "default" ? providerAuth ?? null : null;
}

function safeIdentity(auth, provider, account) {
  const entry = accountEntry(auth, provider, account);
  return entry?.uuid || entry?.accountUuid || entry?.account_uuid || entry?.email || null;
}

export function listAccounts(authJson, provider) {
  const entry = typeof authJson === "string" ? parsedJson(authJson) : authJson;
  const providerAuth = entry?.[provider];
  if (Array.isArray(providerAuth?.accounts)) {
    return providerAuth.accounts.flatMap((account) => typeof account?.name === "string" ? [account.name] : []);
  }
  return providerAuth ? ["default"] : [];
}

function snapshot(provider, account, windows, overageEnabled, source, error) {
  return {
    provider,
    account,
    windows: windows.filter(Boolean),
    overageEnabled: Boolean(overageEnabled),
    source,
    ...(error ? { error: String(error) } : {}),
  };
}

function numericWindow(kind, utilization, resetAt) {
  const value = Number(utilization);
  let reset = typeof resetAt === "number" ? resetAt : Date.parse(resetAt);
  if (typeof resetAt === "number" && resetAt > 0 && resetAt < 1e12) reset *= 1000;
  if (typeof utilization !== "number" || !Number.isFinite(value) || value < 0 || value > 100 || !Number.isFinite(reset)) return null;
  return { kind, utilization: value, resetAt: reset };
}

function mapUsage(provider, account, body, source = "endpoint") {
  if (!body || typeof body !== "object" || body.error) return null;
  if (provider === "anthropic-subscription") {
    const windows = [
      numericWindow("five_hour", body.five_hour?.utilization, body.five_hour?.resets_at),
      numericWindow("seven_day", body.seven_day?.utilization, body.seven_day?.resets_at),
    ].filter(Boolean);
    if (!windows.length) return null;
    return snapshot(provider, account, windows, body.extra_usage?.is_enabled === true, source);
  }
  const rate = body.rate_limit;
  if (!rate || typeof rate !== "object") return null;
  const mapWindow = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const kind = entry.limit_window_seconds === 18000 ? "five_hour"
      : entry.limit_window_seconds === 604800 ? "seven_day" : null;
    return kind ? numericWindow(kind, entry.used_percent, entry.reset_at) : null;
  };
  const windows = [mapWindow(rate.primary_window), mapWindow(rate.secondary_window)].filter(Boolean);
  return windows.length ? snapshot(provider, account, windows, false, source) : null;
}

function authPath(deps) {
  return (deps.env || process.env).OMO_LIMITLESS_AUTH_PATH || join(deps.homeDir || homedir(), ".omo", "agent", "auth.json");
}

async function readJson(fs, path) {
  try {
    const data = await fs.readFile(path, "utf8");
    return parsedJson(typeof data === "string" ? data : data.toString("utf8"));
  } catch { return null; }
}

async function request(fetchFn, url, token, provider, accountId, signal, deps = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (provider === "anthropic-subscription") {
    headers["anthropic-beta"] = "oauth-2025-04-20";
    headers["User-Agent"] = `claude-cli/${(deps.env || process.env).CLAUDE_CODE_VERSION || "1.0.0"} (external, cli)`;
  } else if (accountId) {
    headers["chatgpt-account-id"] = accountId;
  }
  try {
    const response = await fetchFn(url, { method: "GET", headers, signal });
    const body = parsedJson(await response.text());
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: null, error: error?.name === "AbortError" ? "request timed out" : "request failed" };
  }
}

function abortAfter(ms, deps = {}) {
  const controller = new AbortController();
  const schedule = deps.setTimeout || setTimeout;
  const cancel = deps.clearTimeout || clearTimeout;
  const timer = schedule(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => cancel(timer) };
}

async function timedRequest(fetchFn, url, token, provider, accountId, deps) {
  const timeout = abortAfter(10000, deps);
  try {
    return await request(fetchFn, url, token, provider, accountId, timeout.signal, deps);
  } finally {
    timeout.clear();
  }
}

async function fetchMapped(fetchFn, provider, account, token, accountId, source = "endpoint", deps = {}) {
  const timeout = abortAfter(10000, deps);
  try {
    const result = await request(fetchFn, AUTH_URL[provider], token, provider, accountId, timeout.signal, deps);
    if (result.status === 401) return { unauthorized: true, error: "usage endpoint returned 401" };
    const mapped = result.status === 200 ? mapUsage(provider, account, result.body, source) : null;
    return mapped ? { usage: mapped } : { error: result.error || (result.status === 200 ? "invalid usage response" : `usage endpoint status ${result.status}`) };
  } finally {
    timeout.clear();
  }
}

function identityPath(deps, account) {
  const digest = createHash("sha1").update(account).digest("hex");
  return `${deps.homeDir || homedir()}/.omo/limitless/accounts/anthropic-${digest}.json`;
}

async function persistIdentity(deps, account, uuid) {
  const fs = deps.fs || { mkdir, writeFile, rename };
  if (deps.fs && (!fs.mkdir || !fs.writeFile || !fs.rename)) return;
  const path = identityPath(deps, account);
  const temp = `${path}.${process.pid}.${(deps.randomUUID || (() => `${Date.now()}-${Math.random()}`))()}.tmp`;
  try {
    await fs.mkdir(`${deps.homeDir || homedir()}/.omo/limitless/accounts`, { recursive: true });
    await fs.writeFile(temp, JSON.stringify({ uuid }), { mode: 0o600 });
    await fs.rename(temp, path);
  } catch {
    try { await fs.unlink?.(temp); } catch {}
  }
}

async function knownIdentity({ deps, fs, fetchFn, provider, account, token }) {
  if (provider !== "anthropic-subscription") return null;
  const configured = await readJson(fs, authPath(deps));
  const direct = safeIdentity(configured, provider, account);
  if (typeof direct === "string" && direct) return direct;
  const persisted = await readJson(fs, identityPath(deps, account));
  if (typeof persisted?.uuid === "string" && persisted.uuid) return persisted.uuid;
  // Profile identity is captured only after a successful usage request.
  const profile = await timedRequest(fetchFn, "https://api.anthropic.com/api/oauth/profile", token, provider, account, deps);
  if (profile.status !== 200) return null;
  const uuid = profile.body?.account?.uuid || profile.body?.account_uuid || profile.body?.uuid;
  if (typeof uuid !== "string" || !uuid) return null;
  await persistIdentity(deps, account, uuid);
  return uuid;
}

async function claudeCodeFallback({ deps, fs, fetchFn, provider, account, identity, accountId }) {
  if (provider !== "anthropic-subscription") return null;
  const cliAuthPath = join(deps.homeDir || homedir(), ".claude", ".credentials.json");
  const credentials = await readJson(fs, cliAuthPath);
  const cliToken = credentials?.claudeAiOauth?.accessToken;
  if (typeof cliToken !== "string" || !cliToken) return null;
  const uuid = identity || profileUuids.get(`${provider}\0${account}`);
  if (!uuid) return null;
  const cliProfile = await timedRequest(fetchFn, "https://api.anthropic.com/api/oauth/profile", cliToken, provider, accountId, deps);
  const cliUuid = cliProfile.body?.account?.uuid || cliProfile.body?.account_uuid || cliProfile.body?.uuid;
  if (cliProfile.status !== 200 || cliUuid !== uuid) return null;
  const result = await fetchMapped(fetchFn, provider, account, cliToken, accountId, "claude-code", deps);
  return result.usage ? { usage: result.usage } : null;
}

function codexbarFallback(deps, provider, account) {
  const cli = deps.spawnSync || defaultSpawnSync;
  try {
    const result = cli("codexbar-cli", ["usage", "-p", provider === "anthropic-subscription" ? "claude" : "codex", "--json"], {
      encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    const body = parsedJson(result.stdout);
    if (!body) return null;
    return mapUsage(provider, account, body, "codexbar")
      || mapUsage(provider, account, body.usage, "codexbar")
      || mapUsage(provider, account, body.providers?.[provider === "anthropic-subscription" ? "claude" : "codex"], "codexbar");
  } catch { return null; }
}

async function readUsageImpl({ provider, account }, deps = {}) {
  const none = (error = "usage unavailable") => snapshot(provider, account, [], false, "none", error);
  if (!AUTH_URL[provider] || typeof account !== "string") return none("unsupported provider or invalid account");
  const now = deps.now || Date.now;
  const pollMinIntervalMs = deps.pollMinIntervalMs ?? 60000;
  const cacheKey = `${provider}\0${account}`;
  const cached = cache.get(cacheKey);
  const env = deps.env || process.env;
  if (!env.OMO_LIMITLESS_FAKE_USAGE_FILE && cached && now() >= cached.at && now() - cached.at < pollMinIntervalMs) return cached.value;
  let value;
  const fakePath = env.OMO_LIMITLESS_FAKE_USAGE_FILE;
  if (fakePath) {
    const body = await readJson(deps.fs || { readFile }, fakePath);
    const mapped = body?.[provider];
    if (mapped) {
      const windows = ["five_hour", "seven_day"].map((kind) => {
        const entry = mapped[kind];
        return entry ? numericWindow(kind, entry.utilization, entry.resetAt) : null;
      }).filter(Boolean);
      value = windows.length || typeof mapped.overageEnabled === "boolean"
        ? snapshot(provider, account, windows, mapped.overageEnabled, "fake")
        : none("invalid fake usage snapshot");
    } else value = none("fake usage file unavailable");
  } else {
    const fs = deps.fs || { readFile };
    const auth = await readJson(fs, authPath(deps));
    const entry = accountEntry(auth, provider, account);
    const token = entry?.access;
    const accountId = entry?.accountId;
    if (typeof token !== "string" || !token || (provider === "chatgpt-subscription" && typeof accountId !== "string")) {
      value = none("account credentials unavailable");
    } else {
      const fetchFn = deps.fetch || globalThis.fetch;
      const expired = Number.isFinite(entry.expires) && entry.expires <= now();
      const endpoint = expired
        ? { unauthorized: true, error: "account token expired" }
        : await fetchMapped(fetchFn, provider, account, token, accountId, "endpoint", deps);
      value = endpoint.usage;
      if (value && provider === "anthropic-subscription") {
        const identity = await knownIdentity({ deps, fs, fetchFn, provider, account, token });
        if (identity) profileUuids.set(`${provider}\0${account}`, identity);
      }
      let error = endpoint.error;
      if (!value && endpoint.unauthorized) {
        const identity = safeIdentity(auth, provider, account) || profileUuids.get(`${provider}\0${account}`)
          || (await readJson(deps.fs || { readFile }, identityPath(deps, account)))?.uuid;
        const claudeFallback = await claudeCodeFallback({ deps, fs, fetchFn, provider, account, identity, accountId });
        value = claudeFallback?.usage || null;
        if (!value) value = codexbarFallback(deps, provider, account);
        error = error || "all usage sources failed";
      }
      if (!value) value = none(error || "invalid usage response");
    }
  }
  cache.set(cacheKey, { at: now(), value });
  return value;
}

export async function readUsage(request, deps = {}) {
  try {
    return await readUsageImpl(request, deps);
  } catch {
    return snapshot(request?.provider, request?.account, [], false, "none", "usage reader failed");
  }
}

export function clearUsageCache() {
  cache.clear();
  profileUuids.clear();
}
