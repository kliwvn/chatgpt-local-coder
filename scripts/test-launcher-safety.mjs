import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "chatgpt-local-coder.bat");
const source = await fs.readFile(launcher, "utf8");
const executorSource = await fs.readFile(path.join(root, "src", "lib", "process-executor.ts"), "utf8");
const startupCoreSource = await fs.readFile(path.join(root, "scripts", "ensure-startup-core.mjs"), "utf8");
const managerStartSource = await fs.readFile(path.join(root, "scripts", "ensure-manager-start.mjs"), "utf8");

function runChild(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`child timed out: ${file} ${args.join(" ")}`));
    }, options.timeout || 10000);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

assert.match(source, /CLC_OS_SANDBOX%"=="windows_appcontainer/i);
assert.match(
  executorSource,
  /CLC_OS_SANDBOX:\s*"windows_appcontainer"/,
  "strict ProcessExecutor must mark child environments so launcher lifecycle calls fail closed",
);
for (const command of ["setup", "start", "startup", "stop", "autostart", "tunnel"]) {
  assert.match(
    source,
    new RegExp(`if /i "%CMD%"=="${command}"\\s+goto :sandbox_host_lifecycle_blocked`, "i"),
    `${command} must fail closed when the launcher is invoked from the agent AppContainer`,
  );
}
for (const command of ["status", "install", "help"]) {
  assert.doesNotMatch(
    source,
    new RegExp(`if /i "%CMD%"=="${command}"\\s+goto :sandbox_host_lifecycle_blocked`, "i"),
    `${command} is non-lifecycle and should remain available in the sandbox`,
  );
}
assert.match(source, /Host lifecycle bi chan trong Windows AppContainer agent sandbox/i);
assert.match(
  source,
  /^:cmd_startup\s*$[\s\S]{0,900}?call :manager_current[\s\S]{0,900}?call :ensure_runtime_core[\s\S]{0,900}?call :cmd_start/im,
  "Windows-login startup must fast-path a current Manager and reconcile only core runtime before starting Manager",
);
assert.doesNotMatch(
  source.match(/^:cmd_startup\s*$[\s\S]*?(?=^:cmd_stop\s*$)/im)?.[0] || "",
  /ensure-tunnel-client-lazy-codex|:cmd_install/,
  "Windows-login critical path must not eagerly verify/build tunnel runtime; Manager tunnel lifecycle owns lazy tunnel preflight",
);
assert.match(
  source,
  /:ensure_runtime_core[\s\S]{0,500}?ensure-startup-core\.mjs/,
  "launcher core preflight must use the dedicated dependency/build freshness helper",
);
assert.match(
  source,
  /^:cmd_start\s*$[\s\S]{0,800}?ensure-manager-start\.mjs[\s\S]{0,300}?if errorlevel 1/im,
  "Manager startup must delegate single-flight/readiness ownership to the dedicated helper",
);
assert.match(
  source,
  /^:manager_current\s*$[\s\S]{0,700}?TcpClient[\s\S]{0,500}?Wait\(300\)/im,
  "cold login Manager detection must use a bounded TCP precheck before HTTP identity validation",
);
assert.doesNotMatch(
  source.match(/^:cmd_startup\s*$[\s\S]*?(?=^:cmd_stop\s*$)/im)?.[0] || "",
  /call :cmd_start\s*>>/i,
  "startup must not hold startup.log as redirected stdout across Manager spawn; that can lock later milestone appends",
);
assert.doesNotMatch(
  source.match(/^:cmd_startup\s*$[\s\S]*?(?=^:cmd_stop\s*$)/im)?.[0] || "",
  /call :ensure_runtime_core\s*>>/i,
  "concurrent startup must not hold one shared startup.log handle across core preflight",
);
assert.doesNotMatch(
  source.match(/^:cmd_start\s*$[\s\S]*?(?=^:cmd_startup\s*$)/im)?.[0] || "",
  /manager-start\.lock|wait_manager_ready|Start-Process|ping\s+-n\s+5/i,
  "batch launcher must not reimplement Manager single-flight/spawn/readiness logic",
);
assert.match(
  source,
  /startup\.log/,
  "hidden Windows-login startup must persist pre-Manager failure diagnostics",
);
assert.match(
  source,
  /startup\.log[\s\S]{0,500}?524288[\s\S]{0,350}?startup\.prev\.log/,
  "startup diagnostics must stay bounded instead of growing forever across logins",
);
assert.match(
  startupCoreSource,
  /startup-core\.lock[\s\S]{0,1800}?fsp\.mkdir\(coreLockDir\)[\s\S]{0,2600}?processIsAlive[\s\S]{0,2600}?releaseCoreLock/,
  "dependency/build preflight must be single-flight with dead-owner recovery and owned release",
);
assert.match(
  managerStartSource,
  /manager-start\.lock/,
  "Manager start helper must use an owned single-flight lock with dead-owner recovery",
);
assert.match(managerStartSource, /fsp\.mkdir\(lockDir\)/, "Manager start helper must acquire the lock atomically");
assert.match(managerStartSource, /processIsAlive\(owner\.pid\)/, "Manager start helper must recover dead lock owners");
assert.match(managerStartSource, /await release\(claim\.owner\)/, "Manager start helper must release only its owned lock");
assert.match(
  managerStartSource,
  /detached:\s*true/,
  "Manager start helper must detach the Manager and verify readiness rather than fixed-sleep",
);
assert.match(managerStartSource, /child\.unref\(\)/, "Manager start helper must unref the detached Manager");
assert.match(managerStartSource, /await waitHealthy\(pid\)/, "Manager start helper must verify Manager readiness after spawn");
assert.match(
  managerStartSource,
  /Get-CimInstance Win32_Process/,
  "Manager helper must prove exact Windows process ownership and self-restart an artifact-drifted Manager",
);
assert.match(managerStartSource, /artifactDrift/, "Manager helper must inspect Manager artifact drift");
assert.match(managerStartSource, /\/api\/manager\/restart/, "Manager helper must use the Manager self-restart handoff for drift");
assert.match(
  startupCoreSource,
  /startup-core\.log[\s\S]{0,5000}?atomicWriteFile\(coreStatusLog/,
  "core preflight must keep a bounded latest-status diagnostic instead of sharing the login append handle",
);
assert.match(
  source,
  /:ensure_autostart[\s\S]{0,1800}?launcherLiteral[\s\S]{0,500}?startup/,
  "autostart shortcut must target the reconciled startup command rather than raw Manager start",
);
assert.match(
  source,
  /:manager_running[\s\S]{0,520}?Invoke-RestMethod[\s\S]{0,320}?\$r\.ok -eq \$true[\s\S]{0,180}?\$r\.name -eq 'chatgpt-local-coder-manager'/,
  "launcher Manager detection must require the Local Coder Manager health identity, not any HTTP 200 occupant",
);
for (const section of ["cmd_stop", "cmd_status", "cmd_autostart"]) {
  assert.match(
    source,
    new RegExp(`^:${section}[\\s\\S]{0,1800}?if errorlevel 1 exit /b 1`, "im"),
    `${section} must propagate a failed child/action instead of false-green exit 0`,
  );
}
const tunnelStart = source.search(/^:cmd_tunnel\s*$/im);
const tunnelEnd = source.search(/^:ensure_autostart\s*$/im);
const tunnelBlock = tunnelStart >= 0 && tunnelEnd > tunnelStart ? source.slice(tunnelStart, tunnelEnd) : "";
assert.ok(
  (tunnelBlock.match(/if errorlevel 1 exit \/b 1/gi) || []).length >= 2,
  "tunnel launcher must propagate failed start and failed stop API actions instead of false-green exit 0",
);
assert.match(
  source,
  /^:autostart_off[\s\S]{0,520}?del \/q[\s\S]{0,220}?if errorlevel 1[\s\S]{0,260}?if exist "%LNK%"/im,
  "autostart off must verify shortcut deletion instead of reporting success after a failed delete",
);
assert.match(
  source,
  /echo \[OK\] Da tat autostart \^\(xoa LNK\^\)\./,
  "autostart off status text must escape parentheses inside the cmd IF block",
);

if (process.platform === "win32") {
  const run = spawnSync("cmd.exe", ["/d", "/c", launcher, "start"], {
    cwd: root,
    env: { ...process.env, CLC_OS_SANDBOX: "windows_appcontainer" },
    stdio: "ignore",
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 1, `sandboxed launcher start must exit 1, got ${run.status}`);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-launcher-safety-"));
  try {
    const isolatedLauncher = path.join(tmp, "chatgpt-local-coder.bat");
    await fs.copyFile(launcher, isolatedLauncher);

    // A missing/invalid Startup destination must not be turned into CLI success.
    // Point APPDATA at a regular file so WScript.Shell cannot save the .lnk below it.
    const fakeAppData = path.join(tmp, "appdata-file");
    await fs.writeFile(fakeAppData, "not-a-directory", "utf8");
    const autostartFail = spawnSync("cmd.exe", ["/d", "/c", isolatedLauncher, "autostart"], {
      cwd: tmp,
      env: { ...process.env, APPDATA: fakeAppData },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(autostartFail.error, undefined, autostartFail.error?.message);
    assert.notEqual(autostartFail.status, 0, `autostart creation failure must propagate non-zero, output=${autostartFail.stdout}${autostartFail.stderr}`);

    // A real Manager-identity health response followed by a failed tunnel action
    // must also propagate the PowerShell/API failure through cmd.exe.
    const fakeManager = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") {
        res.end(JSON.stringify({ ok: true, name: "chatgpt-local-coder-manager", pid: process.pid }));
        return;
      }
      if (req.url === "/api/instances/default/tunnel/start") {
        res.end(JSON.stringify({ ok: false, error: "injected tunnel failure" }));
        return;
      }
      if (req.url === "/api/instances") {
        res.end(JSON.stringify({ instances: [] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false }));
    });
    await new Promise((resolve, reject) => {
      fakeManager.once("error", reject);
      fakeManager.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = fakeManager.address().port;
      await fs.writeFile(path.join(tmp, ".env"), `MANAGER_PORT=${port}\n`, "utf8");
      const tunnelFail = await runChild("cmd.exe", ["/d", "/c", isolatedLauncher, "tunnel", "start"], {
        cwd: tmp,
        windowsHide: true,
        timeout: 10000,
      });
      assert.notEqual(tunnelFail.status, 0, `failed tunnel API action must propagate non-zero, output=${tunnelFail.stdout}${tunnelFail.stderr}`);

      const statusOk = await runChild("cmd.exe", ["/d", "/c", isolatedLauncher, "status"], {
        cwd: tmp,
        windowsHide: true,
        timeout: 10000,
      });
      assert.equal(statusOk.status, 0, `valid fake Manager identity should satisfy status, output=${statusOk.stdout}${statusOk.stderr}`);
    } finally {
      await new Promise((resolve) => fakeManager.close(resolve));
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

console.log("launcher-safety: ok (agent AppContainer cannot start/stop/persist/tunnel host lifecycle)");
