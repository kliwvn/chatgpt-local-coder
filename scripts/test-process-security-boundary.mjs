import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testBase = path.resolve(repoRoot, "..");
const allowed = await fs.mkdtemp(path.join(testBase, "clc-sandbox-allowed-"));
const outside = await fs.mkdtemp(path.join(testBase, "clc-sandbox-outside-"));
const outsideSecret = path.join(outside, "outside-secret.txt");
const outsideWrite = path.join(outside, "outside-write.txt");
const failClosedMarker = path.join(allowed, "native-fallback-marker.txt");
const childProbe = path.join(allowed, "SandboxChildProbe.exe");
const compiledChildProbe = path.join(repoRoot, "native", "windows-sandbox-runner", "bin", "SandboxChildProbe.exe");
const childMarker = path.join(allowed, "child-marker.txt");
const childStdout = path.join(allowed, "child-stdout.txt");
const outsideJunction = path.join(allowed, "outside-junction");
await fs.writeFile(outsideSecret, "outside-secret", "utf8");
await fs.symlink(outside, outsideJunction, "junction");

const originalEnv = {
  FULL_DISK_ACCESS: process.env.FULL_DISK_ACCESS,
  CLC_TEST_SECRET: process.env.CLC_TEST_SECRET,
  CLC_TEST_FORCE_SANDBOX_FAILURE: process.env.CLC_TEST_FORCE_SANDBOX_FAILURE,
  SANDBOX_ENV_ALLOWLIST: process.env.SANDBOX_ENV_ALLOWLIST,
  SANDBOX_NETWORK_MODE: process.env.SANDBOX_NETWORK_MODE,
  SANDBOX_EXEC_ROOTS: process.env.SANDBOX_EXEC_ROOTS,
  LOCAL_CODER_INSTANCE_ID: process.env.LOCAL_CODER_INSTANCE_ID,
  CLC_SANDBOX_PROFILE_NAME: process.env.CLC_SANDBOX_PROFILE_NAME,
  CLC_SANDBOX_STATE_DIR: process.env.CLC_SANDBOX_STATE_DIR,
};

function ps(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

try {
  const pathSecurity = await import("../dist/lib/path-security.js");
  const processExecutor = await import("../dist/lib/process-executor.js");
  const shell = await import("../dist/lib/persistent-shell.js");

  process.env.FULL_DISK_ACCESS = "false";
  process.env.SANDBOX_NETWORK_MODE = "none";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(allowed, ".sandbox-state");
  process.env.CLC_TEST_SECRET = "super-secret-must-not-leak";
  process.env.SANDBOX_ENV_ALLOWLIST = "CLC_TEST_SECRET";
  delete process.env.CLC_TEST_FORCE_SANDBOX_FAILURE;
  pathSecurity.setDefaultCwd(allowed);
  pathSecurity.setWorkspaceRoots([allowed]);
  shell.resetShellSession(allowed);
  processExecutor.resetProcessSecurityForTests();

  const security = await processExecutor.initializeProcessSecurity();
  assert.equal(security.process_sandbox_mode, "required");
  assert.equal(security.sandbox_backend, "windows_appcontainer");
  assert.equal(security.sandbox_self_test, "passed", security.sandbox_error);
  // Copy only after the inheritable AppContainer ACE is prepared so the probe
  // executable itself is launchable by the sandbox identity.
  await fs.copyFile(compiledChildProbe, childProbe);

  // Intentionally opaque to requireCommandAllowed(): this binary performs the
  // filesystem operations internally, so OS denial—not command parsing—is the
  // only boundary that can make outside_read/outside_write report denied.
  const boundary = await shell.execInShellSession(
    `Start-Process -FilePath ${ps(childProbe)} -ArgumentList ${ps(childMarker)},${ps(outsideSecret)},${ps(outsideWrite)} ` +
      `-WorkingDirectory ${ps(allowed)} -NoNewWindow -Wait -RedirectStandardOutput ${ps(childStdout)}; ` +
      `Get-Content -LiteralPath ${ps(childStdout)}`,
    allowed,
    20_000,
    allowed
  );
  assert.equal(boundary.exit_code, 0, JSON.stringify(boundary));
  assert.match(boundary.stdout, /outside_read=denied/, JSON.stringify(boundary));
  assert.match(boundary.stdout, /outside_write=denied/, JSON.stringify(boundary));
  assert.equal((await fs.readFile(childMarker, "utf8")).trim(), "child-ok");
  await assert.rejects(fs.stat(outsideWrite));

  const envProbe = await shell.execInShellSession(
    `Write-Output $env:CLC_TEST_SECRET`,
    allowed,
    5_000,
    allowed
  );
  assert.equal(envProbe.exit_code, 0, envProbe.stderr);
  assert.equal(envProbe.stdout.trim(), "", "sandbox child inherited a blocked secret environment value");

  const nodeProbe = path.join(allowed, "node-boundary-probe.cjs");
  const nodeInside = path.join(allowed, "node-inside.txt");
  const nodeChildInside = path.join(allowed, "node-child-inside.txt");
  const nodeChildResult = path.join(allowed, "node-child-result.json");
  const nodeOutsideWrite = path.join(outside, "node-outside.txt");
  await fs.writeFile(nodeProbe, [
    "const fs=require('node:fs'); const cp=require('node:child_process');",
    "const [inside,childInside,childResult,outsideRead,outsideWrite]=process.argv.slice(2);",
    "function access(){ let r='denied',w='denied'; try{fs.readFileSync(outsideRead);r='escape'}catch(e){if(!['EACCES','EPERM'].includes(e.code))r='error:'+e.code} try{fs.writeFileSync(outsideWrite,'escape');w='escape'}catch(e){if(!['EACCES','EPERM'].includes(e.code))w='error:'+e.code} return {r,w}; }",
    "if(process.env.CLC_NODE_CHILD==='1'){fs.writeFileSync(childInside,'child-ok'); const x=access(); fs.writeFileSync(childResult,JSON.stringify(x)); process.exit(x.r==='denied'&&x.w==='denied'?0:31)}",
    "fs.writeFileSync(inside,'parent-ok'); const x=access(); const child=cp.spawnSync(process.execPath,[__filename,inside,childInside,childResult,outsideRead,outsideWrite],{env:{...process.env,CLC_NODE_CHILD:'1'},stdio:'ignore',timeout:5000}); const childData=JSON.parse(fs.readFileSync(childResult,'utf8')); console.log('node_read='+x.r+' node_write='+x.w+' child_exit='+child.status); console.log('child_read='+childData.r+' child_write='+childData.w); process.exit(x.r==='denied'&&x.w==='denied'&&child.status===0&&childData.r==='denied'&&childData.w==='denied'?0:32);",
  ].join("\n"), "utf8");
  const nodeRun = await shell.execInShellSession(
    `node ${ps(nodeProbe)} ${ps(nodeInside)} ${ps(nodeChildInside)} ${ps(nodeChildResult)} ${ps(outsideSecret)} ${ps(nodeOutsideWrite)}`,
    allowed,
    20_000,
    allowed
  );
  assert.equal(nodeRun.exit_code, 0, JSON.stringify(nodeRun));
  assert.match(nodeRun.stdout, /node_read=denied node_write=denied child_exit=0/);
  assert.match(nodeRun.stdout, /child_read=denied child_write=denied/);
  assert.equal((await fs.readFile(nodeInside, "utf8")).trim(), "parent-ok");
  assert.equal((await fs.readFile(nodeChildInside, "utf8")).trim(), "child-ok");
  await assert.rejects(fs.stat(nodeOutsideWrite));

  const npmRun = await shell.execInShellSession("npm.cmd --version", allowed, 15_000, allowed);
  assert.equal(npmRun.exit_code, 0, JSON.stringify(npmRun));
  assert.match(npmRun.stdout.trim(), /^\d+\.\d+\.\d+/);

  const junctionProbe = path.join(allowed, "junction-probe.cjs");
  const junctionWrite = path.join(outsideJunction, "junction-escape.txt");
  await fs.writeFile(junctionProbe, [
    "const fs=require('node:fs');",
    "const [readPath,writePath]=process.argv.slice(2); let r='denied',w='denied';",
    "try{fs.readFileSync(readPath);r='escape'}catch(e){if(!['EACCES','EPERM'].includes(e.code))r='error:'+e.code}",
    "try{fs.writeFileSync(writePath,'escape');w='escape'}catch(e){if(!['EACCES','EPERM'].includes(e.code))w='error:'+e.code}",
    "console.log('junction_read='+r+' junction_write='+w); process.exit(r==='denied'&&w==='denied'?0:51);",
  ].join("\n"), "utf8");
  const junctionRun = await shell.execInShellSession(
    `node ${ps(junctionProbe)} ${ps(path.join(outsideJunction, "outside-secret.txt"))} ${ps(junctionWrite)}`,
    allowed,
    10_000,
    allowed
  );
  assert.equal(junctionRun.exit_code, 0, JSON.stringify(junctionRun));
  assert.match(junctionRun.stdout, /junction_read=denied junction_write=denied/);
  await assert.rejects(fs.stat(path.join(outside, "junction-escape.txt")));

  for (const directive of [
    `cd ${ps(outside)}`,
    `Set-Location ${ps(outside)}`,
    `pushd ${ps(outside)}`,
  ]) {
    await assert.rejects(
      shell.execInShellSession(`${directive}; Write-Output should-not-run`, allowed, 5_000),
      /SHELL_CWD_OUTSIDE_SANDBOX/
    );
  }

  // Privileged RX toolchain grants are sticky Windows ACL state. If the approved
  // roots change, runtime must not silently keep using the old AppContainer SID
  // policy; it fails closed until explicit setup reconciles those ACLs.
  const addedExecRoot = path.join(allowed, "extra-exec-root");
  await fs.mkdir(addedExecRoot);
  process.env.SANDBOX_EXEC_ROOTS = addedExecRoot;
  processExecutor.resetProcessSecurityForTests();
  const staleExecPolicy = await processExecutor.initializeProcessSecurity();
  assert.equal(staleExecPolicy.sandbox_self_test, "failed");
  assert.match(staleExecPolicy.sandbox_error || "", /approved executable roots changed/);
  assert.equal(processExecutor.areAgentProcessesOsSandboxed(), false);
  delete process.env.SANDBOX_EXEC_ROOTS;
  processExecutor.resetProcessSecurityForTests();
  const restoredExecPolicy = await processExecutor.initializeProcessSecurity();
  assert.equal(restoredExecPolicy.sandbox_self_test, "passed", restoredExecPolicy.sandbox_error);
  assert.equal(processExecutor.areAgentProcessesOsSandboxed(), true);

  // Force sandbox preparation failure and prove there is no native fallback.
  process.env.CLC_TEST_FORCE_SANDBOX_FAILURE = "prepare";
  processExecutor.resetProcessSecurityForTests();
  shell.resetShellSession(allowed);
  const failed = await processExecutor.initializeProcessSecurity();
  assert.equal(failed.sandbox_self_test, "failed");
  assert.equal(processExecutor.areAgentProcessesOsSandboxed(), false);
  await assert.rejects(
    shell.execInShellSession(
      `Start-Process -FilePath ${ps(childProbe)} -ArgumentList ${ps(failClosedMarker)},${ps(outsideSecret)},${ps(outsideWrite)} ` +
        `-WorkingDirectory ${ps(allowed)} -NoNewWindow -Wait`,
      allowed,
      5_000,
      allowed
    ),
    /OS_SANDBOX_(?:PREPARE_FAILED|UNAVAILABLE)/
  );
  await assert.rejects(fs.stat(failClosedMarker));

  // Explicit trusted mode remains native and can reach the temp outside root.
  delete process.env.CLC_TEST_FORCE_SANDBOX_FAILURE;
  process.env.FULL_DISK_ACCESS = "true";
  processExecutor.resetProcessSecurityForTests();
  shell.resetShellSession(allowed);
  const nativeWrite = path.join(outside, "trusted-mode.txt");
  await fs.rm(nativeWrite, { force: true });
  const trusted = await shell.execInShellSession(
    `Start-Process -FilePath ${ps(childProbe)} -ArgumentList ${ps(childMarker)},${ps(outsideSecret)},${ps(nativeWrite)} ` +
      `-WorkingDirectory ${ps(allowed)} -NoNewWindow -Wait`,
    allowed,
    10_000,
    allowed
  );
  assert.equal(trusted.exit_code, 0, trusted.stderr);
  assert.equal(await fs.readFile(nativeWrite, "utf8"), "escape");

  console.log("OK process security boundary: strict OS deny + nested Node/npm + env sanitize + cwd guard + fail-closed + trusted full mode");
} finally {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(allowed, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
}
