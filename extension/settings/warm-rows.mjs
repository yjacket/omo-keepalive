import { laneDescriptors, parseDuration } from "../keepwarm/cli/expiry.mjs";
import { expirySettingFor } from "../keepwarm/config.mjs";
import { resolveExpiry } from "../keepwarm/policy.mjs";
import { formatDuration, formatDurationToken, withValue } from "./format.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const habitGridM = [1, 2, 3, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
const habitGridT90 = [10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
const habitApply = () => {};
const stagedValue = (staged, id, fallback) => staged instanceof Map && staged.has(id) ? staged.get(id) : fallback;

export function effectiveHabit(snap, staged = new Map()) {
  if (stagedValue(staged, "habit", isObject(snap.keepwarm?.habit) ? "manual" : "auto") === "auto") {
    return snap.autoHabit;
  }
  return {
    p: stagedValue(staged, "habit.p", snap.habit.p),
    mMin: stagedValue(staged, "habit.m", snap.habit.mMin),
    t90Min: stagedValue(staged, "habit.t90", snap.habit.t90Min),
    source: "manual",
  };
}

function habitRow(id, label, hint, read, defaultValue, steps, format, parse, linked) {
  return {
    id, group: "복귀 습관", label, hint, file: "keepwarm",
    valueHelp: ({
      habit: "auto|manual",
      "habit.p": "0.05-1 or 5%-100%",
      "habit.m": "duration < 90% return, e.g. 10m, 1h",
      "habit.t90": "duration > median, e.g. 2h, 3h",
    })[id],
    read, defaultValue, steps, format,
    toText: id === "habit" ? (value) => value : id === "habit.p" ? String : formatDurationToken,
    parse, linked, apply: habitApply,
  };
}

export function warmRows(snap) {
  const lanes = snap.lanes ?? laneDescriptors(snap.keepwarm?.lanes).filter(({ lane }) => lane.policy === "decide");
  const expiryRows = lanes.map(({ key, lane }) => ({
    id: `expiry.${key}`,
    group: "데우는 시간",
    label: key,
    hint: "자리를 비운 뒤 이 lane을 데우는 최대 시간입니다. 자동은 복귀 습관으로 계산합니다",
    file: "keepwarm",
    valueHelp: `auto|${lane.grid.map(formatDurationToken).join("|")}`,
    read: (s) => expirySettingFor(s.keepwarm?.expiry, lane),
    defaultValue: () => "auto",
    steps: (s) => {
      const read = expirySettingFor(s.keepwarm?.expiry, lane);
      return ["auto", ...(typeof read === "number" ? withValue(lane.grid, read) : lane.grid)];
    },
    format: (value, s, staged) => value === "auto"
      ? `자동 (${formatDuration(resolveExpiry({ lane, habit: effectiveHabit(s, staged), setting: "auto" }).effectiveMin)})`
      : value === 0 ? "0 (안 데움)" : formatDuration(value),
    toText: (value) => typeof value === "string" ? value : formatDurationToken(value),
    parse: (text) => {
      if (typeof text !== "string") return undefined;
      if (text.trim().toLowerCase() === "auto") return "auto";
      const value = parseDuration(text);
      return Number.isFinite(value) && lane.grid.includes(value) ? value : undefined;
    },
    apply: (draft, value) => { draft.expiry = { ...draft.expiry, [key]: value }; },
  }));

  const habit = habitRow(
    "habit", "방식", "자동은 기록으로 배운 습관(없으면 기본값)을 씁니다",
    (s) => isObject(s.keepwarm?.habit) ? "manual" : "auto", () => "auto", () => ["auto", "manual"],
    (value) => value === "manual" ? "직접" : "자동",
    (text) => text === "auto" || text === "manual" ? text : undefined,
    (value, s) => value === "auto"
      ? { "habit.p": s.autoHabit.p, "habit.m": s.autoHabit.mMin, "habit.t90": s.autoHabit.t90Min }
      : {},
  );
  const p = habitRow(
    "habit.p", "돌아오는 비율", "자리를 비운 뒤 결국 돌아오는 비율입니다",
    (s) => s.habit.p, (s) => s.autoHabit.p,
    (s) => withValue(Array.from({ length: 20 }, (_, i) => Number(((i + 1) * 0.05).toFixed(2))), s.habit.p),
    (value) => `${Math.round(value * 100)}%`,
    (text) => {
      if (typeof text !== "string") return undefined;
      const m = /^\s*(\d+(?:\.\d+)?)%?\s*$/.exec(text);
      const value = m ? Number(m[1]) / (text.includes("%") ? 100 : 1) : NaN;
      return value > 0 && value <= 1 ? value : undefined;
    },
    () => ({ habit: "manual" }),
  );
  const m = habitRow(
    "habit.m", "복귀 중앙값", "돌아오는 사람의 절반이 이 시간 안에 돌아옵니다",
    (s) => s.habit.mMin, (s) => s.autoHabit.mMin,
    (s, staged) => withValue(habitGridM, s.habit.mMin)
      .filter((value) => value < stagedValue(staged, "habit.t90", s.habit.t90Min)),
    formatDuration,
    (text) => { const value = parseDuration(text); return Number.isFinite(value) && value > 0 ? value : undefined; },
    (value, s, staged) => {
      const changes = { habit: "manual" };
      if (value >= stagedValue(staged, "habit.t90", s.habit.t90Min)) {
        const next = withValue(habitGridT90, s.habit.t90Min).find((step) => step > value);
        if (next !== undefined) changes["habit.t90"] = next;
      }
      return changes;
    },
  );
  const t90 = habitRow(
    "habit.t90", "90% 복귀", "돌아오는 사람의 90%가 이 시간 안에 돌아옵니다",
    (s) => s.habit.t90Min, (s) => s.autoHabit.t90Min,
    (s, staged) => withValue(habitGridT90, s.habit.t90Min)
      .filter((value) => value > stagedValue(staged, "habit.m", s.habit.mMin)),
    formatDuration,
    (text) => { const value = parseDuration(text); return Number.isFinite(value) && value > 0 ? value : undefined; },
    (value, s, staged) => {
      const changes = { habit: "manual" };
      if (value <= stagedValue(staged, "habit.m", s.habit.mMin)) {
        const below = withValue(habitGridM, s.habit.mMin).filter((step) => step < value);
        if (below.length) changes["habit.m"] = below.at(-1);
      }
      return changes;
    },
  );
  return [...expiryRows, habit, p, m, t90];
}
