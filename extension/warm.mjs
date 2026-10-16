import * as nodeFs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WARM_TEXT = "[limitless] 사용량 한도 대기 중. 도구를 쓰지 말고 ok 한 단어로만 답하라.";
const WARM_TIMER = "warm";

let resolverPromise;

export function resolverStartDirectory() {
  return dirname(fileURLToPath(import.meta.url));
}

// The copied extension lives under ~/.omo/agent/extensions, outside senpi's node_modules
// tree. Try normal package resolution first, then the pi-ai package beside Senpi's install.
async function loadResolver(core) {
  if (typeof core.deps.resolvePromptCacheLifetime === "function") return core.deps.resolvePromptCacheLifetime;
  resolverPromise ??= (async () => {
    try {
      const ai = await import("@earendil-works/pi-ai");
      if (typeof ai.resolvePromptCacheLifetime === "function") return ai.resolvePromptCacheLifetime;
    } catch {}
    const env = core.env ?? process.env;
    const candidates = [];
    const starts = [
      process.argv[1],
      env.OMO_BIN,
      // The installed package sits at <home>/.omo/agent/git/github.com/yjacket/omo-limitless.
      // Walk upward from this module too, without assuming a particular user's home.
      resolverStartDirectory(),
    ].filter(Boolean);
    for (const start of starts) {
      let cursor = dirname(resolve(start));
      for (let depth = 0; depth < 8; depth++, cursor = dirname(cursor)) {
        candidates.push(join(cursor, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "prompt-cache-ttl.js"));
        candidates.push(join(cursor, "@earendil-works", "pi-ai", "dist", "utils", "prompt-cache-ttl.js"));
      }
    }
    for (const path of candidates) {
      try {
        const ai = await import(pathToFileURL(path).href);
        if (typeof ai.resolvePromptCacheLifetime === "function") return ai.resolvePromptCacheLifetime;
      } catch {}
    }
    return null;
  })();
  return resolverPromise;
}

function usageOf(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
  const usage = assistant?.usage;
  if (!usage || typeof usage !== "object") return null;
  const numeric = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    input: numeric(usage.input ?? usage.inputTokens),
    cacheRead: numeric(usage.cacheRead ?? usage.cacheReadTokens),
    cacheWrite: numeric(usage.cacheWrite ?? usage.cacheWriteTokens),
    output: numeric(usage.output ?? usage.outputTokens),
    toolCalls: messages.reduce((count, message) => count + (message?.role === "assistant"
      ? (message.content ?? []).filter((part) => part?.type === "toolCall").length : 0), 0),
    provider: assistant?.provider ?? null,
  };
}

function appendUsage(core, usage, provider) {
  const fs = core.deps.fs ?? nodeFs;
  const path = join(core.homeDir, ".omo", "limitless", "events.jsonl");
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.appendFileSync(path, `${JSON.stringify({
      ...usage, provider, sessionId: core.sessionId, at: core.now(),
    })}\n`, "utf8");
  } catch (error) {
    core.recordError("warm-usage", error);
  }
}

export function install(core) {
  let timerResetAt = null;
  let warmQueued = false;
  let warmRun = false;
  let warmFailed = false;

  const stop = (reason) => {
    core.timers.clear(WARM_TIMER);
    if (reason) {
      core.state.warmTurn = "cold";
      core.state.warmStopReason = reason;
      core.persist();
    }
  };
  const active = () => core.enabled() && core.canWarm() && !core.isLatecomer() && !warmFailed;

  async function warmOnce(ctx, stale) {
    // IS-1: a session limitless is not gating (no goal paused by limitless) is never warmed.
    const owned = core.ownedGoalId();
    const goal = owned ? await core.readGoal(ctx) : null;
    if (stale?.()) return false; // the session was reset while reading: nothing of this callback may land
    // Not idle, or senpi has queued messages (types.d.ts ExtensionContext.hasPendingMessages): skip this warm turn.
    if (!owned || goal?.id !== owned || goal.status !== "paused" || !active() || ctx?.isIdle?.() !== true
      || ctx?.hasPendingMessages?.() === true) {
      schedule(true);
      return false;
    }
    warmQueued = true;
    core.pi.sendMessage({ customType: "limitless-warm", content: WARM_TEXT, display: false }, { triggerTurn: true });
    return true;
  }

  function schedule(fromNow = false) {
    if (!active()) {
      stop();
      return;
    }
    const resetAt = core.state.resetAt;
    if (!fromNow && timerResetAt === resetAt && core.timers.has(WARM_TIMER)) return;
    timerResetAt = resetAt;
    let interval = Number(core.state.warm?.intervalMs);
    const override = Number(core.env?.OMO_LIMITLESS_WARM_INTERVAL_MS);
    if (Number.isFinite(override) && override >= 0) interval = override;
    if (!Number.isFinite(interval) || interval < 0) {
      stop("invalid warm interval");
      return;
    }
    core.timers.set(WARM_TIMER, interval, async (ctx, stale) => {
      const sent = await warmOnce(ctx, stale);
      if (stale?.()) return;
      if (sent) schedule(true); // the skip paths already rescheduled
    });
  }

  core.onSessionReset?.(() => {
    timerResetAt = null;
    warmQueued = false;
    warmRun = false;
    warmFailed = false;
  });

  core.onTransition((prev, next) => {
    if (next.parkState !== "park-wait" || next.source === "reactive" || next.warm?.on !== true) {
      stop();
      return;
    }
    if (prev.parkState !== "park-wait") warmFailed = false;
    schedule();
  });
  core.onBoundary((_ctx, kind) => {
    if (!active()) {
      stop();
      return;
    }
    if (kind === "session_start" || kind === "agent_settled" || kind === "turn_end") schedule(kind !== "session_start");
  });

  core.pi.on("before_agent_start", (event) => {
    // Senpi exposes the custom message content as prompt, not customType, in this event.
    if (warmQueued && event?.trigger === "extension" && event?.prompt === WARM_TEXT) {
      warmQueued = false;
      warmRun = true;
      core.markExtensionTurn("warm");
    }
    return undefined;
  });

  core.pi.on("agent_end", (event) => {
    if (!warmRun) return;
    warmRun = false;
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
    const provider = assistant?.provider;
    const usage = usageOf(event);
    if (usage) appendUsage(core, usage, provider ?? core.lane?.provider ?? null);
    const error = event?.error ?? (event?.aborted || assistant?.stopReason === "error");
    if (error) {
      warmFailed = true;
      stop("error");
      return;
    }
    if (provider && core.lane?.provider && provider !== core.lane.provider) {
      warmFailed = true;
      stop("provider mismatch");
      return;
    }
    if (!usage) return;
    if (usage.cacheRead < 0.5 * (usage.input + usage.cacheRead + usage.cacheWrite)) {
      warmFailed = true;
      stop("cold");
    }
  });

  // Resolve Codex TTL before the first scheduled send. Unknown TTL is deliberately no-warm.
  async function checkCodexModel() {
    if (core.lane?.provider !== "chatgpt-subscription") return true;
    const resolve = await loadResolver(core);
    if (!resolve || !core.lastCtx?.model) return false;
    try {
      const lifetime = resolve(core.lastCtx.model);
      return lifetime?.kind === "ttl" && lifetime.ttlSeconds === (Number(core.state.warm?.requireTtlSeconds) || 1800);
    } catch { return false; }
  }
  core.onBoundary(async () => {
    if (!active()) return;
    if (core.lane?.provider === "chatgpt-subscription" && !(await checkCodexModel())) {
      warmFailed = true;
      stop("unknown or unsupported cache TTL");
    }
  });
}
