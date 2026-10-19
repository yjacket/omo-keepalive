// Marks omo-ai's two unflagged before_agent_start registrations previewSafe, so senpi's prompt-prefix preview
// (keepwarm's cache ping) is not blocked by them. Idempotent and fail-closed: it changes the bundle only when
// exactly the two known registrations are found, and only when the result parses.
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync, renameSync as nodeRenameSync, statSync as nodeStatSync, utimesSync as nodeUtimesSync, writeFileSync as nodeWriteFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FLAG = ",{previewSafe:!0}";
const BACKUP_SUFFIX = ".before-previewsafe";

// Index of the "}" matching the block whose body starts at `start` (minified-JS aware: strings, templates, regex, comments).
function matchBrace(s, start) {
  let prevSig = "", prevWord = "", word = "";
  const KW = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do"]);
  const scan = (i, depth) => {
    for (; i < s.length; i++) {
      const c = s[i];
      if (/[A-Za-z0-9_$]/.test(c)) { word += c; prevSig = c; continue; }
      if (word) { prevWord = word; word = ""; }
      if (c === " " || c === "\n" || c === "\t" || c === "\r") continue;
      if (c === '"' || c === "'") { i++; while (s[i] !== c) { if (s[i] === "\\") i++; i++; } prevSig = c; continue; }
      if (c === "`") { i = tpl(i + 1); prevSig = "x"; continue; }
      if (c === "/") {
        if (s[i + 1] === "/") { while (s[i] !== "\n") i++; continue; }
        if (s[i + 1] === "*") { i = s.indexOf("*/", i + 2) + 1; continue; }
        if (prevSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(prevSig) || KW.has(prevWord)) {
          i++;
          let cls = false;
          for (; s[i] !== "/" || cls; i++) { if (s[i] === "\\") i++; else if (s[i] === "[") cls = true; else if (s[i] === "]") cls = false; }
          prevSig = "x";
          continue;
        }
      }
      if (c === "{") depth++;
      else if (c === "}") { if (depth === 0) return i; depth--; }
      prevSig = c;
      prevWord = "";
    }
    throw new Error("unbalanced");
  };
  const tpl = (i) => {
    for (; i < s.length; i++) {
      if (s[i] === "\\") i++;
      else if (s[i] === "$" && s[i + 1] === "{") { const sv = [prevSig, prevWord, word]; word = ""; i = scan(i + 2, 0); [prevSig, prevWord, word] = sv; }
      else if (s[i] === "`") return i;
    }
    throw new Error("unterminated template");
  };
  return scan(start, 0);
}

/** Pure: returns the patched source, or why it was left alone. Does not parse or write anything. */
export function patchOmoSource(src) {
  // gateway-rules: X.on("before_agent_start", a) shortly after "({ensureStore:async()=>".
  const regs = [...src.matchAll(/\b\w+\.on\("before_agent_start",(\w+)(,\{previewSafe:!0\})?\)/g)];
  const gateway = regs.filter((m) => src.slice(Math.max(0, m.index - 3000), m.index).includes("({ensureStore:async()=>"));
  if (gateway.length !== 1) return { status: "no-match", detail: `gateway registrations=${gateway.length}` };
  const unflaggedOthers = regs.filter((m) => m !== gateway[0] && m[2] === undefined);
  if (unflaggedOthers.length > 0) return { status: "no-match", detail: `unknown unflagged bare registrations=${unflaggedOthers.length}` };

  // onboarding: arrow registration whose first statement is the preview guard.
  const ob = [...src.matchAll(/\b\w+\.on\("before_agent_start",\((\w+),(\w+)\)=>\{if\(!\w+\(\1\)\|\|"prompt"!==\1\.trigger\|\|!0===\1\.preview\|\|/g)];
  if (ob.length !== 1) return { status: "no-match", detail: `onboarding registrations=${ob.length}` };
  const open = ob[0].index + ob[0][0].indexOf("=>{") + 2;
  let close;
  try {
    close = matchBrace(src, open + 1);
  } catch (error) {
    return { status: "no-match", detail: `onboarding body: ${error.message}` };
  }
  const obFlagged = src.startsWith(FLAG + ")", close + 1);
  if (!obFlagged && src[close + 1] !== ")") return { status: "no-match", detail: "onboarding call does not close after body" };

  const gFlagged = gateway[0][2] !== undefined;
  if (gFlagged && obFlagged) return { status: "already" };

  const edits = [];
  if (!gFlagged) edits.push(gateway[0].index + gateway[0][0].length - 1);
  if (!obFlagged) edits.push(close + 1);
  edits.sort((x, y) => x - y);
  let out = src;
  for (const at of [...edits].reverse()) out = out.slice(0, at) + FLAG + out.slice(at);
  return { status: "patched", out, sites: edits };
}

const defaultValidate = globalThis.Bun
  ? (text) => {
      new Bun.Transpiler({ loader: "js" }).transformSync(text); // throws on a syntax error
    }
  : null;

/**
 * Patches the installed omo-ai bundle (resolved from OMO_BIN). Never throws.
 * validate(text) must throw when text does not parse; null means no parser is available and nothing is written.
 */
export function ensureOmoPreviewSafe({ env = process.env, fs = { existsSync: nodeExistsSync, readFileSync: nodeReadFileSync, writeFileSync: nodeWriteFileSync, renameSync: nodeRenameSync, statSync: nodeStatSync, utimesSync: nodeUtimesSync }, validate = defaultValidate } = {}) {
  if (env.OMO_KEEPALIVE_PREVIEW_SAFE === "off") return { status: "disabled" };
  if (!env.OMO_BIN) return { status: "no-omo" };
  let file;
  try {
    file = join(dirname(dirname(env.OMO_BIN)), "plugin", "extensions", "omo.js");
    if (!fs.existsSync(file)) return { status: "no-omo", file };
    const src = fs.readFileSync(file, "utf8");
    const r = patchOmoSource(src);
    if (r.status !== "patched") return { status: r.status, file, detail: r.detail };
    if (validate === null) return { status: "no-parser", file };
    validate(r.out);
    const backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, src);
    // omo doctor flags engines started before the bundle's mtime, so the original times are restored after the swap.
    const orig = fs.statSync(file);
    const tmp = file + ".previewsafe.tmp";
    fs.writeFileSync(tmp, r.out);
    fs.renameSync(tmp, file);
    fs.utimesSync(file, orig.atime, orig.mtime);
    return { status: "patched", file };
  } catch (error) {
    return { status: "error", file, detail: String(error?.message ?? error) };
  }
}
