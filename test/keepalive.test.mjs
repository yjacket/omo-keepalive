import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";
import { createKeepalive } from "../extension/keepalive.mjs";

test("child-session factory returns null and registers no handlers", async () => {
  const harness = createHarness({ isChild: true });
  try {
    const result = createKeepalive(harness.pi, { env: { OMO_SENPI_TASK_RPC_CHILD: "1" }, homeDir: harness.tmpHome });
    assert.equal(result, null);
    assert.equal(harness.handlers.size, 0);
    assert.equal(harness.commands.size, 0);
  } finally {
    harness.cleanup();
  }
});

test("main session loads config without registering tools or handlers", () => {
  const harness = createHarness();
  try {
    const result = createKeepalive(harness.pi, { env: {}, homeDir: harness.tmpHome });
    assert.equal(result.config.enabled, true);
    assert.equal(harness.handlers.size, 0);
    assert.equal(harness.commands.size, 0);
  } finally {
    harness.cleanup();
  }
});
