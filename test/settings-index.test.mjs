import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsScreen } from "../extension/settings/screen.mjs";
import {
  completions, loadSnapshot, saveChanges, settingRows, setByText,
  stagedFrom, textListing,
} from "../extension/settings/index.mjs";

const theme = { fg: (_color, text) => text, bold: (text) => text };

function withHomes(run) {
  const homeDir = mkdtempSync(join(tmpdir(), "keepalive-settings-"));
  const keepwarmHome = join(homeDir, "keepwarm");
  try {
    run({
      homeDir,
      keepwarmHome,
      env: { ...process.env, OMO_KEEPALIVE_CONFIG: undefined, OMO_KEEPWARM_HOME: keepwarmHome },
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function snapshot(options, snapshots = []) {
  return loadSnapshot({ ...options, snapshots, now: () => 1_800_000_000_000 });
}

function rowsById(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

test("empty homes produce a readable snapshot and twenty rows in group order", () => withHomes((options) => {
  const snap = snapshot(options, [{ windows: [
    { kind: "five_hour", utilization: 95 }, { kind: "five_hour", utilization: 80 },
    { kind: "seven_day", used_percent: 51 },
  ] }]);
  const rows = settingRows(snap);
  assert.equal(snap.keepaliveReadable, true);
  assert.equal(snap.keepwarmExists, false);
  assert.equal(snap.keepwarmReadable, true);
  assert.equal(snap.keepwarm.mode, "off");
  assert.deepEqual(snap.usage, { five_hour: 95, seven_day: 51 });
  assert.equal(rows.length, 20);
  assert.deepEqual([...new Set(rows.map((row) => row.group))], ["한도", "캐시", "데우는 시간", "복귀 습관"]);
  assert.equal(rows[0].format(90, snap), "90%  (지금 95%)");
}));

test("save writes changed keepalive, expiry, and habit fields to both files", () => withHomes((options) => {
  const snap = snapshot(options);
  const rows = settingRows(snap);
  const staged = stagedFrom(rows, snap);
  const changes = [
    { id: "threshold.5h", value: 95 },
    { id: "expiry.claude-subscription", value: 240 },
    { id: "habit.m", value: 20 },
  ];
  for (const change of changes) staged.set(change.id, change.value);
  const result = saveChanges(options, snap, changes, staged);
  assert.deepEqual(result.files, ["keepalive", "keepwarm"]);
  const alive = JSON.parse(readFileSync(snap.keepalivePath, "utf8"));
  assert.deepEqual(alive.thresholds, { fiveHour: 95 });
  assert.deepEqual(Object.keys(alive), ["thresholds"]);
  const warm = JSON.parse(readFileSync(snap.keepwarmPath, "utf8"));
  assert.deepEqual(warm.expiry, { "claude-subscription": 240 });
  assert.deepEqual(warm.habit, { p: 0.81, medianMinutes: 20, t90Minutes: 140 });
  assert.equal(warm.mode, "off");
  assert.deepEqual(Object.keys(warm).sort(), [
    "backstop", "expiry", "habit", "lanes", "maxHoldMinutes", "maxUsdPerDay",
    "maxUsdPerEpisode", "mode", "v",
  ]);
}));

test("save reports only the changed file names", () => withHomes((options) => {
  const snap = snapshot(options);
  const row = settingRows(snap).find(({ id }) => id === "threshold.5h");
  const staged = stagedFrom(settingRows(snap), snap);
  staged.set(row.id, 95);
  assert.deepEqual(saveChanges(options, snap, [{ id: row.id, value: 95 }], staged).files, ["keepalive"]);

  const failed = saveChanges(options, { ...snap, keepaliveReadable: false }, [{ id: row.id, value: 96 }], staged);
  assert.deepEqual(failed.files, []);
}));

test("unreadable keepalive config refuses save and leaves both files untouched", () => withHomes((options) => {
  const snap = snapshot(options);
  mkdirSync(join(options.homeDir, ".omo", "keepalive"), { recursive: true });
  writeFileSync(snap.keepalivePath, "{ broken");
  const unreadableSnap = snapshot(options);
  const before = readFileSync(snap.keepalivePath, "utf8");
  const result = saveChanges(options, unreadableSnap, [{ id: "threshold.5h", value: 95 }], new Map());
  assert.equal(result.error, `keepalive 설정 파일을 읽지 못해 저장하지 않았습니다: ${unreadableSnap.keepalivePath}`);
  assert.deepEqual(result.files, []);
  assert.equal(readFileSync(snap.keepalivePath, "utf8"), before);
}));

test("text settings parse values, reject invalid values, and preserve habit defaults", () => withHomes((options) => {
  let snap = snapshot(options);
  let result = setByText(options, snap, ["threshold", "5h", "95"]);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(readFileSync(snap.keepalivePath, "utf8")).thresholds.fiveHour, 95);
  result = setByText(options, snap, ["threshold", "5h", "0"]);
  assert.equal(result.ok, false);
  assert.match(result.message, /5시간 임계치에 쓸 수 없는 값입니다: 0/);

  snap = snapshot(options);
  result = setByText(options, snap, ["wait", "claude", "3h"]);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(readFileSync(snap.keepalivePath, "utf8")).waitLimitMs["anthropic-subscription"], 10800000);

  snap = snapshot(options);
  result = setByText(options, snap, ["habit", "p", "0.7"]);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(snap.keepwarmPath, "utf8")).habit, {
    p: 0.7, medianMinutes: 10.5, t90Minutes: 140,
  });
}));

test("setting habit manual freezes the effective habit and reports keepwarm", () => withHomes((options) => {
  const snap = snapshot(options);
  const result = setByText(options, snap, ["habit", "manual"]);
  assert.deepEqual(result, { ok: true, message: "keepalive: 방식 직접", files: ["keepwarm"] });
  assert.deepEqual(JSON.parse(readFileSync(snap.keepwarmPath, "utf8")).habit, {
    p: 0.81, medianMinutes: 10.5, t90Minutes: 140,
  });
}));

test("habit saves merge only changed fields from the save-time file", () => withHomes((options) => {
  mkdirSync(options.keepwarmHome, { recursive: true });
  const path = join(options.keepwarmHome, "config.json");
  writeFileSync(path, JSON.stringify({ v: 1, mode: "off", habit: { p: 0.81, medianMinutes: 10.5, t90Minutes: 140 } }));
  const snap = snapshot(options);
  writeFileSync(path, JSON.stringify({ v: 1, mode: "off", habit: { p: 0.81, medianMinutes: 10.5, t90Minutes: 180 } }));
  const staged = stagedFrom(settingRows(snap), snap);
  staged.set("habit.p", 0.7);
  assert.deepEqual(saveChanges(options, snap, [{ id: "habit.p", value: 0.7 }], staged).error, undefined);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).habit, { p: 0.7, medianMinutes: 10.5, t90Minutes: 180 });

  const before = readFileSync(path, "utf8");
  staged.set("habit.m", 240);
  const result = saveChanges(options, snap, [{ id: "habit.m", value: 240 }], staged);
  assert.match(result.error, /복귀 습관 값이 맞지 않습니다/);
  assert.equal(readFileSync(path, "utf8"), before);
}));

test("listing and completions expose paths, values, and empty matches", () => withHomes((options) => {
  const snap = snapshot(options);
  const listing = textListing(snap);
  assert.match(listing, /threshold 5h/);
  assert.match(listing, /5시간 임계치/);
  assert.ok(completions("set th", snap).some((item) => item.value === "set threshold"));
  assert.ok(completions("set threshold ", snap).some((item) => item.value === "set threshold 5h"));
  assert.ok(completions("set threshold 5h ", snap).some((item) => item.value === "set threshold 5h 95"));
  assert.ok(completions("set habit ", snap).some((item) => item.value === "set habit manual"));
  assert.ok(completions("set habit ", snap).some((item) => item.value === "set habit auto"));
  assert.equal(completions("zz", snap), null);
}));

test("real warm rows keep staged habit median below t90 through stepping and reset", () => withHomes((options) => {
  const snap = snapshot(options);
  const rows = settingRows(snap);
  const screen = new SettingsScreen(theme, { rows, snap, focusId: "habit.t90", onSave() {}, onClose() {} });
  const ids = rowsById(rows);
  const rowIndex = (id) => rows.findIndex((row) => row.id === id);
  const focus = (id) => {
    while (screen.cursor < rowIndex(id)) screen.handleInput("j");
    while (screen.cursor > rowIndex(id)) screen.handleInput("k");
  };
  const valid = () => assert.ok(screen.staged.get("habit.m") < screen.staged.get("habit.t90"));
  for (let i = 0; i < 2; i++) screen.handleInput("\x1b[C");
  assert.equal(screen.staged.get("habit.t90"), 240);
  valid();
  focus("habit.m");
  for (let i = 0; i < 8; i++) { screen.handleInput("\x1b[C"); valid(); }
  assert.equal(screen.staged.get("habit.m"), 180);
  focus("habit.t90");
  screen.handleInput("\x1b[D");
  valid();
  assert.equal(screen.staged.get("habit.t90"), 240);
  screen.handleInput("r");
  valid();
  assert.equal(screen.staged.get("habit.t90"), 140);
  assert.equal(screen.staged.get("habit.m"), 120);
  assert.ok(ids.has("habit.m"));
}));
