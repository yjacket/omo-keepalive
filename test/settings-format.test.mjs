import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDuration, formatDurationToken, formatOnOff, formatPercent, formatUsd,
  parseDuration, parseOnOff, parsePercent, parseUsd, stepValue, withValue,
} from "../extension/settings/format.mjs";

test("duration formatters preserve minutes and render hours", () => {
  assert.equal(formatDuration(0), "0분");
  assert.equal(formatDuration(10.5), "10.5분");
  assert.equal(formatDuration(90), "1시간 30분");
  assert.equal(formatDuration(240), "4시간");
  assert.equal(formatDurationToken(90), "1h30m");
  assert.equal(formatDurationToken(30), "30m");
  assert.equal(formatDurationToken(10.5), "10.5m");
  assert.equal(formatDurationToken(240), "4h");
  assert.equal(formatDurationToken(0), "0");
});

test("scalar formatters and parsers validate supported values", () => {
  assert.equal(formatPercent(95), "95%");
  assert.equal(formatPercent(97.5), "97.5%");
  assert.equal(formatOnOff(true), "켜짐");
  assert.equal(formatOnOff(false), "꺼짐");
  assert.equal(formatUsd(3), "$3");
  assert.equal(formatUsd(0.5), "$0.5");
  assert.equal(formatUsd(0.25), "$0.25");
  for (const text of ["95", "95%", "97.5"]) assert.equal(parsePercent(text), Number.parseFloat(text));
  assert.equal(parsePercent("120"), undefined);
  assert.equal(parsePercent("0"), undefined);
  assert.equal(parseDuration("90"), 90);
  assert.equal(parseDuration("20m"), 20);
  assert.equal(parseDuration("4h"), 240);
  assert.equal(parseDuration("2h20m"), 140);
  assert.equal(parseDuration("4x"), undefined);
  assert.equal(parseOnOff("ON"), true);
  assert.equal(parseOnOff("꺼짐"), false);
  assert.equal(parseOnOff("maybe"), undefined);
  assert.equal(parseUsd("$3"), 3);
  assert.equal(parseUsd("0.5"), 0.5);
  assert.equal(parseUsd("-1"), undefined);
});

test("stepValue moves, clamps, wraps and handles off-grid numbers", () => {
  assert.equal(stepValue([1, 2, 3], 2, 1), 3);
  assert.equal(stepValue([30, 60], 45, -1), 30);
  assert.equal(stepValue(["on", "off"], "off", 1, { wrap: true }), "on");
  assert.equal(stepValue([1, 2], 2, 1), 2);
  assert.equal(stepValue([1, 2], 2, 1, { wrap: true }), 1);
  assert.equal(stepValue([30, 60], 45, 1), 60);
  assert.equal(stepValue([], 45, 1), 45);
});

test("withValue sorts and deduplicates a numeric grid", () => {
  assert.deepEqual(withValue([3, 1, 2], 2), [1, 2, 3]);
  assert.deepEqual(withValue([3, 1], 2), [1, 2, 3]);
});
