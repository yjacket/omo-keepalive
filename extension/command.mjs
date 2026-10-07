// limitless feature module: plan todo 9 "User override and /limitless command".
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, sanitizeId } from "./state.mjs";
import { hhmm, statusText } from "./core.mjs";
import { overWindows } from "./policy.mjs";

function formatStateKorean(parkState) {
  const stateMap = {
    "ok": "대기 없음",
    "park-wait": "한도 대기(이 세션 유지)",
    "park-exit": "한도 대기(종료 후 재실행)",
  };
  return stateMap[parkState] ?? parkState;
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
    if (mode === "off") core.state.resumeHold = null;
    core.persist();
    if (mode === "off" && core.isParked()) {
      await core.release({ reason: "control-off" });
      await core.releaseOwnedGoal({ reason: "control-off" });
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
        const statusLine = (s.parkState === "ok" ? null : statusText(s.resetAt, now)) ?? "⏸ 한도 대기 없음";
        const stateKo = formatStateKorean(s.parkState);
        const resetTimeKo = s.resetAt ? hhmm(s.resetAt, now) : "unknown";
        const switchKo = s.mode === "off" ? "꺼짐" : "켜짐";
        const source = snapshot?.source ?? "unknown";
        const output = `${statusLine}\n상태: ${stateKo}\n사용량: ${windows}\n리셋: ${resetTimeKo}\n출처: ${source}\n스위치: ${switchKo}`;
        ctx.ui?.notify?.(output, "info");
        return;
      }

      if (action === "off" || action === "on") {
        writeControl(action);
        core.state.mode = action;
        core.state.resumeHold = null; // turning gating off/on means normal behavior again
        core.persist();
      }

      if (action === "park") {
        const decision = core.getPolicy();
        if (!decision || !["park-wait", "park-exit"].includes(decision.state)) {
          ctx.ui?.notify?.("limitless: no usage decision available to force park", "info");
          return;
        }
        core.state.resumeHold = null; // a forced park wins over a resume hold
        await core.park({ ...decision, state: "park-wait" }, { source: "manual" });
      } else if (action === "resume" || action === "off") {
        // resume while over threshold: do not re-park for this same window until its resetAt
        if (action === "resume" && core.isParked() && core.state.source !== "reactive") {
          const { window, resetAt } = core.state;
          const windows = Object.fromEntries([...overWindows({ snapshots: core.state.snapshots, config: core.config })]
            .filter(([, reset]) => Number.isFinite(reset) && reset > core.now()));
          // snapshots yielding no over window (stale readings): fall back to the parked window itself
          if (Object.keys(windows).length === 0 && window && window !== "unknown" && Number.isFinite(resetAt) && resetAt > core.now()) {
            windows[window] = resetAt;
          }
          core.state.resumeHold = Object.keys(windows).length > 0 ? { windows } : null;
        }
        if (core.isParked()) await core.release({ reason: action === "off" ? "manual-off" : "manual" });
        await core.releaseOwnedGoal({ reason: action === "off" ? "manual-off" : "manual" });
      } else if (action === "on" && core.enabled()) {
        await core.poll({ force: true });
      }
    },
  });
}
