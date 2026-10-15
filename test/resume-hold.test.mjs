import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLimitless } from "../extension/limitless.mjs";
import { createHarness } from "./harness.mjs";

const T0 = 1_700_000_000_000;
const FIVE_RESET = T0 + 10 * 60_000;
const SEVEN_RESET = T0 + 30 * 60_000;
const MIN = 60_000;

function usage(five, seven) {
  return {
    "anthropic-subscription": {
      five_hour: { utilization: five, resetAt: FIVE_RESET },
      seven_day: { utilization: seven, resetAt: SEVEN_RESET },
    },
  };
}

function boot(homeDir, now, extraDeps = {}) {
  const h = createHarness({
    sessionId: "hold-test", homeDir, idle: true, now,
    model: { api: "claude-sdk-oauth", provider: "anthropic-subscription", id: "claude-sonnet" },
    goal: { id: "goal-1", status: "active" },
    env: { OMO_LIMITLESS_FAKE_USAGE_FILE: join(homeDir, "usage.json") },
  });
  h.installFakeGoalExtension();
  const core = startLimitless(h.pi, h.deps(extraDeps));
  return { h, core, command: h.commands.get("limitless") };
}

async function setup(t, initial = usage(95, 10)) {
  const homeDir = mkdtempSync(join(tmpdir(), "limitless-hold-"));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const first = boot(homeDir, T0);
  first.h.writeHomeJson("usage.json", initial);
  first.h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fixture" } });
  await first.h.fire("session_start", { type: "session_start" });
  await first.h.runTurn();
  assert.equal(first.core.isParked(), true);
  await first.command.handler("resume", first.h.ctx);
  assert.equal(first.core.isParked(), false);
  return { ...first, homeDir };
}

const pollLater = async (h, ms = 2 * MIN) => {
  await h.clock.tick(ms);
  return h.runTurn({ tools: ["task"] });
};

test("resume holds the same window: polls never re-park until its resetAt", async (t) => {
  const { h, core } = await setup(t);
  assert.deepEqual(core.state.resumeHold, { windows: { five_hour: FIVE_RESET } });
  for (let i = 0; i < 3; i += 1) {
    const turn = await pollLater(h);
    assert.equal(core.isParked(), false);
    assert.deepEqual(turn.blocked, []);
    assert.deepEqual(turn.executed, ["task"]);
  }
  assert.equal(core.state.decision.state, "park-wait", "the poll still sees the window over threshold");
  assert.equal(h.goalStore.goal.status, "active");
  assert.equal(h.statusLines.get("limitless"), "🔄");
  assert.equal(h.notice(), undefined);
});

test("the hold expires at the window's resetAt and normal gating resumes", async (t) => {
  const { h, core } = await setup(t);
  await pollLater(h, 2 * MIN);
  assert.ok(core.state.resumeHold);
  await pollLater(h, FIVE_RESET - h.clock.now() + 1_000);
  assert.equal(core.state.resumeHold, null);
  assert.equal(h.readHomeJson(".omo/limitless/state/hold-test.json").resumeHold, null);
});

test("a different window crossing the threshold during the hold parks", async (t) => {
  const { h, core } = await setup(t);
  await pollLater(h);
  assert.equal(core.isParked(), false);
  h.writeHomeJson("usage.json", usage(95, 96));
  await pollLater(h);
  assert.equal(core.isParked(), true);
  assert.equal(core.state.window, "seven_day");
});

test("a hold on seven_day does not hide a five_hour crossing", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "limitless-hold-"));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const { h, core, command } = boot(homeDir, T0);
  h.writeHomeJson("usage.json", usage(10, 96));
  h.writeHomeJson(".omo/agent/auth.json", { "anthropic-subscription": { access: "fixture" } });
  await h.fire("session_start", { type: "session_start" });
  await h.runTurn();
  assert.equal(core.state.window, "seven_day");
  await command.handler("resume", h.ctx);
  assert.deepEqual(core.state.resumeHold, { windows: { seven_day: SEVEN_RESET } });
  await pollLater(h);
  assert.equal(core.isParked(), false);
  h.writeHomeJson("usage.json", usage(95, 96));
  await pollLater(h);
  assert.equal(core.isParked(), true);
});

test("/limitless park clears the hold", async (t) => {
  const { h, core, command } = await setup(t);
  await pollLater(h);
  await command.handler("park", h.ctx);
  assert.equal(core.isParked(), true);
  assert.equal(core.state.source, "manual");
  assert.equal(core.state.resumeHold, null);
});

test("off then on clears the hold", async (t) => {
  const { h, core, command } = await setup(t);
  await command.handler("off", h.ctx);
  await command.handler("on", h.ctx);
  assert.equal(core.state.resumeHold, null);
  assert.equal(core.isParked(), true, "the forced poll after on parks again");
});

test("the hold survives a restart", async (t) => {
  const { h, homeDir } = await setup(t);
  await pollLater(h);
  const again = boot(homeDir, h.clock.now());
  await again.h.fire("session_start", { type: "session_start" });
  assert.deepEqual(again.core.state.resumeHold, { windows: { five_hour: FIVE_RESET } });
  const turn = await pollLater(again.h);
  assert.equal(again.core.isParked(), false);
  assert.deepEqual(turn.executed, ["task"]);
});

test("a reactive limit error during the hold still parks", async (t) => {
  const { h, core } = await setup(t);
  await pollLater(h);
  await h.fire("message_end", {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "You have hit your usage limit" }] },
  });
  assert.equal(core.isParked(), true);
  assert.equal(core.state.source, "reactive");
});

const P = "anthropic-subscription";
// table: account -> {five, seven}; per-account fake usage reader (no usage file)
function bootAccounts(homeDir, table, accounts) {
  const readUsage = async ({ account }) => ({
    provider: P, account, overageEnabled: false, source: "fake", windows: [
      { kind: "five_hour", utilization: table[account].five, resetAt: table[account].fiveReset ?? FIVE_RESET },
      { kind: "seven_day", utilization: table[account].seven, resetAt: SEVEN_RESET },
    ],
  });
  const b = boot(homeDir, T0, { readUsage });
  b.h.writeHomeJson(".omo/agent/auth.json", { [P]: { accounts: accounts.map((name) => ({ name, access: "x" })) } });
  return b;
}
async function parkAndResume(b) {
  await b.h.fire("session_start", { type: "session_start" });
  await b.h.runTurn();
  assert.equal(b.core.isParked(), true);
  await b.command.handler("resume", b.h.ctx);
  assert.equal(b.core.isParked(), false);
}
const tmpHome = (t) => {
  const d = mkdtempSync(join(tmpdir(), "limitless-hold-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

test("both windows over at resume: both are held, no re-park", async (t) => {
  const { h, core, command } = await setup(t, usage(95, 96));
  assert.deepEqual(core.state.resumeHold, { windows: { five_hour: FIVE_RESET, seven_day: SEVEN_RESET } });
  for (let i = 0; i < 3; i += 1) {
    const turn = await pollLater(h);
    assert.deepEqual(turn.blocked, []);
  }
  assert.equal(core.isParked(), false);
  void command;
});

test("two accounts over different windows at resume: both windows held, no re-park", async (t) => {
  const b = bootAccounts(tmpHome(t), { a: { five: 95, seven: 10 }, b: { five: 10, seven: 96 } }, ["a", "b"]);
  await parkAndResume(b);
  assert.deepEqual(b.core.state.resumeHold, { windows: { five_hour: FIVE_RESET, seven_day: SEVEN_RESET } });
  await pollLater(b.h);
  assert.equal(b.core.isParked(), false);
});

test("each held window expires at its own resetAt", async (t) => {
  const { h, core } = await setup(t, usage(95, 96));
  await pollLater(h, FIVE_RESET - h.clock.now() + 1_000);
  assert.deepEqual(core.state.resumeHold, { windows: { seven_day: SEVEN_RESET } });
  assert.equal(core.isParked(), true, "five_hour is over again outside the remaining held set");
  await pollLater(h, SEVEN_RESET - h.clock.now() + 1_000);
  assert.equal(core.state.resumeHold, null);
});

test("an external control-file off clears the hold", async (t) => {
  const { h, core } = await setup(t);
  assert.ok(core.state.resumeHold);
  h.writeHomeJson(".omo/limitless/control/hold-test.json", { v: 1, mode: "off" });
  await pollLater(h);
  assert.equal(core.state.resumeHold, null);
  h.writeHomeJson(".omo/limitless/control/hold-test.json", { v: 1, mode: "on" });
  await pollLater(h);
  assert.equal(core.isParked(), true, "gating is back to normal");
});

test("a window exactly at the threshold counts as over", async (t) => {
  const { h, core } = await setup(t);
  await pollLater(h);
  assert.equal(core.isParked(), false);
  h.writeHomeJson("usage.json", usage(95, core.config.thresholds.sevenDay));
  await pollLater(h);
  assert.equal(core.isParked(), true);
  assert.equal(core.state.window, "seven_day");
});

test("a reactive park during the hold stays parked across the next poll", async (t) => {
  const { h, core } = await setup(t);
  await pollLater(h);
  await h.fire("message_end", {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "You have hit your usage limit" }] },
  });
  assert.equal(core.state.source, "reactive");
  await pollLater(h);
  assert.equal(core.isParked(), true);
  assert.equal(core.state.source, "poll", "the hold never blocks parking a session that is already parked");
});

test("two accounts over the same window with different resetAt: the hold uses the earliest", async (t) => {
  const b = bootAccounts(tmpHome(t), {
    a: { five: 95, seven: 10, fiveReset: FIVE_RESET }, b: { five: 96, seven: 10, fiveReset: FIVE_RESET + 10 * MIN },
  }, ["a", "b"]);
  await parkAndResume(b);
  assert.deepEqual(b.core.state.resumeHold, { windows: { five_hour: FIVE_RESET } });
});

test("a reactive park converted to a poll park by the 30 minute check is held after resume", async (t) => {
  const homeDir = tmpHome(t);
  const { h, core, command } = boot(homeDir, T0);
  const FAR_FIVE = T0 + 120 * MIN; // inside the 4h wait limit, after the 30 minute check
  const SEVEN_FAR = T0 + 200 * MIN;
  const far = (five, seven = 10) => ({ [P]: {
    five_hour: { utilization: five, resetAt: FAR_FIVE }, seven_day: { utilization: seven, resetAt: SEVEN_FAR },
  } });
  h.writeHomeJson("usage.json", far(10));
  h.writeHomeJson(".omo/agent/auth.json", { [P]: { access: "fixture" } });
  await h.fire("session_start", { type: "session_start" });
  await h.runTurn();
  h.writeHomeJson("usage.json", far(95, 96));
  await h.fire("message_end", {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "You have hit your usage limit" }] },
  });
  assert.equal(core.state.source, "reactive");
  await h.clock.tick(31 * MIN);
  assert.equal(core.state.source, "poll", "the reactive check converted the park");
  await command.handler("resume", h.ctx);
  assert.deepEqual(core.state.resumeHold, { windows: { five_hour: FAR_FIVE, seven_day: SEVEN_FAR } });
  await pollLater(h);
  assert.equal(core.isParked(), false);
});

test("resume falls back to the parked window when the snapshots show no over window", async (t) => {
  const { h, core, command } = await setup(t);
  await command.handler("park", h.ctx);
  assert.equal(core.isParked(), true);
  core.state.snapshots = []; // stale readings
  await command.handler("resume", h.ctx);
  assert.deepEqual(core.state.resumeHold, { windows: { five_hour: FIVE_RESET } });
});
