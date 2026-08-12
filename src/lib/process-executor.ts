import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getFullDiskAccess, getWorkspaceRoots } from "./path-security.js";

export const OS_SANDBOX_UNAVAILABLE = "OS_SANDBOX_UNAVAILABLE";
export const OS_SANDBOX_PREPARE_FAILED = "OS_SANDBOX_PREPARE_FAILED";
export const OS_SANDBOX_ACL_FAILED = "OS_SANDBOX_ACL_FAILED";
export const OS_SANDBOX_LAUNCH_FAILED = "OS_SANDBOX_LAUNCH_FAILED";
export const OS_SANDBOX_SELF_TEST_FAILED = "OS_SANDBOX_SELF_TEST_FAILED";
export const SANDBOX_TOOLCHAIN_NOT_ALLOWED = "SANDBOX_TOOLCHAIN_NOT_ALLOWED";

export type SandboxNetworkMode = "none" | "internet";
export type ProcessSandboxHealthState = "native" | "uninitialized" | "preparing" | "passed" | "failed";

export interface ProcessSecurityStatus {
  path_tool_full_disk_access: boolean;
  process_sandbox_mode: "native_trusted" | "required";
  process_filesystem_scope: "full_machine_os_user" | "workspace_roots";
  process_network_mode: "native" | SandboxNetworkMode;
  sandbox_backend: "none" | "windows_appcontainer";
  sandbox_self_test: ProcessSandboxHealthState;
  sandbox_identity?: string;
  sandbox_profile_path?: string;
  sandbox_rw_roots: string[];
  sandbox_exec_roots: string[];
  /** True only when startup reused an already-recorded exact ACL policy and
   * verified it non-mutatingly before the normal OS boundary self-test. */
  sandbox_policy_reused: boolean;
  sandbox_error?: string;
}

export interface ProcessSpawnRequest {
  executable: string;
  args?: string[];
  cwd: string;
  /** Native mode only. Strict mode always uses buildSandboxEnvironment(). */
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  /** Broker-enforced timeout. 0/undefined means no broker timeout. */
  timeoutMs?: number;
}

export interface ProcessHandle {
  child: ChildProcessWithoutNullStreams;
  sandboxed: boolean;
  backend: "native" | "windows_appcontainer";
  executable: string;
  terminate(force?: boolean): Promise<boolean>;
}

interface SandboxState {
  profileName: string;
  sid: string;
  profilePath: string;
  rwRoots: string[];
  execRoots: string[];
  networkMode: SandboxNetworkMode;
  runnerPath: string;
}

interface BrokerPrepareResponse {
  ok: boolean;
  backend: string;
  profileName: string;
  sid: string;
  profilePath: string;
}

interface SandboxPolicyManifest {
  version: 1;
  profileName: string;
  sid: string;
  rwRoots: string[];
  execRoots: string[];
  updatedAt: string;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "../..");
const sandboxNativeRoot = path.join(repoRoot, "native", "windows-sandbox-runner");
const defaultRunnerPath = path.join(sandboxNativeRoot, "bin", "SandboxRunner.exe");
const defaultChildProbePath = path.join(sandboxNativeRoot, "bin", "SandboxChildProbe.exe");

let sandboxState: SandboxState | null = null;
let status: ProcessSecurityStatus = buildInitialStatus();
let initializationPromise: Promise<ProcessSecurityStatus> | null = null;

function buildInitialStatus(): ProcessSecurityStatus {
  const full = getFullDiskAccess();
  return {
    path_tool_full_disk_access: full,
    process_sandbox_mode: full ? "native_trusted" : "required",
    process_filesystem_scope: full ? "full_machine_os_user" : "workspace_roots",
    process_network_mode: full ? "native" : readNetworkMode(),
    sandbox_backend: full ? "none" : "windows_appcontainer",
    sandbox_self_test: full ? "native" : "uninitialized",
    sandbox_rw_roots: full ? [] : getWorkspaceRoots(),
    sandbox_exec_roots: [],
    sandbox_policy_reused: false,
  };
}

function readNetworkMode(): SandboxNetworkMode {
  const raw = (process.env.SANDBOX_NETWORK_MODE || "none").trim().toLowerCase();
  if (raw === "none" || raw === "internet") return raw;
  throw new Error(`Invalid SANDBOX_NETWORK_MODE=${JSON.stringify(raw)}; expected none|internet`);
}

function splitSemicolonList(value: string | undefined): string[] {
  return (value || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function canonicalDirectory(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`sandbox root is not a directory: ${resolved}`);
  return await fs.realpath(resolved);
}

async function canonicalDirectories(values: string[]): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const canonical = await canonicalDirectory(value);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return result;
}

function sameCanonicalPathSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const rightSet = new Set(right.map(normalize));
  return left.every((value) => rightSet.has(normalize(value)));
}

function instanceId(): string {
  return (process.env.LOCAL_CODER_INSTANCE_ID || process.env.MCP_INSTANCE_NAME || "default")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 24) || "default";
}

function profileNameFor(): string {
  const override = process.env.CLC_SANDBOX_PROFILE_NAME?.trim();
  if (override) {
    if (override.length > 64 || !/^[A-Za-z0-9_. -]+$/.test(override)) {
      throw new Error(`${OS_SANDBOX_PREPARE_FAILED}: invalid CLC_SANDBOX_PROFILE_NAME`);
    }
    return override;
  }
  return `ChatGPTLocalCoder.${instanceId()}`.slice(0, 64);
}

export function getExpectedSandboxProfileName(): string {
  return profileNameFor();
}

function sandboxPolicyStatePath(): string {
  const configuredStateDir = process.env.CLC_SANDBOX_STATE_DIR?.trim() || process.env.MCP_SHELL_STATE_DIR?.trim();
  const dir = configuredStateDir
    ? path.resolve(configuredStateDir)
    : path.join(repoRoot, ".mcp-state");
  return path.join(dir, `sandbox-policy-${instanceId()}.json`);
}

async function readPolicyManifest(): Promise<SandboxPolicyManifest | null> {
  const filePath = sandboxPolicyStatePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as SandboxPolicyManifest;
    if (
      parsed?.version !== 1 ||
      typeof parsed.profileName !== "string" ||
      typeof parsed.sid !== "string" ||
      !Array.isArray(parsed.rwRoots) || !parsed.rwRoots.every((item) => typeof item === "string") ||
      !Array.isArray(parsed.execRoots) || !parsed.execRoots.every((item) => typeof item === "string")
    ) {
      throw new Error("invalid shape");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${OS_SANDBOX_PREPARE_FAILED}: sandbox policy state is invalid at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function writePolicyManifest(manifest: SandboxPolicyManifest): Promise<void> {
  const filePath = sandboxPolicyStatePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function deletePolicyManifest(): Promise<void> {
  await fs.rm(sandboxPolicyStatePath(), { force: true }).catch(() => undefined);
}

function sandboxHelperPath(): string {
  const override = process.env.CLC_SANDBOX_RUNNER_PATH?.trim();
  return override ? path.resolve(override) : defaultRunnerPath;
}

async function assertHelperIntegrity(filePath: string): Promise<void> {
  const hashPath = `${filePath}.sha256`;
  const [bytes, expectedRaw] = await Promise.all([
    fs.readFile(filePath),
    fs.readFile(hashPath, "utf8"),
  ]);
  const actual = createHash("sha256").update(bytes).digest("hex");
  const expected = expectedRaw.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
    throw new Error(`${OS_SANDBOX_UNAVAILABLE}: sandbox broker hash mismatch (${actual} != ${expected || "missing"})`);
  }
}

async function invokeBrokerControl(
  runnerPath: string,
  request: Record<string, unknown>,
  timeoutMs = 15_000
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = spawn(runnerPath, [], {
    cwd: repoRoot,
    windowsHide: true,
    env: buildBrokerEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(request));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${OS_SANDBOX_PREPARE_FAILED}: sandbox broker control call timed out`)));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve({ stdout, stderr, exitCode: code })));
  });
}

async function prepareSandboxPolicy(
  runnerPath: string,
  profileName: string,
  rwRoots: string[],
  execRoots: string[],
  removeRoots: string[],
  networkMode: SandboxNetworkMode
): Promise<BrokerPrepareResponse> {
  const prepare = await invokeBrokerControl(runnerPath, {
    operation: "prepare",
    profileName,
    rwRoots,
    rxRoots: execRoots,
    removeRoots,
    networkMode,
  });
  if (prepare.exitCode !== 0) {
    const reason = prepare.stderr.trim() || prepare.stdout.trim() || `exit ${prepare.exitCode}`;
    throw new Error(`${OS_SANDBOX_PREPARE_FAILED}: ${reason}`);
  }
  const response = JSON.parse(prepare.stdout.trim()) as BrokerPrepareResponse;
  if (!response.ok || !response.sid || !response.profilePath) {
    throw new Error(`${OS_SANDBOX_PREPARE_FAILED}: broker returned incomplete prepare response`);
  }
  return response;
}

async function openSandboxIdentity(
  runnerPath: string,
  profileName: string
): Promise<BrokerPrepareResponse> {
  const opened = await invokeBrokerControl(runnerPath, {
    operation: "identity",
    profileName,
  });
  if (opened.exitCode !== 0) {
    const reason = opened.stderr.trim() || opened.stdout.trim() || `exit ${opened.exitCode}`;
    throw new Error(`${OS_SANDBOX_PREPARE_FAILED}: ${reason}`);
  }
  const response = JSON.parse(opened.stdout.trim()) as BrokerPrepareResponse;
  if (!response.ok || !response.sid || !response.profilePath || response.profileName !== profileName) {
    throw new Error(`${OS_SANDBOX_PREPARE_FAILED}: broker returned incomplete identity response`);
  }
  return response;
}

async function cleanupSandboxPolicy(
  runnerPath: string,
  manifest: Pick<SandboxPolicyManifest, "profileName" | "rwRoots" | "execRoots">
): Promise<void> {
  const cleanup = await invokeBrokerControl(runnerPath, {
    operation: "revoke",
    profileName: manifest.profileName,
    // Toolchain RX grants are explicit privileged setup state. A medium-token
    // runtime must never attempt to rewrite protected Program Files ACLs.
    removeRoots: [...manifest.rwRoots],
    rwRoots: [],
    rxRoots: [],
  });
  if (cleanup.exitCode !== 0) {
    const reason = cleanup.stderr.trim() || cleanup.stdout.trim() || `exit ${cleanup.exitCode}`;
    throw new Error(`${OS_SANDBOX_ACL_FAILED}: sandbox policy cleanup failed: ${reason}`);
  }
}

function buildBrokerEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    COMSPEC: path.join(systemRoot, "System32", "cmd.exe"),
    PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE || "AMD64",
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS || "1",
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
}

function discoverApprovedExecRootStrings(): string[] {
  const roots = splitSemicolonList(process.env.SANDBOX_EXEC_ROOTS);
  roots.push(path.dirname(process.execPath)); // node + npm on the supported host
  const git = findExecutableOnPath("git");
  if (git) roots.push(path.dirname(git));
  return roots;
}

const sensitiveEnvPattern = /(?:^|_)(?:OPENAI|ADMIN|API_KEY|TOKEN|SECRET|PASSWORD|AWS|AZURE|GITHUB|GH|SSH)(?:_|$)/i;

function isSensitiveEnvName(name: string): boolean {
  return sensitiveEnvPattern.test(name) || /(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)$/i.test(name);
}

function buildSandboxEnvironment(state: SandboxState): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const powershellDir = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  const pathEntries = [path.join(systemRoot, "System32"), powershellDir, ...state.execRoots];
  const home = path.join(state.profilePath, "Home");
  const localAppData = path.join(state.profilePath, "AppData", "Local");
  const roamingAppData = path.join(state.profilePath, "AppData", "Roaming");
  const temp = path.join(state.profilePath, "Temp");
  const env: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    COMSPEC: path.join(systemRoot, "System32", "cmd.exe"),
    PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE || "AMD64",
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS || "1",
    PATH: [...new Set(pathEntries.map((entry) => path.resolve(entry)))].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
    APPDATA: roamingAppData,
    TEMP: temp,
    TMP: temp,
  };

  const allowSensitive = process.env.SANDBOX_ALLOW_SENSITIVE_ENV === "1";
  for (const name of splitSemicolonList(process.env.SANDBOX_ENV_ALLOWLIST)) {
    if (!allowSensitive && isSensitiveEnvName(name)) continue;
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function pathInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function createOutsideSelfTestDir(rwRoots: string[]): Promise<string> {
  const candidates = [os.tmpdir(), path.dirname(rwRoots[0] || repoRoot)];
  for (const base of candidates) {
    try {
      const canonicalBase = await fs.realpath(base);
      if (rwRoots.some((root) => pathInsideRoot(canonicalBase, root))) continue;
      const dir = await fs.mkdtemp(path.join(canonicalBase, "clc-sandbox-outside-"));
      const canonical = await fs.realpath(dir);
      if (rwRoots.some((root) => pathInsideRoot(canonical, root))) {
        await fs.rm(dir, { recursive: true, force: true });
        continue;
      }
      return canonical;
    } catch {
      continue;
    }
  }
  throw new Error(`${OS_SANDBOX_SELF_TEST_FAILED}: could not create a temporary outside-root test directory`);
}

async function runSandboxSelfTest(state: SandboxState): Promise<void> {
  if (process.env.CLC_TEST_FORCE_SANDBOX_FAILURE === "1") {
    throw new Error(`${OS_SANDBOX_SELF_TEST_FAILED}: forced failure test seam`);
  }
  const insideBase = state.rwRoots[0];
  if (!insideBase) throw new Error(`${OS_SANDBOX_SELF_TEST_FAILED}: no writable workspace root`);
  const selfRoot = await fs.mkdtemp(path.join(insideBase, ".clc-sandbox-selftest-"));
  const outsideRoot = await createOutsideSelfTestDir(state.rwRoots);
  const insideRead = path.join(selfRoot, "inside-read.txt");
  const insideWrite = path.join(selfRoot, "inside-write.txt");
  const childProbe = path.join(selfRoot, "SandboxChildProbe.exe");
  const childMarker = path.join(selfRoot, "child-marker.txt");
  const childStdout = path.join(selfRoot, "child-stdout.txt");
  const outsideRead = path.join(outsideRoot, "outside-secret.txt");
  const outsideWrite = path.join(outsideRoot, "outside-write.txt");

  try {
    await fs.writeFile(insideRead, "inside", "utf8");
    await fs.writeFile(outsideRead, "outside-secret", "utf8");
    await fs.copyFile(defaultChildProbePath, childProbe);
    const powershell = path.join(
      process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command = [
      "$ErrorActionPreference='Stop'",
      `$insideRead=${ps(insideRead)}`,
      `$insideWrite=${ps(insideWrite)}`,
      `$outsideRead=${ps(outsideRead)}`,
      `$outsideWrite=${ps(outsideWrite)}`,
      "$okInsideRead=$false; try { [IO.File]::ReadAllText($insideRead)|Out-Null; $okInsideRead=$true } catch {}",
      "$okInsideWrite=$false; try { [IO.File]::WriteAllText($insideWrite,'inside-ok'); $okInsideWrite=$true } catch {}",
      "$outsideReadDenied=$false; try { [IO.File]::ReadAllText($outsideRead)|Out-Null } catch [UnauthorizedAccessException] { $outsideReadDenied=$true } catch {}",
      "$outsideWriteDenied=$false; try { [IO.File]::WriteAllText($outsideWrite,'escape') } catch [UnauthorizedAccessException] { $outsideWriteDenied=$true } catch {}",
      `$child=Start-Process -FilePath ${ps(childProbe)} -ArgumentList @(${ps(childMarker)},${ps(outsideRead)},${ps(outsideWrite)}) -WorkingDirectory ${ps(selfRoot)} -NoNewWindow -Wait -PassThru -RedirectStandardOutput ${ps(childStdout)}`,
      `$childText=if (Test-Path -LiteralPath ${ps(childStdout)}) { Get-Content -LiteralPath ${ps(childStdout)} -Raw } else { '' }`,
      "$childReadDenied=$childText -match 'outside_read=denied'",
      "$childWriteDenied=$childText -match 'outside_write=denied'",
      "if (-not $okInsideRead -or -not $okInsideWrite -or -not $outsideReadDenied -or -not $outsideWriteDenied -or $child.ExitCode -ne 0 -or -not $childReadDenied -or -not $childWriteDenied) { exit 93 }",
      "Write-Output 'sandbox_self_test=passed'",
    ].join("; ");
    const result = await invokeSandboxedProcess(state, {
      executable: powershell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      cwd: selfRoot,
      timeoutMs: 20_000,
    });
    const { stdout, stderr, code } = await collectProcess(result.child, 25_000);
    if (code !== 0 || !stdout.includes("sandbox_self_test=passed")) {
      throw new Error(`${OS_SANDBOX_SELF_TEST_FAILED}: exit=${code}; stderr=${stderr.trim().slice(-1000)}`);
    }
    const childMarkerValue = await fs.readFile(childMarker, "utf8").then((value) => value.trim(), () => "");
    if (childMarkerValue !== "child-ok") {
      throw new Error(`${OS_SANDBOX_SELF_TEST_FAILED}: nested child did not launch inside allowed root`);
    }
    if (existsSync(outsideWrite)) {
      throw new Error(`${OS_SANDBOX_SELF_TEST_FAILED}: outside write marker exists`);
    }
  } finally {
    await fs.rm(selfRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(outsideRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function collectProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${OS_SANDBOX_SELF_TEST_FAILED}: process collection timed out`)));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve({ stdout, stderr, code })));
  });
}

export async function initializeProcessSecurity(): Promise<ProcessSecurityStatus> {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    status = buildInitialStatus();
    sandboxState = null;
    if (getFullDiskAccess()) return status;

    status.sandbox_self_test = "preparing";
    if (process.platform !== "win32") {
      status.sandbox_self_test = "failed";
      status.sandbox_error = `${OS_SANDBOX_UNAVAILABLE}: AppContainer backend requires Windows`;
      return status;
    }

    try {
      const runnerPath = sandboxHelperPath();
      await assertHelperIntegrity(runnerPath);
      await assertHelperIntegrity(defaultChildProbePath);
      const rwRoots = await canonicalDirectories(getWorkspaceRoots());
      if (rwRoots.length === 0) throw new Error(`${OS_SANDBOX_PREPARE_FAILED}: no workspace roots configured`);
      const execRoots = await canonicalDirectories(discoverApprovedExecRootStrings());
      const networkMode = readNetworkMode();
      const profileName = profileNameFor();
      const previous = await readPolicyManifest();

      // Identity is stable per Local Coder instance. Never auto-delete a
      // different historic identity here: older manager builds could make
      // multiple instances share ChatGPTLocalCoder.default, so silently cleaning
      // that SID could remove ACLs still owned by another live instance.
      if (previous && previous.profileName !== profileName) {
        throw new Error(
          `${OS_SANDBOX_PREPARE_FAILED}: sandbox identity changed from ${previous.profileName} to ${profileName}. ` +
            "Refusing automatic ACL cleanup because ownership of the previous AppContainer identity is not provably exclusive. " +
            "Run the explicit sandbox setup/reconciliation workflow, then restart Local Coder."
        );
      }
      const previousSameProfile = previous?.profileName === profileName ? previous : null;
      if (previousSameProfile && !sameCanonicalPathSet(previousSameProfile.execRoots, execRoots)) {
        throw new Error(
          `${OS_SANDBOX_PREPARE_FAILED}: approved executable roots changed for ${profileName}. ` +
            "Refusing to run with stale AppContainer RX grants. Run `npm run setup:sandbox` once to reconcile privileged toolchain ACLs, then restart Local Coder."
        );
      }
      const previousRoots = previousSameProfile
        ? [...previousSameProfile.rwRoots]
        : [];

      const canReusePolicy = Boolean(
        previousSameProfile &&
        sameCanonicalPathSet(previousSameProfile.rwRoots, rwRoots) &&
        sameCanonicalPathSet(previousSameProfile.execRoots, execRoots)
      );

      if (canReusePolicy && previousSameProfile) {
        // Durable inherited ACLs do not need recursive reconciliation on every
        // boot. Re-open the deterministic identity without mutation, verify its
        // SID against the persisted policy ledger, then run the same real OS
        // boundary self-test before allowing any agent-triggered process.
        const response = await openSandboxIdentity(runnerPath, profileName);
        if (response.sid.toLowerCase() !== previousSameProfile.sid.toLowerCase()) {
          throw new Error(
            `${OS_SANDBOX_PREPARE_FAILED}: sandbox SID changed for ${profileName}; ` +
              `manifest=${previousSameProfile.sid} runtime=${response.sid}. Run explicit sandbox setup/reconciliation.`
          );
        }
        sandboxState = {
          profileName,
          sid: response.sid,
          profilePath: response.profilePath,
          rwRoots,
          execRoots,
          networkMode,
          runnerPath,
        };
        status = {
          path_tool_full_disk_access: false,
          process_sandbox_mode: "required",
          process_filesystem_scope: "workspace_roots",
          process_network_mode: networkMode,
          sandbox_backend: "windows_appcontainer",
          sandbox_self_test: "preparing",
          sandbox_identity: profileName,
          sandbox_profile_path: response.profilePath,
          sandbox_rw_roots: [...rwRoots],
          sandbox_exec_roots: [...execRoots],
          sandbox_policy_reused: true,
        };
        await runSandboxSelfTest(sandboxState);
        status.sandbox_self_test = "passed";
        return status;
      }

      let prepareAttempted = false;
      try {
        if (process.env.CLC_TEST_FORCE_SANDBOX_FAILURE === "prepare") {
          throw new Error(`${OS_SANDBOX_PREPARE_FAILED}: forced failure test seam`);
        }
        prepareAttempted = true;
        const response = await prepareSandboxPolicy(
          runnerPath,
          profileName,
          rwRoots,
          execRoots,
          previousRoots,
          networkMode
        );
        sandboxState = {
          profileName,
          sid: response.sid,
          profilePath: response.profilePath,
          rwRoots,
          execRoots,
          networkMode,
          runnerPath,
        };
        status = {
          path_tool_full_disk_access: false,
          process_sandbox_mode: "required",
          process_filesystem_scope: "workspace_roots",
          process_network_mode: networkMode,
          sandbox_backend: "windows_appcontainer",
          sandbox_self_test: "preparing",
          sandbox_identity: profileName,
          sandbox_profile_path: response.profilePath,
          sandbox_rw_roots: [...rwRoots],
          sandbox_exec_roots: [...execRoots],
          sandbox_policy_reused: false,
        };
        await runSandboxSelfTest(sandboxState);
        await writePolicyManifest({
          version: 1,
          profileName,
          sid: response.sid,
          rwRoots: [...rwRoots],
          execRoots: [...execRoots],
          updatedAt: new Date().toISOString(),
        });
        status.sandbox_self_test = "passed";
        return status;
      } catch (error) {
        // Policy updates are transactional. If validation fails, restore the
        // previous same-profile grants or remove the newly prepared identity.
        // Rollback failure is appended to the primary error and still fails closed.
        let rollbackError = "";
        if (prepareAttempted) {
          try {
            if (previousSameProfile) {
              // A timed-out broker may have changed only part of the ACL before
              // its process was terminated. Reconcile the union of attempted and
              // previous roots unconditionally; do not rely on receiving a
              // successful prepare response as proof that rollback is needed.
              await prepareSandboxPolicy(
                runnerPath,
                profileName,
                previousSameProfile.rwRoots,
                previousSameProfile.execRoots,
                [...new Set([...rwRoots, ...previousSameProfile.rwRoots])],
                networkMode
              );
            } else {
              await cleanupSandboxPolicy(runnerPath, {
                profileName,
                rwRoots,
                execRoots,
              });
              await deletePolicyManifest();
            }
          } catch (rollback) {
            rollbackError = `; rollback_failed=${rollback instanceof Error ? rollback.message : String(rollback)}`;
          }
        }
        const primary = error instanceof Error ? error.message : String(error);
        throw new Error(`${primary}${rollbackError}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sandboxState = null;
      status.sandbox_self_test = "failed";
      status.sandbox_error = message.startsWith("OS_SANDBOX_") ? message : `${OS_SANDBOX_UNAVAILABLE}: ${message}`;
      return status;
    }
  })();
  return initializationPromise;
}

export function resetProcessSecurityForTests(): void {
  sandboxState = null;
  initializationPromise = null;
  status = buildInitialStatus();
}

export function getProcessSecurityStatus(): ProcessSecurityStatus {
  return {
    ...status,
    sandbox_rw_roots: [...status.sandbox_rw_roots],
    sandbox_exec_roots: [...status.sandbox_exec_roots],
  };
}

/** True only when arbitrary/project-controlled local process trees are actually
 * running under a healthy OS sandbox. "required" alone is not enough: a failed
 * startup self-test means execution is fail-closed, not sandboxed-and-running. */
export function areAgentProcessesOsSandboxed(): boolean {
  return (
    !getFullDiskAccess() &&
    status.process_sandbox_mode === "required" &&
    status.sandbox_backend === "windows_appcontainer" &&
    status.sandbox_self_test === "passed" &&
    sandboxState !== null
  );
}

export function assertProcessExecutionAvailable(): void {
  if (getFullDiskAccess()) return;
  if (!sandboxState || status.sandbox_self_test !== "passed") {
    throw new Error(status.sandbox_error || `${OS_SANDBOX_UNAVAILABLE}: sandbox is not healthy`);
  }
}

function findExecutableOnPath(command: string): string | null {
  if (path.isAbsolute(command)) return existsSync(command) ? path.resolve(command) : null;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const known: Record<string, string> = {
    "powershell.exe": path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    powershell: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "cmd.exe": path.join(systemRoot, "System32", "cmd.exe"),
    cmd: path.join(systemRoot, "System32", "cmd.exe"),
  };
  const direct = known[command.toLowerCase()];
  if (direct && existsSync(direct)) return direct;
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const hasExt = Boolean(path.extname(command));
  for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidates = hasExt ? [path.join(entry, command)] : extensions.map((ext) => path.join(entry, command + ext.toLowerCase()));
    for (const candidate of candidates) {
      if (existsSync(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

async function invokeSandboxedProcess(state: SandboxState, request: ProcessSpawnRequest): Promise<ProcessHandle> {
  const executable = findExecutableOnPath(request.executable);
  if (!executable) throw new Error(`${SANDBOX_TOOLCHAIN_NOT_ALLOWED}: executable not found: ${request.executable}`);
  const child = spawn(state.runnerPath, [], {
    cwd: repoRoot,
    windowsHide: true,
    env: buildBrokerEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const brokerRequest = {
    operation: "run",
    profileName: state.profileName,
    executable,
    args: request.args || [],
    cwd: path.resolve(request.cwd),
    env: buildSandboxEnvironment(state),
    rwRoots: state.rwRoots,
    rxRoots: state.execRoots,
    networkMode: state.networkMode,
    timeoutMs: Math.max(0, Math.floor(request.timeoutMs || 0)),
  };
  child.stdin.end(JSON.stringify(brokerRequest));
  return {
    child,
    sandboxed: true,
    backend: "windows_appcontainer",
    executable,
    terminate: async () => {
      if (child.killed || child.exitCode !== null) return false;
      // The broker owns a Job Object with KILL_ON_JOB_CLOSE. Terminating the
      // broker closes that handle and the kernel terminates the whole tree.
      return child.kill();
    },
  };
}

async function terminateNativeTree(child: ChildProcessWithoutNullStreams, force = true): Promise<boolean> {
  if (!child.pid || child.exitCode !== null) return false;
  try {
    if (process.platform === "win32") {
      const args = ["/PID", String(child.pid), "/T"];
      if (force) args.push("/F");
      const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore", env: buildBrokerEnvironment() });
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          killer.kill();
          finish(false);
        }, 3000);
        timer.unref?.();
        killer.once("error", () => finish(false));
        killer.once("close", (code) => finish(code === 0));
      });
    }
    const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
    return true;
  } catch {
    return false;
  }
}

export async function spawnProcess(request: ProcessSpawnRequest): Promise<ProcessHandle> {
  if (getFullDiskAccess()) {
    const child = spawn(request.executable, request.args || [], {
      cwd: request.cwd,
      windowsHide: true,
      env: request.env || process.env,
      detached: request.detached ?? process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      child,
      sandboxed: false,
      backend: "native",
      executable: request.executable,
      terminate: (force = true) => terminateNativeTree(child, force),
    };
  }

  // Startup calls initializeProcessSecurity() proactively. Keep this lazy path as
  // a defense-in-depth guard for tests/internal callers that reach execution
  // before startup initialization has completed. Failure still remains closed.
  if (!sandboxState || status.sandbox_self_test === "uninitialized") {
    await initializeProcessSecurity();
  }
  assertProcessExecutionAvailable();
  return await invokeSandboxedProcess(sandboxState!, request);
}
