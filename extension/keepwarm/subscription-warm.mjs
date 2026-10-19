// Trace-free warm pings for the subscription lanes, until senpi ships its own (senpi#2454).
//
// claude-sdk-fork: the session's Claude Code session (id from senpi's binding sidecar) is resumed with
//   forkSession + persistSession:false, so the ping reads the cached prefix but writes no transcript. The query
//   options are built by the running senpi's own anthropic-subscription modules (dist/core), so the system prompt,
//   tools, thinking and executable match the real turn and follow senpi updates.
// codex-sse: the last real request body is re-sent over SSE with store:false, no previous_response_id and one
//   extra user item, under the same prompt_cache_key. Nothing is stored server-side and no chain is extended.
//
// Measured 2026-10-16 (research note in docs/senpi-upstream-요구.md): fork pings read 98-100% and renewed the 1h
// cache; Codex pings every 15 min kept a cache that otherwise expired between 25 and 30 min.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PING_TEXT = "Keep-alive ping from omo-keepalive. Reply with just: OK";
const TOKEN_MARGIN_MS = 5 * 60_000;
const SUB = "dist/core/extensions/builtin/anthropic-subscription";

// The senpi code this process runs: an explicit override, else the CLI entry senpi was started with. senpi copies
// itself to <agentDir>/runtime/<build> and runs that copy (claims/<pid> marks the process), so the copy claimed by
// this process wins over the install: its modules hold the state (executable resolution) the real turns use.
export function findSenpiRoot({
  argv = process.argv,
  env = process.env,
  exists = existsSync,
  pid = process.pid,
  listDir = (dir) => readdirSync(dir),
  readText = (file) => readFileSync(file, "utf8"),
} = {}) {
  if (env.OMO_KEEPWARM_SENPI_ROOT && exists(join(env.OMO_KEEPWARM_SENPI_ROOT, SUB, "options.js"))) return env.OMO_KEEPWARM_SENPI_ROOT;
  const installs = [];
  for (const arg of argv.slice(1)) {
    const norm = String(arg).replace(/\\/g, "/");
    const at = norm.indexOf("/@code-yeongyu/senpi/");
    if (at !== -1) installs.push(norm.slice(0, at + "/@code-yeongyu/senpi".length));
  }
  const install = installs.find((root) => exists(join(root, SUB, "options.js"))) ?? null;
  if (install === null) return null;
  const agentDir = env.OMO_CODING_AGENT_DIR || env.SENPI_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(homedir(), ".omo", "agent");
  const runtime = join(agentDir, "runtime");
  const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
  let builds = [];
  try { builds = listDir(runtime); } catch { return install; }
  for (const build of builds) {
    const dir = join(runtime, build);
    if (!exists(join(dir, "claims", String(pid))) || !exists(join(dir, SUB, "options.js"))) continue;
    try {
      const marker = JSON.parse(readText(join(dir, "runtime-snapshot.json")));
      if (typeof marker?.installPackageDir === "string" && same(marker.installPackageDir, install)) return dir;
    } catch {
      // unreadable marker: not a snapshot of this install
    }
  }
  return install;
}

async function loadSenpiModules(root) {
  const load = (name) => import(pathToFileURL(join(root, SUB, name)).href);
  const [config, options, tools, customTools, executable, settings, boundary, bindingStore, authEnv, sync] = await Promise.all([
    import(pathToFileURL(join(root, "dist", "config.js")).href),
    load("options.js"),
    load("tools.js"),
    load("custom-tools.js"),
    load("executable.js"),
    load("settings.js"),
    load("sdk-boundary.js"),
    load("session-binding-store.js"),
    load("auth-environment.js"),
    load("session-sync.js"),
  ]);
  return { config, options, tools, customTools, executable, settings, boundary, bindingStore, authEnv, sync };
}

// The pi-ai Codex request module next to the running senpi (pi-ai's public index has no streamSimple). Looked up
// like Node's node_modules search: Bun's createRequire().resolve() does not return a path for it inside senpi.
export function findCodexApiFile(root, exists = existsSync) {
  return findPiAiFile(root, join("dist", "api", "openai-codex-responses.js"), exists);
}

// A file of the pi-ai package next to the running senpi, looked up like Node's node_modules search.
export function findPiAiFile(root, file, exists = existsSync) {
  const rel = join("@earendil-works", "pi-ai", file);
  for (let dir = root; ; dir = dirname(dir)) {
    const nested = join(dir, "node_modules", rel);
    if (exists(nested)) return nested;
    // A global install keeps senpi and pi-ai side by side: <node_modules>/@code-yeongyu/senpi and <node_modules>/@earendil-works.
    if (dir.replace(/\\/g, "/").endsWith("/node_modules") && exists(join(dir, rel))) return join(dir, rel);
    if (dirname(dir) === dir) return null;
  }
}

// What the old keepwarm stub injected from the host packages: pi-ai's public API and senpi's convertToLlm.
export async function loadHostDeps(root = findSenpiRoot()) {
  if (!root) return { piAi: null, convertToLlm: null };
  const index = findPiAiFile(root, join("dist", "index.js"));
  const [piAi, messages] = await Promise.all([
    index ? import(pathToFileURL(index).href) : null,
    import(pathToFileURL(join(root, "dist", "core", "messages.js")).href),
  ]);
  return { piAi, convertToLlm: messages.convertToLlm };
}

async function loadCodexApi(root) {
  const file = findCodexApiFile(root);
  if (!file) throw unsupported("pi-ai Codex module not found next to senpi");
  return import(pathToFileURL(file).href);
}

function unsupported(message) {
  const e = new Error(message);
  e.kind = "unsupported";
  return e;
}

function authError(message) {
  const e = new Error(message);
  e.kind = "auth";
  return e;
}

// A prefix that changed after the session's SDK session was bound: the fork would read another cache, so it never
// goes out. Classified as prefix_mismatch (warm.mjs matches the error name).
function prefixMismatch(message) {
  const e = new Error(message);
  e.name = "PrefixMismatchError";
  return e;
}

const NO_BINDING = "no Claude SDK session binding";
const MODEL_DIFFERS = "model differs from the bound SDK session";

function claudeAuthLane(settings, credential) {
  const accounts = Array.isArray(credential?.accounts) ? credential.accounts : [];
  return { accounts, lane: settings.tokenInjection ?? (accounts.length > 0 ? "oauth-slots" : "ambient") };
}

// Token of the account the session is bound to. Never refreshed here: a refresh rotates the stored token
// under senpi's feet, so a token close to expiry skips the ping instead.
export function claudeAuthEnv({ settings, accountName, env, now, readAuth, stripManaged }) {
  const { accounts, lane } = claudeAuthLane(settings, readAuth()?.["anthropic-subscription"]);
  if (lane === "ambient") {
    const out = { ...env };
    for (const name of Object.keys(out)) if (name.startsWith("SENPI_")) delete out[name];
    return { lane, env: out };
  }
  if (lane !== "oauth-slots") throw unsupported(`auth lane ${lane} is not supported`);
  const account = accounts.find((a) => a?.name === accountName);
  if (!account?.access) throw authError(`no stored token for account ${accountName}`);
  if (!(Number(account.expires) > now() + TOKEN_MARGIN_MS)) throw authError("account token expires within 5 minutes");
  return { lane, env: { ...stripManaged(env), CLAUDE_CODE_OAUTH_TOKEN: account.access } };
}

function claudeUsage(u) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { input: n(u?.input_tokens), output: n(u?.output_tokens), cacheRead: n(u?.cache_read_input_tokens), cacheWrite: n(u?.cache_creation_input_tokens) };
}

// The query options of a ping, built by the running senpi's own modules (system prompt, tools, thinking, executable).
async function buildQueryOptions(m, { model, context, streamOptions, providerSettings, authLane }) {
  const resolved = m.tools.resolveSdkTools(context);
  const mcpServers = await m.customTools.buildCustomToolServers(resolved.customTools);
  const executable = m.executable.resolveClaudeCodeRun(m.executable.defaultExecutableDeps()).executable;
  const queryOptions = m.options.buildAnthropicSubscriptionQueryOptions({
    model,
    context,
    streamOptions,
    providerSettings,
    authLane,
    tools: resolved.sdkTools,
    pathToClaudeCodeExecutable: executable,
  });
  if (mcpServers) queryOptions.mcpServers = mcpServers;
  return queryOptions;
}

// senpi's own fingerprint (session-sync configFingerprint) of the options a ping would send, against the hashes the
// binding stored on the real turn. Taken before the ping's extra spawn args, as senpi takes it. Returns what differs.
function fingerprintMismatch(m, binding, queryOptions, context, authLane) {
  const fp = m.sync.configFingerprint(queryOptions, context, authLane, binding.accountName);
  if (fp.systemPromptHash !== binding.systemPromptHash) return "system prompt differs from the bound SDK session";
  if (fp.toolsetHash !== binding.toolsetHash) return "toolset differs from the bound SDK session";
  return null;
}

export function createClaudeForkPinger({
  senpiRoot = findSenpiRoot(),
  load = loadSenpiModules,
  env = process.env,
  cwd = () => process.cwd(),
  now = Date.now,
  readAuth,
} = {}) {
  let modules = null;
  const authReader = (m) => readAuth ?? (() => JSON.parse(readFileSync(join(m.config.getAgentDir(), "auth.json"), "utf8")));

  // Whether a ping could work, decided without sending anything: null when nothing is known against it, else
  // { reason: "no_sdk_binding" | "prefix_unsafe" | "prefix_mismatch", detail }. Only these three certain
  // conditions answer; anything undecidable (auth file unreadable) is left to the ping, which reports it typed.
  async function probe({ ctx, signal }) {
    if (!senpiRoot) return null;
    modules ??= await load(senpiRoot);
    const m = modules;
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) return { reason: "no_sdk_binding", detail: "session has no file" };
    const binding = await m.bindingStore.readStoredBinding(sessionFile);
    if (!binding) return { reason: "no_sdk_binding", detail: NO_BINDING };
    const prefix = await ctx.getPromptCachePrefixRequest?.({ signal });
    if (prefix?.status !== "ready") return { reason: "prefix_unsafe", detail: `prompt prefix ${prefix?.reason ?? "unavailable"}` };
    const { model, context, options: streamOptions } = prefix.request;
    if (model.id !== binding.modelId) return { reason: "prefix_mismatch", detail: MODEL_DIFFERS };
    let credential;
    try {
      credential = authReader(m)()?.["anthropic-subscription"];
    } catch {
      return null;
    }
    const providerSettings = m.settings.loadAnthropicSubscriptionProviderSettingsFromDisk(cwd());
    const { lane } = claudeAuthLane(providerSettings, credential);
    const queryOptions = await buildQueryOptions(m, { model, context, streamOptions, providerSettings, authLane: lane });
    const detail = fingerprintMismatch(m, binding, queryOptions, context, lane);
    return detail ? { reason: "prefix_mismatch", detail } : null;
  }

  async function ping({ ctx, signal }) {
    if (!senpiRoot) throw unsupported("senpi install not found");
    modules ??= await load(senpiRoot);
    const m = modules;
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) throw unsupported("session has no file");
    const binding = await m.bindingStore.readStoredBinding(sessionFile);
    if (!binding) throw unsupported(NO_BINDING);
    const prefix = await ctx.getPromptCachePrefixRequest?.({ signal });
    if (prefix?.status !== "ready") throw unsupported(`prompt prefix ${prefix?.reason ?? "unavailable"}`);
    const { model, context, options: streamOptions } = prefix.request;
    if (model.id !== binding.modelId) throw unsupported(MODEL_DIFFERS);

    await m.boundary.loadClaudeAgentSdk();
    const providerSettings = m.settings.loadAnthropicSubscriptionProviderSettingsFromDisk(cwd());
    const auth = claudeAuthEnv({
      settings: providerSettings,
      accountName: binding.accountName,
      env,
      now,
      readAuth: authReader(m),
      stripManaged: m.authEnv.stripManagedAuthEnvironment,
    });
    const queryOptions = await buildQueryOptions(m, { model, context, streamOptions, providerSettings, authLane: auth.lane });
    // The prefix may have changed since the segment opened: a fork of a differently-fingerprinted session never goes out.
    const mismatch = fingerprintMismatch(m, binding, queryOptions, context, auth.lane);
    if (mismatch) throw prefixMismatch(mismatch);
    // Same shape as senpi's resident session (session-registry getOrCreate), plus the fork that keeps it trace-free.
    const options = {
      ...queryOptions,
      env: { ...auth.env, ...queryOptions.env },
      extraArgs: { ...queryOptions.extraArgs, "replay-user-messages": "" },
      resume: binding.sdkSessionId,
      forkSession: true,
      persistSession: false,
      maxTurns: 1,
    };
    const query = m.boundary.getSdkBoundary().query({ prompt: PING_TEXT, options });
    const onAbort = () => query.close?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    let result = null;
    try {
      for await (const message of query) if (message?.type === "result") result = message;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      query.close?.();
    }
    if (!result) throw new Error("SDK query ended without a result");
    if (result.is_error) throw new Error(`SDK result error: ${String(result.result ?? result.subtype ?? "unknown").slice(0, 200)}`);
    return claudeUsage(result.usage);
  }

  return { available: () => senpiRoot !== null, ping, probe };
}

// The probe the episode controller uses when it is given none: the Claude lane against this process's senpi.
// Returns null (not applicable) without a Claude warm path or a senpi install, else a promise of probe()'s answer.
let sharedClaude = null;
export function probeWarmPath({ ctx, warmPath, signal }) {
  if (warmPath !== "claude-sdk-fork") return null;
  sharedClaude ??= createClaudeForkPinger();
  return sharedClaude.available() ? sharedClaude.probe({ ctx, signal }) : null;
}

// ---- Codex ----------------------------------------------------------------

// The last real request body with one user item added; nothing stored, no response chain.
export function codexPingBody(payload) {
  const { previous_response_id: _drop, ...rest } = payload;
  const input = Array.isArray(rest.input) ? rest.input : [];
  return {
    ...rest,
    store: false,
    input: [...input, { role: "user", content: [{ type: "input_text", text: PING_TEXT }] }],
  };
}

export function createCodexPinger({ senpiRoot = findSenpiRoot(), load = loadCodexApi } = {}) {
  let api = null;

  function available() {
    return senpiRoot !== null;
  }

  async function ping({ ctx, model, payload, signal, timeoutMs }) {
    if (!senpiRoot) throw unsupported("senpi install not found");
    api ??= await load(senpiRoot);
    if (!payload || typeof payload !== "object" || typeof payload.prompt_cache_key !== "string") {
      throw unsupported("no captured Codex request");
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok) throw authError(String(auth?.error ?? "auth unavailable"));
    const body = codexPingBody(payload);
    const stream = api.streamSimple(model, { systemPrompt: "", messages: [] }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      sessionId: payload.prompt_cache_key,
      transport: "sse",
      onPayload: () => body,
      signal,
      timeoutMs,
    });
    let final = null;
    for await (const ev of stream) {
      if (ev?.type === "done") final = ev.message;
      if (ev?.type === "error") final = ev.error;
    }
    if (!final) throw new Error("Codex stream ended without a message");
    if (final.stopReason === "error" || final.stopReason === "aborted") {
      const e = new Error(String(final.errorMessage ?? final.stopReason));
      if (final.stopReason === "aborted") e.name = "AbortError";
      throw e;
    }
    return final.usage ?? {};
  }

  return { available, ping };
}
