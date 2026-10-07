// limitless feature module: plan todo 7 "Resume at reset for park-wait".
//
// One timer ("resume") at most. A known future reset arms it at resetAt + resumeGraceMs. A park-wait whose
// reset is null or already past arms a re-check at now + max(pollMinIntervalMs, 60 s) instead; the timer is
// never armed for a time <= now. Both run core.resetDue() (forced fresh poll), then re-schedule, so a
// parked session always has a pending timer. A reactive park without a known reset is left to reactive.mjs.
const RECHECK_MIN_MS = 60000;

export function install(core) {
  const timer = "resume";
  let recheck = false; // the armed timer is a re-check (kept as is until it fires)

  const clear = () => {
    core.timers.clear(timer);
    recheck = false;
  };

  const schedule = () => {
    if (!core.isParked() || core.state.parkState !== "park-wait") return clear();
    const now = core.now();
    const known = Number.isFinite(core.state.resetAt) && core.state.resetAt > now;
    if (!known && core.state.source === "reactive") return clear();
    const fakeDelay = Number(core.env.OMO_LIMITLESS_FAKE_RESET_IN_MS);
    const dueAt = core.env.OMO_LIMITLESS_FAKE_RESET_IN_MS && Number.isFinite(fakeDelay)
      ? now + fakeDelay
      : known ? core.state.resetAt + core.config.resumeGraceMs : null;
    if (dueAt !== null && dueAt > now) {
      recheck = false;
      core.timers.set(timer, dueAt - now, onReset);
      return;
    }
    if (recheck && core.timers.has(timer)) return;
    recheck = true;
    core.timers.set(timer, Math.max(core.config.pollMinIntervalMs ?? 0, RECHECK_MIN_MS), onReset);
  };

  const onReset = async (_ctx, stale) => {
    recheck = false;
    if (!core.isParked() || core.state.parkState !== "park-wait") return;
    await core.resetDue();
    if (stale?.()) return; // session reset mid-poll: the next session arms its own timer
    schedule();
  };

  core.onSessionReset?.(() => { recheck = false; });
  core.onTransition((_prev, next) => {
    if (next.parkState === "park-wait") schedule();
    else clear();
  });
  core.onBoundary((_ctx, kind) => {
    if (kind === "session_start" || kind === "agent_settled" || kind === "turn_end") schedule();
  });
}
