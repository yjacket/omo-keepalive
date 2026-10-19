import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULTS } from "../extension/config.mjs";

const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === "object" ? flatten(v, prefix + k + ".") : [[prefix + k, v]]);

const expected = Object.fromEntries(flatten(DEFAULTS));
const FORBIDDEN = [/OMO_KEEPALIVE_CONFIG/, /OMO_KEEPALIVE_FAKE_\w*/, /OMO_KEEPALIVE_WARM_INTERVAL_MS/, /OMO_KEEPALIVE_AUTH_PATH/, /OMO_KEEPALIVE_QA_COMMAND_PREFIX/];

for (const file of ["README.md", "README.ko.md"]) {
  const text = readFileSync(new URL("../" + file, import.meta.url), "utf8");
  test(file + " defaults table equals config.mjs DEFAULTS", () => {
    const rows = [...text.matchAll(/^\| `([\w.-]+)` \| `([^`]+)` \|/gm)];
    const actual = Object.fromEntries(rows.map(([, k, v]) => [k, JSON.parse(v)]));
    assert.equal(rows.length, Object.keys(actual).length, "duplicate keys in table");
    assert.deepEqual(actual, expected);
  });
  test(file + " names no test-only env var", () => {
    for (const re of FORBIDDEN) assert.doesNotMatch(text, re);
  });
}
