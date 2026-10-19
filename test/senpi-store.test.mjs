import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHarness } from "./harness.mjs";
import { startKeepalive } from "../extension/keepalive.mjs";
import { createSenpiGoalStore, senpiDistCandidates } from "../extension/core.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const RESET = T0 + 2 * 3600000;
const CLAUDE = { provider: "anthropic-subscription", api: "claude-sdk-oauth", id: "claude-fake" };
const GOAL_REL = ["core", "extensions", "builtin", "goal"];

const tmp = () => mkdtempSync(join(tmpdir(), "keepalive-store-"));
const norm = (p) => p.replaceAll("\\", "/");

// A stand-in for <senpi>/dist/core/extensions/builtin/goal with the two modules keepalive imports.
function writeStubDist(dist) {
  const goal = join(dist, ...GOAL_REL);
  mkdirSync(goal, { recursive: true });
  writeFileSync(join(goal, "store-ref.js"), "export const goalStoreRef = (sm, cwd) => ({ sid: sm.getSessionId(), cwd });\n");
  writeFileSync(join(goal, "store.js"), [
    "const goals = new Map();",
    "export const seed = (ref, goal) => goals.set(ref.sid, goal);",
    "export const readGoal = async (ref) => goals.get(ref.sid) ?? null;",
    "export const updateGoal = async (ref, update) => { const g = { ...goals.get(ref.sid), ...update }; goals.set(ref.sid, g); return g; };",
    "",
  ].join("\n"));
  return goal;
}

const fakeCtx = (sid) => ({ cwd: "/x", sessionManager: { getSessionId: () => sid, getCwd: () => "/x" } });

test("senpiDistCandidates covers the bundled layout (argv[1] = dist/bundle/cli.js) and the omo launcher layouts", () => {
  const argv1 = "/g/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js";
  const bundled = senpiDistCandidates({ env: {}, argv1 }).map(norm);
  assert.ok(bundled.includes("/g/node_modules/@code-yeongyu/senpi/dist"));
  const viaBin = senpiDistCandidates({ env: { OMO_BIN: "/g/node_modules/omo-ai/bin/omo.js" }, argv1: "/usr/bin/node" }).map(norm);
  assert.ok(viaBin.includes("/g/node_modules/@code-yeongyu/senpi/dist"), "hoisted senpi next to omo-ai");
  assert.ok(viaBin.includes("/g/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist"), "senpi nested under omo-ai");
});

test("goal store is found from a bundled argv[1], reads, and sets status through senpi's store modules", async () => {
  const root = tmp();
  try {
    const dist = join(root, "node_modules", "@code-yeongyu", "senpi", "dist");
    const goalDir = writeStubDist(dist);
    mkdirSync(join(dist, "bundle"), { recursive: true });
    const store = createSenpiGoalStore({ env: {}, argv1: join(dist, "bundle", "cli.js") });
    const seed = (await import(pathToFileURL(join(goalDir, "store.js")).href)).seed;
    seed({ sid: "s-bundled", cwd: "/x" }, { id: "g1", status: "active" });
    const ctx = fakeCtx("s-bundled");
    assert.equal((await store.read(ctx)).status, "active");
    await store.setStatus(ctx, "paused");
    assert.equal((await store.read(ctx)).status, "paused");
    await store.setStatus(ctx, "active");
    assert.equal((await store.read(ctx)).status, "active");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("goal store is found through OMO_BIN when argv[1] is not inside senpi, and a miss is retried instead of cached", async () => {
  const root = tmp();
  try {
    const bin = join(root, "node_modules", "omo-ai", "bin", "omo.js");
    const dist = join(root, "node_modules", "@code-yeongyu", "senpi", "dist");
    const store = createSenpiGoalStore({ env: { OMO_BIN: bin }, argv1: join(root, "elsewhere", "run.js") });
    await assert.rejects(() => store.read(fakeCtx("s-bin")), /senpi goal store unavailable/);
    const goalDir = writeStubDist(dist);
    (await import(pathToFileURL(join(goalDir, "store.js")).href)).seed({ sid: "s-bin", cwd: "/x" }, { id: "g2", status: "paused" });
    assert.equal((await store.read(fakeCtx("s-bin"))).status, "paused");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The installed senpi, when present: its real store.js/store-ref.js and its real on-disk goal file format.
const REAL_ARGV1 = join(homedir(), ".bun", "install", "global", "node_modules", "@code-yeongyu", "senpi", "dist", "bundle", "cli.js");
const realDist = join(REAL_ARGV1, "..", "..");

test("against senpi's real store: the goal file written by senpi is read, paused and re-activated on disk", { skip: !existsSync(join(realDist, ...GOAL_REL, "store.js")) }, async () => {
  const dir = tmp();
  try {
    const sessionManager = { getSessionFile: () => join(dir, "s.jsonl"), getSessionDir: () => dir, getSessionId: () => "sid-real", getCwd: () => dir };
    const real = await import(pathToFileURL(join(realDist, ...GOAL_REL, "store.js")).href);
    const refs = await import(pathToFileURL(join(realDist, ...GOAL_REL, "store-ref.js")).href);
    const ref = refs.goalStoreRef(sessionManager, dir);
    const created = await real.createGoal(ref, "tiny goal");
    const store = createSenpiGoalStore({ env: {}, argv1: REAL_ARGV1 });
    const ctx = { sessionManager, cwd: dir };
    const onDisk = () => {
      const file = readdirSync(join(dir, "extensions", "goal")).find((name) => name.endsWith(".json"));
      return JSON.parse(readFileSync(join(dir, "extensions", "goal", file), "utf8")).goal;
    };
    assert.equal((await store.read(ctx)).id, created.id);
    await store.setStatus(ctx, "paused");
    assert.equal(onDisk().status, "paused");
    assert.equal((await store.read(ctx)).status, "paused");
    await store.setStatus(ctx, "active");
    assert.equal(onDisk().status, "active");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function parked({ goal } = {}) {
  const h = createHarness({ model: CLAUDE, branch: [{ type: "message", message: { role: "assistant", api: "claude-sdk-oauth", content: [] } }], goal, now: T0 });
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "not-a-real-token" } });
  const reader = async () => ({
    provider: "anthropic-subscription", account: "default",
    windows: [{ kind: "five_hour", utilization: 95, resetAt: RESET }], overageEnabled: false, source: "endpoint",
  });
  const core = startKeepalive(h.pi, h.deps({ readUsage: reader }));
  return { h, core };
}

test("IS-1: a failed pause does not unblock spawns while the goal is active and the account is parked", async () => {
  const { h, core } = parked({ goal: { id: "g1", status: "active", objective: "work" } });
  try {
    h.goalStore.setStatus = async () => { throw new Error("store write failed"); };
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(core.isParked(), true);
    assert.equal(h.goalStore.goal.status, "active", "the pause really failed");
    const turn = await h.runTurn({ tools: ["task", "task_create", "read"] });
    assert.deepEqual(turn.blocked.map((b) => b.toolName), ["task", "task_create"]);
    assert.deepEqual(turn.executed, ["read"]);
    assert.match(turn.blocked[0].reason, /^keepalive: usage limit/);
  } finally { h.cleanup(); }
});

test("IS-1: an unreadable goal store still blocks spawns once keepalive owns a pause, and allows them when it owns none", async () => {
  const { h, core } = parked({ goal: { id: "g1", status: "active", objective: "work" } });
  try {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(core.state.pausedByKeepalive, "g1");
    h.goalStore.read = async () => { throw new Error("senpi goal store unavailable"); };
    const owned = await h.runTurn({ tools: ["task"] });
    assert.deepEqual(owned.blocked.map((b) => b.toolName), ["task"]);
    core.state.pausedByKeepalive = null;
    const unowned = await h.runTurn({ tools: ["task"] });
    assert.deepEqual(unowned.executed, ["task"]);
    assert.equal(core.state.lastError.where, "goal-read");
  } finally { h.cleanup(); }
});
