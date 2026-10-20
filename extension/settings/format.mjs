import { parseDuration as parseDurationValue } from "../keepwarm/cli/expiry.mjs";

const numberText = (n) => String(n);

export function formatDuration(min) {
  if (min < 60) return `${numberText(min)}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${numberText(m)}분`;
}

export function formatDurationToken(min) {
  if (min === 0) return "0";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h ? `${numberText(h)}h` : ""}${m ? `${numberText(m)}m` : ""}`;
}

export function formatPercent(n) {
  return `${numberText(n)}%`;
}

export function formatOnOff(value) {
  return value ? "켜짐" : "꺼짐";
}

export function formatUsd(n) {
  return `$${numberText(n)}`;
}

export function parsePercent(text) {
  if (typeof text !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)%?\s*$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value > 0 && value <= 100 ? value : undefined;
}

export function parseDuration(text) {
  const value = parseDurationValue(text);
  return Number.isNaN(value) ? undefined : value;
}

export function parseOnOff(text) {
  if (typeof text !== "string") return undefined;
  switch (text.trim().toLowerCase()) {
    case "on":
    case "true":
    case "켜짐": return true;
    case "off":
    case "false":
    case "꺼짐": return false;
    default: return undefined;
  }
}

export function parseUsd(text) {
  if (typeof text !== "string") return undefined;
  const match = /^\s*\$?(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value >= 0 ? value : undefined;
}

export function stepValue(steps, current, dir, { wrap = false } = {}) {
  if (steps.length === 0) return current;
  let index = steps.findIndex((step) => step === current);
  if (index < 0) {
    if (dir > 0) index = steps.findIndex((step) => step > current);
    else {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i] < current) { index = i; break; }
      }
    }
    if (index < 0) return wrap ? (dir > 0 ? steps[0] : steps.at(-1)) : (dir > 0 ? steps.at(-1) : steps[0]);
    return steps[index];
  }
  const next = index + (dir > 0 ? 1 : -1);
  if (next >= 0 && next < steps.length) return steps[next];
  return wrap ? (dir > 0 ? steps[0] : steps.at(-1)) : steps[index];
}

export function withValue(grid, value) {
  return [...new Set([...grid, value])].sort((a, b) => a - b);
}
