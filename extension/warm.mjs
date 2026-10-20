// keepalive feature module: prompt-cache warming, owned by the keepwarm runtime (extension/keepwarm).
//
// keepwarm warms an idle session with trace-free pings (no turn, no transcript entry) and decides from the user's
// return habit how long to keep it warm. keepalive only tells it about a usage-limit park-wait: the session returns
// at the reset for sure, so keepwarm warms until then, or not at all when the policy said no (99% utilization,
// warm off for the lane, a reactive park, a latecomer).
import { existsSync as nodeExistsSync } from "node:fs";
import { join } from "node:path";
import keepwarm from "./keepwarm/runtime.mjs";
import { ensureOmoPreviewSafe } from "./keepwarm/omo-preview-safe.mjs";
import { loadHostDeps } from "./keepwarm/subscription-warm.mjs";

let previewSafeChecked = false; // omo.js is patched once per process

// senpi's convertToLlm arrives asynchronously (loadHostDeps); a turn that reaches it before then must fail loudly.
export function hostConvert(getConvert, messages) {
  const convert = getConvert();
  if (!convert) throw new Error("keepalive: senpi host modules are not loaded yet");
  return convert(messages);
}

export function install(core) {
  const injected = core.deps.keepwarm ?? {};
  // pi-ai and senpi's convertToLlm come from the running senpi install; until they load, lane classification falls
  // back to its defaults and the API-key warm path reports unavailable.
  const piAi = injected.piAi ?? {};
  let convert = injected.convertToLlm ?? null;
  if (!injected.piAi) {
    loadHostDeps()
      .then((host) => {
        if (host.piAi) Object.assign(piAi, host.piAi);
        convert = host.convertToLlm;
      })
      .catch((error) => core.recordError("keepwarm-host", error));
  }
  const env = core.deps.env ?? process.env;
  if (!previewSafeChecked) {
    previewSafeChecked = true;
    const r = ensureOmoPreviewSafe({ env });
    if (r.status === "error" || r.status === "no-match") core.recordError("omo-preview-safe", new Error(`${r.status}: ${r.detail ?? r.file}`));
  }
  const kw = keepwarm(core.pi, {
    home: env.OMO_KEEPWARM_HOME || join(core.homeDir, ".omo-keepwarm"),
    ...injected,
    piAi,
    convertToLlm: injected.convertToLlm ?? ((messages) => hostConvert(() => convert, messages)),
  });
  if (!kw) return;
  core.keepwarm = kw;

  // Why keepalive forbids warming this park, shown on the /keepalive screen.
  const forbidden = () => {
    if (core.isLatecomer()) return "latecomer";
    if (core.state.source === "reactive") return "reactive";
    if (core.state.warm?.on !== true) return core.config.warm?.[core.lane?.provider]?.on === false ? "off" : "policy";
    return null;
  };
  const apply = () => {
    const waiting = core.enabled() && core.isParked() && core.state.parkState === "park-wait";
    const warm = waiting && core.canWarm();
    kw.controller.setLimitHold(waiting ? { untilMs: core.state.resetAt, warm, reason: warm ? null : forbidden() } : null);
  };
  // A pre-rename stub left in the agent dir still registers a cache-warm handler that never reaches this extension.
  let stubChecked = false;
  core.onBoundary((_ctx, kind) => {
    if (kind !== "session_start" || stubChecked) return;
    stubChecked = true;
    const agentDir = env.OMO_CODING_AGENT_DIR || env.SENPI_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(core.homeDir, ".omo", "agent");
    const stub = join(agentDir, "extensions", "omo-keepwarm.ts");
    const existsSync = core.deps.fs?.existsSync ?? nodeExistsSync;
    if (existsSync(stub)) {
      core.notify(`keepalive: 옛 omo-keepwarm 스텁이 남아 있어 캐시 데우기가 이 확장으로 넘어오지 않습니다. 이 파일을 지우고 /reload 하세요: ${stub}`, "warning");
    }
  });
  core.onTransition(apply);
  core.onConfigApplied(apply);
  core.onBoundary(apply);
  core.onSessionReset(() => kw.controller.setLimitHold(null));
}
