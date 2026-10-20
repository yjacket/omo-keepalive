import {
  formatDuration, formatDurationToken, formatOnOff, formatUsd,
  parseDuration, parseOnOff, parseUsd,
} from "./format.mjs";

const HOLD_STEPS = [30, 60, 90, 120, 180, 240, 360, 480, 720, 1080, 1440];
const DAY_STEPS = [0, 0.5, 1, 2, 3, 5, 10, 20, 50];
const EPISODE_STEPS = [0, 0.1, 0.25, 0.5, 1, 2, 5];
const numberText = (value) => String(value);
const withNumericValue = (steps, value) => [...new Set([...steps, value])].sort((a, b) => a - b);
const valueOr = (value, fallback) => value === undefined ? fallback : value;

const rows = [
  {
    id: "mode", group: "캐시", label: "캐시 데우기",
    hint: "켜짐은 ping을 보내고, 기록만은 판단만 남깁니다",
    file: "keepwarm", valueHelp: "on|shadow|off",
    read: (snap) => snap.keepwarm.mode,
    defaultValue: () => "off",
    steps: () => ["on", "shadow", "off"],
    format: (value) => ({ on: "켜짐", shadow: "기록만", off: "꺼짐" })[value],
    toText: (value) => value,
    parse: (text) => ["on", "shadow", "off"].includes(text) ? text : undefined,
    apply: (draft, value) => { draft.mode = value; },
  },
  {
    id: "backstop", group: "캐시", label: "goal backstop 붙잡기",
    hint: "데우는 동안 senpi의 한 시간 backstop을 붙잡습니다",
    file: "keepwarm", valueHelp: "on|off",
    read: (snap) => snap.keepwarm.backstop,
    defaultValue: () => "on",
    steps: () => ["on", "off"],
    format: (value) => formatOnOff(value === "on"),
    toText: (value) => value,
    parse: (text) => { const value = parseOnOff(text); return value === undefined ? undefined : value ? "on" : "off"; },
    apply: (draft, value) => { draft.backstop = value; },
  },
  {
    id: "hold", group: "캐시", label: "goal 기다릴 때 데우기",
    hint: "goal이 무언가를 기다리는 동안 캐시를 데우고 backstop을 붙잡아 두는 최대 시간입니다",
    file: "keepwarm", valueHelp: "30-1440m",
    read: (snap) => snap.keepwarm.maxHoldMinutes,
    defaultValue: () => 360,
    steps: (snap) => withNumericValue(HOLD_STEPS, snap.keepwarm.maxHoldMinutes),
    format: (value) => `${formatDuration(value)}까지`,
    toText: (value) => formatDurationToken(value),
    parse: (text) => {
      const value = parseDuration(text);
      return Number.isInteger(value) && value >= 30 && value <= 1440 ? value : undefined;
    },
    apply: (draft, value) => { draft.maxHoldMinutes = value; },
  },
  {
    id: "usd.day", group: "캐시", label: "하루 비용 상한",
    hint: "API 키로 데울 때 하루 ping 비용이 이 값을 넘으면 데우기를 멈춥니다",
    file: "keepwarm", valueHelp: ">=0",
    read: (snap) => snap.keepwarm.maxUsdPerDay,
    defaultValue: () => 3,
    steps: (snap) => withNumericValue(DAY_STEPS, snap.keepwarm.maxUsdPerDay),
    format: (value) => formatUsd(value),
    toText: numberText,
    parse: parseUsd,
    apply: (draft, value) => { draft.maxUsdPerDay = value; },
  },
  {
    id: "usd.episode", group: "캐시", label: "자리 비울 때마다 비용 상한",
    hint: "자리를 한 번 비울 때마다 API 키로 데우는 ping 비용의 상한입니다",
    file: "keepwarm", valueHelp: ">=0",
    read: (snap) => snap.keepwarm.maxUsdPerEpisode,
    defaultValue: () => 0.5,
    steps: (snap) => withNumericValue(EPISODE_STEPS, snap.keepwarm.maxUsdPerEpisode),
    format: (value) => formatUsd(value),
    toText: numberText,
    parse: parseUsd,
    apply: (draft, value) => { draft.maxUsdPerEpisode = value; },
  },
];

export function cacheRows() {
  return rows.map((row) => ({
    ...row,
    read: (snap) => valueOr(row.read(snap), row.defaultValue(snap)),
    steps: (snap, staged) => row.steps(snap, staged),
  }));
}
