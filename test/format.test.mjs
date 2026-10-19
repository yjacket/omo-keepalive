import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./harness.mjs";
import { hhmm, statusText } from "../extension/core.mjs";
import { startKeepalive } from "../extension/keepalive.mjs";

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

test("reset formatter: today / other day / unknown are identical in core and /keepalive status", async () => {
  const now = at(2026, 5, 10, 9, 0);
  assert.equal(statusText(at(2026, 5, 10, 14, 5), now), "⏸ 한도 대기 · 14:05 재개");
  assert.equal(statusText(at(2026, 5, 11, 2, 30), now), "⏸ 한도 대기 · 5/11 02:30 재개");
  assert.equal(statusText(null, now), "⏸ 한도 대기 · 재개 시각 미정");
  assert.equal(hhmm(null, now), "--:--");

  for (const [resetAt, expected] of [[at(2026, 5, 11, 2, 30), "5/11 02:30"], [at(2026, 5, 10, 14, 5), "14:05"]]) {
    const h = createHarness({ now });
    const core = startKeepalive(h.pi, h.deps());
    await h.fire("session_start", { type: "session_start" });
    core.state.parkState = "park-wait";
    core.state.resetAt = resetAt;
    await h.commands.get("keepalive").handler("status", h.ctx);
    const text = h.notifications.at(-1).text;
    assert.ok(text.startsWith(`한도  ${statusText(resetAt, now)} (`), text);
    assert.ok(statusText(resetAt, now).includes(expected), text);
    h.cleanup();
  }
});

test("harness runs one event's handlers sequentially in registration order, tool_call stops at first block", async () => {
  const h = createHarness();
  const order = [];
  h.pi.on("tool_call", async () => { order.push("a-start"); await Promise.resolve(); await Promise.resolve(); order.push("a-end"); return { block: true, reason: "a" }; });
  h.pi.on("tool_call", () => { order.push("b"); });
  const results = await h.fire("tool_call", { toolName: "x" });
  assert.deepEqual(order, ["a-start", "a-end"]);
  assert.equal(results.length, 1);
  h.pi.on("agent_end", async () => { order.push("c-start"); await Promise.resolve(); order.push("c-end"); });
  h.pi.on("agent_end", () => { order.push("d"); });
  await h.fire("agent_end", {});
  assert.deepEqual(order.slice(2), ["c-start", "c-end", "d"]);
  h.cleanup();
});
