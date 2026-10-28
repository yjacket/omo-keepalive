import { readAuthJson } from "./lane.mjs";
import { GOAL_CONTINUATION_CAP, trailingContinuations } from "./park-exit.mjs";
import { decide } from "./policy.mjs";
import { accountEntry, epochMs } from "./state.mjs";

const CHECK_MS = 30 * 60 * 1000;
const MAX_MS = 6 * 60 * 60 * 1000;
const LIMIT_TEXT = /usage limit|session limit|weekly limit|5-hour limit|usage_limit_reached|hit your .{0,20}limit/i;
// A limit on one model family ("You've reached your Fable limit"): other models still serve and OMO's fallback
// moves on, so it never parks. Same patterns as senpi's MODEL_FAMILY_LIMIT / FAMILY_KEY (2026.10.25-2).
const MODEL_FAMILY_LIMIT = /\b(opus|sonnet|haiku|fable|mythos)(?:\s+\d+(?:\.\d+)?)?(?:\s+(?:weekly|daily|monthly|session|\d+-hour))?\s+limit\b/i;
const FAMILY_KEY = /^(?:opus|sonnet|haiku|fable|mythos)$/;
// Account rotation found no usable account for the model. Without an account-wide blockedUntil it carries no reset
// and is no proof the account is out, so it does not park; it still counts as a limit error for the stalled-goal rescue.
const ALL_BLOCKED = /\ball\b.{0,40}\baccounts\b.{0,80}\bcurrently blocked\b/i;
const RESCUE_LIMIT = 3; // consecutive rescues with no successful assistant turn in between

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
  const syncLane = () => {
    const lane = core.lane ?? {};
    provider = lane.provider;
    accounts = lane.accounts?.length ? lane.accounts : ["default"];
    account = accounts[0];
  };
  const inFamily = (modelId, family) => new RegExp(`(?:^|[^a-z])${family}(?:[^a-z]|$)`, "i").test(modelId);
  // A future auth.json modelBlocks entry that applies to modelId on any lane account (senpi activeModelBlockUntil).
  const modelBlocked = (modelId) => {
    if (typeof modelId !== "string" || modelId === "") return false;
    const auth = readAuthJson({ env, homeDir, fs });
    return accounts.some((name) => Object.entries(accountEntry(auth, provider, name)?.modelBlocks ?? {}).some(([key, block]) => {
      const ms = epochMs(block?.blockedUntil);
      return ms !== null && ms > now() && (key === modelId || (FAMILY_KEY.test(key) && inFamily(modelId, key)));
    }));
  };
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
    const text = [messageText(event?.message), event?.message?.text, event?.message?.errorMessage, event?.error?.message,
      event?.content, event?.providerDiagnostic?.message, event?.providerDiagnostic?.detail].filter((x) => typeof x === "string").join(" ");
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
  // "account" (the whole account is out: park), "model" (one model family), "blocked" (no account for the model), or null.
  // claude-sdk-oauth errors arrive with content [] and the text only in message.errorMessage.
  const limitKind = (event, modelId) => {
    const diagnostic = event?.message?.providerDiagnostic ?? event?.providerDiagnostic;
    const text = [
      messageText(event?.message), event?.message?.text, event?.message?.errorMessage, event?.message?.error?.message,
      event?.error?.message, event?.error, event?.content, diagnostic?.message, diagnostic?.detail,
    ].filter((x) => typeof x === "string").join(" ");
    if (futureBlockedUntil() !== null) return "account";
    if (MODEL_FAMILY_LIMIT.test(text)) return "model";
    if (LIMIT_TEXT.test(text)) return "account";
    if (modelBlocked(modelId)) return "model";
    return ALL_BLOCKED.test(text) ? "blocked" : null;
  };
  const release = async (reason, notify = false) => {
    core.timers.clear("reactive-check");
    active = false;
    await core.release({ reason });
    await core.releaseOwnedGoal({ reason });
    if (notify) core.notify("[keepalive] 사용량 한도 대기를 해제했습니다. 다음 턴에서 다시 시도합니다.", "info");
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
        core.state.snapshots = snapshots; // /keepalive resume derives its hold from the current readings
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
    syncLane();
    if (!provider || limitKind(event, message.model ?? ctx?.model?.id) !== "account") return;
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

  // Stalled-goal rescue. OMO stops goal continuation after GOAL_CONTINUATION_CAP continuations in a row, and its
  // fallback tried set is cleared only by a user message_start, so a goal that ran into limit errors (typically a
  // model-scoped limit after every fallback was tried once) idles until someone types. One user message resets both.
  const lastAssistant = (branch) => {
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message?.role === "assistant") return entry.message;
    }
    return null;
  };
  // Rescue messages in a row at the end of the branch with no successful assistant turn after any of them.
  const rescueStreak = (branch) => {
    let count = 0;
    for (let i = branch.length - 1; i >= 0; i--) {
      const message = branch[i]?.type === "message" ? branch[i].message : null;
      if (message?.role === "assistant" && message.stopReason !== "error") break;
      if (message?.role !== "user") continue;
      if (messageText(message).trim() !== core.texts.limitRescue) break;
      count += 1;
    }
    return count;
  };

  core.onBoundary(async (ctx, kind) => {
    if (kind !== "agent_settled" || !core.enabled() || core.isVetoed?.() || core.isParked()) return;
    const branch = ctx?.sessionManager?.getBranch?.();
    if (!Array.isArray(branch) || trailingContinuations(branch) < GOAL_CONTINUATION_CAP) return;
    const last = lastAssistant(branch);
    if (last?.stopReason !== "error") return;
    syncLane();
    if (limitKind({ message: last }, last.model ?? ctx?.model?.id) === null) return;
    // One rescue per stop episode: the episode is the branch as it stands (a delivered rescue message ends it).
    const key = String(branch.at(-1)?.id ?? branch.length);
    if (core.state.limitRescue?.key === key) return;
    const goal = await core.readGoal(ctx);
    if (goal?.status !== "active") return;
    const streak = rescueStreak(branch);
    core.state.limitRescue = { key, at: now(), streak: streak + 1 };
    core.persist();
    if (streak >= RESCUE_LIMIT) {
      core.notify(`[keepalive] 한도 오류로 멈춘 goal을 ${RESCUE_LIMIT}번 이어서 다시 시작했지만 매번 실패해 더 시도하지 않습니다.`, "warning");
      return;
    }
    core.pi.sendUserMessage(core.texts.limitRescue);
  });
}
