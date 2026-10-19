// The /keepalive screen: three groups (한도, 캐시, 기록), usage as bars, and forecasts made from the measurements.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createConfigSource } from "./keepwarm/config.mjs";
import { readJsonLines } from "./keepwarm/fsx.mjs";
import { layout, localDate, localMonth } from "./keepwarm/paths.mjs";
import { returnCdf } from "./keepwarm/policy.mjs";
import { buildReport } from "./keepwarm/report.mjs";
import { holdWord } from "./keepwarm/summary.mjs";

const WINDOW_NAME = { five_hour: "5시간", seven_day: "7일" };
const THRESHOLD_KEY = { five_hour: "fiveHour", seven_day: "sevenDay" };
const BAR_CELLS = 20;
const FORECAST_SPAN_MS = 60 * 60_000;
const FORECAST_MIN_SPAN_MS = 10 * 60_000;

// Why warming stopped, in one or two words.
const STOP_WORD = {
  expired: "시간 끝", cache_miss: "캐시 놓침", small_context: "맥락 작음", expiry_zero: "시간 0", cache_cold_at_open: "이미 식음",
  no_refresh_anchor: "기준 없음", lane_off: "대상 아님", lane_invalid: "대상 아님", no_warm_path: "대상 아님", unverified: "대상 아님",
  duplicate_warmer: "중복", prefix_change: "맥락 바뀜", model_change: "모델 바뀜", effort_change: "모델 바뀜", lane_change: "모델 바뀜",
  compacting: "정리 중", episode_request_cap: "횟수 끝", episode_usd_cap: "상한", daily_cap: "상한", last_turn_error: "오류 뒤",
  last_turn_aborted: "취소 뒤", aborted: "취소", timeout: "실패", provider_error: "실패", auth: "실패", unsupported: "실패",
  rate_limit: "실패", prefix_mismatch: "맥락 바뀜", no_prefix: "기준 없음", context_unknown: "맥락 모름", config_off: "꺼짐",
  session_parked: "세션 닫힘", clock_anomaly: "시계 이상", late_tick: "늦음", internal_error: "실패",
  no_sdk_binding: "기준 없음", prefix_unsafe: "다른 확장",
};

// Why the wait for the next turn is not warming yet, from the snapshot's goalWait.
const GOAL_WAIT_WORD = {
  not_worth_it: "이득 없음", context_unknown: "맥락 모름", lane_off: "대상 아님", unverified: "대상 아님",
  no_warm_path: "대상 아님", mode_off: "꺼짐", max_hold: "시간 끝", pending: "준비 중",
};

// Display cells in a terminal: Hangul, CJK and emoji take two.
export function cells(text) {
  let n = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(text)) {
    const first = segment.codePointAt(0);
    const wide = (first >= 0x1100 && first <= 0x115f) || (first >= 0x2e80 && first <= 0xa4cf)
      || (first >= 0xac00 && first <= 0xd7a3) || (first >= 0xf900 && first <= 0xfaff)
      || (first >= 0xfe30 && first <= 0xfe4f) || (first >= 0xff00 && first <= 0xff60);
    const emoji = /\p{Extended_Pictographic}/u.test(segment)
      && (segment.includes("\ufe0f") || first >= 0x1f000);
    n += wide || emoji ? 2 : 1;
  }
  return n;
}
const pad = (text, width) => text + " ".repeat(Math.max(0, width - cells(text)));

export function bar(percent, width = BAR_CELLS) {
  const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "█".repeat(full) + "░".repeat(width - full);
}

export function tokens(n) {
  if (!(n > 0)) return "0";
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 100) / 10}K`;
  return String(Math.round(n));
}

export function duration(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h}시간` : `${h}시간 ${min % 60}분`;
}

// When the window reaches the threshold at the rate of the last hour; null without enough rise to tell.
export function forecastThreshold(history, kind, threshold, nowMs) {
  const points = (history ?? []).filter((e) => Number.isFinite(e?.util?.[kind]) && nowMs - e.t <= FORECAST_SPAN_MS && e.t <= nowMs);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points.at(-1);
  if (last.t - first.t < FORECAST_MIN_SPAN_MS || last.util[kind] >= threshold) return null;
  const rate = (last.util[kind] - first.util[kind]) / (last.t - first.t);
  if (!(rate > 0)) return null;
  return last.t + (threshold - last.util[kind]) / rate;
}

// Chance the user returns while warming still runs, given they have not returned yet.
export function returnChance(habit, awayMin, endMin) {
  if (!habit || !(endMin > awayMin)) return null;
  const now = returnCdf(awayMin, habit);
  if (now >= 1) return null;
  return Math.max(0, Math.min(1, (returnCdf(endMin, habit) - now) / (1 - now)));
}

function todayPings(home, nowMs) {
  const dir = layout(home).recordsDir;
  const today = localDate(nowMs);
  let sent = 0;
  let hits = 0;
  let files;
  try {
    files = readdirSync(join(dir, localMonth(nowMs)));
  } catch {
    return { sent, hits };
  }
  for (const f of files) {
    for (const r of readJsonLines(join(dir, localMonth(nowMs), f))) {
      if (r?.type !== "ping" || localDate(Date.parse(r.ts)) !== today) continue;
      sent += 1;
      if (r.ok && r.hit) hits += 1;
    }
  }
  return { sent, hits };
}

function limitLines({ state, config, now, hhmm, statusText }) {
  const lines = [];
  const parked = state.parkState === "park-wait" || state.parkState === "park-exit";
  let head;
  if (state.mode === "off") head = "⏹ 꺼짐 (이 세션)";
  // The same words as the status line, plus how long until the resume.
  else if (parked) head = Number.isFinite(state.resetAt) && state.resetAt > now ? `${statusText} (${duration(state.resetAt - now)} 뒤)` : statusText;
  else head = "🔄 감시 중";
  lines.push(`한도  ${head}`);
  const windows = new Map();
  for (const s of state.snapshots ?? []) {
    for (const w of s?.windows ?? []) {
      const kind = w?.kind ?? w?.window;
      const util = w?.utilization ?? w?.used_percent;
      if (!WINDOW_NAME[kind] || !Number.isFinite(util)) continue;
      if (!windows.has(kind) || util > windows.get(kind).util) windows.set(kind, { util, resetAt: w.resetAt });
    }
  }
  const nameWidth = Math.max(0, ...[...windows.keys()].map((k) => cells(WINDOW_NAME[k])));
  for (const kind of ["five_hour", "seven_day"]) {
    const w = windows.get(kind);
    if (!w) continue;
    const reset = Number.isFinite(w.resetAt) ? `  리셋 ${hhmm(w.resetAt)}` : "";
    lines.push(`      ${pad(WINDOW_NAME[kind], nameWidth)} ${bar(w.util)} ${pad(`${Math.round(w.util)}%`, 4)}${reset}`);
  }
  if (!parked && state.mode !== "off") {
    for (const kind of ["five_hour", "seven_day"]) {
      const threshold = config.thresholds?.[THRESHOLD_KEY[kind]];
      const eta = forecastThreshold(state.usageHistory, kind, threshold, now);
      const reset = windows.get(kind)?.resetAt;
      if (eta === null || (Number.isFinite(reset) && eta >= reset)) continue;
      lines.push(`      예측  이 속도면 ${WINDOW_NAME[kind]} ${threshold}% 도달 ${hhmm(eta)}`);
      break;
    }
  }
  return lines;
}

function cacheLines({ home, snap, now, hhmm, parked, inert, backstop = null }) {
  const config = createConfigSource({ home, now: () => now });
  if (!config.exists(true) || config.get().mode === "off") return ["캐시  🩵 꺼짐"];
  if (config.get().mode === "shadow") return ["캐시  🩵 판단만 기록"];
  if (inert) return ["캐시  🩵 다른 인스턴스"];
  const s = snap ?? {};
  const hold = s.limitHold ?? null;
  const verdict = holdWord(hold);
  const warming = s.phase === "ARMED" || s.phase === "PINGING";
  const next = Number.isFinite(s.nextTickMs) ? ` · 다음 ping ${hhmm(s.nextTickMs)}` : "";
  let head;
  let forecast = null;
  const backstopLine = backstop?.tripped ? "      대기  backstop 그대로 · senpi 바뀜"
    : backstop?.holding ? "      대기  backstop 멈춤 · 확인은 omo-health" : null;
  if (parked && hold && verdict && verdict !== "warm") {
    head = `🩵 ${verdict}`;
  } else if (s.goalWait) {
    head = s.goalWait.warm && warming
      ? `❤️‍🔥 다음 턴까지${next}`
      : `🩵 ${GOAL_WAIT_WORD[s.goalWait.reason] ?? STOP_WORD[s.goalWait.reason] ?? "멈춤"}`;
  } else if (warming) {
    const until = parked && hold ? "재개까지"
      : Number.isFinite(s.awayStartMs) && Number.isFinite(s.E) ? `${hhmm(s.awayStartMs + s.E * 60_000)}까지` : null;
    head = `❤️‍🔥 ${until ? `${until}${next}` : Number.isFinite(s.nextTickMs) ? `다음 ping ${hhmm(s.nextTickMs)}` : "다음 ping 미정"}`;
    if (!parked && Number.isFinite(s.awayStartMs) && Number.isFinite(s.E)) {
      const chance = returnChance(s.habit, (now - s.awayStartMs) / 60_000, s.E);
      if (chance !== null) forecast = `그 안에 돌아올 확률 ${Math.round(chance * 100)}%`;
    }
  } else if (s.phase === "OBSERVING") head = `🩵 ${STOP_WORD[s.reason] ?? s.reason ?? "멈춤"}`;
  else if (["PAUSED", "BUSY", "CLASSIFYING"].includes(s.phase)) head = "🩵 작업 중";
  else head = s.reason ? `🩵 ${STOP_WORD[s.reason] ?? s.reason}` : "🩵 준비 중";
  const lines = forecast ? [`캐시  ${head}`, `      예측  ${forecast}`] : [`캐시  ${head}`];
  if (backstopLine) lines.push(backstopLine);
  return lines;
}

function recordLines({ home, now }) {
  const today = todayPings(home, now);
  const day = buildReport(home, { days: 1, now }).total;
  const week = buildReport(home, { days: 7, now }).total;
  return [
    `기록  오늘 ping ${today.sent} · 적중 ${today.hits} · 아낌 ${tokens(day.savedWriteTokens)}`,
    `      7일 식은 복귀 ${week.coldWithoutWarm}/${week.humanReturns} · 아낌 ${tokens(week.savedWriteTokens)}`,
  ];
}

export function renderPanel({ state, config, home, snapshot, now, hhmm, statusText, inert = false, backstop = null }) {
  const parked = state.parkState === "park-wait";
  return [
    ...limitLines({ state, config, now, hhmm, statusText }),
    ...cacheLines({ home, snap: snapshot, now, hhmm, parked, inert, backstop }),
    ...recordLines({ home, now }),
  ].join("\n");
}
