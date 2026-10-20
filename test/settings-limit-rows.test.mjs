import assert from "node:assert/strict";
import test from "node:test";
import { limitRows } from "../extension/settings/limit-rows.mjs";
import { stepValue } from "../extension/settings/format.mjs";

function snapshot(overrides = {}) {
  return {
    keepalive: {
      thresholds: { fiveHour: 90, sevenDay: 95 },
      waitLimitMs: { "anthropic-subscription": 240 * 60000, "chatgpt-subscription": 120 * 60000 },
      warm: { "anthropic-subscription": { on: true }, "chatgpt-subscription": { on: true } },
    },
    usage: { five_hour: 95, seven_day: null },
    ...overrides,
  };
}

test("limit rows expose the six exact keepalive settings", () => {
  const rows = limitRows();
  assert.deepEqual(rows.map(({ id }) => id), [
    "threshold.5h", "threshold.7d", "wait.claude", "wait.chatgpt",
    "park-warm.claude", "park-warm.chatgpt",
  ]);
  const snap = snapshot();
  assert.deepEqual(rows.map((row) => row.read(snap)), [90, 95, 240, 120, true, true]);
  assert.deepEqual(rows.map((row) => row.defaultValue(snap)), [90, 95, 240, 120, true, true]);
});

test("threshold rows format usage, parse values, and suggest common thresholds", () => {
  const [fiveHour, sevenDay] = limitRows();
  const snap = snapshot();
  assert.equal(fiveHour.format(90, snap), "90%  (지금 95%)");
  assert.equal(sevenDay.format(95, snap), "95%");
  assert.equal(fiveHour.format(90, snapshot({ usage: { five_hour: null, seven_day: null } })), "90%");
  assert.equal(fiveHour.toText(97), "97");
  assert.equal(fiveHour.parse("97"), 97);
  assert.equal(fiveHour.parse("0"), undefined);
  assert.equal(fiveHour.parse("abc"), undefined);
  assert.deepEqual(fiveHour.suggestions(snap), [50, 60, 70, 80, 85, 90, 95, 98, 100]);
  assert.equal(fiveHour.steps(snap).length, 100);
});

test("wait rows merge off-grid values and step to the next valid duration", () => {
  const claude = limitRows()[2];
  const snap = snapshot({
    keepalive: {
      ...snapshot().keepalive,
      waitLimitMs: { "anthropic-subscription": 330 * 60000, "chatgpt-subscription": 120 * 60000 },
    },
  });
  assert.equal(claude.read(snap), 330);
  assert.ok(claude.steps(snap).includes(330));
  assert.equal(stepValue(claude.steps(snap), 330, 1), 360);
  assert.equal(claude.format(0, snap), "안 기다림");
  assert.equal(claude.format(90, snap), "1시간 30분까지");
  assert.equal(claude.toText(90), "1h30m");
  assert.equal(claude.parse("0"), 0);
  assert.equal(claude.parse("-1"), undefined);
});

test("park-warm rows format, parse, and apply without losing unrelated data", () => {
  const row = limitRows()[4];
  const snap = snapshot();
  assert.equal(row.format(true, snap), "켜짐");
  assert.equal(row.format(false, snap), "꺼짐");
  assert.equal(row.toText(false), "off");
  assert.equal(row.parse("on"), true);
  assert.equal(row.parse("off"), false);
  const draft = { thresholds: { fiveHour: 90 }, warm: { other: { on: false } }, x: 1 };
  row.apply(draft, false);
  assert.deepEqual(draft, {
    thresholds: { fiveHour: 90 },
    warm: { other: { on: false }, "anthropic-subscription": { on: false } },
    x: 1,
  });
});

test("threshold apply preserves unrelated draft keys", () => {
  const row = limitRows()[1];
  const draft = { thresholds: { fiveHour: 90 }, x: 1 };
  row.apply(draft, 97);
  assert.deepEqual(draft, { thresholds: { fiveHour: 90, sevenDay: 97 }, x: 1 });
});

test("wait and park-warm apply preserve sibling provider settings", () => {
  const [,, wait, , , parkChatgpt] = limitRows();
  const draft = {
    waitLimitMs: { "chatgpt-subscription": 500 },
    warm: { "anthropic-subscription": { on: true }, extra: 2 },
  };
  wait.apply(draft, 360);
  parkChatgpt.apply(draft, false);
  assert.deepEqual(draft, {
    waitLimitMs: { "chatgpt-subscription": 500, "anthropic-subscription": 21600000 },
    warm: {
      "anthropic-subscription": { on: true },
      "chatgpt-subscription": { on: false },
      extra: 2,
    },
  });
});
