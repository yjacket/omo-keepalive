import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ensureOmoPreviewSafe, omoSelfPreviewSafe, patchOmoSource } from "../../extension/keepwarm/omo-preview-safe.mjs";

const FLAG = ",{previewSafe:!0}";

// Synthetic fixtures mirroring the two minified shapes in omo-ai's plugin/extensions/omo.js.
const GATEWAY = 'var G=({ensureStore:async()=>null,blockForSession:()=>""});t.on("before_agent_start",a)}}}';
const GATEWAY_FLAGGED = 'var G=({ensureStore:async()=>null,blockForSession:()=>""});t.on("before_agent_start",a,{previewSafe:!0})}}}';
const ONBOARD = 'r.on("before_agent_start",(e,t)=>{if(!MR(e)||"prompt"!==e.trigger||!0===e.preview||!d(t))return;x(t)})';
const ONBOARD_FLAGGED = 'r.on("before_agent_start",(e,t)=>{if(!MR(e)||"prompt"!==e.trigger||!0===e.preview||!d(t))return;x(t)},{previewSafe:!0})';
const bundle = (gateway, onboard, extra = "") => `// omo:abc123:def456\n${extra}${gateway};${onboard};\n`;

test("unflagged fixture: patched with exactly two insertions", () => {
  const src = bundle(GATEWAY, ONBOARD);
  const r = patchOmoSource(src);
  assert.equal(r.status, "patched");
  assert.equal(r.sites.length, 2);
  assert.equal(r.out.length, src.length + 2 * FLAG.length);
  assert.equal(r.out.split(FLAG).length - 1, 2);
  assert.ok(r.out.startsWith("// omo:abc123:def456\n"), "line 1 is untouched");
});

test("already flagged fixture: already", () => {
  assert.equal(patchOmoSource(bundle(GATEWAY_FLAGGED, ONBOARD_FLAGGED)).status, "already");
});

test("patching twice is idempotent", () => {
  const once = patchOmoSource(bundle(GATEWAY, ONBOARD));
  assert.equal(patchOmoSource(once.out).status, "already");
});

test("a second unknown unflagged bare registration is no-match", () => {
  const r = patchOmoSource(bundle(GATEWAY, ONBOARD, 'q.on("before_agent_start",b);'));
  assert.equal(r.status, "no-match");
  assert.match(r.detail, /unknown unflagged/);
});

test("a changed onboarding guard is no-match", () => {
  const r = patchOmoSource(bundle(GATEWAY, ONBOARD.replace('"prompt"!==e.trigger', '"x"!==e.trigger')));
  assert.equal(r.status, "no-match");
  assert.match(r.detail, /onboarding/);
});

test("a bundle without the gateway store is no-match", () => {
  const r = patchOmoSource(bundle(GATEWAY.replace("ensureStore", "other"), ONBOARD));
  assert.equal(r.status, "no-match");
});

function omoTree(files, version) {
  const root = mkdtempSync(join(tmpdir(), "psafe-test-"));
  const bin = join(root, "bin", "omo.js");
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, "// bin\n");
  if (version !== undefined) writeFileSync(join(root, "package.json"), JSON.stringify({ name: "omo-ai", version }));
  const file = join(root, "plugin", "extensions", "omo.js");
  if (files !== null) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, files);
  }
  return { root, bin, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const okValidate = () => {};

test("ensureOmoPreviewSafe: disabled by the off switch", () => {
  assert.deepEqual(ensureOmoPreviewSafe({ env: { OMO_KEEPALIVE_PREVIEW_SAFE: "off", OMO_BIN: "x" } }), { status: "disabled" });
});

test("ensureOmoPreviewSafe: no-omo when OMO_BIN is unset or the bundle is missing", () => {
  assert.equal(ensureOmoPreviewSafe({ env: {} }).status, "no-omo");
  const t = omoTree(null);
  try {
    assert.equal(ensureOmoPreviewSafe({ env: { OMO_BIN: t.bin }, validate: okValidate }).status, "no-omo");
  } finally {
    t.cleanup();
  }
});

test("ensureOmoPreviewSafe: patched writes the file and a backup once; second call is already", () => {
  const original = bundle(GATEWAY, ONBOARD);
  const t = omoTree(original);
  try {
    const env = { OMO_BIN: t.bin };
    const first = ensureOmoPreviewSafe({ env, validate: okValidate });
    assert.equal(first.status, "patched");
    assert.equal(readFileSync(t.file, "utf8"), patchOmoSource(original).out);
    assert.equal(readFileSync(t.file + ".before-previewsafe", "utf8"), original);

    const second = ensureOmoPreviewSafe({ env, validate: okValidate });
    assert.equal(second.status, "already");
    assert.equal(readFileSync(t.file + ".before-previewsafe", "utf8"), original, "backup is not overwritten");
  } finally {
    t.cleanup();
  }
});

test("omoSelfPreviewSafe: 5.1.43 and later only", () => {
  for (const v of ["5.1.43", "5.1.48", "5.2.0", "6.0.0", "5.1.43-beta.1"]) assert.equal(omoSelfPreviewSafe(v), true, v);
  for (const v of ["5.1.42", "5.0.99", "4.9.100", null, "", "x"]) assert.equal(omoSelfPreviewSafe(v), false, String(v));
});

test("ensureOmoPreviewSafe: omo-ai 5.1.43+ is not-needed and the bundle is left alone", () => {
  const original = bundle(GATEWAY, ONBOARD);
  const t = omoTree(original, "5.1.43");
  try {
    assert.deepEqual(ensureOmoPreviewSafe({ env: { OMO_BIN: t.bin }, validate: okValidate }), { status: "not-needed", version: "5.1.43" });
    assert.equal(readFileSync(t.file, "utf8"), original);
  } finally {
    t.cleanup();
  }
});

test("ensureOmoPreviewSafe: omo-ai older than 5.1.43 is still patched", () => {
  const original = bundle(GATEWAY, ONBOARD);
  const t = omoTree(original, "5.1.42");
  try {
    assert.equal(ensureOmoPreviewSafe({ env: { OMO_BIN: t.bin }, validate: okValidate }).status, "patched");
    assert.equal(readFileSync(t.file, "utf8"), patchOmoSource(original).out);
  } finally {
    t.cleanup();
  }
});

test("ensureOmoPreviewSafe: patching keeps the original atime and mtime", () => {
  const original = bundle(GATEWAY, ONBOARD);
  const t = omoTree(original);
  try {
    const past = new Date("2020-01-02T03:04:05Z");
    utimesSync(t.file, past, past);
    const before = statSync(t.file);
    assert.equal(ensureOmoPreviewSafe({ env: { OMO_BIN: t.bin }, validate: okValidate }).status, "patched");
    const after = statSync(t.file);
    assert.equal(after.mtimeMs, before.mtimeMs, "mtime is unchanged");
    assert.equal(after.atimeMs, before.atimeMs, "atime is unchanged");
  } finally {
    t.cleanup();
  }
});

test("ensureOmoPreviewSafe: no parser means nothing is written", () => {
  const original = bundle(GATEWAY, ONBOARD);
  const t = omoTree(original);
  try {
    assert.equal(ensureOmoPreviewSafe({ env: { OMO_BIN: t.bin }, validate: null }).status, "no-parser");
    assert.equal(readFileSync(t.file, "utf8"), original);
  } finally {
    t.cleanup();
  }
});

test("ensureOmoPreviewSafe: output that fails to parse is an error and nothing is written", () => {
  const original = bundle(GATEWAY, ONBOARD);
  const t = omoTree(original);
  try {
    const r = ensureOmoPreviewSafe({
      env: { OMO_BIN: t.bin },
      validate: () => {
        throw new SyntaxError("bad");
      },
    });
    assert.equal(r.status, "error");
    assert.equal(readFileSync(t.file, "utf8"), original);
  } finally {
    t.cleanup();
  }
});
