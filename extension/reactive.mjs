import { readAuthJson } from "./lane.mjs";
import { decide } from "./policy.mjs";
import { accountEntry, epochMs } from "./state.mjs";

const CHECK_MS = 30 * 60 * 1000;
const MAX_MS = 6 * 60 * 60 * 1000;
const LIMIT_TEXT = /usage limit|session limit|weekly limit|5-hour limit|usage_limit_reached|hit your .{0,20}limit/i;

export function install(core) {
  const now = core.deps.now ?? Date.now;
  const fs = core.deps.fs;
  const env = core.deps.env ?? process.env;
  const homeDir = core.deps.homeDir ?? core.homeDir;
  let active = false;
  let startedAt = 0;
  let provider;
  let account;
  let accounts = [];

  const messageText = (message) => Array.isArray(message?.content)
    ? message.content.map((part) => typeof part === "string" ? part : part?.text ?? "").join(" ")
    : typeof message?.content === "string" ? message.content : "";
  // Only a blockedUntil in the future counts; a stale one is no evidence of a limit.
  const futureBlockedUntil = () => {
    const blocked = accountEntry(readAuthJson({ env, homeDir, fs }), provider, account)?.blockedUntil;
    if (blocked === null || blocked === undefined || blocked === "") return null;
    const ms = epochMs(blocked);
    return ms !== null && ms > now() ? ms : null;
  };
  const parsedReset = (event) => {
    const blockedMs = futureBlockedUntil();
    if (blockedMs !== null) return blockedMs;

    const fields = [event?.message, event?.message?.error, event?.message?.providerDiagnostic,
      event?.error, event?.providerDiagnostic, event];
    for (const field of fields) {
      if (!field || typeof field !== "object") continue;
      const value = field.resets_at ?? field.reset_at;
      if (value !== undefined) {
        const ms = epochMs(value);
        if (ms !== null) return ms;
      }
      const seconds = Number(field.reset_after_seconds);
      if (Number.isFinite(seconds) && seconds >= 0) return now() + seconds * 1000;
    }
    const text = [messageText(event?.message), event?.message?.text, event?.error?.message, event?.content,
      event?.providerDiagnostic?.message, event?.providerDiagnostic?.detail].filter((x) => typeof x === "string").join(" ");
    const match = /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
    if (!match || (match[2] === undefined && !match[3])) return null;
    const current = new Date(now());
    let hour = Number(match[1]) % 12;
    if (match[3]?.toLowerCase() === "pm") hour += 12;
    if (match[3]?.toLowerCase() === "am" && Number(match[1]) === 12) hour = 0;
    const result = new Date(current);
    result.setHours(hour, Number(match[2] ?? 0), 0, 0);
    if (result.getTime() <= now()) result.setDate(result.getDate() + 1);
    return result.getTime();
  };
  const isLimit = (event) => {
    const diagnostic = event?.message?.providerDiagnostic ?? event?.providerDiagnostic;
    const text = [
      messageText(event?.message), event?.message?.text, event?.message?.error?.message,
      event?.error?.message, event?.error, event?.content, diagnostic?.message, diagnostic?.detail,
    ].filter((x) => typeof x === "string").join(" ");
    return futureBlockedUntil() !== null || LIMIT_TEXT.test(text);
  };
  const release = async (reason, notify = false) => {
    core.timers.clear("reactive-check");
    active = false;
    await core.release({ reason });
    await core.releaseOwnedGoal({ reason });
    if (notify) core.notify("[limitless] 사용량 한도 대기를 해제했습니다. 다음 턴에서 다시 시도합니다.", "info");
  };
  const scheduleCheck = () => {
    const elapsed = now() - startedAt;
    if (elapsed >= MAX_MS) return release("reactive-check-cap", true);
    core.timers.set("reactive-check", Math.min(CHECK_MS, MAX_MS - elapsed), async (_ctx, stale) => {
      if (!active) return;
      if (now() - startedAt >= MAX_MS) return release("reactive-check-cap", true);
      try {
        const snapshots = [];
        for (const name of accounts) snapshots.push(await core.readUsage(provider, name));
        if (stale?.()) return;
        if (snapshots.length === 0 || snapshots.some((s) => !s || s.source === "none")) {
          return release("reactive-usage-unavailable");
        }
        const verdict = decide({ snapshots, config: core.config, now: now() });
        if (verdict.state !== "park-wait" && verdict.state !== "park-exit") return release("reactive-usage-ok");
        // A successful still-over check ends the reactive park: it becomes a normal policy park through
        // core.park, which normalizes an unknown or past reset to park-wait/null (resume.mjs re-checks).
        active = false;
        core.timers.clear("reactive-check");
        core.state.snapshots = snapshots; // /limitless resume derives its hold from the current readings
        await core.park(verdict, { source: "poll" });
        return;
      } catch (error) {
        core.recordError("reactive-usage", error);
      }
      scheduleCheck();
    });
  };

  core.onTransition((_previous, next) => {
    if (next.parkState !== "park-wait" || next.source !== "reactive") {
      active = false;
      core.timers.clear("reactive-check");
    }
  });

  core.onSessionReset?.(() => {
    active = false;
    startedAt = 0;
    provider = undefined;
    account = undefined;
    accounts = [];
  });

  core.pi.on("message_end", async (event, ctx) => {
    // An off or vetoed session shows no reactive park and arms no timer.
    if (!core.enabled() || core.isVetoed?.()) return;
    core.lastCtx = ctx;
    const message = event?.message;
    if (message?.role !== "assistant" || !(message.stopReason === "error" || message.error || event?.error)) return;
    const lane = core.lane ?? {};
    provider = lane.provider;
    accounts = lane.accounts?.length ? lane.accounts : ["default"];
    account = accounts[0];
    if (!provider || !isLimit(event)) return;
    const resetAt = parsedReset(event);
    const waitLimit = core.config.waitLimitMs?.[provider] ?? 0;
    const decision = resetAt === null
      ? { state: "park-wait", window: "unknown", resetAt: null, reason: "reactive usage limit", util: null, warm: { on: false } }
      : {
          state: resetAt - now() <= waitLimit ? "park-wait" : "park-exit",
          window: "unknown",
          resetAt,
          reason: "reactive usage limit",
          util: null,
          warm: { on: false },
        };
    await core.park(decision, { source: "reactive" });
    active = true;
    startedAt = now();
    if (core.state.resetAt === null) scheduleCheck(); // includes a past reset that core.park normalized
  });
}
