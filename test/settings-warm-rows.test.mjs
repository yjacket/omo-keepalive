import assert from "node:assert/strict";
import test from "node:test";
import { laneDescriptors } from "../extension/keepwarm/cli/expiry.mjs";
import { DEFAULT_HABIT } from "../extension/keepwarm/config.mjs";
import { effectiveHabit, warmRows } from "../extension/settings/warm-rows.mjs";

const lanes = laneDescriptors({}).filter(({ lane }) => lane.policy === "decide");

function snapshot(overrides = {}) {
  return {
    keepwarm: { lanes: {}, expiry: {}, habit: "auto", ...overrides.keepwarm },
    habit: overrides.habit ?? { ...DEFAULT_HABIT },
    autoHabit: overrides.autoHabit ?? { ...DEFAULT_HABIT },
    lanes: overrides.lanes ?? lanes,
  };
}

test("warm rows build expiry rows in lane order and format auto expiry", () => {
  const snap = snapshot();
  const rows = warmRows(snap);
  assert.deepEqual(rows.slice(0, lanes.length).map((row) => row.id), lanes.map(({ key }) => `expiry.${key}`));
  const claude = rows[0];
  assert.equal(claude.id, "expiry.claude-subscription");
  assert.equal(claude.read(snap), "auto");
  assert.deepEqual(claude.steps(snap, new Map()), ["auto", ...lanes[0].lane.grid]);
  assert.equal(claude.format("auto", snap, new Map()), "자동 (5시간)");
  assert.equal(claude.parse("7h"), undefined);
  assert.equal(claude.parse("5h"), 300);
  assert.equal(claude.toText(240), "4h");
  assert.match(claude.valueHelp, /^auto\|0\|/);
  assert.ok(claude.valueHelp.includes("5h"));
});

test("off-grid saved expiry is kept as a step between its neighbors", () => {
  const snap = snapshot({ keepwarm: { expiry: { "claude-subscription": 270 } } });
  const row = warmRows(snap)[0];
  assert.equal(row.read(snap), 270);
  const steps = row.steps(snap, new Map());
  assert.ok(steps.indexOf(270) > steps.indexOf(240));
  assert.ok(steps.indexOf(270) < steps.indexOf(300));
  assert.equal(row.format(270, snap, new Map()), "4시간 30분");
});

test("expiry apply keeps other lane keys in the draft", () => {
  const snap = snapshot();
  const rows = warmRows(snap);
  const otherKey = lanes[1].key;
  const draft = { expiry: { [otherKey]: 20 } };
  rows[0].apply(draft, 240);
  assert.deepEqual(draft.expiry, { [otherKey]: 20, "claude-subscription": 240 });
});

test("expiry apply preserves other settings and habit rows do not apply", () => {
  const snap = snapshot();
  const rows = warmRows(snap);
  const draft = { expiry: { existing: 30 }, other: true };
  rows[0].apply(draft, 240);
  assert.deepEqual(draft, { expiry: { existing: 30, "claude-subscription": 240 }, other: true });
  for (const row of rows.slice(lanes.length)) row.apply(draft, row.read(snap));
  assert.deepEqual(draft.expiry, { existing: 30, "claude-subscription": 240 });
});

test("habit rows expose defaults, parsing, and auto/manual effective values", () => {
  const snap = snapshot();
  const rows = warmRows(snap);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(rows.slice(-4).map((row) => row.id), ["habit", "habit.p", "habit.m", "habit.t90"]);
  assert.equal(byId.habit.format("auto", snap, new Map()), "자동");
  assert.deepEqual(byId.habit.steps(snap, new Map()), ["auto", "manual"]);
  assert.equal(byId.habit.toText("auto"), "auto");
  assert.equal(byId.habit.toText("manual"), "manual");
  assert.equal(byId.habit.valueHelp, "auto|manual");
  assert.equal(byId["habit.p"].valueHelp, "0.05-1 or 5%-100%");
  assert.equal(byId["habit.m"].valueHelp, "duration < 90% return, e.g. 10m, 1h");
  assert.equal(byId["habit.t90"].valueHelp, "duration > median, e.g. 2h, 3h");
  assert.equal(byId["habit.p"].read(snap), 0.81);
  assert.ok(byId["habit.p"].steps(snap, new Map()).includes(0.81));
  assert.equal(byId["habit.p"].parse("70%"), 0.7);
  assert.equal(byId["habit.p"].format(0.7, snap, new Map()), "70%");
  assert.deepEqual(effectiveHabit(snap, new Map([["habit", "auto"]])), snap.autoHabit);
  assert.deepEqual(
    effectiveHabit(snap, new Map([["habit", "manual"], ["habit.p", 0.7], ["habit.m", 20], ["habit.t90", 180]])),
    { p: 0.7, mMin: 20, t90Min: 180, source: "manual" },
  );
  assert.deepEqual(byId.habit.linked("auto", snap, new Map()), {
    "habit.p": DEFAULT_HABIT.p, "habit.m": DEFAULT_HABIT.mMin, "habit.t90": DEFAULT_HABIT.t90Min,
  });
  assert.deepEqual(byId.habit.linked("manual", snap, new Map()), {});
  assert.deepEqual(byId["habit.p"].linked(0.7, snap, new Map()), { habit: "manual" });
});

test("expiry value help lists each lane's duration tokens", () => {
  const rows = warmRows(snapshot());
  for (const { key, lane } of lanes) {
    const row = rows.find((entry) => entry.id === `expiry.${key}`);
    assert.equal(row.valueHelp, `auto|${lane.grid.map((value) => row.toText(value)).join("|")}`);
    assert.equal(row.valueHelp.split("|").filter((token) => token === "0").length, 1);
  }
});

test("habit median and t90 steps and linked values preserve their ordering", () => {
  const snap = snapshot({ habit: { ...DEFAULT_HABIT, mMin: 10, t90Min: 140 } });
  const rows = Object.fromEntries(warmRows(snap).map((row) => [row.id, row]));
  const staged = new Map([["habit.t90", 10]]);
  assert.ok(!rows["habit.m"].steps(snap, staged).some((value) => value >= staged.get("habit.t90")));
  assert.ok(!rows["habit.m"].steps(snap, new Map([["habit.t90", 10]])).includes(snap.habit.mMin));

  assert.deepEqual(rows["habit.m"].linked(180, snap, new Map([["habit.t90", 120]])), {
    habit: "manual", "habit.t90": 240,
  });
  assert.deepEqual(rows["habit.t90"].linked(10, snap, new Map([["habit.m", 20]])), {
    habit: "manual", "habit.m": 7.5,
  });
  assert.deepEqual(rows["habit.t90"].linked(180, snap, new Map([["habit.m", 180]])), {
    habit: "manual", "habit.m": 120,
  });
});
