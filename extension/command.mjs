// keepalive feature module: plan todo 9 "User override and /keepalive command".
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, sanitizeId } from "./state.mjs";
import { hhmm, statusText } from "./core.mjs";
import { overWindows } from "./policy.mjs";
import { run as expiryCli } from "./keepwarm/cli/expiry.mjs";
import { run as habitCli } from "./keepwarm/cli/habit.mjs";
import { renderPanel } from "./panel.mjs";
import { completions, findRow, loadSnapshot, saveChanges, settingRows, setByText, textListing } from "./settings/index.mjs";
import { SettingsScreen } from "./settings/screen.mjs";

import { updateConfig } from "./keepwarm/config.mjs";
export function install(core) {
  const fs = core.deps.fs ?? { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync };
  const controlPath = () => join(core.homeDir, ".omo", "keepalive", "control", `${sanitizeId(core.sessionId)}.json`);

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
    if (wasOff !== (mode === "off")) core.refreshStatus();
  });

  const usage = ["Usage: /keepalive <명령>", ...[
    ["status", "화면 보기 (명령 없이 /keepalive도 같다)"],
    ["resume", "한도 대기를 풀고 바로 재개"],
    ["park", "지금 한도 대기 (사용량이 임계치 위일 때만)"],
    ["off | on", "이 세션에서 끄기 / 켜기"],
    ["set", "설정 화면 (터미널 밖에서는 설정 목록)"],
    ["set <item> <value>", "설정 하나 바로 바꾸기 (예: set threshold 5h 95)"],
    ["set expiry <lane> <step|auto>", "lane별 데우는 시간 (예: set expiry claude-subscription 4h)"],
    ["set habit auto | --return-rate <0-1> --median <dur> --t90 <dur>", ""],
    ["", "복귀 습관 자동 / 직접 정하기"],
    ["set mode on|shadow|off", "캐시 데우기 켜기 / 기록만 / 끄기"],
    ["set backstop on|off", "데우는 동안 goal backstop 붙잡기 켜기 / 끄기"],
  ].map(([cmd, text]) => `  ${cmd.padEnd(30)} ${text}`.trimEnd())].join("\n");
  const expiryHint = [
    "",
    "바꾸기  /keepalive set expiry <lane> <step|auto>   예: claude-subscription 4h",
    "        [ ]가 지금 값 · 0은 데우지 않음 · auto는 복귀 습관으로 계산",
  ].join("\n");
  const habitHint = [
    "",
    "바꾸기  /keepalive set habit auto | --return-rate <0-1> --median <dur> --t90 <dur>",
    "        p 돌아오는 비율 · m 복귀 시간 중앙값 · t90 90%가 돌아오는 시간",
  ].join("\n");
  const env = core.deps.env ?? process.env;
  const warmHome = () => env.OMO_KEEPWARM_HOME || join(core.homeDir, ".omo-keepwarm");
  const notify = (ctx, text, level = "info") => ctx.ui?.notify?.(text, level);
  const isTui = (ctx) => ctx?.hasUI === true && ctx.mode === "tui" && typeof ctx.ui?.custom === "function";
  const loadSnap = () => loadSnapshot({ env, homeDir: core.homeDir, keepwarmHome: warmHome(), snapshots: core.state.snapshots, now: core.now });
  async function openScreen(ctx, focusId) {
    const snap = loadSnap();
    // As many rows as fit in the overlay's 80% of the terminal, so a tall terminal shows every setting at once.
    const maxRows = (tui) => Math.max(5, Math.floor((tui?.terminal?.rows ?? 30) * 0.8) - 11);
    await ctx.ui.custom((tui, theme, keybindings, done) => new SettingsScreen(theme, {
      rows: settingRows(snap), snap, focusId, keybindings, maxRows: maxRows(tui),
      onSave: (changes, staged) => {
        const r = saveChanges({ env, homeDir: core.homeDir, keepwarmHome: warmHome() }, snap, changes, staged);
        if (r.error) return r.error;
        // The new values hold before onSave returns; the park is re-decided right after.
        if (r.files.includes("keepalive") && core.reloadConfig().changed) {
          core.applyReloadedConfig().catch((e) => core.recordError("settings-apply", e));
        }
        try { core.refreshStatus(); } catch {}
        return undefined;
      },
      onClose: () => { done(undefined); tui?.requestRender?.(); },
    }), { overlay: true, overlayOptions: { width: "96%", maxHeight: "80%", minWidth: 40, margin: 1 } });
  }
  // Cache-warming settings: /keepalive set expiry|habit|mode|backstop ...
  const SET_TARGETS = {
    // Without arguments expiry and habit show the current values, so the user sees what to type.
    expiry: async (args, io) => {
      if (args.length > 0) return expiryCli(["set", ...args], io);
      await expiryCli([], io);
      io.stdout(expiryHint);
    },
    habit: async (args, io) => {
      if (args.length > 0) return habitCli(args[0] === "auto" ? ["auto"] : ["set", ...args], io);
      await habitCli([], io);
      io.stdout(habitHint);
    },
    mode: async ([value], io) => {
      if (!["on", "shadow", "off"].includes(value)) {
        io.stderr(usage);
        return;
      }
      updateConfig(warmHome(), (c) => { c.mode = value; });
      io.stdout(`keepalive: 캐시 데우기 ${value}`);
    },
    backstop: async ([value], io) => {
      if (!["on", "off"].includes(value)) {
        io.stderr(usage);
        return;
      }
      updateConfig(warmHome(), (c) => { c.backstop = value; });
      io.stdout(`keepalive: backstop 붙잡기 ${value}`);
    },
  };

  async function runSet(extra, ctx) {
    const [target, ...args] = extra;
    if (!target) {
      if (isTui(ctx)) return openScreen(ctx);
      return notify(ctx, textListing(loadSnap()));
    }
    if (target === "expiry") {
      if (args.length < 2 && isTui(ctx)) {
        const snap = loadSnap();
        const lane = snap.lanes.find(({ key }) => key === args[0] || key.startsWith(`${args[0]}:`));
        return openScreen(ctx, lane ? `expiry.${lane.key}` : "expiry");
      }
      return runTarget(target, args, ctx);
    }
    if (target === "habit") {
      if (args.length && ((args[0] === "auto" && args.length === 1) || args[0].startsWith("--"))) return runTarget(target, args, ctx);
      if (args.length === 0) {
        if (isTui(ctx)) return openScreen(ctx, "habit");
        return runTarget(target, args, ctx);
      }
    }
    if (target === "mode" || target === "backstop") {
      if (args.length) return runTarget(target, args, ctx);
      if (isTui(ctx)) return openScreen(ctx, target);
      notify(ctx, usage, "info");
      return;
    }
    const snap = loadSnap();
    const rows = settingRows(snap);
    const textFound = findRow(rows, extra);
    if (textFound.row && textFound.valueText) {
      try {
        const r = setByText({ env, homeDir: core.homeDir, keepwarmHome: warmHome() }, snap, extra);
        notify(ctx, r.message, r.ok ? "info" : "warning");
        if (r.ok && r.files.includes("keepalive")) {
          try { await core.applyConfigChange(); } catch (e) { core.recordError("settings-apply", e); }
          try { core.refreshStatus(); } catch {}
        }
      } catch (error) {
        notify(ctx, `keepalive: 설정을 저장하지 못했습니다 (${error?.message ?? error})`, "warning");
      }
      return;
    }
    // A row path without a value, or the start of one: show where it is.
    const focusRow = textFound.row ?? textFound.prefixRows?.[0];
    if (focusRow) {
      if (isTui(ctx)) return openScreen(ctx, focusRow.id);
      return notify(ctx, textListing(snap), "info");
    }
    if (!Object.hasOwn(SET_TARGETS, target)) {
      notify(ctx, usage, "info");
      return;
    }
    try { await runTarget(target, args, ctx); }
    catch (error) { notify(ctx, `keepalive: 설정을 저장하지 못했습니다 (${error?.message ?? error})`, "warning"); }
  }

  async function runTarget(target, args, ctx) {
    let out = "";
    let err = "";
    const io = {
      stdout: (text) => { out += text; },
      stderr: (text) => { err += text; },
      env: { ...env, OMO_KEEPWARM_HOME: warmHome() },
      now: () => core.now(),
      cwd: process.cwd(),
    };
    try {
      await SET_TARGETS[target](args, io);
      notify(ctx, `${out}${err}`.trimEnd() || "keepalive: 바꿨습니다", err ? "warning" : "info");
    } catch (error) {
      notify(ctx, `keepalive: 설정을 저장하지 못했습니다 (${error?.message ?? error})`, "warning");
    }
  }

  function panelText() {
    const now = core.now();
    try {
      return renderPanel({
        state: core.state,
        config: core.config,
        home: warmHome(),
        snapshot: core.keepwarm?.controller.snapshot(),
        inert: core.keepwarm?.isInert?.() === true,
        backstop: core.backstop?.status?.() ?? null,
        now,
        hhmm: (ms) => hhmm(ms, now),
        statusText: statusText(core.state.resetAt, now),
      });
    } catch (error) {
      core.recordError("panel", error);
      return `keepalive: 화면을 만들지 못했습니다 (${error?.message ?? error})`;
    }
  }
  core.pi.registerCommand("keepalive", {
    description: "Show keepalive status, control parking, and change settings",
    argumentHint: "[status|resume|park|off|on|set]",
    getArgumentCompletions: (prefix) => {
      try {
        return completions(prefix, loadSnap());
      } catch { return null; }
    },
    handler: async (args, ctx) => {
      core.lastCtx = ctx;
      const [first, ...extra] = String(args ?? "").trim().split(/\s+/);
      // The bare command shows everything on one screen.
      const action = first === "" ? "status" : first;
      if (action === "set") {
        await runSet(extra, ctx);
        return;
      }
      if (extra.length || !["status", "resume", "park", "off", "on"].includes(action)) {
        ctx.ui?.notify?.(usage, "info");
        return;
      }

      if (action === "status") {
        ctx.ui?.notify?.(panelText(), "info");
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
          ctx.ui?.notify?.("keepalive: 지금은 사용량이 임계치 아래이거나 아직 판정이 없어 한도 대기를 걸지 않았습니다", "info");
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
      if (action === "off" || action === "on") core.refreshStatus();
    },
  });
}
