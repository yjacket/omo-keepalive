export function install(core) {
  core.onTransition((_prev, next) => {
    const payload = {
      sessionId: core.sessionId,
      state: next.parkState,
      resetAt: next.resetAt,
    };
    return core.pi.events?.emit?.("limitless:park", payload);
  });
}
