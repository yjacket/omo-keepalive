import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, configStamp, loadConfig, parseConfig, updateKeepaliveConfig } from "../extension/config.mjs";

function withHome(run) {
  const homeDir = mkdtempSync(join(tmpdir(), "keepalive-config-"));
  try { run(homeDir); } finally { rmSync(homeDir, { recursive: true, force: true }); }
}

test("configPath uses override or the keepalive home path", () => {
  assert.equal(configPath({ env: { OMO_KEEPALIVE_CONFIG: "custom.json" }, homeDir: "home" }), "custom.json");
  assert.equal(configPath({ env: {}, homeDir: "home" }), join("home", ".omo", "keepalive", "config.json"));
});

test("parseConfig returns validated config and warnings", () => {
  const parsed = parseConfig({ thresholds: { fiveHour: 101 } });
  assert.equal(parsed.config.thresholds.fiveHour, 90);
  assert.deepEqual(parsed.warnings, ["thresholds.fiveHour: invalid value"]);
});

test("configStamp distinguishes missing, stat errors, and file versions", () => {
  assert.equal(configStamp("missing", { statSync() { const error = new Error(); error.code = "ENOENT"; throw error; } }), "none");
  assert.equal(configStamp("bad", { statSync() { throw new Error(); } }), "error");
  const value = { mtimeMs: 12.5, size: 7 };
  assert.equal(configStamp("file", { statSync: () => value }), "12.5:7");
});

test("writer preserves unknown keys, loads the update, and removes temp file", () => withHome((homeDir) => {
  updateKeepaliveConfig({ homeDir }, (draft) => {
    draft.future = { enabled: true };
    draft.thresholds = { fiveHour: 97 };
  });
  const path = configPath({ env: {}, homeDir });
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.thresholds.fiveHour, 97);
  assert.deepEqual(raw.future, { enabled: true });
  assert.equal(loadConfig({ env: {}, homeDir }).config.thresholds.fiveHour, 97);
  assert.throws(() => statSync(`${path}.${process.pid}.tmp`), { code: "ENOENT" });
}));

test("writer permits untouched invalid fields and preserves them", () => withHome((homeDir) => {
  const path = configPath({ env: {}, homeDir });
  mkdirSync(join(homeDir, ".omo", "keepalive"), { recursive: true });
  writeFileSync(path, '{"pollMinIntervalMs":-1,"thresholds":{"fiveHour":90}}');
  updateKeepaliveConfig({ homeDir }, (draft) => { draft.thresholds.sevenDay = 97; });
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.pollMinIntervalMs, -1);
  assert.equal(raw.thresholds.sevenDay, 97);
}));

test("writer uses a returned replacement object", () => withHome((homeDir) => {
  const path = configPath({ env: {}, homeDir });
  mkdirSync(join(homeDir, ".omo", "keepalive"), { recursive: true });
  writeFileSync(path, '{"thresholds":{"fiveHour":90},"old":true}');
  updateKeepaliveConfig({ homeDir }, () => ({ thresholds: { fiveHour: 80 }, future: 2 }));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { thresholds: { fiveHour: 80 }, future: 2 });
}));

test("writer rejects invalid returned replacement without changing the file", () => withHome((homeDir) => {
  const path = configPath({ env: {}, homeDir });
  mkdirSync(join(homeDir, ".omo", "keepalive"), { recursive: true });
  writeFileSync(path, '{"thresholds":{"fiveHour":90},"old":true}');
  const before = readFileSync(path, "utf8");
  assert.throws(
    () => updateKeepaliveConfig({ homeDir }, () => ({ thresholds: { sevenDay: 150 } })),
    /thresholds\.sevenDay: invalid value/,
  );
  assert.equal(readFileSync(path, "utf8"), before);
}));

test("writer rejects newly invalid edits without changing the file", () => withHome((homeDir) => {
  const path = configPath({ env: {}, homeDir });
  mkdirSync(join(homeDir, ".omo", "keepalive"), { recursive: true });
  writeFileSync(path, '{"thresholds":{"fiveHour":90}}');
  const before = readFileSync(path, "utf8");
  assert.throws(() => updateKeepaliveConfig({ homeDir }, (draft) => { draft.thresholds.fiveHour = 120; }), /thresholds\.fiveHour: invalid value/);
  assert.equal(readFileSync(path, "utf8"), before);
}));

test("writer rejects malformed or non-object config without changing it", () => withHome((homeDir) => {
  const path = configPath({ env: {}, homeDir });
  mkdirSync(join(homeDir, ".omo", "keepalive"), { recursive: true });
  for (const contents of ["{ broken", "[]"]) {
    writeFileSync(path, contents);
    assert.throws(() => updateKeepaliveConfig({ homeDir }, () => {}), new RegExp(`keepalive config unreadable: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(readFileSync(path, "utf8"), contents);
  }
}));
