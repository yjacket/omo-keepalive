import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig, updateKeepaliveConfig } from "../config.mjs";
import { createConfigSource, updateConfig } from "../keepwarm/config.mjs";
import { laneDescriptors } from "../keepwarm/cli/expiry.mjs";
import { readJsonSafe } from "../keepwarm/fsx.mjs";
import { layout } from "../keepwarm/paths.mjs";
import { cacheRows } from "./cache-rows.mjs";
import { limitRows } from "./limit-rows.mjs";
import { warmRows, effectiveHabit } from "./warm-rows.mjs";
import { displayWidth, padCells } from "./text.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const HABIT_IDS = new Set(["habit", "habit.p", "habit.m", "habit.t90"]);
const USAGE_KINDS = ["five_hour", "seven_day"];

function usageFor(snapshots = []) {
  const usage = { five_hour: null, seven_day: null };
  for (const snapshot of snapshots) {
    for (const window of snapshot?.windows ?? []) {
      const kind = window?.kind ?? window?.window;
      const value = window?.utilization ?? window?.used_percent;
      if (USAGE_KINDS.includes(kind) && Number.isFinite(value)) {
        usage[kind] = usage[kind] === null ? value : Math.max(usage[kind], value);
      }
    }
  }
  return usage;
}

export function loadSnapshot({ env = process.env, homeDir = homedir(), keepwarmHome, snapshots = [], now = Date.now } = {}) {
  const keepalivePath = configPath({ env, homeDir });
  const loaded = loadConfig({ env, homeDir });
  const keepaliveReadable = !loaded.warnings.some((warning) =>
    warning.startsWith("config: unable to parse or read") || warning === "config: expected an object");
  const warmHome = keepwarmHome ?? env.OMO_KEEPWARM_HOME ?? join(homeDir, ".omo-keepwarm");
  const keepwarmPath = layout(warmHome).config;
  const keepwarmExists = existsSync(keepwarmPath);
  const rawWarm = keepwarmExists ? readJsonSafe(keepwarmPath) : undefined;
  const keepwarmReadable = !keepwarmExists || isObject(rawWarm);
  const source = createConfigSource({ home: warmHome, now });
  const keepwarm = source.get();
  return {
    keepalive: loaded.config,
    keepalivePath,
    keepaliveReadable,
    keepwarm,
    keepwarmPath,
    keepwarmExists,
    keepwarmReadable,
    habit: source.habit(),
    autoHabit: source.autoHabit(),
    lanes: laneDescriptors(keepwarm.lanes).filter(({ lane }) => lane.policy === "decide"),
    usage: usageFor(snapshots),
  };
}

export function settingRows(snap) {
  return [...limitRows(), ...cacheRows(), ...warmRows(snap)];
}

export function stagedFrom(rows, snap) {
  return new Map(rows.map((row) => [row.id, row.read(snap)]));
}

export function applyHabit(draft, staged, changedIds) {
  const changed = new Set(changedIds);
  if (changed.has("habit") && staged.get("habit") === "auto") {
    draft.habit = "auto";
    return;
  }
  if (![...HABIT_IDS].some((id) => changed.has(id))) return;
  const habit = isObject(draft.habit) ? { ...draft.habit } : {
    p: staged.get("habit.p"),
    medianMinutes: staged.get("habit.m"),
    t90Minutes: staged.get("habit.t90"),
  };
  if (changed.has("habit.p")) habit.p = staged.get("habit.p");
  if (changed.has("habit.m")) habit.medianMinutes = staged.get("habit.m");
  if (changed.has("habit.t90")) habit.t90Minutes = staged.get("habit.t90");
  if (!(habit.p > 0 && habit.p <= 1 && habit.medianMinutes > 0 && habit.medianMinutes < habit.t90Minutes)) {
    throw new Error("복귀 습관 값이 맞지 않습니다: 중앙값은 90% 복귀보다 짧아야 합니다");
  }
  draft.habit = habit;
}

export function saveChanges(options, snap, changes, staged) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const keepwarmHome = options.keepwarmHome ?? env.OMO_KEEPWARM_HOME ?? join(homeDir, ".omo-keepwarm");
  const rows = settingRows(snap);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const keepalive = changes.filter(({ id }) => byId.get(id)?.file === "keepalive");
  const keepwarm = changes.filter(({ id }) => byId.get(id)?.file === "keepwarm");
  const files = [];

  if (keepalive.length) {
    if (!snap.keepaliveReadable) return { error: `keepalive 설정 파일을 읽지 못해 저장하지 않았습니다: ${snap.keepalivePath}`, files };
    try {
      updateKeepaliveConfig({ env, homeDir }, (draft) => {
        for (const { id, value } of keepalive) byId.get(id).apply(draft, value, staged);
      });
      files.push("keepalive");
    } catch (error) {
      return { error: `keepalive 설정을 저장하지 못했습니다: ${error?.message ?? error}`, files };
    }
  }
  if (keepwarm.length) {
    if (!snap.keepwarmReadable) return { error: `캐시 설정 파일을 읽지 못해 저장하지 않았습니다: ${snap.keepwarmPath}`, files };
    try {
      const changedIds = keepwarm.map(({ id }) => id);
      updateConfig(keepwarmHome, (draft) => {
        for (const { id, value } of keepwarm) if (!HABIT_IDS.has(id)) byId.get(id).apply(draft, value, staged);
        applyHabit(draft, staged, changedIds);
      });
      files.push("keepwarm");
    } catch (error) {
      return { error: `캐시 설정을 저장하지 못했습니다: ${error?.message ?? error}`, files };
    }
  }
  return { files };
}

export function pathOf(row) {
  return row.id.replace(".", " ");
}

export function textListing(snap) {
  const rows = settingRows(snap);
  const groups = [...new Set(rows.map((row) => row.group))];
  const paths = rows.map(pathOf);
  const pw = Math.max(...paths.map(displayWidth));
  const lw = Math.max(...rows.map((row) => displayWidth(row.label)));
  const lines = ["keepalive 설정 · 바꾸기: /keepalive set <항목> <값>"];
  for (const group of groups) {
    lines.push(group);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.group !== group) continue;
      lines.push(`  ${padCells(paths[i], pw)}  ${padCells(row.label, lw)}  ${row.format(row.read(snap), snap, new Map())}`);
    }
  }
  return lines.join("\n");
}

export function findRow(rows, tokens) {
  const row = rows
    .filter((candidate) => {
      const parts = candidate.id.split(".");
      return parts.length <= tokens.length && parts.every((part, index) => part === tokens[index]);
    })
    .sort((a, b) => b.id.split(".").length - a.id.split(".").length)[0];
  if (row) return { row, valueText: tokens.slice(row.id.split(".").length).join(" ") };
  const prefixRows = rows.filter((candidate) =>
    candidate.id.split(".").slice(0, tokens.length).every((part, index) => part === tokens[index])
    && tokens.length <= candidate.id.split(".").length,
  );
  return { row: null, prefixRows };
}

export function setByText(io, snap, tokens) {
  const rows = settingRows(snap);
  const found = findRow(rows, tokens);
  if (!found.row) return { ok: false, message: `keepalive: 모르는 설정입니다: ${tokens.join(" ")}`, files: [] };
  const { row, valueText } = found;
  const value = row.parse(valueText);
  if (value === undefined) {
    return { ok: false, message: `keepalive: ${row.label}에 쓸 수 없는 값입니다: ${valueText} (${row.valueHelp})`, files: [] };
  }
  const saved = stagedFrom(rows, snap);
  const staged = new Map(saved);
  staged.set(row.id, value);
  for (const [id, linked] of Object.entries(row.linked?.(value, snap, staged) ?? {})) {
    if (staged.has(id)) staged.set(id, linked);
  }
  // The row itself plus what its linked rules moved, like a save from the screen.
  const changes = rows.filter((r) => r.id === row.id || staged.get(r.id) !== saved.get(r.id))
    .map((r) => ({ id: r.id, value: staged.get(r.id) }));
  const result = saveChanges(io, snap, changes, staged);
  return result.error
    ? { ok: false, message: result.error, files: result.files }
    : { ok: true, message: `keepalive: ${row.label} ${row.format(value, snap, staged)}`, files: result.files };
}

function autocomplete(value, label, description) {
  return { value, label, description };
}

export function completions(prefix, snap) {
  const text = String(prefix ?? "");
  const trailing = /\s$/.test(text);
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const current = trailing ? "" : (tokens.pop() ?? "");
  if (tokens.length === 0) {
    const commands = [
      ["status", "화면 보기"], ["resume", "한도 대기 풀고 재개"], ["park", "지금 한도 대기"],
      ["off", "이 세션에서 끄기"], ["on", "이 세션에서 켜기"], ["set", "설정 화면 / 설정 바꾸기"],
    ];
    const matches = commands.filter(([value]) => value.startsWith(current))
      .map(([value, description]) => autocomplete(value, value, description));
    return matches.length ? matches : null;
  }
  if (tokens[0] !== "set") return null;
  const rows = settingRows(snap);
  const staged = stagedFrom(rows, snap);
  const typed = tokens.slice(1);
  const items = new Map();
  const add = (label, description) => {
    const value = `set ${[...typed, label].join(" ")}`;
    if (label.startsWith(current) && !items.has(value)) items.set(value, autocomplete(value, label, description));
  };
  // Values of the row whose whole path is typed, then the next path segments below it.
  const row = rows.find((r) => r.id === typed.join("."));
  if (row) {
    for (const value of (row.suggestions?.(snap) ?? row.steps(snap, staged)).slice(0, 12)) add(row.toText(value), row.format(value, snap, staged));
  }
  for (const r of rows) {
    const parts = r.id.split(".");
    if (parts.length <= typed.length || !typed.every((t, i) => parts[i] === t)) continue;
    const segment = parts[typed.length];
    const path = [...typed, segment].join(".");
    const leaf = !rows.some((x) => x.id.startsWith(`${path}.`));
    const exact = rows.find((x) => x.id === path);
    const now = exact ? exact.format(exact.read(snap), snap, staged) : "";
    add(segment, leaf && exact ? (exact.label === segment ? now : `${exact.label} · ${now}`) : r.group);
  }
  return items.size ? [...items.values()] : null;
}
