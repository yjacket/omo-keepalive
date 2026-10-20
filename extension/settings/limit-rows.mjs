import {
  formatDuration, formatDurationToken, formatOnOff, formatPercent,
  parseDuration, parseOnOff, parsePercent, withValue,
} from "./format.mjs";

const WAIT_STEPS = [0, 30, 60, 120, 180, 240, 300, 360, 480, 720, 1440];
const PROVIDERS = {
  claude: "anthropic-subscription",
  chatgpt: "chatgpt-subscription",
};

function thresholdRow(id, label, hint, key, usageKey, defaultValue) {
  return {
    id, group: "한도", label, hint, file: "keepalive", valueHelp: "1-100",
    read: (snap) => snap.keepalive.thresholds[key],
    defaultValue: () => defaultValue,
    steps: (snap) => withValue(Array.from({ length: 100 }, (_, i) => i + 1), snap.keepalive.thresholds[key]),
    format: (value, snap) => `${formatPercent(value)}${snap.usage[usageKey] == null ? "" : `  (지금 ${Math.round(snap.usage[usageKey])}%)`}`,
    toText: (value) => String(value),
    parse: parsePercent,
    suggestions: (snap) => withValue([50, 60, 70, 80, 85, 90, 95, 98, 100], snap.keepalive.thresholds[key]),
    apply: (draft, value) => {
      draft.thresholds = { ...draft.thresholds, [key]: value };
    },
  };
}

function waitRow(lane, provider, label, defaultValue) {
  const id = `wait.${lane}`;
  return {
    id, group: "한도", label,
    hint: "리셋이 이보다 늦으면 세션을 닫았다가 리셋 때 다시 엽니다",
    file: "keepalive", valueHelp: "0|30m|1h|2h|3h|4h|5h|6h|8h|12h|24h",
    read: (snap) => snap.keepalive.waitLimitMs[provider] / 60000,
    defaultValue: () => defaultValue,
    steps: (snap) => withValue(WAIT_STEPS, snap.keepalive.waitLimitMs[provider] / 60000),
    format: (value) => value === 0 ? "안 기다림" : `${formatDuration(value)}까지`,
    toText: formatDurationToken,
    parse: (text) => {
      const value = parseDuration(text);
      return value !== undefined && value >= 0 ? value : undefined;
    },
    apply: (draft, value) => {
      draft.waitLimitMs = { ...draft.waitLimitMs, [provider]: value * 60000 };
    },
  };
}

function parkWarmRow(lane, provider, label) {
  return {
    id: `park-warm.${lane}`, group: "한도", label,
    hint: "리셋을 기다리는 동안에도 캐시를 데워, 다시 시작할 때 캐시를 그대로 씁니다",
    file: "keepalive", valueHelp: "on|off",
    read: (snap) => snap.keepalive.warm[provider].on,
    defaultValue: () => true,
    steps: () => [true, false],
    format: formatOnOff,
    toText: (value) => value ? "on" : "off",
    parse: parseOnOff,
    apply: (draft, value) => {
      draft.warm = { ...draft.warm, [provider]: { ...draft.warm?.[provider], on: value } };
    },
  };
}

export function limitRows() {
  return [
    thresholdRow("threshold.5h", "5시간 임계치", "5시간 사용량이 이 값에 닿으면 한도 대기를 겁니다", "fiveHour", "five_hour", 90),
    thresholdRow("threshold.7d", "7일 임계치", "7일 사용량이 이 값에 닿으면 한도 대기를 겁니다", "sevenDay", "seven_day", 95),
    waitRow("claude", PROVIDERS.claude, "Claude 리셋 기다리기", 240),
    waitRow("chatgpt", PROVIDERS.chatgpt, "ChatGPT 리셋 기다리기", 120),
    parkWarmRow("claude", PROVIDERS.claude, "Claude 기다리는 동안 데우기"),
    parkWarmRow("chatgpt", PROVIDERS.chatgpt, "ChatGPT 기다리는 동안 데우기"),
  ];
}
