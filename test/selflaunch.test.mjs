import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findOnPath, resolveLauncher, validLauncher, REGISTER_SCRIPT, UNREGISTER_SCRIPT, createSelfLaunch, isoLocal, selfTaskOf, taskName,
} from "../extension/selflaunch.mjs";

const SID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NOW = Date.UTC(2026, 9, 7, 3, 0, 0);
const AT = NOW + 5 * 3600000 + 60000;
const tmp = mkdtempSync(join(tmpdir(), "selflaunch-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const ok = (stdout) => ({ code: 0, stdout, stderr: "", timedOut: false });

function make({ wt = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe", reply, platform = "win32" } = {}) {
  const calls = [];
  const runPowerShell = async (req) => {
    calls.push(req);
    return reply ? reply(req) : ok(`LIMITLESS-REGISTERED ${selfTaskOf(SID)}\r\n`);
  };
  const sl = createSelfLaunch({ runPowerShell, findExe: () => wt, now: () => NOW, platform, env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } });
  return { sl, calls };
}

test("wt.exe case: exact static script, values only in env, selfTask returned", async () => {
  const { sl, calls } = make();
  const res = await sl.register({ sessionId: SID, cwd: tmp, at: AT });
  assert.deepEqual(res, { ok: true, selfTask: `\\omo-limitless\\omo-limitless-resume-${SID.slice(0, 8)}` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, REGISTER_SCRIPT);
  assert.match(REGISTER_SCRIPT, /Register-ScheduledTask -TaskName \$name -TaskPath '\\omo-limitless\\' -Trigger \$trigger -Action \$action -Settings \$settings -Force/);
  assert.match(REGISTER_SCRIPT, /New-ScheduledTaskTrigger -Once -At \$at/);
  assert.match(REGISTER_SCRIPT, /New-ScheduledTaskSettingsSet -StartWhenAvailable/);
  assert.match(REGISTER_SCRIPT, /@\('-d', \(\$q \+ \$env:OMO_LL_CWD \+ \$q\)\) \+ \$l \+ @\('--session', \$env:OMO_LL_SID\)/);
  assert.doesNotMatch(REGISTER_SCRIPT, /-RunLevel|-Principal|-User|-Daily|-Weekly|-Repetition|"/);
  assert.deepEqual(calls[0].env, {
    OMO_LL_TASK: taskName(SID), OMO_LL_SID: SID, OMO_LL_CWD: tmp, OMO_LL_EXE: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
    OMO_LL_KIND: "wt", OMO_LL_LAUNCH: "omo", OMO_LL_AT: isoLocal(AT),
  });
});

test("cmd.exe case when wt.exe is absent", async () => {
  const { sl, calls } = make({ wt: null });
  assert.equal((await sl.register({ sessionId: SID, cwd: tmp, at: AT })).ok, true);
  assert.equal(calls[0].env.OMO_LL_KIND, "cmd");
  assert.equal(calls[0].env.OMO_LL_EXE, "C:\\Windows\\System32\\cmd.exe");
  assert.match(REGISTER_SCRIPT, /@\('\/c', 'start', \(\$q \+ 'limitless' \+ \$q\), '\/D', \(\$q \+ \$env:OMO_LL_CWD \+ \$q\)\) \+ \$l \+ @\('--session', \$env:OMO_LL_SID\)/);
});

test("cwd with ';' never reaches wt.exe: cmd.exe action even though wt.exe exists", async () => {
  const dir = join(tmp, "x;notepad");
  mkdirSync(dir, { recursive: true });
  const { sl, calls } = make();
  assert.equal((await sl.register({ sessionId: SID, cwd: dir, at: AT })).ok, true);
  assert.equal(calls[0].env.OMO_LL_KIND, "cmd");
  assert.equal(calls[0].env.OMO_LL_EXE, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(calls[0].env.OMO_LL_CWD, dir);
});

test("findOnPath (real detector) finds an entry whose stat fails but lstat works (WindowsApps alias)", () => {
  const aliasDir = join(tmp, "Microsoft", "WindowsApps");
  mkdirSync(aliasDir, { recursive: true });
  const alias = join(aliasDir, "wt.exe");
  const fsStub = {
    existsSync: () => false, // what a reparse-point alias looks like to existsSync/statSync
    lstatSync: (p) => { if (p === alias) return { isSymbolicLink: () => true }; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  };
  assert.equal(findOnPath("wt.exe", { env: { LOCALAPPDATA: tmp, PATH: "" }, fs: fsStub }), alias);
  assert.equal(findOnPath("nope.exe", { env: { LOCALAPPDATA: tmp, PATH: "" }, fs: fsStub }), null);
  writeFileSync(join(aliasDir, "real.exe"), "");
  assert.equal(findOnPath("real.exe", { env: { PATH: aliasDir }, fs: nodeFs }), join(aliasDir, "real.exe"));
  assert.equal(findOnPath("missing.exe", { env: { PATH: aliasDir }, fs: nodeFs }), null);
});

test("trigger time is ISO local and never in the past", async () => {
  assert.match(isoLocal(AT), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  const { sl, calls } = make();
  await sl.register({ sessionId: SID, cwd: tmp, at: NOW - 1000 });
  assert.equal(calls[0].env.OMO_LL_AT, isoLocal(NOW + 20000));
});

test("cwd with & and ; $() backtick is passed inertly through env, never into the script", async () => {
  const dir = join(tmp, "a & b; $(calc) `x` 'q'");
  mkdirSync(dir, { recursive: true });
  const { sl, calls } = make();
  assert.equal((await sl.register({ sessionId: SID, cwd: dir, at: AT })).ok, true);
  assert.equal(calls[0].script, REGISTER_SCRIPT);
  assert.equal(calls[0].script.includes("calc"), false);
  assert.equal(calls[0].env.OMO_LL_CWD, dir);
});

test("invalid sid / cwd throw before any PowerShell call", async () => {
  const { sl, calls } = make();
  const bad = [
    { sessionId: "x&calc-12345678", cwd: tmp }, { sessionId: `${SID}"; calc`, cwd: tmp }, { sessionId: "$(calc)-12345678", cwd: tmp },
    { sessionId: "short", cwd: tmp }, { sessionId: "-" + SID, cwd: tmp }, { sessionId: undefined, cwd: tmp },
    { sessionId: SID, cwd: "relative/dir" }, { sessionId: SID, cwd: join(tmp, "missing") },
    { sessionId: SID, cwd: `${tmp}"; calc; "` }, { sessionId: SID, cwd: "C:\\%PATH%" }, { sessionId: SID, cwd: tmp + "\u0000" },
  ];
  for (const req of bad) await assert.rejects(() => sl.register({ ...req, at: AT }), /self-launch/, JSON.stringify(req));
  await assert.rejects(() => sl.register({ sessionId: SID, cwd: tmp, at: NaN }), /self-launch/);
  assert.equal(calls.length, 0);
});

test("registration failures never claim success", async () => {
  for (const reply of [
    () => ({ code: 1, stdout: "", stderr: "Access denied\n", timedOut: false }),
    () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
    () => ok("some banner\r\n"), // exit 0 but no Get-ScheduledTask confirmation line
    () => ok("LIMITLESS-REGISTERED \\omo-limitless\\other\r\n"),
  ]) {
    const { sl } = make({ reply });
    const res = await sl.register({ sessionId: SID, cwd: tmp, at: AT });
    assert.equal(res.ok, false);
    assert.equal(res.selfTask, undefined);
  }
});

test("non-Windows host: not ok, no PowerShell call", async () => {
  const { sl, calls } = make({ platform: "linux" });
  assert.equal((await sl.register({ sessionId: SID, cwd: tmp, at: AT })).ok, false);
  assert.equal(calls.length, 0);
});

test("unregister: static script, own task only, not-found is fine, failure reported", async () => {
  const { sl, calls } = make({ reply: () => ok("LIMITLESS-UNREGISTERED\n") });
  assert.deepEqual(await sl.unregister({ sessionId: SID, selfTask: selfTaskOf(SID) }), { ok: true, gone: false });
  assert.equal(calls[0].script, UNREGISTER_SCRIPT);
  assert.deepEqual(calls[0].env, { OMO_LL_TASK: taskName(SID) });
  assert.match(UNREGISTER_SCRIPT, /Unregister-ScheduledTask -TaskName \$name -TaskPath '\\omo-limitless\\' -Confirm:\$false/);
  const gone = make({ reply: () => ok("LIMITLESS-GONE\n") });
  assert.deepEqual(await gone.sl.unregister({ sessionId: SID, selfTask: selfTaskOf(SID) }), { ok: true, gone: true });
  const failed = make({ reply: () => ({ code: 3, stdout: "LIMITLESS-STILL-PRESENT\n", stderr: "", timedOut: false }) });
  assert.equal((await failed.sl.unregister({ sessionId: SID, selfTask: selfTaskOf(SID) })).ok, false);
  const other = make();
  await assert.rejects(() => other.sl.unregister({ sessionId: SID, selfTask: "\\omo-limitless\\someone-else" }), /self-launch/);
  assert.equal(other.calls.length, 0);
});

// Launcher resolution -------------------------------------------------------------------------------------------
const BUN = join(tmp, "bun.exe");
const OMO_JS = join(tmp, "omo.js");
const NEW_OMO = join(tmp, "bunbin", "omo.exe");
const OLD_OMO = join(tmp, "local", "omo.exe");
for (const f of [BUN, OMO_JS, NEW_OMO, OLD_OMO]) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, ""); }
const rl = (o) => resolveLauncher({ fs: nodeFs, platform: "win32", env: {}, execPath: BUN, probe: async () => [], ...o });

test("resolveLauncher step 1: nearest ancestor omo launcher wins over OMO_BIN", async () => {
  assert.deepEqual(await rl({ env: { OMO_BIN: OMO_JS }, probe: async () => [BUN, NEW_OMO, OLD_OMO] }), { exe: NEW_OMO, args: [] });
});

test("resolveLauncher step 2: OMO_BIN run by the bun/node executable", async () => {
  assert.deepEqual(await rl({ env: { OMO_BIN: OMO_JS }, probe: async () => [BUN, join(tmp, "cmd.exe")] }), { exe: BUN, args: [OMO_JS] });
  assert.deepEqual(await rl({ env: { OMO_BIN: OMO_JS }, probe: async () => { throw new Error("probe died"); } }), { exe: BUN, args: [OMO_JS] });
});

test("resolveLauncher step 3: bare omo when nothing usable", async () => {
  const bare = { exe: "omo", args: [] };
  assert.deepEqual(await rl({}), bare);
  assert.deepEqual(await rl({ env: { OMO_BIN: join(tmp, "missing.js") } }), bare);
  assert.deepEqual(await rl({ env: { OMO_BIN: OMO_JS }, execPath: join(tmp, "other.exe") }), bare);
  assert.deepEqual(await rl({ probe: async () => [join(tmp, "nowhere", "omo.exe")] }), bare);
});

test("validLauncher rejects relative, missing and metacharacter paths", () => {
  assert.equal(validLauncher({ exe: "omo.exe", args: [] }, nodeFs), null);
  assert.equal(validLauncher({ exe: join(tmp, "nope.exe"), args: [] }, nodeFs), null);
  assert.equal(validLauncher({ exe: BUN, args: ["x & calc"] }, nodeFs), null);
  assert.equal(validLauncher({ exe: BUN, args: ["relative.js"] }, nodeFs), null);
  assert.deepEqual(validLauncher({ exe: BUN, args: [OMO_JS] }, nodeFs), { exe: BUN, args: [OMO_JS] });
});

test("register passes the launcher through env: wt.exe and cmd.exe scheduled-task inputs", async () => {
  const launcher = { exe: BUN, args: [OMO_JS] };
  const wt = make();
  await wt.sl.register({ sessionId: SID, cwd: tmp, at: AT, launcher });
  assert.equal(wt.calls[0].env.OMO_LL_KIND, "wt");
  assert.equal(wt.calls[0].env.OMO_LL_LAUNCH, [BUN, OMO_JS].join("\n"));
  assert.equal(wt.calls[0].script, REGISTER_SCRIPT);
  const cmd = make({ wt: null });
  await cmd.sl.register({ sessionId: SID, cwd: tmp, at: AT, launcher });
  assert.equal(cmd.calls[0].env.OMO_LL_KIND, "cmd");
  assert.equal(cmd.calls[0].env.OMO_LL_LAUNCH, [BUN, OMO_JS].join("\n"));
  const semi = join(tmp, "se;mi");
  mkdirSync(semi, { recursive: true });
  const semiExe = join(semi, "omo.exe");
  writeFileSync(semiExe, "");
  const viaExe = make();
  await viaExe.sl.register({ sessionId: SID, cwd: tmp, at: AT, launcher: { exe: semiExe, args: [] } });
  assert.equal(viaExe.calls[0].env.OMO_LL_KIND, "cmd");
  const bad = make();
  await bad.sl.register({ sessionId: SID, cwd: tmp, at: AT, launcher: { exe: "C:\\x & calc.exe", args: [] } });
  assert.equal(bad.calls[0].env.OMO_LL_LAUNCH, "omo");
});

test("the static script builds the exact action argument for both branches (PowerShell evaluation)", { skip: process.platform !== "win32" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const body = REGISTER_SCRIPT.split("\n").filter((l) => /^\$q =|^\$l =|^if \(\$env:OMO_LL_KIND|^else \{ \$argv/.test(l)).join("\n");
  for (const [kind, want] of [
    ["wt", `-d "C:\\w" "${BUN}" "${OMO_JS}" --session S1`],
    ["cmd", `/c start "limitless" /D "C:\\w" "${BUN}" "${OMO_JS}" --session S1`],
  ]) {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", body + "\n[Console]::Out.Write($argv -join ' ')"], {
      env: { ...process.env, OMO_LL_KIND: kind, OMO_LL_CWD: "C:\\w", OMO_LL_SID: "S1", OMO_LL_LAUNCH: [BUN, OMO_JS].join("\n") }, encoding: "utf8",
    });
    assert.equal(out, want);
  }
});
