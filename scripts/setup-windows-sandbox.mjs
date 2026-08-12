import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = path.join(repoRoot, "scripts", "build-windows-sandbox-helper.mjs");
const runner = path.join(repoRoot, "native", "windows-sandbox-runner", "bin", "SandboxRunner.exe");

if (process.platform !== "win32") {
  console.log("Windows AppContainer setup skipped: non-Windows host");
  process.exit(0);
}

function instanceId() {
  return (process.env.LOCAL_CODER_INSTANCE_ID || "default")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 24) || "default";
}

function validateProfileName(value) {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_. -]+$/.test(value)) {
    throw new Error(`invalid AppContainer profile name: ${JSON.stringify(value)}`);
  }
  return value;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function configuredWorkspaceRoots() {
  const primary = process.env.WORKSPACE_PATH?.trim() || repoRoot;
  const extra = (process.env.EXTRA_WORKSPACE_PATHS || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const roots = [];
  const seen = new Set();
  for (const raw of [primary, ...extra]) {
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) continue;
    const canonical = fs.realpathSync.native(resolved);
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(canonical);
  }
  return roots;
}

function ancestorChain(roots) {
  const result = [];
  const seen = new Set();
  for (const root of roots) {
    let current = path.dirname(root);
    while (current) {
      const key = current.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(current);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return result;
}

function findExecutable(command) {
  const hasExt = Boolean(path.extname(command));
  const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidates = hasExt
      ? [path.join(entry, command)]
      : extensions.map((ext) => path.join(entry, command + ext.toLowerCase()));
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return fs.realpathSync.native(candidate);
    }
  }
  return null;
}

function approvedExecRoots() {
  const roots = (process.env.SANDBOX_EXEC_ROOTS || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  roots.push(path.dirname(process.execPath));
  const git = findExecutable("git");
  if (git) roots.push(path.dirname(git));
  const result = [];
  const seen = new Set();
  for (const raw of roots) {
    if (!fs.existsSync(raw)) continue;
    const canonical = fs.realpathSync.native(path.resolve(raw));
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return result;
}

function sandboxPolicyStatePath() {
  const dir = process.env.CLC_SANDBOX_STATE_DIR?.trim()
    ? path.resolve(process.env.CLC_SANDBOX_STATE_DIR)
    : path.join(repoRoot, ".mcp-state");
  return path.join(dir, `sandbox-policy-${instanceId()}.json`);
}

async function readExistingPolicyManifest() {
  try {
    const parsed = JSON.parse(await fsp.readFile(sandboxPolicyStatePath(), "utf8"));
    if (
      parsed?.version !== 1 ||
      typeof parsed.profileName !== "string" ||
      !Array.isArray(parsed.execRoots) ||
      !parsed.execRoots.every((item) => typeof item === "string")
    ) return null;
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function pathSetDifference(left, right) {
  const rightSet = new Set(right.map((value) => path.resolve(value).toLowerCase()));
  return left.filter((value) => !rightSet.has(path.resolve(value).toLowerCase()));
}

async function recordReconciledExecRoots(previous, productionProfile, execRoots) {
  if (!previous || previous.profileName !== productionProfile) return;
  const filePath = sandboxPolicyStatePath();
  const next = { ...previous, execRoots: [...execRoots], updatedAt: new Date().toISOString() };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fsp.rename(tempPath, filePath);
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

const build = spawnSync(process.execPath, [buildScript], {
  cwd: repoRoot,
  stdio: "inherit",
  windowsHide: true,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const productionProfile = validateProfileName(
  process.env.CLC_SANDBOX_PROFILE_NAME?.trim() || `ChatGPTLocalCoder.${instanceId()}`
);
const profiles = [...new Set([productionProfile, "ChatGPTLocalCoder.tests"])]
  .map(validateProfileName);
const roots = configuredWorkspaceRoots();
const ancestors = ancestorChain(roots);
const execRoots = approvedExecRoots();
const previousPolicy = await readExistingPolicyManifest();
const previousExecRoots = previousPolicy?.execRoots || [];
const staleExecRoots = pathSetDifference(previousExecRoots, execRoots);
const staleExecProfiles = previousPolicy
  ? [...new Set([previousPolicy.profileName, "ChatGPTLocalCoder.tests"])]
  : [];

function traversePathsForProfile(profile) {
  // The dedicated test profile creates temporary allowed roots underneath the
  // configured production roots. It therefore needs traverse-only access to
  // those parent roots as well; production receives full root ACLs at prepare.
  return profile === "ChatGPTLocalCoder.tests"
    ? [...new Set([...ancestors, ...roots])]
    : ancestors;
}

function runDirect(args) {
  return spawnSync(runner, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

let directOk = true;
const directNull = runDirect(["--grant-null", ...profiles]);
if (directNull.status !== 0) directOk = false;
else if (directNull.stdout) process.stdout.write(directNull.stdout);
if (staleExecRoots.length > 0) {
  for (const profile of staleExecProfiles) {
    const revoke = runDirect(["--revoke-exec", profile, ...staleExecRoots]);
    if (revoke.status !== 0) directOk = false;
    else if (revoke.stdout) process.stdout.write(revoke.stdout);
  }
}
for (const profile of profiles) {
  const traversePaths = traversePathsForProfile(profile);
  if (traversePaths.length === 0) continue;
  const directTraverse = runDirect(["--grant-traverse", profile, ...traversePaths]);
  if (directTraverse.status !== 0) directOk = false;
  else if (directTraverse.stdout) process.stdout.write(directTraverse.stdout);
  if (execRoots.length > 0) {
    const directExec = runDirect(["--grant-exec", profile, ...execRoots]);
    if (directExec.status !== 0) directOk = false;
    else if (directExec.stdout) process.stdout.write(directExec.stdout);
  }
}
if (directOk) {
  await recordReconciledExecRoots(previousPolicy, productionProfile, execRoots);
  console.log(`Windows AppContainer compatibility prepared for: ${profiles.join(", ")}`);
  process.exit(0);
}

const powershell = path.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);
const stateDir = path.join(repoRoot, ".mcp-state");
await fsp.mkdir(stateDir, { recursive: true });
const elevatedScriptPath = path.join(stateDir, `sandbox-compat-${process.pid}-${Date.now()}.ps1`);
const elevatedLines = [
  "$ErrorActionPreference='Stop'",
  `& ${psQuote(runner)} '--grant-null' ${profiles.map(psQuote).join(" ")}`,
  "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
];
if (staleExecRoots.length > 0) {
  for (const profile of staleExecProfiles) {
    elevatedLines.push(
      `& ${psQuote(runner)} '--revoke-exec' ${psQuote(profile)} ${staleExecRoots.map(psQuote).join(" ")}`,
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
    );
  }
}
for (const profile of profiles) {
  const traversePaths = traversePathsForProfile(profile);
  if (traversePaths.length === 0) continue;
  elevatedLines.push(
    `& ${psQuote(runner)} '--grant-traverse' ${psQuote(profile)} ${traversePaths.map(psQuote).join(" ")}`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
  );
  if (execRoots.length > 0) {
    elevatedLines.push(
      `& ${psQuote(runner)} '--grant-exec' ${psQuote(profile)} ${execRoots.map(psQuote).join(" ")}`,
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
    );
  }
}
elevatedLines.push("exit 0");
await fsp.writeFile(elevatedScriptPath, `${elevatedLines.join("\r\n")}\r\n`, "utf8");

const elevateCommand = [
  "$ErrorActionPreference='Stop'",
  "try {",
  `  $p=Start-Process -FilePath ${psQuote(powershell)} -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psQuote(elevatedScriptPath)}) -Verb RunAs -Wait -PassThru`,
  "  exit $p.ExitCode",
  "} catch {",
  "  Write-Error $_",
  "  exit 1223",
  "}",
].join("; ");

console.log(
  "Windows AppContainer needs one explicit UAC approval for NUL compatibility, traverse-only workspace ancestors, and RX-only approved toolchain roots."
);
let elevated;
try {
  elevated = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", elevateCommand],
    { cwd: repoRoot, stdio: "inherit", windowsHide: false }
  );
} finally {
  await fsp.rm(elevatedScriptPath, { force: true }).catch(() => undefined);
}
if (elevated.status !== 0) {
  console.error(`OS_SANDBOX_PREPARE_FAILED: privileged compatibility setup failed (exit ${elevated.status ?? "unknown"})`);
  process.exit(elevated.status ?? 1);
}

await recordReconciledExecRoots(previousPolicy, productionProfile, execRoots);
console.log(`Windows AppContainer compatibility prepared for: ${profiles.join(", ")}`);
