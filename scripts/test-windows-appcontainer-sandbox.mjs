import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandboxBinRoot = path.join(repoRoot, "native", "windows-sandbox-runner", "bin");
const runnerPointerPath = path.join(sandboxBinRoot, "SandboxRunner.current");
const legacyRunnerPath = path.join(sandboxBinRoot, "SandboxRunner.exe");
function resolveRunnerPath() {
  if (!existsSync(runnerPointerPath)) return legacyRunnerPath;
  const fileName = readFileSync(runnerPointerPath, "utf8").trim();
  if (!/^SandboxRunner\.[a-f0-9]{16}\.exe$/i.test(fileName) || path.basename(fileName) !== fileName) {
    throw new Error(`invalid sandbox runner pointer: ${runnerPointerPath}`);
  }
  const resolved = path.join(sandboxBinRoot, fileName);
  if (!existsSync(resolved)) throw new Error(`sandbox runner pointer target is missing: ${resolved}`);
  return resolved;
}
const helper = resolveRunnerPath();
const compiledChildProbe = path.join(repoRoot, "native", "windows-sandbox-runner", "bin", "SandboxChildProbe.exe");
const allowedRoot = path.join(repoRoot, ".sandbox-proof");
const outsideRoot = path.resolve(repoRoot, "..", "clc-sandbox-proof-outside");
const insideFile = path.join(allowedRoot, "inside.txt");
const insideWrite = path.join(allowedRoot, "inside-created.txt");
const outsideFile = path.join(outsideRoot, "outside-secret.txt");
const outsideWrite = path.join(outsideRoot, "outside-created.txt");
const childMarker = path.join(allowedRoot, "child-launched.txt");
const childStdout = path.join(allowedRoot, "child-stdout.txt");
const childProbe = path.join(allowedRoot, "SandboxChildProbe.exe");
const identityHash = createHash("sha256").update(allowedRoot.toLowerCase()).digest("hex").slice(0, 16);
const profileName = `ChatGPTLocalCoder.Proof.${identityHash}`;
const powershell = path.join(process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function invoke(request, { timeout = 30_000 } = {}) {
  return spawnSync(helper, [], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function invokeDirect(args, { timeout = 30_000 } = {}) {
  return spawnSync(helper, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

if (process.platform !== "win32") {
  console.log("SKIP windows AppContainer test: non-Windows host");
  process.exit(0);
}

await fs.mkdir(allowedRoot, { recursive: true });
await fs.mkdir(outsideRoot, { recursive: true });
await fs.writeFile(insideFile, "inside-secret", "utf8");
await fs.writeFile(outsideFile, "outside-secret", "utf8");
await fs.rm(insideWrite, { force: true }).catch(() => undefined);
await fs.rm(outsideWrite, { force: true }).catch(() => undefined);
await fs.rm(childMarker, { force: true }).catch(() => undefined);
await fs.rm(childStdout, { force: true }).catch(() => undefined);
await fs.rm(childProbe, { force: true }).catch(() => undefined);

const prepare = invoke({
  operation: "prepare",
  profileName,
  rwRoots: [allowedRoot],
  rxRoots: [],
  networkMode: "none",
});
if (prepare.status !== 0) {
  console.error(prepare.stdout);
  console.error(prepare.stderr);
  throw new Error(`AppContainer prepare failed: exit ${prepare.status}`);
}
const prepared = JSON.parse(prepare.stdout.trim());
const profilePath = prepared.profilePath;
// Copy after the inheritable AppContainer ACE is installed so the executable
// itself inherits the allowed-root access rule.
await fs.copyFile(compiledChildProbe, childProbe);

const script = [
  "$ErrorActionPreference='Stop'",
  `$inside=${psLiteral(insideFile)}`,
  `$insideWrite=${psLiteral(insideWrite)}`,
  `$outside=${psLiteral(outsideFile)}`,
  `$outsideWrite=${psLiteral(outsideWrite)}`,
  "$insideRead='denied'",
  "try { [IO.File]::ReadAllText($inside) | Out-Null; $insideRead='yes' } catch {}",
  "$insideWriteOk='denied'",
  "try { [IO.File]::WriteAllText($insideWrite,'ok'); $insideWriteOk='yes' } catch {}",
  "$outsideRead='denied'",
  "try { [IO.File]::ReadAllText($outside) | Out-Null; $outsideRead='escape' } catch {}",
  "$outsideWriteOk='denied'",
  "try { [IO.File]::WriteAllText($outsideWrite,'escape'); $outsideWriteOk='escape' } catch {}",
  `Write-Output (\"diag_current=\" + [Environment]::CurrentDirectory + \" diag_probe_exists=\" + (Test-Path -LiteralPath ${psLiteral(childProbe)}))`,
  `$childRead='no-output'; $childWrite='no-output'; $childExit=$null; $childLaunch='not-started'`,
  `try { $p=Start-Process -FilePath ${psLiteral(childProbe)} -ArgumentList @(${psLiteral(childMarker)},${psLiteral(outsideFile)},${psLiteral(outsideWrite)}) -WorkingDirectory ${psLiteral(allowedRoot)} -NoNewWindow -Wait -PassThru -RedirectStandardOutput ${psLiteral(childStdout)}; $childExit=$p.ExitCode; $childLaunch='yes'; if (Test-Path -LiteralPath ${psLiteral(childStdout)}) { $childText=Get-Content -LiteralPath ${psLiteral(childStdout)} -Raw; if ($childText -match 'outside_read=denied') { $childRead='denied' } elseif ($childText -match 'outside_read=escape') { $childRead='escape' }; if ($childText -match 'outside_write=denied') { $childWrite='denied' } elseif ($childText -match 'outside_write=escape') { $childWrite='escape' } } } catch { $childLaunch='error:' + $_.Exception.Message }`,
  "Write-Output ('child_launch=' + $childLaunch)",
  "Write-Output \"inside_read=$insideRead inside_write=$insideWriteOk outside_read=$outsideRead outside_write=$outsideWriteOk child_outside_read=$childRead child_outside_write=$childWrite child_exit=$childExit\"",
  "if ($insideRead -ne 'yes' -or $insideWriteOk -ne 'yes' -or $outsideRead -ne 'denied' -or $outsideWriteOk -ne 'denied' -or $childRead -ne 'denied' -or $childWrite -ne 'denied' -or $childExit -ne 0) { exit 9 }",
].join("; ");

const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
const sandboxEnv = {
  SystemRoot: systemRoot,
  WINDIR: systemRoot,
  COMSPEC: path.join(systemRoot, "System32", "cmd.exe"),
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE || "AMD64",
  NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS || "1",
  PATH: [
    path.join(systemRoot, "System32"),
    path.dirname(powershell),
    path.dirname(process.execPath),
  ].join(";"),
  HOME: path.join(profilePath, "Home"),
  USERPROFILE: path.join(profilePath, "Home"),
  LOCALAPPDATA: path.join(profilePath, "AppData", "Local"),
  APPDATA: path.join(profilePath, "AppData", "Roaming"),
  TEMP: path.join(profilePath, "Temp"),
  TMP: path.join(profilePath, "Temp"),
};

const run = invoke({
  operation: "run",
  profileName,
  executable: powershell,
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
  cwd: allowedRoot,
  env: sandboxEnv,
  rwRoots: [allowedRoot],
  rxRoots: [],
  networkMode: "none",
  timeoutMs: 20_000,
});

console.log(run.stdout.trim());
if (run.stderr.trim()) console.error(run.stderr.trim());
if (run.status !== 0) throw new Error(`AppContainer sandbox proof failed: exit ${run.status}`);
if (!run.stdout.includes("inside_read=yes") || !run.stdout.includes("inside_write=yes")) {
  throw new Error("sandbox proof did not preserve allowed-root read/write");
}
if (!run.stdout.includes("outside_read=denied") || !run.stdout.includes("outside_write=denied")) {
  throw new Error("sandbox proof did not deny outside-root access");
}
if (!run.stdout.includes("child_outside_read=denied") || !run.stdout.includes("child_outside_write=denied")) {
  throw new Error("sandbox proof did not confine nested child process read/write");
}
const childMarkerValue = await fs.readFile(childMarker, "utf8").then((value) => value.trim(), () => "");
if (childMarkerValue !== "child-ok") {
  throw new Error("sandbox child did not actually launch and write inside the allowed root");
}
if (await fs.stat(outsideWrite).then(() => true, () => false)) {
  throw new Error("outside marker exists: sandbox write escaped");
}

// Privileged RX grants are sticky ACL state. Prove the reconciliation primitive
// actually changes the OS boundary: grant outsideRoot read/execute, observe read
// success but write denial, revoke that SID ACE, then observe read denial again.
const grantExec = invokeDirect(["--grant-exec", profileName, outsideRoot]);
if (grantExec.status !== 0) {
  throw new Error(`sandbox exec grant proof failed: ${grantExec.stderr || grantExec.stdout}`);
}
const readWithExecGrant = invoke({
  operation: "run",
  profileName,
  executable: powershell,
  args: [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "$r='denied'; $w='denied'",
      `try { [IO.File]::ReadAllText(${psLiteral(outsideFile)}) | Out-Null; $r='yes' } catch {}`,
      `try { [IO.File]::WriteAllText(${psLiteral(outsideWrite)},'escape'); $w='escape' } catch {}`,
      "Write-Output \"exec_grant_read=$r exec_grant_write=$w\"",
      "if ($r -ne 'yes' -or $w -ne 'denied') { exit 21 }",
    ].join("; "),
  ],
  cwd: allowedRoot,
  env: sandboxEnv,
  rwRoots: [allowedRoot],
  rxRoots: [outsideRoot],
  networkMode: "none",
  timeoutMs: 10_000,
});
if (readWithExecGrant.status !== 0 || !readWithExecGrant.stdout.includes("exec_grant_read=yes exec_grant_write=denied")) {
  throw new Error(`sandbox exec grant did not produce RX-only access: ${readWithExecGrant.stdout} ${readWithExecGrant.stderr}`);
}

const revokeExec = invokeDirect(["--revoke-exec", profileName, outsideRoot]);
if (revokeExec.status !== 0) {
  throw new Error(`sandbox exec revoke proof failed: ${revokeExec.stderr || revokeExec.stdout}`);
}
const readAfterRevoke = invoke({
  operation: "run",
  profileName,
  executable: powershell,
  args: [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "$r='denied'",
      `try { [IO.File]::ReadAllText(${psLiteral(outsideFile)}) | Out-Null; $r='escape' } catch {}`,
      "Write-Output \"exec_revoke_read=$r\"",
      "if ($r -ne 'denied') { exit 22 }",
    ].join("; "),
  ],
  cwd: allowedRoot,
  env: sandboxEnv,
  rwRoots: [allowedRoot],
  rxRoots: [],
  networkMode: "none",
  timeoutMs: 10_000,
});
if (readAfterRevoke.status !== 0 || !readAfterRevoke.stdout.includes("exec_revoke_read=denied")) {
  throw new Error(`sandbox exec revoke did not restore denial: ${readAfterRevoke.stdout} ${readAfterRevoke.stderr}`);
}

// These roots are owned exclusively by this proof. Remove them explicitly so a
// successful verification never leaves test artifacts in the user working tree.
await fs.rm(allowedRoot, { recursive: true, force: true });
await fs.rm(outsideRoot, { recursive: true, force: true });
console.log(`OK windows AppContainer proof sid=${prepared.sid}`);
