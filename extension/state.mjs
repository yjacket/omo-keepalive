// limitless persistence (plan todo 5): per-session state and per-account shared usage snapshots.
//
//   <home>/.omo/limitless/state/<sid>.json              session state (see core.mjs header for keys)
//   <home>/.omo/limitless/usage/<provider>-<sha1>.json  {v:1, observedAt, snapshot} shared by all sessions
//
// Every write is temp + rename. Every read treats a missing, unreadable, or malformed file as absent
// and never throws. `fs` is a sync node:fs subset {readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync}.
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

let tempCounter = 0;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function limitlessDir(homeDir) {
  return join(homeDir, ".omo", "limitless");
}

export function sanitizeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function statePath(homeDir, sessionId) {
  return join(limitlessDir(homeDir), "state", `${sanitizeId(sessionId)}.json`);
}

export function snapshotPath(homeDir, provider, account) {
  const digest = createHash("sha1").update(String(account)).digest("hex");
  return join(limitlessDir(homeDir), "usage", `${sanitizeId(provider)}-${digest}.json`);
}

export function readJson(path, fs = nodeFs) {
  try {
    const parsed = JSON.parse(String(fs.readFileSync(path, "utf8")));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Returns true when the file was written. Never throws; a failed write leaves no temp file behind.
export function writeJsonAtomic(path, data, fs = nodeFs) {
  const temp = `${path}.${process.pid}.${++tempCounter}.tmp`;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(data, null, 2));
    fs.renameSync(temp, path);
    return true;
  } catch {
    try { fs.unlinkSync?.(temp); } catch {}
    return false;
  }
}

export function loadState({ homeDir, sessionId, fs = nodeFs }) {
  const raw = readJson(statePath(homeDir, sessionId), fs);
  return raw && raw.v === 1 ? raw : null;
}

export function saveState({ homeDir, sessionId, state, fs = nodeFs }) {
  return writeJsonAtomic(statePath(homeDir, sessionId), { ...state, v: 1, sessionId }, fs);
}

const validSnapshot = (snapshot, provider, account) =>
  isRecord(snapshot) && snapshot.provider === provider && snapshot.account === account
  && Array.isArray(snapshot.windows) && typeof snapshot.source === "string";

export function readSharedSnapshot({ homeDir, provider, account, fs = nodeFs }) {
  const raw = readJson(snapshotPath(homeDir, provider, account), fs);
  if (!raw || !Number.isFinite(raw.observedAt) || !validSnapshot(raw.snapshot, provider, account)) return null;
  return { observedAt: raw.observedAt, snapshot: raw.snapshot };
}

export function writeSharedSnapshot({ homeDir, snapshot, observedAt, fs = nodeFs }) {
  return writeJsonAtomic(snapshotPath(homeDir, snapshot.provider, snapshot.account), { v: 1, observedAt, snapshot }, fs);
}
