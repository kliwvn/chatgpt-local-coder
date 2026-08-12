import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Temp base derives from the repo itself, never WORKSPACE_PATH: that env value
// can be a placeholder or point outside the test's control.
const testBase = path.resolve(repoRoot, "..");
const root = await fs.mkdtemp(path.join(testBase, "clc-start-sandbox-"));
const outside = await fs.mkdtemp(path.join(testBase, "clc-start-outside-"));
const outsideSecret = path.join(outside, "secret.txt");
const outsideWrite = path.join(outside, "escape.txt");
const script = path.join(root, "background-probe.cjs");
const parentResult = path.join(root, "parent-result.json");
const childResult = path.join(root, "child-result.json");
const pidsFile = path.join(root, "pids.json");
await fs.writeFile(outsideSecret, "outside-secret", "utf8");

const old = Object.fromEntries([
  "FULL_DISK_ACCESS",
  "LOCAL_CODER_INSTANCE_ID",
  "CLC_SANDBOX_PROFILE_NAME",
  "CLC_SANDBOX_STATE_DIR",
  "SANDBOX_NETWORK_MODE",
  "MCP_SHELL_STATE_DIR",
].map((key) => [key, process.env[key]]));

function ps(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

try {
  process.env.FULL_DISK_ACCESS = "false";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(root, ".sandbox-state");
  process.env.SANDBOX_NETWORK_MODE = "none";
  process.env.MCP_SHELL_STATE_DIR = path.join(root, ".shell-state");

  const pathSecurity = await import("../dist/lib/path-security.js");
  const executor = await import("../dist/lib/process-executor.js");
  pathSecurity.setDefaultCwd(root);
  pathSecurity.setWorkspaceRoots([root]);
  executor.resetProcessSecurityForTests();
  const security = await executor.initializeProcessSecurity();
  assert.equal(security.sandbox_self_test, "passed", security.sandbox_error);

  await fs.writeFile(script, [
    "const fs=require('node:fs'); const cp=require('node:child_process');",
    "const [mode,parentResult,childResult,pidsFile,outsideRead,outsideWrite]=process.argv.slice(2);",
    "function probe(){let r='denied',w='denied';try{fs.readFileSync(outsideRead);r='escape'}catch(e){if(!['EACCES','EPERM'].includes(e.code))r='error:'+e.code}try{fs.writeFileSync(outsideWrite,'escape');w='escape'}catch(e){if(!['EACCES','EPERM'].includes(e.code))w='error:'+e.code}return {r,w};}",
    "if(mode==='child'){const x=probe();fs.writeFileSync(childResult,JSON.stringify(x));setInterval(()=>{},1000);return;}",
    "const x=probe();fs.writeFileSync(parentResult,JSON.stringify(x));",
    // stdio:'inherit': inside an AppContainer 'ignore' fails on the NUL device
    // and anonymous-pipe stdio hangs node's CreateProcess (see
    // test-process-security-boundary); inherit still runs the child with the
    // same container token, which is the property under test.
    "const child=cp.spawn(process.execPath,[__filename,'child',parentResult,childResult,pidsFile,outsideRead,outsideWrite],{stdio:'inherit'});",
    "fs.writeFileSync(pidsFile,JSON.stringify({parent:process.pid,child:child.pid}));console.log('READY parent='+process.pid+' child='+child.pid);setInterval(()=>{},1000);",
  ].join("\n"), "utf8");

  const shell = await import("../dist/tools/shell.js");
  const handlers = new Map();
  shell.registerShellTools({
    registerTool(name, _definition, handler) { handlers.set(name, handler); },
  }, root, 60);
  const call = async (name, args = {}) => {
    const handler = handlers.get(name);
    assert.equal(typeof handler, "function", `missing ${name}`);
    return handler(args);
  };
  const data = (result) => result.structuredContent.data;

  const started = data(await call("start_process", {
    command: `node ${ps(script)} parent ${ps(parentResult)} ${ps(childResult)} ${ps(pidsFile)} ${ps(outsideSecret)} ${ps(outsideWrite)}`,
    working_directory: root,
  }));
  assert.equal(started.sandboxed, true);
  assert.equal(started.sandbox_backend, "windows_appcontainer");

  const deadline = Date.now() + 10_000;
  let output = "";
  while (Date.now() < deadline) {
    const current = data(await call("process_output", { id: started.id, tail_chars: 20_000 }));
    output = current.stdout || "";
    if (output.includes("READY")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(output, /READY parent=\d+ child=\d+/, output);

  const pids = JSON.parse(await fs.readFile(pidsFile, "utf8"));
  const parentProbe = JSON.parse(await fs.readFile(parentResult, "utf8"));
  const childDeadline = Date.now() + 5000;
  while (Date.now() < childDeadline) {
    try { await fs.access(childResult); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  const childProbe = JSON.parse(await fs.readFile(childResult, "utf8"));
  assert.deepEqual(parentProbe, { r: "denied", w: "denied" });
  assert.deepEqual(childProbe, { r: "denied", w: "denied" });
  await assert.rejects(fs.stat(outsideWrite));
  assert.equal(await pidAlive(pids.parent), true, "background parent was not alive before stop");
  assert.equal(await pidAlive(pids.child), true, "background child was not alive before stop");

  const stopped = data(await call("stop_process", { id: started.id, force: true }));
  assert.equal(stopped.sent, true);
  const stopDeadline = Date.now() + 5000;
  while (Date.now() < stopDeadline && ((await pidAlive(pids.parent)) || (await pidAlive(pids.child)))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await pidAlive(pids.parent), false, `parent ${pids.parent} survived Job Object stop`);
  assert.equal(await pidAlive(pids.child), false, `child ${pids.child} survived Job Object stop`);
  await shell.shutdownManagedProcesses();

  console.log("OK start_process sandbox: background parent/child denied outside and Job Object stop killed whole tree");
} finally {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
}
