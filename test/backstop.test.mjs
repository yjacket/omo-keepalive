// keepalive backstop feature: holds senpi's goal backstop (continuation_hold_state "omo-keepalive") while a goal wait is
// kept warm and omo-health is ready, and releases it the moment any condition is lost.
// keepwarm is a fake controller (core.keepwarm injected as a feature installed before backstop): the tests drive the
// goal-wait signal, the snapshot's goalWait.warm and the health files directly.
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { startKeepalive } from "../extension/keepalive.mjs";
import * as backstop from "../extension/backstop.mjs";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const SOURCE = "omo-keepalive";

function fakeKeepwarm() {
  const calls = [];
  const controller = {
    calls,
    warm: true,
    waiting: false,
    setGoalWait(on) { calls.push(on); controller.waiting = on; },
    snapshot: () => ({
      goalWait: controller.waiting ? { sinceMs: T0, warm: controller.warm, reason: controller.warm ? null : "unverified" } : null,
    }),
  };
  return { controller, inert: false, isInert: () => false };
}

async function setup({ withKeepwarm = true } = {}) {
  const h = createHarness({ now: T0 });
  const kw = fakeKeepwarm();
  const injectKeepwarm = { install: (core) => { core.keepwarm = kw; } };
  const core = startKeepalive(h.pi, h.deps(), withKeepwarm ? [injectKeepwarm, backstop] : [backstop]);
  await h.fire("session_start", { type: "session_start", reason: "startup" });
  const emit = (name, payload) => h.pi.events.emit(name, payload);
  const api = {
    h, core, kw, controller: kw.controller,
    emit,
    // health files, all fresh at the harness clock unless overridden
    health({ daemonTs = h.clock.now(), capabilities = ["goal-liveness"], goalLiveness = { wakeReady: true, actionScope: null },
      sensorTs = h.clock.now(), schema = 1 } = {}) {
      h.writeHomeJson(".omo-health/daemon.json", { ts: daemonTs, capabilities, goalLiveness });
      const sensor = { v: 1, sessionId: "s1", ts: sensorTs };
      if (schema !== null) sensor.goalLivenessSchema = schema; // null = a legacy heartbeat without the field
      h.writeHomeJson(".omo-health/sensors/s1.json", sensor);
    },
    arm: (kind = "monitor") => emit("goal_continuation_timer_state", { armed: true, kind, dueAtMs: T0 + 3_600_000 }),
    disarm: () => emit("goal_continuation_timer_state", { armed: false, kind: "monitor" }),
    source: (source, activeCount) => emit("wake_source_state", { source, activeCount }),
    holds: () => h.eventsEmitted.filter((e) => e.name === "continuation_hold_state").map((e) => ({ ...e.payload })),
    status: () => core.backstop.status(),
    recheck: () => h.clock.tick(10_000),
    // armed monitor + one running source + fresh health
    async goalWait() {
      api.health();
      await api.arm();
      await api.source("senpi-task", 1);
    },
  };
  return api;
}

test("armed monitor + wake source + warm + health ready: exactly one hold active:true", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.goalWait();
  await s.source("omo-dag", 2); // more events, same state
  await s.recheck();
  assert.deepEqual(s.holds(), [{ source: SOURCE, active: true }]);
  assert.deepEqual(s.status(), { holding: true, tripped: false });
});

test("wake sources drain: the hold is released", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.goalWait();
  await s.source("senpi-task", 0);
  assert.deepEqual(s.holds(), [{ source: SOURCE, active: true }, { source: SOURCE, active: false }]);
  assert.equal(s.status().holding, false);
});

test("terminal_monitor_state counts as the terminal-monitors wake source", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  s.health();
  await s.arm();
  await s.emit("terminal_monitor_state", { activeCount: 1 });
  assert.deepEqual(s.holds(), [{ source: SOURCE, active: true }]);
  await s.emit("terminal_monitor_state", { activeCount: 0 });
  assert.equal(s.holds().at(-1).active, false);
});

test("armed:false releases the hold", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.goalWait();
  await s.disarm();
  assert.deepEqual(s.holds(), [{ source: SOURCE, active: true }, { source: SOURCE, active: false }]);
});

test("a userGrace timer is never held", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  s.health();
  await s.arm("userGrace");
  await s.source("senpi-task", 1);
  await s.recheck();
  assert.deepEqual(s.holds(), []);
  assert.deepEqual(s.controller.calls, []);
  // monitor armed, then replaced by a userGrace timer: released
  await s.arm("monitor");
  assert.equal(s.status().holding, true);
  await s.arm("userGrace");
  assert.equal(s.status().holding, false);
});

test("an ask-user wait is never held", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  s.health();
  await s.arm();
  await s.source("senpi-task", 1);
  assert.equal(s.status().holding, true);
  await s.source("ask-user", 1);
  assert.equal(s.status().holding, false);
  assert.equal(s.controller.waiting, false);
  await s.source("ask-user", 0);
  assert.equal(s.status().holding, true);
});

test("no hold while omo-health is stale, lacks goal-liveness or the sensor heartbeat is stale; a hold is released when it goes stale", async (t) => {
  for (const [name, health] of [
    ["daemon stale", { daemonTs: T0 - 60_000 }],
    ["no goal-liveness capability", { capabilities: ["park-resume"] }],
    ["sensor stale", { sensorTs: T0 - 60_000 }],
  ]) {
    const s = await setup();
    t.after(() => s.h.cleanup());
    s.health(health);
    await s.arm();
    await s.source("senpi-task", 1);
    assert.deepEqual(s.holds(), [], name);
  }
  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.goalWait();
  assert.equal(s.status().holding, true);
  await s.recheck(); // health still fresh at +10 s: the hold stays
  s.health({ daemonTs: s.h.clock.now() - 60_000 });
  await s.recheck();
  assert.deepEqual(s.holds(), [{ source: SOURCE, active: true }, { source: SOURCE, active: false }]);
  s.health();
  await s.recheck();
  assert.equal(s.status().holding, true, "fresh health holds again");
});

test("a missing daemon.json or sensor file never holds", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.arm();
  await s.source("senpi-task", 1);
  assert.deepEqual(s.holds(), []);
});

test("a fresh legacy sensor heartbeat without goalLivenessSchema never holds", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  s.health({ schema: null });
  await s.arm();
  await s.source("senpi-task", 1);
  assert.deepEqual(s.holds(), []);
  s.health({ schema: 2 });
  await s.recheck();
  assert.deepEqual(s.holds(), []);
});

test("keepwarm backstop off: no hold, and a hold is released at the next re-evaluation", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  s.h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on", backstop: "off" });
  await s.goalWait();
  assert.deepEqual(s.holds(), []);
  const held = await setup();
  t.after(() => held.h.cleanup());
  await held.goalWait();
  assert.equal(held.status().holding, true);
  held.h.writeHomeJson(".omo-keepwarm/config.json", { v: 1, mode: "on", backstop: "off" });
  await held.recheck();
  assert.equal(held.status().holding, false);
});

test("daemon goalLiveness: wakeReady false or a foreign actionScope never holds; scope containing the session holds", async (t) => {
  for (const [name, goalLiveness] of [
    ["wakeReady false", { wakeReady: false, actionScope: null }],
    ["scope without this session", { wakeReady: true, actionScope: ["other"] }],
    ["wakeReady missing", {}],
  ]) {
    const s = await setup();
    t.after(() => s.h.cleanup());
    s.health({ goalLiveness });
    await s.arm();
    await s.source("senpi-task", 1);
    assert.deepEqual(s.holds(), [], name);
  }
  for (const [name, actionScope] of [["scope with this session", ["other", "s1"]], ["empty scope", []], ["null scope", null]]) {
    const s = await setup();
    t.after(() => s.h.cleanup());
    s.health({ goalLiveness: { wakeReady: true, actionScope } });
    await s.arm();
    await s.source("senpi-task", 1);
    assert.deepEqual(s.holds(), [{ source: SOURCE, active: true }], name);
  }
  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.goalWait();
  assert.equal(s.status().holding, true);
  s.health({ goalLiveness: { wakeReady: false, actionScope: null } });
  await s.recheck();
  assert.equal(s.status().holding, false, "released within one 10 s re-evaluation");
});

test("keepwarm snapshot goalWait.warm false: no hold, and a hold is released at the next re-evaluation", async (t) => {
  const cold = await setup();
  t.after(() => cold.h.cleanup());
  cold.controller.warm = false;
  await cold.goalWait();
  assert.deepEqual(cold.holds(), []);
  assert.equal(cold.controller.waiting, true, "the goal-wait signal is still sent");
  cold.controller.warm = true;
  await cold.recheck();
  assert.equal(cold.status().holding, true, "warm turns true: held at the next re-evaluation");

  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.goalWait();
  assert.equal(s.status().holding, true);
  s.controller.warm = false;
  await s.recheck();
  assert.equal(s.status().holding, false);
  assert.deepEqual(s.holds(), [{ source: SOURCE, active: true }, { source: SOURCE, active: false }]);
});

test("the goal-wait signal calls setGoalWait only on transitions", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  s.health();
  await s.arm();
  assert.deepEqual(s.controller.calls, [], "armed alone is not a goal wait");
  await s.source("senpi-task", 1);
  await s.source("senpi-task", 3);
  await s.recheck();
  assert.deepEqual(s.controller.calls, [true]);
  await s.source("senpi-task", 0);
  await s.source("senpi-task", 0);
  assert.deepEqual(s.controller.calls, [true, false]);
  await s.source("senpi-task", 1);
  await s.disarm();
  assert.deepEqual(s.controller.calls, [true, false, true, false]);
});

test("without keepwarm there is no goal wait and no hold, and nothing throws", async (t) => {
  const s = await setup({ withKeepwarm: false });
  t.after(() => s.h.cleanup());
  await s.goalWait();
  await s.recheck();
  assert.deepEqual(s.holds(), []);
  assert.equal(s.core.state.lastError, null);
});

test("senpi fires its backstop while held: tripped, error recorded, never held again", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.goalWait();
  assert.equal(s.status().holding, true);
  await s.disarm(); // senpi emits armed:false BEFORE resumed
  assert.equal(s.status().holding, false);
  await s.emit("goal_continuation_resumed", { wakeCause: "timer" });
  assert.deepEqual(s.status(), { holding: false, tripped: true });
  assert.equal(s.core.state.lastError.where, "backstop-hold");
  assert.match(s.core.state.lastError.message, /senpi fired its backstop while held/);
  await s.arm();
  await s.source("senpi-task", 1);
  await s.recheck();
  assert.equal(s.status().holding, false);
  assert.deepEqual(s.holds(), [{ source: SOURCE, active: true }, { source: SOURCE, active: false }]);
});

test("benign sequences do not trip", async (t) => {
  // health went stale (hold released), then senpi's timer fired on its own
  const a = await setup();
  t.after(() => a.h.cleanup());
  await a.goalWait();
  a.health({ sensorTs: a.h.clock.now() - 60_000 });
  await a.recheck();
  assert.equal(a.status().holding, false);
  await a.disarm();
  await a.emit("goal_continuation_resumed", { wakeCause: "timer" });
  assert.deepEqual(a.status(), { holding: false, tripped: false });
  assert.equal(a.core.state.lastError, null);
  a.health();
  await a.arm();
  await a.source("senpi-task", 1);
  assert.equal(a.status().holding, true, "a later wait is held normally");

  // the sources drained (hold released), then senpi resumed because of it
  const b = await setup();
  t.after(() => b.h.cleanup());
  await b.goalWait();
  await b.source("senpi-task", 0);
  assert.equal(b.status().holding, false);
  await b.disarm();
  await b.emit("goal_continuation_resumed", { wakeCause: "sources-drained" });
  assert.deepEqual(b.status(), { holding: false, tripped: false });

  // held at the disarm, but the wake is not the timer
  const c = await setup();
  t.after(() => c.h.cleanup());
  await c.goalWait();
  await c.disarm();
  await c.emit("goal_continuation_resumed", { wakeCause: "sources-drained" });
  assert.deepEqual(c.status(), { holding: false, tripped: false });
  await c.emit("goal_continuation_resumed", { wakeCause: "timer" });
  assert.equal(c.status().tripped, false, "the disarm record is consumed by the first resumed");
});

test("session shutdown releases the hold and the goal-wait signal", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.goalWait();
  assert.equal(s.status().holding, true);
  await s.h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.deepEqual(s.holds(), [{ source: SOURCE, active: true }, { source: SOURCE, active: false }]);
  assert.deepEqual(s.controller.calls, [true, false]);
  assert.deepEqual(s.status(), { holding: false, tripped: false });
  assert.equal(s.h.clock.pendingTimers().length, 0, "no re-evaluation timer is left behind");
});

test("switching keepalive off releases the hold at the next re-evaluation", async (t) => {
  const s = await setup();
  t.after(() => s.h.cleanup());
  await s.goalWait();
  s.core.state.mode = "off";
  await s.recheck();
  assert.equal(s.status().holding, false);
  assert.equal(s.controller.waiting, false);
});
