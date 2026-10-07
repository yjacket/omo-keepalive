import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = {
  thresholds: { fiveHour: 90, sevenDay: 95 },
  waitLimitMs: {
    "anthropic-subscription": 14400000,
    "chatgpt-subscription": 7200000,
  },
  warm: {
    "anthropic-subscription": { on: true, intervalMs: 3300000 },
    "chatgpt-subscription": { on: true, intervalMs: 1620000, requireTtlSeconds: 1800 },
  },
  enabled: true,
  pollMinIntervalMs: 60000,
  resumeGraceMs: 60000,
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function loadConfig({ env = process.env, homeDir = homedir(), fs = { readFileSync } } = {}) {
  const path = env.OMO_LIMITLESS_CONFIG || join(homeDir, ".omo", "limitless", "config.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { config: structuredClone(DEFAULTS), warnings: [] };
    return { config: structuredClone(DEFAULTS), warnings: [`config: unable to parse or read ${path}`] };
  }

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
  for (const [lane, defaults] of Object.entries(DEFAULTS.warm)) {
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
    for (const key of ["intervalMs", ...(defaults.requireTtlSeconds === undefined ? [] : ["requireTtlSeconds"])]) {
      if (value[key] === undefined) continue;
      if (validNumber(value[key])) config.warm[lane][key] = value[key];
      else warnings.push(`warm.${lane}.${key}: invalid value`);
    }
  }
  for (const key of ["enabled", "pollMinIntervalMs", "resumeGraceMs"]) {
    if (raw[key] === undefined) continue;
    if (key === "enabled" ? typeof raw[key] === "boolean" : validNumber(raw[key])) config[key] = raw[key];
    else warnings.push(`${key}: invalid value`);
  }
  return { config, warnings };
}
