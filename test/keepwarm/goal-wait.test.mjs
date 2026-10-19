import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createController, wireController } from "../../extension/keepwarm/episode.mjs";
import { createConfigSource } from "../../extension/keepwarm/config.mjs";
import { createRecorder } from "../../extension/keepwarm/records.mjs";
import { createStatus } from "../../extension/keepwarm/status.mjs";
import { createLedger } from "../../extension/keepwarm/ledger.mjs";
import { createWarmer } from "../../extension/keepwarm/warm.mjs";
import { atomicWriteJson, readJsonLines } from "../../extension/keepwarm/fsx.mjs";
import { layout } from "../../extension/keepwarm/paths.mjs";
import { createFakeClock, createFakeCtx, createFakePi, createFakePiAi, models, tmpHome } from "./helpers/fake-host.mjs";

const SEC = 1000;
const MIN = 60 * SEC;
const START = new Date(2026, 5, 15, 9, 0, 0).getTime();
const BASE_CONFIG = { v: 1, mode: "on", maxUsdPerEpisode: 100, maxUsdPerDay: 1000 };
const USAGE_50K = { input: 1000, output: 200, cacheRead: 49_000, cacheWrite: 0 };
const USAGE_300 = { input: 200, output: 5, cacheRead: 100, cacheWrite: 0 };
const CODEX_USAGE = { input: 200, output: 5, cacheRead: 11_776, cacheWrite: 0 };
const CODEX_BODY = { model: "gpt-5-codex", prompt_cache_key: "sess-1", store: false, input: [] };
const identity = (messages) => messages;

// ---- harness (codex lane: 15 min interval, habit expiry 1 h, verified, fake pinger) ----

const live = [];

afterEach(() => {
  const harnesses = live.splice(0);
  for (const h of harnesses) {
    assert.deepEqual(h.pi.forbiddenCalls, [], "forbidden pi API calls");
    assert.deepEqual(h.ctx.uiCalls, [], "ctx.ui calls");
    for (const r of h.pi.returns) assert.equal(r.value, undefined, `${r.name} handler returned a value`);
  }
  for (const home of new Set(harnesses.map((h) => h.home))) rmSync(home, { recursive: true, force: true });
});

function fakePinger(usage) {
  const calls = [];
  return { calls, available: () => true, ping: async (args) => (calls.push(args), usage) };
}

function setup(o = {}) {
  const home = tmpHome();
  const clock = createFakeClock(START);
  const L = layout(home);
  atomicWriteJson(L.config, { ...BASE_CONFIG, ...(o.config ?? {}) });
  const pi = createFakePi();
  const ctx = createFakeCtx({ model: o.model ?? models.openaiCodex, ...(o.ctxOpts ?? {}) });
  const piAi = createFakePiAi();
  const now = clock.now;
  const config = createConfigSource({ home, now, statEveryMs: 0 });
  const codex = o.codex ?? fakePinger(CODEX_USAGE);
  const warmer = createWarmer({ piAi, convertToLlm: identity, now, codex });
  const controller = createController({
    pi,
    deps: {
      now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      config,
      recorder: (id) => createRecorder({ home, sessionId: id, now }),
      status: (id) => createStatus({ home, sessionId: id, now }),
      ledger: createLedger({ home, now }),
      warmer,
      piAi,
      home,
      version: "0.1.0+test",
      ...(o.deps ?? {}),
    },
  });
  wireController(pi, controller);
  let n = 0;
  const h = {
    home, clock, L, pi, ctx, controller, codex,
    snap: () => controller.snapshot(),
    emit: (name, ev = {}) => pi.emit(name, { type: name, ...ev }, ctx),
    bus: (name, data) => pi.events.emit(name, data),
    async to(min) {
      await clock.advance(START + min * MIN - clock.now());
    },
    async drain() {
      for (let i = 0; i < 10; i++) await clock.flush();
    },
    push(message) {
      ctx.setMessages([...ctx.state.messages, message]);
      return message;
    },
    start: () => h.emit("session_start", { reason: "startup" }),
    settle: () => h.emit("agent_settled"),
    async humanTurn({ settle = true, usage = USAGE_50K, payload = CODEX_BODY } = {}) {
      n += 1;
      const inputId = `sess-1:${n}`;
      await h.emit("input", { inputId, text: "hello", source: "interactive" });
      await h.emit("before_agent_start", { prompt: "hello", trigger: "prompt", systemPrompt: ctx.getSystemPrompt() });
      await h.emit("input_disposition", { inputId, disposition: "started" });
      await h.emit("agent_start");
      const first = h.push({ role: "user", content: `u${n}`, timestamp: clock.now() });
      await h.emit("message_start", { message: first });
      await h.emit("message_end", { message: first });
      await h.emit("before_provider_request", { payload });
      const reply = h.push({ role: "assistant", content: `a${n}`, stopReason: "stop", usage, model: ctx.model.id, timestamp: clock.now() });
      await h.emit("message_start", { message: reply });
      await h.emit("message_end", { message: reply });
      await h.emit("agent_end", { messages: [first, reply] });
      if (settle) await h.settle();
    },
    async openEpisode(turn = {}) {
      await h.start();
      await h.humanTurn(turn);
    },
    records(type) {
      const dir = L.recordsDir;
      if (!existsSync(dir)) return [];
      const out = [];
      for (const month of readdirSync(dir).sort()) {
        for (const f of readdirSync(join(dir, month)).sort()) out.push(...readJsonLines(join(dir, month, f)));
      }
      return out.filter((r) => !type || r.type === type);
    },
    ticks: () => h.records("decision").map((d) => [d.action, d.tAwayMin]),
    stops: () => h.records("warm_stop").map((r) => r.reason),
    markers: () => h.records("marker").map((m) => m.kind),
    async runTo(from, to, step = 15) {
      for (let m = from; m <= to; m += step) {
        await h.to(m);
        await h.drain();
      }
    },
  };
  live.push(h);
  return h;
}

const warmAt = (...mins) => mins.map((m) => ["warm", m]);

// ---- warming ---------------------------------------------------------------

test("goalWait is null until set, setGoalWait is exposed and a second identical call changes nothing", async () => {
  const h = setup();
  assert.equal(typeof h.controller.setGoalWait, "function");
  assert.equal(h.snap().goalWait, null);
  await h.start();
  h.controller.setGoalWait(true);
  await h.clock.advance(MIN);
  const before = h.snap().goalWait;
  h.controller.setGoalWait(true);
  assert.deepEqual(h.snap().goalWait, before);
  h.controller.setGoalWait(false);
  assert.equal(h.snap().goalWait, null);
});

test("goal wait before the episode opens reports warm false, reason pending", async () => {
  const h = setup();
  await h.start();
  h.controller.setGoalWait(true);
  assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason: "pending" });
});

test("goal wait warms past the habit expiry: pings continue after 60 min, E and maxPings follow maxHoldMinutes", async () => {
  const h = setup();
  await h.start();
  h.controller.setGoalWait(true);
  await h.humanTurn();
  const [open] = h.records("episode_open");
  assert.equal(open.expiry.effectiveMin, 60, "the habit alone would stop at 1 h");
  assert.equal(open.maxPings, 25, "ceil(360 / 15) + 1");
  assert.equal(h.snap().E, 360);
  await h.runTo(15, 90);
  assert.deepEqual(h.ticks(), warmAt(15, 30, 45, 60, 75, 90));
  assert.equal(h.codex.calls.length, 6);
  assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: true, reason: null });
  assert.deepEqual(h.stops(), []);
  assert.ok(h.markers().includes("goal_wait_start"));
});

test("goal wait with senpi-task active keeps pinging instead of pausing for child work", async () => {
  const h = setup();
  await h.start();
  h.controller.setGoalWait(true);
  await h.humanTurn({ settle: false });
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 1 });
  await h.settle();
  assert.equal(h.snap().phase, "ARMED", "the episode opens armed although child work is active");
  assert.equal(h.snap().childWork, 1);
  await h.runTo(15, 45);
  assert.deepEqual(h.ticks(), warmAt(15, 30, 45));
  assert.equal(h.snap().pauseReason, null);
  assert.equal(h.codex.calls.length, 3);
});

test("goal wait set during child work resumes a PAUSED child_work episode", async () => {
  const h = setup();
  await h.start();
  await h.humanTurn({ settle: false });
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 1 });
  await h.settle();
  assert.deepEqual([h.snap().phase, h.snap().pauseReason], ["PAUSED", "child_work"]);
  h.controller.setGoalWait(true);
  assert.equal(h.snap().phase, "ARMED");
  assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: true, reason: null });
  assert.deepEqual(h.records("segment_open").map((s) => s.reason), ["episode_open", "goal_wait"]);
});

test("setGoalWait(false) during child work pauses again at the next tick", async () => {
  const h = setup();
  await h.start();
  h.controller.setGoalWait(true);
  await h.humanTurn();
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 1 });
  await h.runTo(15, 15);
  assert.deepEqual(h.ticks(), warmAt(15));
  h.controller.setGoalWait(false);
  assert.equal(h.snap().goalWait, null);
  await h.runTo(30, 30);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason]).at(-1), ["skip", "child_work_active"]);
  assert.deepEqual([h.snap().phase, h.snap().pauseReason], ["PAUSED", "child_work"]);
  assert.deepEqual(h.stops(), []);
  assert.equal(h.codex.calls.length, 1);
  assert.deepEqual(h.markers(), ["goal_wait_start", "goal_wait_end"]);
});

test("setGoalWait(false) brings the habit expiry back: the next tick past 60 min expires", async () => {
  const h = setup();
  await h.start();
  h.controller.setGoalWait(true);
  await h.humanTurn();
  await h.runTo(15, 75);
  h.controller.setGoalWait(false);
  assert.equal(h.snap().E, 60);
  await h.runTo(90, 90);
  assert.deepEqual(h.ticks().at(-1), ["expire", 90]);
  assert.equal(h.codex.calls.length, 5);
  assert.deepEqual(h.stops(), ["expired"]);
});

test("maxHoldMinutes 30: warming stops with max_hold after 30 min", async () => {
  const h = setup({ config: { maxHoldMinutes: 30 } });
  await h.start();
  h.controller.setGoalWait(true);
  await h.humanTurn();
  await h.runTo(15, 45);
  assert.deepEqual(h.records("decision").map((d) => [d.action, d.reason, d.tAwayMin]), [
    ["warm", null, 15],
    ["skip", "max_hold", 30],
  ]);
  assert.deepEqual(h.stops(), ["max_hold"]);
  assert.equal(h.codex.calls.length, 1);
  assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason: "max_hold" });
});

test("a warm stop for another reason while goal wait is set reports warm_stopped", async () => {
  const h = setup();
  await h.start();
  h.controller.setGoalWait(true);
  await h.humanTurn();
  await h.runTo(15, 15);
  h.bus("cache_warm_ping", {});
  assert.deepEqual(h.stops(), ["duplicate_warmer"]);
  assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason: "warm_stopped" });
});

// ---- verdicts that keep warming off ----------------------------------------

test("small context: not worth it, warm false, zero pings", async () => {
  const h = setup();
  await h.start();
  h.controller.setGoalWait(true);
  await h.humanTurn({ usage: USAGE_300 });
  assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason: "not_worth_it" });
  await h.runTo(15, 60);
  assert.equal(h.codex.calls.length, 0);
  assert.deepEqual(h.records("ping"), []);
});

test("unverified lane: warm false unverified, zero ping records", async () => {
  const h = setup({ config: { lanes: { "codex-subscription": { verified: false } } } });
  await h.start();
  h.controller.setGoalWait(true);
  assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason: "unverified" });
  await h.humanTurn();
  await h.runTo(15, 60);
  assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason: "unverified" });
  assert.equal(h.codex.calls.length, 0);
  assert.deepEqual(h.records("ping"), []);
});

for (const [name, setupOpts, reason] of [
  ["mode_off", { config: { mode: "shadow" } }, "mode_off"],
  ["lane_off", { model: models.githubCopilot }, "lane_off"],
  ["no_warm_path", { codex: { calls: [], available: () => false, ping: async () => CODEX_USAGE } }, "no_warm_path"],
  ["context_unknown", {}, "context_unknown"],
]) {
  test(`verdict ${name}: warm false, reason ${reason}, zero pings`, async () => {
    const h = setup(setupOpts);
    if (reason === "context_unknown") h.ctx.setContextTokens(null);
    await h.start();
    h.controller.setGoalWait(true);
    assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason });
    assert.equal(h.snap().E, null);
    await h.humanTurn({ usage: reason === "context_unknown" ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : USAGE_50K });
    await h.runTo(15, 60);
    assert.equal(h.snap().goalWait.warm, false);
    assert.equal(h.codex.calls.length, 0);
    assert.deepEqual(h.records("ping"), []);
  });
}

// ---- rejected segments -------------------------------------------------------

for (const [name, setupOpts, prepare, reason] of [
  [
    "small_context",
    { config: { lanes: { "codex-subscription": { minContextTokens: 100_000 } } } },
    async (h) => {
      await h.humanTurn();
    },
    "small_context",
  ],
  [
    "cache_cold_at_open",
    {},
    async (h) => {
      await h.humanTurn({ settle: false });
      await h.clock.advance(30 * MIN);
      await h.settle();
    },
    "cache_cold_at_open",
  ],
  [
    "duplicate_warmer",
    {},
    async (h) => {
      h.bus("cache_warm_ping", {});
      await h.humanTurn();
    },
    "duplicate_warmer",
  ],
  [
    "prefix_unsafe",
    { deps: { warmProbe: async () => ({ reason: "prefix_unsafe", detail: null }) } },
    async (h) => {
      await h.humanTurn();
      await h.drain();
    },
    "prefix_unsafe",
  ],
]) {
  test(`a segment rejected for ${name} shows warm false with that reason and sends no ping`, async () => {
    const h = setup(setupOpts);
    await h.start();
    h.controller.setGoalWait(true);
    assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason: "pending" });
    await prepare(h);
    assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason });
    assert.equal(h.snap().phase, "OBSERVING");
    const startMin = (h.clock.now() - START) / MIN;
    await h.runTo(Math.ceil(startMin) + 15, Math.ceil(startMin) + 75);
    assert.deepEqual(h.snap().goalWait, { sinceMs: START, warm: false, reason });
    assert.equal(h.codex.calls.length, 0);
    assert.deepEqual(h.records("ping"), []);
  });
}
