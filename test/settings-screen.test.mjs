import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsScreen } from "../extension/settings/screen.mjs";
import { displayWidth } from "../extension/settings/text.mjs";

const theme = { fg: (_color, text) => text, bold: (text) => text };

const numRow = (id, group, label, { steps = [1, 2, 3], def = 1, linked } = {}) => ({
  id,
  group,
  label,
  hint: `${label} 힌트입니다`,
  file: "keepalive",
  valueHelp: "1-3",
  read: (snap) => snap.values[id],
  defaultValue: () => def,
  steps: () => steps,
  format: (value) => `<${value}>`,
  toText: (value) => String(value),
  parse: () => undefined,
  linked,
  apply() {},
});

function open(rows, { values = {}, focusId, maxRows, onSave = () => undefined } = {}) {
  const log = { saves: [], closes: 0 };
  const screen = new SettingsScreen(theme, {
    rows,
    snap: { values },
    focusId,
    maxRows,
    onSave: (changes, staged) => {
      log.saves.push({ changes, staged });
      return onSave(changes, staged);
    },
    onClose: () => {
      log.closes++;
    },
  });
  return { screen, log };
}

const text = (screen, width = 80) => screen.render(width).join("\n");
const cursorLine = (screen, width = 80) => screen.render(width).find((line) => line.includes("▸ "));

test("initial render shows the title, group names and the cursor on the first row", () => {
  const rows = [numRow("threshold.5h", "한도", "5시간 임계치", { def: 90 }), numRow("mode", "캐시", "캐시 데우기")];
  const { screen } = open(rows, { values: { "threshold.5h": 1, mode: 1 } });
  const out = text(screen);
  assert.match(out, /keepalive 설정/);
  assert.match(out, /한도/);
  assert.match(out, /캐시/);
  assert.match(cursorLine(screen), /5시간 임계치/);
});

test("right arrow changes the value, marks it, and shows the unsaved count", () => {
  const rows = [numRow("threshold.5h", "한도", "5시간 임계치")];
  const { screen } = open(rows, { values: { "threshold.5h": 1 } });
  screen.handleInput("\x1b[C");
  assert.match(cursorLine(screen), /<2> \*/);
  assert.match(text(screen), /저장 안 된 변경 1건 · s 저장/);
});

test("s saves the changes and then shows 저장됨", () => {
  const rows = [numRow("threshold.5h", "한도", "5시간 임계치")];
  const { screen, log } = open(rows, { values: { "threshold.5h": 1 } });
  screen.handleInput("\x1b[C");
  screen.handleInput("s");
  assert.equal(log.saves.length, 1);
  assert.deepEqual(log.saves[0].changes, [{ id: "threshold.5h", value: 2 }]);
  assert.equal(log.saves[0].staged.get("threshold.5h"), 2);
  const out = text(screen);
  assert.match(out, /저장됨/);
  assert.doesNotMatch(out, /저장 안 된 변경/);
});

test("s without changes shows the info message and does not save", () => {
  const rows = [numRow("threshold.5h", "한도", "5시간 임계치")];
  const { screen, log } = open(rows, { values: { "threshold.5h": 1 } });
  screen.handleInput("s");
  assert.equal(log.saves.length, 0);
  assert.match(text(screen), /바뀐 것이 없습니다/);
});

test("an onSave error is shown and the baseline stays unchanged", () => {
  const rows = [numRow("threshold.5h", "한도", "5시간 임계치")];
  const { screen, log } = open(rows, { values: { "threshold.5h": 1 }, onSave: () => "boom" });
  screen.handleInput("\x1b[C");
  screen.handleInput("s");
  assert.match(text(screen), /boom/);
  assert.doesNotMatch(text(screen), /저장됨/);
  screen.handleInput("s");
  assert.equal(log.saves.length, 2);
  assert.deepEqual(log.saves[1].changes, [{ id: "threshold.5h", value: 2 }]);
});

test("q closes at once without changes, and needs two presses with changes", () => {
  const rows = [numRow("threshold.5h", "한도", "5시간 임계치")];
  const clean = open(rows, { values: { "threshold.5h": 1 } });
  clean.screen.handleInput("q");
  assert.equal(clean.log.closes, 1);

  const { screen, log } = open(rows, { values: { "threshold.5h": 1 } });
  screen.handleInput("\x1b[C");
  screen.handleInput("q");
  assert.equal(log.closes, 0);
  assert.match(text(screen), /한 번 더 누르면 버립니다/);
  screen.handleInput("j");
  screen.handleInput("q");
  assert.equal(log.closes, 0);
  screen.handleInput("\x1b");
  assert.equal(log.closes, 1);
});

test("linked rows update in the staged values", () => {
  const rows = [
    numRow("a.x", "한도", "A", { linked: (value) => ({ "b.y": value * 10 }) }),
    numRow("b.y", "캐시", "B"),
  ];
  const { screen, log } = open(rows, { values: { "a.x": 1, "b.y": 10 } });
  screen.handleInput("\x1b[C");
  screen.handleInput("s");
  assert.deepEqual(log.saves[0].changes, [
    { id: "a.x", value: 2 },
    { id: "b.y", value: 20 },
  ]);
});

test("render returns lines of exactly the requested width", () => {
  const rows = [
    numRow("threshold.5h", "한도", "5시간 임계치"),
    numRow("long", "캐시", "아주 아주 긴 이름의 항목입니다 가나다라마바사아자차카타파하"),
  ];
  const { screen } = open(rows, { values: { "threshold.5h": 1, long: 1 } });
  for (const width of [30, 200]) {
    for (const line of screen.render(width)) assert.equal(displayWidth(line), width);
  }
});

test("Korean labels align the value column", () => {
  const rows = [numRow("a", "한도", "가나"), numRow("b", "한도", "abc")];
  const { screen } = open(rows, { values: { a: 1, b: 2 } });
  const lines = screen.render(60);
  const columnOf = (label) => {
    const line = lines.find((l) => l.includes(label));
    return displayWidth(line.slice(0, line.indexOf("<")));
  };
  assert.equal(columnOf("가나"), columnOf("abc"));
});

test("focusId focuses the first prefixed row or an exact id", () => {
  const rows = [
    numRow("mode", "캐시", "캐시 데우기"),
    numRow("threshold.5h", "한도", "5시간 임계치"),
    numRow("threshold.7d", "한도", "7일 임계치"),
  ];
  const values = { mode: 1, "threshold.5h": 1, "threshold.7d": 1 };
  assert.match(cursorLine(open(rows, { values, focusId: "threshold" }).screen), /5시간 임계치/);
  assert.match(cursorLine(open(rows, { values, focusId: "threshold.7d" }).screen), /7일 임계치/);
});

test("scrolling keeps the cursor visible within maxRows", () => {
  const rows = Array.from({ length: 6 }, (_, i) => numRow(`item.${i}`, "한도", `item${i}`));
  const values = Object.fromEntries(rows.map((row) => [row.id, 1]));
  const { screen } = open(rows, { values, maxRows: 3 });
  for (let i = 0; i < 4; i++) screen.handleInput("j");
  const out = text(screen);
  assert.match(cursorLine(screen), /item4/);
  assert.match(out, /item2/);
  assert.doesNotMatch(out, /item0/);
});
