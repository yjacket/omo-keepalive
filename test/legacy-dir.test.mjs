import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyDir } from "../extension/state.mjs";

const tempHome = () => mkdtempSync(join(tmpdir(), "keepalive-legacy-"));

test("migrateLegacyDir moves the old folder when the new one is absent", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, ".omo", "limitless", "state"), { recursive: true });
    writeFileSync(join(home, ".omo", "limitless", "state", "a.json"), "{\"a\":1}");
    assert.equal(migrateLegacyDir(home), null);
    assert.equal(readFileSync(join(home, ".omo", "keepalive", "state", "a.json"), "utf8"), "{\"a\":1}");
    assert.equal(existsSync(join(home, ".omo", "limitless")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("migrateLegacyDir leaves both folders alone when the new one exists", () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, ".omo", "limitless"), { recursive: true });
    mkdirSync(join(home, ".omo", "keepalive"), { recursive: true });
    writeFileSync(join(home, ".omo", "limitless", "old.json"), "{}");
    assert.equal(migrateLegacyDir(home), null);
    assert.equal(existsSync(join(home, ".omo", "limitless", "old.json")), true);
    assert.equal(existsSync(join(home, ".omo", "keepalive", "old.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("migrateLegacyDir does nothing when neither folder exists", () => {
  const home = tempHome();
  try {
    assert.equal(migrateLegacyDir(home), null);
    assert.equal(existsSync(join(home, ".omo")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("migrateLegacyDir reports a failing rename", () => {
  const fakeFs = {
    existsSync: (path) => String(path).endsWith("limitless"),
    renameSync: () => {
      throw new Error("EPERM");
    },
  };
  const result = migrateLegacyDir("C:/fake-home", fakeFs);
  assert.equal(typeof result, "string");
  assert.match(result, /EPERM/);
});
