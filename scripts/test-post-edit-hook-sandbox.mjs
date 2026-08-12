import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const testBase = path.resolve(process.env.WORKSPACE_PATH?.trim() || path.dirname(process.cwd()));
const root = await fs.mkdtemp(path.join(testBase, "clc-hook-sandbox-"));
const outside = await fs.mkdtemp(path.join(testBase, "clc-hook-outside-"));
const target = path.join(root, "edited.txt");
const config = path.join(root, "hooks.json");
const probe = path.join(root, "hook-probe.cjs");
const insideMarker = path.join(root, "hook-inside.txt");
const outsideSecret = path.join(outside, "secret.txt");
const outsideWrite = path.join(outside, "escape.txt");
await fs.writeFile(target, "edited\n", "utf8");
await fs.writeFile(outsideSecret, "secret\n", "utf8");

const old = Object.fromEntries([
  "FULL_DISK_ACCESS",
  "LOCAL_CODER_INSTANCE_ID",
  "CLC_SANDBOX_PROFILE_NAME",
  "CLC_SANDBOX_STATE_DIR",
  "SANDBOX_NETWORK_MODE",
  "POST_EDIT_HOOKS_CONFIG",
].map((key) => [key, process.env[key]]));

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

try {
  process.env.FULL_DISK_ACCESS = "false";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(root, ".sandbox-state");
  process.env.SANDBOX_NETWORK_MODE = "none";
  process.env.POST_EDIT_HOOKS_CONFIG = config;

  const pathSecurity = await import("../dist/lib/path-security.js");
  const executor = await import("../dist/lib/process-executor.js");
  pathSecurity.setDefaultCwd(root);
  pathSecurity.setWorkspaceRoots([root]);
  executor.resetProcessSecurityForTests();
  const security = await executor.initializeProcessSecurity();
  assert.equal(security.sandbox_self_test, "passed", security.sandbox_error);

  await fs.writeFile(probe, [
    "const fs=require('node:fs');",
    "const [inside,outsideRead,outsideWrite]=process.argv.slice(2);",
    "fs.writeFileSync(inside,'hook-ok'); let r='denied',w='denied';",
    "try{fs.readFileSync(outsideRead);r='escape'}catch(e){if(!['EACCES','EPERM'].includes(e.code))r='error:'+e.code}",
    "try{fs.writeFileSync(outsideWrite,'escape');w='escape'}catch(e){if(!['EACCES','EPERM'].includes(e.code))w='error:'+e.code}",
    "console.log('hook_read='+r+' hook_write='+w); process.exit(r==='denied'&&w==='denied'?0:41);",
  ].join("\n"), "utf8");
  await fs.writeFile(config, JSON.stringify({
    enabled: true,
    hooks: [{
      glob: "**/*.txt",
      command: `node ${quote(probe)} ${quote(insideMarker)} ${quote(outsideSecret)} ${quote(outsideWrite)}`,
      timeout_ms: 10_000,
    }],
  }), "utf8");

  const { runPostEditHooks } = await import("../dist/lib/post-edit-hooks.js");
  const result = await runPostEditHooks([target]);
  const hook = result?.post_edit_hooks?.[0];
  assert.ok(hook, "strict post-edit hook did not execute");
  assert.equal(hook.exit_code, 0, JSON.stringify(hook));
  assert.match(hook.stdout, /hook_read=denied hook_write=denied/);
  assert.equal((await fs.readFile(insideMarker, "utf8")).trim(), "hook-ok");
  await assert.rejects(fs.stat(outsideWrite));

  console.log("OK post-edit hook sandbox: project hook ran inside workspace and OS denied outside read/write");
} finally {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
}
