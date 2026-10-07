// limitless feature module: plan todo 14 "self-launch fallback when the session runs outside Orca and herdr".
//
// Before park-exit shuts a session down in an unknown terminal, register ONE one-shot Windows scheduled task
// (\omo-limitless\omo-limitless-resume-<sid8>, trigger = reset + grace, default interactive non-elevated
// principal, StartWhenAvailable, -Force so a leftover task of an earlier episode is replaced) that opens
// Windows Terminal (wt.exe if found, else cmd.exe) running `omo --session <sid>`.
//
// Injection safety: the PowerShell scripts below are STATIC text. Session id, cwd, executable and trigger time
// reach PowerShell only through process environment variables (OMO_LL_*), never through the command text, and
// the task action argument is assembled from a PowerShell array. sid is allow-listed (omo-health terminal.mjs
// regex), cwd must be an absolute existing directory without `"`, `%` or control characters (the characters that
// can break out of the quoted action argument or be expanded by cmd.exe).
//
// Success is claimed only when Get-ScheduledTask, run inside the same script after registration, confirms
// the task; every PowerShell call has a hard timeout. Never recurring, never elevated.
//
// API: createSelfLaunch(deps) -> { register({sessionId,cwd,at}) -> {ok, selfTask?, reason?}, unregister({sessionId,selfTask}) }.
// register THROWS on invalid input before any PowerShell call (park-exit treats a throw as "stay park-wait").
import { spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import { basename, delimiter, isAbsolute, join, normalize } from "node:path";

export const TASK_PATH = "\\omo-limitless\\";
export const SID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/; // omo-health/src/act/terminal.mjs:24
export const POWERSHELL_TIMEOUT_MS = 30_000;
const MIN_LEAD_MS = 20_000;

export const taskName = (sessionId) => `omo-limitless-resume-${sessionId.slice(0, 8)}`;
export const selfTaskOf = (sessionId) => `${TASK_PATH}${taskName(sessionId)}`;

const pad = (n) => String(n).padStart(2, "0");
export function isoLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// No double quote anywhere: [char]34 keeps the text immune to command-line quoting layers.
export const REGISTER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$q = [string][char]34",
  "$name = $env:OMO_LL_TASK",
  "$at = [datetime]::ParseExact($env:OMO_LL_AT, 'yyyy-MM-ddTHH:mm:ss', [cultureinfo]::InvariantCulture)",
  "$l = @($env:OMO_LL_LAUNCH.Split([char]10) | ForEach-Object { $q + $_ + $q })",
  "if ($env:OMO_LL_KIND -eq 'wt') { $argv = @('-d', ($q + $env:OMO_LL_CWD + $q)) + $l + @('--session', $env:OMO_LL_SID) }",
  "else { $argv = @('/c', 'start', ($q + 'limitless' + $q), '/D', ($q + $env:OMO_LL_CWD + $q)) + $l + @('--session', $env:OMO_LL_SID) }",
  "$trigger = New-ScheduledTaskTrigger -Once -At $at",
  "$action = New-ScheduledTaskAction -Execute $env:OMO_LL_EXE -Argument ($argv -join ' ')",
  "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable",
  "Register-ScheduledTask -TaskName $name -TaskPath '\\omo-limitless\\' -Trigger $trigger -Action $action -Settings $settings -Force | Out-Null",
  "$t = Get-ScheduledTask -TaskName $name -TaskPath '\\omo-limitless\\'",
  "Write-Output ('LIMITLESS-REGISTERED ' + $t.TaskPath + $t.TaskName)",
].join("\n");

export const UNREGISTER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$name = $env:OMO_LL_TASK",
  "$t = Get-ScheduledTask -TaskName $name -TaskPath '\\omo-limitless\\' -ErrorAction SilentlyContinue",
  "if ($null -eq $t) { Write-Output 'LIMITLESS-GONE'; exit 0 }",
  "Unregister-ScheduledTask -TaskName $name -TaskPath '\\omo-limitless\\' -Confirm:$false",
  "$still = Get-ScheduledTask -TaskName $name -TaskPath '\\omo-limitless\\' -ErrorAction SilentlyContinue",
  "if ($null -ne $still) { Write-Output 'LIMITLESS-STILL-PRESENT'; exit 3 }",
  "Write-Output 'LIMITLESS-UNREGISTERED'",
].join("\n");

// Real runner: static script via -EncodedCommand, values via env, hard timeout that kills the process tree.
export function powershellRunner({ timeoutMs = POWERSHELL_TIMEOUT_MS, env = process.env } = {}) {
  return ({ script, env: extra }) => new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let timedOut = false;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { env: { ...env, ...extra }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      timedOut = true;
      try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
      try { child.kill(); } catch {}
      finish({ code: null, stdout: out, stderr: err, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (error) => finish({ code: null, stdout: out, stderr: String(error?.message ?? error), timedOut }));
    child.on("close", (code) => finish({ code, stdout: out, stderr: err, timedOut }));
  });
}

// Launcher of the running session. {exe, args}: exe is "omo" (PATH lookup) or an absolute existing file without
// shell metacharacters; args are metacharacter-free strings (the first, when present, an existing absolute file).
export const FALLBACK_LAUNCHER = Object.freeze({ exe: "omo", args: Object.freeze([]) });
// eslint-disable-next-line no-control-regex
const UNSAFE_RE = /["%&|<>^`$!\u0000-\u001f]/;
const OMO_LAUNCHER_RE = /^omo(\.exe|\.cmd)?$/i;
const RUNTIME_RE = /^(bun|node)(\.exe)?$/i;

const isFile = (p, fs) => { try { return Boolean(fs.statSync(p)?.isFile?.()); } catch { return false; } };

export function validLauncher(launcher, fs = nodeFs) {
  const exe = launcher?.exe;
  const args = launcher?.args ?? [];
  if (typeof exe !== "string" || !Array.isArray(args)) return null;
  if (exe === "omo" && args.length === 0) return { exe, args: [] };
  if (UNSAFE_RE.test(exe) || !isAbsolute(exe) || !isFile(exe, fs)) return null;
  for (const [i, arg] of args.entries()) {
    if (typeof arg !== "string" || arg === "" || UNSAFE_RE.test(arg)) return null;
    if (i === 0 && (!isAbsolute(arg) || !isFile(arg, fs))) return null;
  }
  return { exe: normalize(exe), args: args.map((a, i) => (i === 0 ? normalize(a) : a)) };
}

// Static script; the pid arrives through the environment. Prints the executable path of each ancestor, nearest first.
export const ANCESTOR_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$byId = @{}",
  "Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath | ForEach-Object { $byId[[int]$_.ProcessId] = $_ }",
  "$p = [int]$env:OMO_LL_PID",
  "for ($i = 0; $i -lt 8; $i++) {",
  "  $c = $byId[$p]",
  "  if (-not $c) { break }",
  "  $p = [int]$c.ParentProcessId",
  "  $a = $byId[$p]",
  "  if (-not $a) { break }",
  "  if ($a.ExecutablePath) { Write-Output $a.ExecutablePath }",
  "}",
].join("\n");

export async function probeAncestors({ pid = process.pid, env = process.env, timeoutMs = 15_000 } = {}) {
  const result = await powershellRunner({ timeoutMs, env })({ script: ANCESTOR_SCRIPT, env: { OMO_LL_PID: String(pid) } });
  if (result?.code !== 0 || result.timedOut) return [];
  return String(result.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Order: (1) nearest ancestor process that is an omo launcher (omo.exe / omo.cmd), (2) OMO_BIN run by the current
// bun/node executable, (3) bare "omo". Never throws.
export async function resolveLauncher({ env = process.env, execPath = process.execPath, fs = nodeFs, platform = process.platform,
  pid = process.pid, probe = probeAncestors } = {}) {
  if (platform === "win32") {
    try {
      for (const exe of (await probe({ pid, env })) ?? []) {
        if (!OMO_LAUNCHER_RE.test(basename(String(exe)))) continue;
        const launcher = validLauncher({ exe, args: [] }, fs);
        if (launcher) return launcher;
      }
    } catch {}
  }
  if (env.OMO_BIN && RUNTIME_RE.test(basename(String(execPath ?? "")))) {
    const launcher = validLauncher({ exe: execPath, args: [env.OMO_BIN] }, fs);
    if (launcher) return launcher;
  }
  return { exe: "omo", args: [] };
}

// lstat, not exists/stat: the WindowsApps wt.exe is an app-execution-alias reparse point that stat() rejects with EACCES.
export function findOnPath(name, { env, fs }) {
  const dirs = [join(env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps"), ...String(env.PATH ?? env.Path ?? "").split(delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try { fs.lstatSync(candidate); return candidate; } catch {}
  }
  return null;
}

function validateCwd(cwd, fs) {
  if (typeof cwd !== "string" || cwd === "" || !isAbsolute(cwd)) throw new Error("self-launch: cwd must be an absolute path");
  // eslint-disable-next-line no-control-regex
  if (/["%\u0000-\u001f]/.test(cwd)) throw new Error("self-launch: cwd contains a forbidden character");
  let stat = null;
  try { stat = fs.statSync(cwd); } catch {}
  if (!stat?.isDirectory?.()) throw new Error("self-launch: cwd does not exist");
  // `"C:\dir\"` would escape the closing quote; a drive root keeps a trailing dot instead.
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\.` : trimmed;
}

function validateSid(sessionId) {
  if (typeof sessionId !== "string" || !SID_RE.test(sessionId)) throw new Error("self-launch: invalid session id");
  return sessionId;
}

const lastLine = (text) => String(text ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";

export function createSelfLaunch(deps = {}) {
  const env = deps.env ?? process.env;
  const fs = deps.fs ?? nodeFs;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => Date.now());
  const run = deps.runPowerShell ?? powershellRunner({ env });
  const findExe = deps.findExe ?? ((name) => findOnPath(name, { env, fs }));

  async function register({ sessionId, cwd, at, launcher } = {}) {
    const sid = validateSid(sessionId);
    const dir = validateCwd(cwd, fs);
    if (!Number.isFinite(at)) throw new Error("self-launch: invalid trigger time");
    if (platform !== "win32") return { ok: false, reason: "not-windows" };
    // Windows Terminal splits its command line at ';' even inside quotes: such a cwd must only reach cmd.exe.
    const launch = validLauncher(launcher, fs) ?? { exe: "omo", args: [] };
    const wt = dir.includes(";") || launch.exe.includes(";") ? null : findExe("wt.exe");
    const kind = wt ? "wt" : "cmd";
    const exe = wt ?? env.ComSpec ?? "cmd.exe";
    const selfTask = selfTaskOf(sid);
    const result = await run({
      script: REGISTER_SCRIPT,
      env: {
        OMO_LL_TASK: taskName(sid), OMO_LL_SID: sid, OMO_LL_CWD: dir, OMO_LL_EXE: exe, OMO_LL_KIND: kind,
        OMO_LL_LAUNCH: [launch.exe, ...launch.args].join("\n"),
        OMO_LL_AT: isoLocal(Math.max(at, now() + MIN_LEAD_MS)),
      },
    });
    if (result?.timedOut) return { ok: false, reason: "powershell-timeout" };
    if (result?.code !== 0) return { ok: false, reason: `powershell-exit-${result?.code ?? "none"}: ${lastLine(result?.stderr).slice(0, 200)}` };
    if (lastLine(result.stdout) !== `LIMITLESS-REGISTERED ${selfTask}`) return { ok: false, reason: "registration-not-confirmed" };
    return { ok: true, selfTask };
  }

  async function unregister({ sessionId, selfTask } = {}) {
    const sid = validateSid(sessionId);
    if (selfTask !== selfTaskOf(sid)) throw new Error("self-launch: selfTask does not belong to this session");
    if (platform !== "win32") return { ok: false, reason: "not-windows" };
    const result = await run({ script: UNREGISTER_SCRIPT, env: { OMO_LL_TASK: taskName(sid) } });
    if (result?.timedOut) return { ok: false, reason: "powershell-timeout" };
    const line = lastLine(result?.stdout);
    if (result?.code === 0 && (line === "LIMITLESS-UNREGISTERED" || line === "LIMITLESS-GONE")) return { ok: true, gone: line === "LIMITLESS-GONE" };
    return { ok: false, reason: `unregister-failed: ${lastLine(result?.stderr).slice(0, 200) || line}` };
  }

  return { register, unregister };
}

export const selfLaunch = createSelfLaunch();
export const registerSelfLaunch = (request) => selfLaunch.register(request);
export const unregisterSelfLaunch = (request) => selfLaunch.unregister(request);
