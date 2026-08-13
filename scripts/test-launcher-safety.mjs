import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "chatgpt-local-coder.bat");
const source = await fs.readFile(launcher, "utf8");
const executorSource = await fs.readFile(path.join(root, "src", "lib", "process-executor.ts"), "utf8");

assert.match(source, /CLC_OS_SANDBOX%"=="windows_appcontainer/i);
assert.match(
  executorSource,
  /CLC_OS_SANDBOX:\s*"windows_appcontainer"/,
  "strict ProcessExecutor must mark child environments so launcher lifecycle calls fail closed",
);
for (const command of ["setup", "start", "stop", "autostart", "tunnel"]) {
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
}

console.log("launcher-safety: ok (agent AppContainer cannot start/stop/persist/tunnel host lifecycle)");
