import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { updateConfig } from "../extension/keepwarm/config.mjs";
import { cells, renderPanel } from "../extension/panel.mjs";

const now = new Date(2026, 8, 14, 12).getTime();
const hhmm = (ms) => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

function panel({ mode = "on", snapshot, parked = false, inert = false, home, state = {}, backstop = null } = {}) {
  if (mode !== null) updateConfig(home, (config) => { config.mode = mode; });
  return renderPanel({
    state: { parkState: parked ? "park-wait" : "active", snapshots: [], ...state },
    config: { thresholds: {} }, home, snapshot, now, hhmm, statusText: "대기", inert, backstop,
  });
}

const cacheLine = (output) => output.split("\n").find((line) => line.startsWith("캐시"));

test("cache first line precedence covers config, mode, inert, hold and phases", (t) => {
  const home = mkdtempSync(join(tmpdir(), "panel-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cases = [
    ["missing config", { mode: null }, "캐시  🩵 꺼짐"],
    ["off mode", { mode: "off" }, "캐시  🩵 꺼짐"],
    ["shadow mode", { mode: "shadow", inert: true }, "캐시  🩵 판단만 기록"],
    ["inert", { inert: true }, "캐시  🩵 다른 인스턴스"],
    ["parked forbidden hold", { parked: true, snapshot: { limitHold: { warm: false, reason: "policy" } } }, "캐시  🩵 한도 임박"],
    ["parked verdict hold", { parked: true, snapshot: { limitHold: { warm: true, verdict: { why: "not_worth_it" } } } }, "캐시  🩵 이득 없음"],
    ["armed", { snapshot: { phase: "ARMED", awayStartMs: now, E: 60, nextTickMs: now + 5 * 60_000 } }, "캐시  ❤️‍🔥 13:00까지 · 다음 ping 12:05"],
    ["parked warming", { parked: true, snapshot: { phase: "PINGING", limitHold: { warm: true, verdict: { why: "worth_it" } } } }, "캐시  ❤️‍🔥 재개까지"],
    ["unknown deadline", { snapshot: { phase: "ARMED" } }, "캐시  ❤️‍🔥 다음 ping 미정"],
    ["observing mapped reason", { snapshot: { phase: "OBSERVING", reason: "expired" } }, "캐시  🩵 시간 끝"],
    ["observing unknown reason", { snapshot: { phase: "OBSERVING", reason: "unknown_reason" } }, "캐시  🩵 unknown_reason"],
    ["paused", { snapshot: { phase: "PAUSED" } }, "캐시  🩵 작업 중"],
    ["busy", { snapshot: { phase: "BUSY" } }, "캐시  🩵 작업 중"],
    ["classifying", { snapshot: { phase: "CLASSIFYING" } }, "캐시  🩵 작업 중"],
    ["held", { snapshot: { phase: "HELD" } }, "캐시  🩵 준비 중"],
    ["held with a disabled segment", { snapshot: { phase: "HELD", reason: "expiry_zero" } }, "캐시  🩵 시간 0"],
    ["detached", { snapshot: { phase: "DETACHED" } }, "캐시  🩵 준비 중"],
    ["inert phase", { snapshot: { phase: "INERT" } }, "캐시  🩵 준비 중"],
    ["undefined phase", {}, "캐시  🩵 준비 중"],
  ];
  for (const [name, options, expected] of cases) {
    const output = panel({ home, ...options });
    assert.equal(output.split("\n").find((line) => line.startsWith("캐시")), expected, name);
    assert.doesNotMatch(output, /데움/, name);
  }
});

test("parked warming has no prediction and idle warming shows return chance", (t) => {
  const home = mkdtempSync(join(tmpdir(), "panel-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const habit = { p: 0.81, mMin: 10.5, t90Min: 140 };
  const parked = panel({
    home, parked: true,
    snapshot: { phase: "ARMED", limitHold: { warm: true, verdict: { why: "worth_it" } }, contextTokens: 1000, awayStartMs: now, E: 60, habit },
  });
  assert.ok(!parked.split("\n").some((line) => line.includes("예측")));
  const idle = panel({ home, snapshot: { phase: "ARMED", awayStartMs: now, E: 60, habit } });
  assert.ok(idle.split("\n").some((line) => line.includes("그 안에 돌아올 확률")));
  assert.doesNotMatch(parked, /데움/);
  assert.doesNotMatch(idle, /데움/);
});

test("goal wait warm line replaces the ping line and drops the prediction", (t) => {
  const home = mkdtempSync(join(tmpdir(), "panel-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const snapshot = {
    phase: "ARMED", awayStartMs: now, E: 60, habit: { p: 0.81, mMin: 10.5, t90Min: 140 },
    contextTokens: 1000, nextTickMs: now + 5 * 60_000,
  };
  const goalWait = { sinceMs: now, warm: true, reason: null };
  const warm = panel({ home, snapshot: { ...snapshot, goalWait } });
  assert.equal(cacheLine(warm), "캐시  ❤️‍🔥 다음 턴까지 · 다음 ping 12:05");
  assert.ok(!warm.split("\n").some((line) => line.includes("예측")), "no prediction while warm");
  const pinging = panel({ home, snapshot: { ...snapshot, phase: "PINGING", goalWait, nextTickMs: undefined } });
  assert.equal(cacheLine(pinging), "캐시  ❤️‍🔥 다음 턴까지");
  const cold = panel({ home, snapshot: { ...snapshot, phase: "OBSERVING", goalWait } });
  assert.equal(cacheLine(cold), "캐시  🩵 멈춤", "warm outside the warming phases is not the warm head");
});

test("goal wait waits show one word per reason", (t) => {
  const home = mkdtempSync(join(tmpdir(), "panel-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cases = [
    ["not_worth_it", "이득 없음"], ["context_unknown", "맥락 모름"], ["lane_off", "대상 아님"],
    ["unverified", "대상 아님"], ["no_warm_path", "대상 아님"], ["mode_off", "꺼짐"],
    ["max_hold", "시간 끝"], ["pending", "준비 중"], ["warm_stopped", "멈춤"], ["small_context", "맥락 작음"],
    ["cache_cold_at_open", "이미 식음"], ["duplicate_warmer", "중복"], ["prefix_unsafe", "다른 확장"],
    ["prefix_mismatch", "맥락 바뀜"], ["no_sdk_binding", "기준 없음"], ["some_new_reason", "멈춤"],
  ];
  for (const [reason, word] of cases) {
    const output = panel({ home, snapshot: { phase: "ARMED", goalWait: { sinceMs: now, warm: false, reason } } });
    assert.equal(cacheLine(output), `캐시  🩵 ${word}`, reason);
  }
  const paused = panel({ home, snapshot: { phase: "PAUSED", goalWait: { sinceMs: now, warm: false, reason: "pending" } } });
  assert.equal(cacheLine(paused), "캐시  🩵 준비 중");
});

test("backstop line follows the cache head, and null backstop adds nothing", (t) => {
  const home = mkdtempSync(join(tmpdir(), "panel-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const snapshot = { phase: "ARMED", goalWait: { sinceMs: now, warm: false, reason: "pending" } };
  const tripped = panel({ home, snapshot, backstop: { holding: true, tripped: true } });
  assert.deepEqual(tripped.split("\n").filter((line) => line.startsWith("      대기")),
    ["      대기  backstop 그대로 · senpi 바뀜"]);
  const holding = panel({ home, snapshot, backstop: { holding: true, tripped: false } });
  assert.deepEqual(holding.split("\n").filter((line) => line.startsWith("      대기")),
    ["      대기  backstop 멈춤 · 확인은 omo-health"]);
  const idle = panel({ home, snapshot, backstop: { holding: false, tripped: false } });
  assert.deepEqual(idle.split("\n").filter((line) => line.startsWith("      대기")), [], "idle backstop adds no line");
  const absent = panel({ home, snapshot });
  assert.deepEqual(absent.split("\n").filter((line) => line.startsWith("      대기")), [], "null backstop adds no line");
  const parkedOff = panel({ home, mode: "off", snapshot, backstop: { holding: true, tripped: true } });
  assert.deepEqual(parkedOff.split("\n").filter((line) => line.startsWith("      대기")), [], "the early out has no backstop line");
});

test("cell widths count grapheme clusters as terminal cells", () => {
  assert.equal(cells("❤️‍🔥"), 2);
  assert.equal(cells("🩵"), 2);
  assert.equal(cells("한"), 2);
  assert.equal(cells("a"), 1);
  assert.equal(cells("⏸"), 1);
});
