import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULTS = {
  thresholds: { fiveHour: 90, sevenDay: 95 },
  waitLimitMs: {
    "anthropic-subscription": 14400000,
    "chatgpt-subscription": 7200000,
  },
  // Whether the keepwarm feature may warm a session while it waits in park-wait. When and how often it pings is
  // keepwarm's lane table, not this config.
  warm: {
    "anthropic-subscription": { on: true },
    "chatgpt-subscription": { on: true },
  },
  enabled: true,
  pollMinIntervalMs: 60000,
  resumeGraceMs: 60000,
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function configPath({ env = process.env, homeDir = homedir() } = {}) {
  return env.OMO_KEEPALIVE_CONFIG || join(homeDir, ".omo", "keepalive", "config.json");
}

export function parseConfig(raw) {
  const config = structuredClone(DEFAULTS);
  const warnings = [];
  if (!isRecord(raw)) return { config, warnings: ["config: expected an object"] };
  for (const key of ["thresholds", "waitLimitMs", "warm"]) {
    if (raw[key] !== undefined && !isRecord(raw[key])) warnings.push(`${key}: expected an object`);
  }
  for (const key of ["fiveHour", "sevenDay"]) {
    const value = raw.thresholds?.[key];
    if (value === undefined) continue;
    if (validNumber(value) && value <= 100) config.thresholds[key] = value;
    else warnings.push(`thresholds.${key}: invalid value`);
  }
  for (const key of Object.keys(DEFAULTS.waitLimitMs)) {
    const value = raw.waitLimitMs?.[key];
    if (value === undefined) continue;
    if (validNumber(value)) config.waitLimitMs[key] = value;
    else warnings.push(`waitLimitMs.${key}: invalid value`);
  }
  for (const lane of Object.keys(DEFAULTS.warm)) {
    const value = raw.warm?.[lane];
    if (value === undefined) continue;
    if (!isRecord(value)) {
      warnings.push(`warm.${lane}: expected an object`);
      continue;
    }
    if (value.on !== undefined) {
      if (typeof value.on === "boolean") config.warm[lane].on = value.on;
      else warnings.push(`warm.${lane}.on: invalid value`);
    }
  }
  for (const key of ["enabled", "pollMinIntervalMs", "resumeGraceMs"]) {
    if (raw[key] === undefined) continue;
    if (key === "enabled" ? typeof raw[key] === "boolean" : validNumber(raw[key])) config[key] = raw[key];
    else warnings.push(`${key}: invalid value`);
  }
  return { config, warnings };
}

export function loadConfig({ env = process.env, homeDir = homedir(), fs = { readFileSync } } = {}) {
  const path = configPath({ env, homeDir });
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { config: structuredClone(DEFAULTS), warnings: [] };
    return { config: structuredClone(DEFAULTS), warnings: [`config: unable to parse or read ${path}`] };
  }
  return parseConfig(raw);
}

export function configStamp(path, fs = { statSync }) {
  try {
    const stat = fs.statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    return error?.code === "ENOENT" ? "none" : "error";
  }
}

export function updateKeepaliveConfig(
  { env = process.env, homeDir = homedir(), fs = { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, statSync } } = {},
  mutator,
) {
  const path = configPath({ env, homeDir });
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`keepalive config unreadable: ${path}`);
    raw = {};
  }
  if (!isRecord(raw)) throw new Error(`keepalive config unreadable: ${path}`);

  let draft = structuredClone(raw);
  const replacement = mutator(draft);
  if (isRecord(replacement)) draft = replacement;
  const rawWarnings = new Set(parseConfig(raw).warnings);
  const newWarnings = parseConfig(draft).warnings.filter((warning) => !rawWarnings.has(warning));
  if (newWarnings.length > 0) throw new Error(newWarnings.join("; "));

  const temp = `${path}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(draft, null, 2)}\n`);
    fs.renameSync(temp, path);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  return parseConfig(draft).config;
}
