// The park-wait verdict for the /keepalive screen, in a few words.

// Why keepalive forbids warming, and why the cost comparison said no: one short phrase each.
const FORBIDDEN = { policy: "한도 임박", off: "꺼짐", reactive: "시각 모름", latecomer: "새 세션" };
const NOT_WORTH = {
  not_worth_it: "이득 없음",
  cache_outlives_wait: "필요 없음",
  context_unknown: "맥락 모름",
  no_reset: "시각 모름",
};

// A hold's short cache-line reason, or null while its verdict is pending.
export function holdWord(hold) {
  if (!hold) return null;
  if (hold.warm !== true) return FORBIDDEN[hold.reason] ?? "막힘";
  const why = hold.verdict?.why;
  if (why === "worth_it") return "warm";
  return why ? NOT_WORTH[why] ?? why : null;
}
