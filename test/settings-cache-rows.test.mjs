import assert from "node:assert/strict";
import test from "node:test";
import { cacheRows } from "../extension/settings/cache-rows.mjs";

const snap = (overrides = {}) => ({
  keepwarm: {
    mode: "shadow", backstop: "on", maxHoldMinutes: 360,
    maxUsdPerDay: 3, maxUsdPerEpisode: 0.5,
    ...overrides,
  },
});

const row = (id) => cacheRows().find((entry) => entry.id === id);

test("mode row follows the cache settings contract", () => {
  const setting = row("mode");
  const snapshot = snap();
  assert.deepEqual(
    [setting.id, setting.group, setting.label, setting.file],
    ["mode", "캐시", "캐시 데우기", "keepwarm"],
  );
  assert.equal(setting.read(snapshot), "shadow");
  assert.equal(setting.defaultValue(snapshot), "off");
  assert.deepEqual(setting.steps(snapshot, new Map()), ["on", "shadow", "off"]);
  assert.equal(setting.format("shadow", snapshot, new Map()), "기록만");
  assert.equal(setting.format("off", snapshot, new Map()), "꺼짐");
  assert.equal(setting.toText("shadow"), "shadow");
  assert.equal(setting.toText("on"), "on");
  assert.equal(setting.parse("on"), "on");
  assert.equal(setting.parse("shadow"), "shadow");
  assert.equal(setting.parse("off"), "off");
  assert.equal(setting.parse("invalid"), undefined);

  const draft = { unrelated: true, mode: "old" };
  setting.apply(draft, "on", new Map());
  assert.deepEqual(draft, { unrelated: true, mode: "on" });
});

test("backstop row follows the cache settings contract", () => {
  const setting = row("backstop");
  const snapshot = snap();
  assert.deepEqual(
    [setting.id, setting.group, setting.label, setting.file],
    ["backstop", "캐시", "goal backstop 붙잡기", "keepwarm"],
  );
  assert.equal(setting.read(snapshot), "on");
  assert.equal(setting.defaultValue(snapshot), "on");
  assert.deepEqual(setting.steps(snapshot, new Map()), ["on", "off"]);
  assert.equal(setting.format("on", snapshot, new Map()), "켜짐");
  assert.equal(setting.format("off", snapshot, new Map()), "꺼짐");
  assert.equal(setting.toText("on"), "on");
  assert.equal(setting.toText("off"), "off");
  assert.equal(setting.parse("on"), "on");
  assert.equal(setting.parse("off"), "off");
  assert.equal(setting.parse("invalid"), undefined);

  const draft = { unrelated: true, backstop: "old" };
  setting.apply(draft, "off", new Map());
  assert.deepEqual(draft, { unrelated: true, backstop: "off" });
});

test("hold row follows the cache settings contract", () => {
  const setting = row("hold");
  const snapshot = snap();
  assert.deepEqual(
    [setting.id, setting.group, setting.label, setting.file],
    ["hold", "캐시", "goal 기다릴 때 데우기", "keepwarm"],
  );
  assert.equal(setting.read(snapshot), 360);
  assert.equal(setting.defaultValue(snapshot), 360);
  assert.deepEqual(setting.steps(snapshot, new Map()), [30, 60, 90, 120, 180, 240, 360, 480, 720, 1080, 1440]);
  assert.deepEqual(setting.steps(snap({ maxHoldMinutes: 100 }), new Map()), [30, 60, 90, 100, 120, 180, 240, 360, 480, 720, 1080, 1440]);
  assert.equal(setting.format(30, snapshot, new Map()), "30분까지");
  assert.equal(setting.format(90, snapshot, new Map()), "1시간 30분까지");
  assert.equal(setting.toText(240), "4h");
  assert.equal(setting.toText(90), "1h30m");
  assert.equal(setting.parse("45m"), 45);
  assert.equal(setting.parse("20m"), undefined);
  assert.equal(setting.parse("25h"), undefined);
  assert.equal(setting.parse("45.5m"), undefined);

  const draft = { unrelated: true, maxHoldMinutes: 60 };
  setting.apply(draft, 240, new Map());
  assert.deepEqual(draft, { unrelated: true, maxHoldMinutes: 240 });
});

test("daily USD row follows the cache settings contract", () => {
  const setting = row("usd.day");
  const snapshot = snap();
  assert.deepEqual(
    [setting.id, setting.group, setting.label, setting.file],
    ["usd.day", "캐시", "하루 비용 상한", "keepwarm"],
  );
  assert.equal(setting.read(snapshot), 3);
  assert.equal(setting.defaultValue(snapshot), 3);
  assert.deepEqual(setting.steps(snapshot, new Map()), [0, 0.5, 1, 2, 3, 5, 10, 20, 50]);
  assert.deepEqual(setting.steps(snap({ maxUsdPerDay: 4 }), new Map()), [0, 0.5, 1, 2, 3, 4, 5, 10, 20, 50]);
  assert.equal(setting.format(0, snapshot, new Map()), "$0");
  assert.equal(setting.format(3, snapshot, new Map()), "$3");
  assert.equal(setting.toText(0.5), "0.5");
  assert.equal(setting.toText(2), "2");
  assert.equal(setting.parse("$2"), 2);
  assert.equal(setting.parse("0.25"), 0.25);
  assert.equal(setting.parse("$0"), 0);
  assert.equal(setting.parse("-1"), undefined);
  assert.equal(setting.parse("invalid"), undefined);

  const draft = { unrelated: true, maxUsdPerDay: 1 };
  setting.apply(draft, 2, new Map());
  assert.deepEqual(draft, { unrelated: true, maxUsdPerDay: 2 });
});

test("episode USD row follows the cache settings contract", () => {
  const setting = row("usd.episode");
  const snapshot = snap();
  assert.deepEqual(
    [setting.id, setting.group, setting.label, setting.file],
    ["usd.episode", "캐시", "자리 비울 때마다 비용 상한", "keepwarm"],
  );
  assert.equal(setting.read(snapshot), 0.5);
  assert.equal(setting.defaultValue(snapshot), 0.5);
  assert.deepEqual(setting.steps(snapshot, new Map()), [0, 0.1, 0.25, 0.5, 1, 2, 5]);
  assert.equal(setting.format(0, snapshot, new Map()), "$0");
  assert.equal(setting.format(0.5, snapshot, new Map()), "$0.5");
  assert.equal(setting.toText(0.5), "0.5");
  assert.equal(setting.toText(2), "2");
  assert.equal(setting.parse("$2"), 2);
  assert.equal(setting.parse("0.25"), 0.25);
  assert.equal(setting.parse("$0"), 0);
  assert.equal(setting.parse("-1"), undefined);
  assert.equal(setting.parse("invalid"), undefined);

  const draft = { unrelated: true, maxUsdPerEpisode: 1 };
  setting.apply(draft, 0.25, new Map());
  assert.deepEqual(draft, { unrelated: true, maxUsdPerEpisode: 0.25 });
});
