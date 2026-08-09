import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-process-manager-"));
process.env.MCP_SHELL_STATE_DIR = path.join(root, "shell-state");
process.env.PROCESS_MAX_RUNNING = "2";
process.env.PROCESS_HISTORY_MAX = "2";
process.env.PROCESS_LOG_MAX_CHARS = "4096";
process.env.FULL_DISK_ACCESS = "true";

const { registerShellTools, getManagedProcessStats, shutdownManagedProcesses } = await import("../dist/tools/shell.js");
const handlers = new Map();
const server = {
  registerTool(name, _definition, handler) {
    handlers.set(name, handler);
  },
};
registerShellTools(server, process.cwd(), 30);
await new Promise((resolve) => setTimeout(resolve, 100));

async function call(name, args = {}) {
  const handler = handlers.get(name);
  assert.equal(typeof handler, "function", `missing handler ${name}`);
  return handler(args);
}
function data(result) {
  return result.structuredContent.data;
}
async function waitFinished(id, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = data(await call("process_status", { id })).processes[0];
    if (status && !status.running) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${id} did not finish`);
}
function nodeCommand(js) {
  const exe = JSON.stringify(process.execPath);
  const code = JSON.stringify(js);
  return process.platform === "win32" ? `& ${exe} -e ${code}` : `${exe} -e ${code}`;
}

try {
  const noisy = data(await call("start_process", { command: nodeCommand("process.stdout.write('x'.repeat(9000))") }));
  await waitFinished(noisy.id);
  const noisyOutput = data(await call("process_output", { id: noisy.id, tail_chars: 200000 }));
  assert.ok(noisyOutput.stdout.length <= 4096, `stdout was not bounded: ${noisyOutput.stdout.length}`);
  assert.ok(noisyOutput.stdout.endsWith("x".repeat(64)), "bounded log must preserve newest output");

  for (let i = 0; i < 4; i++) {
    const item = data(await call("start_process", { command: nodeCommand(`process.stdout.write('done-${i}')`) }));
    await waitFinished(item.id);
  }
  const afterHistory = getManagedProcessStats();
  assert.equal(afterHistory.running, 0);
  assert.ok(afterHistory.finished <= 2, `finished history exceeded cap: ${JSON.stringify(afterHistory)}`);
  assert.ok(afterHistory.total <= 2, `process map exceeded finished cap: ${JSON.stringify(afterHistory)}`);

  const sleeperCode = "setTimeout(() => {}, 30000)";
  const first = data(await call("start_process", { command: nodeCommand(sleeperCode) }));
  const second = data(await call("start_process", { command: nodeCommand(sleeperCode) }));
  const live = getManagedProcessStats();
  assert.equal(live.running, 2);
  await assert.rejects(
    () => call("start_process", { command: nodeCommand(sleeperCode) }),
    /capacity reached \(2\/2\)/
  );

  const started = Date.now();
  await shutdownManagedProcesses();
  const shutdownMs = Date.now() - started;
  const afterShutdown = getManagedProcessStats();
  assert.equal(afterShutdown.running, 0, `shutdown left managed process running: ${JSON.stringify(afterShutdown)}`);
  assert.ok(shutdownMs < 7000, `managed shutdown exceeded bound: ${shutdownMs}ms`);

  for (const pid of [first.pid, second.pid]) {
    let alive = true;
    const deadline = Date.now() + 3000;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, `child pid ${pid} survived managed shutdown`);
  }

  console.log(`shell-process-manager: ok (log<=4096, history<=2, cap=2, shutdown=${shutdownMs}ms)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
