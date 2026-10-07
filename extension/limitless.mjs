import { DEFAULTS, loadConfig } from "./config.mjs";
import { createCore } from "./core.mjs";
import * as events from "./events.mjs";
import * as command from "./command.mjs";
import * as resume from "./resume.mjs";
import * as warm from "./warm.mjs";
import * as parkExit from "./park-exit.mjs";
import * as reactive from "./reactive.mjs";

const CHILD_ENV = ["OMO_SENPI_TASK_RPC_CHILD", "SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID"];
// Fixed install order: events first so every later transition is published, command second so the
// control-file reader is in place before any timer exists.
export const FEATURES = [events, command, resume, warm, parkExit, reactive];

export default (pi) => startLimitless(pi);

// Config only, no handlers (null in task child sessions).
export function createLimitless(pi, deps = {}) {
  const env = deps.env ?? process.env;
  if (CHILD_ENV.some((key) => (env[key] ?? "").length > 0)) return null;
  const loaded = loadConfig({ env, homeDir: deps.homeDir, fs: deps.fs });
  return { config: loaded.config, warnings: loaded.warnings };
}

// One notification line per invalid config key (max 3, then "외 N개"); null when there are no warnings.
export function configWarningText(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  const line = (warning) => {
    const key = String(warning).split(":")[0];
    if (key === "config") return "limitless 설정 오류: 설정 파일을 읽지 못해 기본값을 씁니다";
    const value = key.split(".").reduce((node, part) => node?.[part], DEFAULTS);
    const shown = value !== null && typeof value === "object" ? "" : `(${value})`;
    return `limitless 설정 오류: ${key} 값이 잘못돼 기본값${shown}을 씁니다`;
  };
  const lines = warnings.slice(0, 3).map(line);
  if (warnings.length > 3) lines.push(`외 ${warnings.length - 3}개`);
  return lines.join("\n");
}

// Full extension: core + senpi event wiring + feature modules. Returns the core (null in child sessions).
export function startLimitless(pi, deps = {}, features = FEATURES) {
  const created = createLimitless(pi, deps);
  if (created === null) return null;
  const core = createCore(pi, { config: created.config, deps });
  core.configWarnings = created.warnings;
  let warned = false;
  pi.on("session_start", async (event, ctx) => {
    await core.handleSessionStart(event, ctx);
    const text = configWarningText(core.configWarnings);
    if (warned || text === null || core.isVetoed()) return;
    warned = true;
    core.notify(text, "warning");
  });
  pi.on("before_agent_start", (event, ctx) => core.handleBeforeAgentStart(event, ctx), { previewSafe: true });
  pi.on("tool_call", (event, ctx) => core.handleToolCall(event, ctx));
  pi.on("turn_end", (event, ctx) => core.handleTurnEnd(event, ctx));
  pi.on("agent_start", () => core.handleAgentStart());
  pi.on("agent_end", (event, ctx) => core.handleAgentEnd(event, ctx));
  pi.on("agent_settled", (event, ctx) => core.handleAgentSettled(event, ctx));
  pi.events?.on?.("goal_store_changed", (data) => core.handleGoalStoreChanged(data));
  for (const feature of features) feature.install(core);
  return core;
}
