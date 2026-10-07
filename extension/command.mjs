// limitless feature module: plan todo 9 "User override and /limitless command".
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, sanitizeId } from "./state.mjs";
import { statusText } from "./core.mjs";

function formatStatusLine(parkState, resetAt, now) {
  if (parkState === "ok") return null;
  if (!resetAt) return statusText(resetAt);
  const resetDate = new Date(resetAt);
  const nowDate = new Date(now);
  const hours = String(resetDate.getHours()).padStart(2, "0");
  const mins = String(resetDate.getMinutes()).padStart(2, "0");
  const isSameDay = resetDate.toDateString() === nowDate.toDateString();
  const timeStr = `${hours}:${mins}`;
  if (isSameDay) {
    return `⏸ 한도 대기 · ${timeStr} 재개`;
  } else {
    const month = resetDate.getMonth() + 1;
    const date = resetDate.getDate();
    return `⏸ 한도 대기 · ${month}/${date} ${timeStr} 재개`;
  }
}

function formatStateKorean(parkState) {
  const stateMap = {
    "ok": "대기 없음",
    "park-wait": "한도 대기(이 세션 유지)",
    "park-exit": "한도 대기(종료 후 재실행)",
  };
  return stateMap[parkState] ?? parkState;
}

function formatResetTime(resetAt, now) {
  if (!resetAt) return "unknown";
  const resetDate = new Date(resetAt);
  const nowDate = new Date(now);
  const hours = String(resetDate.getHours()).padStart(2, "0");
  const mins = String(resetDate.getMinutes()).padStart(2, "0");
  const isSameDay = resetDate.toDateString() === nowDate.toDateString();
  const timeStr = `${hours}:${mins}`;
  if (isSameDay) {
    return timeStr;
  } else {
    const month = resetDate.getMonth() + 1;
    const date = resetDate.getDate();
    return `${month}/${date} ${timeStr}`;
  }
}

export function install(core) {
  const fs = core.deps.fs ?? { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync };
  const controlPath = () => join(core.homeDir, ".omo", "limitless", "control", `${sanitizeId(core.sessionId)}.json`);

  const writeControl = (mode) => {
    if (!core.sessionId) return;
    const path = controlPath();
    const temp = `${path}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ v: 1, mode }));
      fs.renameSync(temp, path);
    } catch (error) {
      try { fs.unlinkSync?.(temp); } catch {}
      core.recordError("control-write", error);
    }
  };

  core.setControlReader(async () => {
    if (!core.sessionId) return;
    const control = readJson(controlPath(), fs);
    const mode = control?.v === 1 && (control.mode === "on" || control.mode === "off") ? control.mode : "on";
    const wasOff = core.state.mode === "off";
    core.state.mode = mode;
    core.persist();
    if (mode === "off" && core.isParked()) {
      await core.release({ reason: "control-off" });
      await core.releaseOwnedGoal({ reason: "control-off", text: core.texts.manualResume });
    } else if (wasOff && mode === "on" && core.enabled()) {
      await core.poll({ force: true });
    }
  });

  const usage = "Usage: /limitless status|resume|park|off|on";
  core.pi.registerCommand("limitless", {
    description: "Show or control usage-limit parking",
    handler: async (args, ctx) => {
      core.lastCtx = ctx;
      const [action, ...extra] = String(args ?? "").trim().split(/\s+/);
      if (extra.length || !["status", "resume", "park", "off", "on"].includes(action)) {
        ctx.ui?.notify?.(usage, "info");
        return;
      }

      if (action === "status") {
        const s = core.state;
        const snapshot = s.snapshots?.at(-1);
        const now = core.deps.now?.() ?? Date.now();
        const windows = snapshot?.windows?.map((w) => {
          let windowName = "unknown";
          const kind = w.kind ?? w.window;
          if (kind === "five_hour") {
            windowName = "5시간";
          } else if (kind === "seven_day") {
            windowName = "7일";
          } else if (w.name) {
            windowName = w.name;
          }
          const utilization = w.utilization ?? w.used_percent;
          return `${windowName} 창 ${utilization}%`;
        }).join(", ") ?? "unavailable";
        const statusLine = formatStatusLine(s.parkState, s.resetAt, now) ?? "⏸ 한도 대기 없음";
        const stateKo = formatStateKorean(s.parkState);
        const resetTimeKo = formatResetTime(s.resetAt, now);
        const switchKo = s.mode === "off" ? "꺼짐" : "켜짐";
        const source = snapshot?.source ?? "unknown";
        const output = `${statusLine}\n상태: ${stateKo}\n사용량: ${windows}\n리셋: ${resetTimeKo}\n출처: ${source}\n스위치: ${switchKo}`;
        ctx.ui?.notify?.(output, "info");
        return;
      }

      if (action === "off" || action === "on") {
        writeControl(action);
        core.state.mode = action;
        core.persist();
      }

      if (action === "park") {
        const decision = core.getPolicy();
        if (!decision || !["park-wait", "park-exit"].includes(decision.state)) {
          ctx.ui?.notify?.("limitless: no usage decision available to force park", "info");
          return;
        }
        await core.park({ ...decision, state: "park-wait" }, { source: "manual" });
      } else if (action === "resume" || action === "off") {
        if (core.isParked()) await core.release({ reason: action === "off" ? "manual-off" : "manual" });
        await core.releaseOwnedGoal({ reason: action === "off" ? "manual-off" : "manual", text: core.texts.manualResume });
      } else if (action === "on" && core.enabled()) {
        await core.poll({ force: true });
      }
    },
  });
}
