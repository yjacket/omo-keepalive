import { stepValue } from "./format.mjs";
import { decodeKey } from "./keys.mjs";
import { displayWidth, fitCells, padCells } from "./text.mjs";

const HELP = ["↑↓ 이동", "←→ 바꾸기", "r 기본값", "s 저장", "q 닫기"];
const LABEL_MAX = 28;

export class SettingsScreen {
  constructor(theme, { rows, snap, focusId, maxRows = 14, keybindings, onSave, onClose }) {
    this.theme = theme;
    this.rows = rows;
    this.snap = snap;
    this.maxRows = maxRows;
    this.keybindings = keybindings;
    this.onSave = onSave;
    this.onClose = onClose;
    this.staged = new Map(rows.map((row) => [row.id, row.read(snap)]));
    this.baseline = new Map(this.staged);
    const exact = rows.findIndex((row) => row.id === focusId);
    const prefix = rows.findIndex((row) => row.id.startsWith(`${focusId}.`));
    this.cursor = exact >= 0 ? exact : prefix >= 0 ? prefix : 0;
    this.scroll = 0;
    this.message = undefined;
    this.savedMessage = false;
    this.pendingClose = false;
  }

  changes() {
    return this.rows
      .filter((row) => this.staged.get(row.id) !== this.baseline.get(row.id))
      .map((row) => ({ id: row.id, value: this.staged.get(row.id) }));
  }

  setValue(row, value) {
    this.staged.set(row.id, value);
    this.savedMessage = false;
    const linked = row.linked?.(value, this.snap, this.staged) ?? {};
    for (const [id, linkedValue] of Object.entries(linked)) {
      if (this.staged.has(id)) this.staged.set(id, linkedValue);
    }
  }

  step(dir, options) {
    const row = this.rows[this.cursor];
    const current = this.staged.get(row.id);
    const next = stepValue(row.steps(this.snap, this.staged), current, dir, options);
    if (next !== current) this.setValue(row, next);
  }

  save() {
    const changes = this.changes();
    if (changes.length === 0) {
      this.message = { text: "바뀐 것이 없습니다", tone: "info" };
      return;
    }
    const error = this.onSave(changes, new Map(this.staged));
    if (error === undefined) {
      this.baseline = new Map(this.staged);
      this.savedMessage = true;
      this.message = undefined;
    } else this.message = { text: error, tone: "error" };
  }

  handleInput(data) {
    const key = decodeKey(data, this.keybindings);
    if (key === undefined) return;
    this.message = undefined;
    const last = this.rows.length - 1;
    switch (key) {
      case "up":
      case "k":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "down":
      case "j":
        this.cursor = Math.min(last, this.cursor + 1);
        break;
      case "pageUp":
        this.cursor = Math.max(0, this.cursor - (this.maxRows - 1));
        break;
      case "pageDown":
        this.cursor = Math.min(last, this.cursor + (this.maxRows - 1));
        break;
      case "home":
        this.cursor = 0;
        break;
      case "end":
        this.cursor = last;
        break;
      case "left":
      case "h":
        this.step(-1);
        break;
      case "right":
      case "l":
        this.step(1);
        break;
      case "enter":
      case "space":
        this.step(1, { wrap: true });
        break;
      case "r": {
        const row = this.rows[this.cursor];
        const value = row.defaultValue(this.snap);
        if (value !== this.staged.get(row.id)) this.setValue(row, value);
        break;
      }
      case "s":
        this.save();
        break;
      case "q":
      case "escape":
        if (this.pendingClose || this.changes().length === 0) this.onClose();
        else this.pendingClose = true;
        return;
      default:
        break;
    }
    this.pendingClose = false;
  }

  invalidate() {}

  render(width) {
    const { theme } = this;
    const boxed = width >= 20;
    const inner = Math.max(1, width - (boxed ? 4 : 0));
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + this.maxRows) this.scroll = this.cursor - this.maxRows + 1;
    const end = Math.min(this.rows.length, this.scroll + this.maxRows);
    // A narrow overlay gives the label column at most half the row, so the values stay readable.
    const labelWidth = Math.min(LABEL_MAX, Math.max(...this.rows.map((row) => displayWidth(row.label))), Math.max(6, Math.floor((inner - 4) / 2)));

    const lines = [padCells(theme.bold(theme.fg("accent", "keepalive 설정")), inner)];
    let group;
    for (let i = this.scroll; i < end; i++) {
      const row = this.rows[i];
      if (row.group !== group) {
        group = row.group;
        lines.push(padCells(theme.bold(row.group), inner));
      }
      const value = this.staged.get(row.id);
      const changed = value !== this.baseline.get(row.id);
      const cursor = i === this.cursor;
      let line = padCells(
        `${cursor ? "▸ " : "  "}${padCells(row.label, labelWidth)}  ${row.format(value, this.snap, this.staged)}${changed ? " *" : ""}`,
        inner,
      );
      if (cursor) line = theme.bold(theme.fg("accent", line));
      lines.push(line);
    }

    const focused = this.rows[this.cursor];
    lines.push(padCells(theme.fg("dim", fitCells(focused.hint, inner)), inner));

    const changedCount = this.changes().length;
    let status = "";
    if (this.pendingClose) status = theme.fg("warning", "저장 안 된 변경이 있습니다 · 한 번 더 누르면 버립니다");
    else if (this.message) status = theme.fg(this.message.tone === "error" ? "error" : "dim", this.message.text);
    else if (changedCount > 0) status = theme.fg("warning", `저장 안 된 변경 ${changedCount}건 · s 저장`);
    else if (this.savedMessage) status = theme.fg("success", "저장됨");
    lines.push(padCells(status, inner));

    let help = "";
    for (const item of HELP) {
      const fitted = fitCells(item, inner);
      if (help && displayWidth(help) + 3 + displayWidth(fitted) > inner) {
        lines.push(padCells(theme.fg("dim", help), inner));
        help = fitted;
      } else help += `${help ? " · " : ""}${fitted}`;
    }
    lines.push(padCells(theme.fg("dim", help), inner));

    if (!boxed) return lines.map((line) => padCells(line, width));
    const border = (s) => theme.fg("border", s);
    const top = `┌${"─".repeat(inner + 2)}┐`;
    const bottom = `└${"─".repeat(inner + 2)}┘`;
    return [
      top,
      ...lines.map((line) => `${border("│")} ${padCells(line, inner)} ${border("│")}`),
      bottom,
    ].map((line) => padCells(line, width));
  }
}
