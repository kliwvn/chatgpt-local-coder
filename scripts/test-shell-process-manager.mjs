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
process.env.MCP_SYNC_RESPONSE_BUDGET_MS = "1000";

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
  const guardTarget = path.join(root, "guard-must-survive");
  await fs.mkdir(guardTarget);
  await fs.writeFile(path.join(guardTarget, "data.txt"), "survive\n");
  const historicalIncidentCommand = String.raw`cmd.exe /d /c "rmdir /s /q \"${guardTarget}\""`;
  const beforeGuardStats = getManagedProcessStats();
  await assert.rejects(
    () => call("run_command", { command: historicalIncidentCommand, working_directory: root }),
    /BLOCKED_DESTRUCTIVE_COMMAND/,
    "run_command spawned the historical malformed recursive-delete chain",
  );
  await assert.rejects(
    () => call("start_process", { command: historicalIncidentCommand, working_directory: root }),
    /BLOCKED_DESTRUCTIVE_COMMAND/,
    "start_process spawned the historical malformed recursive-delete chain",
  );
  assert.equal((await fs.stat(guardTarget)).isDirectory(), true, "blocked MCP shell command mutated its fixture");
  assert.deepEqual(getManagedProcessStats(), beforeGuardStats, "blocked start_process allocated a managed process");

  const syncStarted = Date.now();
  // Command runs ~15s, far beyond the 1s sync budget and the 10s assertion
  // ceiling: an ignored budget would resolve after ~15s and fail this test.
  // The response must come back at the deadline with timed_out: true while
  // taskkill cleanup continues in the background.
  const syncTimed = data(await call("run_command", { command: nodeCommand("setTimeout(() => {}, 15000)") }));
  const syncElapsed = Date.now() - syncStarted;
  assert.equal(syncTimed.timed_out, true, "run_command ignored the synchronous MCP response budget");
  assert.equal(syncTimed.configured_timeout_ms, 30_000);
  assert.equal(syncTimed.effective_timeout_ms, 1_000);
  assert.equal(syncTimed.sync_response_budget_ms, 1_000);
  // Response bound includes slow Windows spawns (~2.5-3s under AV scanning);
  // 10s keeps headroom while still proving the 15s command was cut off.
  assert.ok(syncElapsed < 10_000, `run_command exceeded bounded synchronous response time: ${syncElapsed}ms`);

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

  console.log(`shell-process-manager: ok (destructive run/start blocked before spawn; sync-budget=${syncElapsed}ms, log<=4096, history<=2, cap=2, shutdown=${shutdownMs}ms)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
