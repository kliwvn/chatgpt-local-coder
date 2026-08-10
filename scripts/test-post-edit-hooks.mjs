import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-post-edit-hooks-"));
const config = path.join(temp, "hooks.json");
const target = path.join(temp, "sample.txt");
await fs.writeFile(target, "x\n", "utf8");

async function removeTempBounded(dir) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const transient = ["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"].includes(err?.code);
      if (!transient || Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

try {
  const noisyCommand = `node -e "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(50000))"`;
  await fs.writeFile(config, JSON.stringify({
    enabled: true,
    hooks: [{ glob: "**/*.txt", command: noisyCommand, timeout_ms: 5000 }],
  }), "utf8");
  process.env.POST_EDIT_HOOKS_CONFIG = config;
  const { runPostEditHooks } = await import("../dist/lib/post-edit-hooks.js");
  const result = await runPostEditHooks([target]);
  const hook = result?.post_edit_hooks?.[0];
  assert.ok(hook, "matching post-edit hook did not run");
  assert.equal(hook.exit_code, 0);
  assert.equal(hook.stdout_truncated, true, "large hook stdout was not marked truncated");
  assert.equal(hook.stderr_truncated, true, "large hook stderr was not marked truncated");
  assert.ok(hook.stdout.length <= 2000, "hook stdout result exceeded response cap");
  assert.ok(hook.stderr.length <= 2000, "hook stderr result exceeded response cap");

  const mustSurvive = path.join(temp, "hook-must-survive");
  await fs.mkdir(mustSurvive);
  await fs.writeFile(path.join(mustSurvive, "data.txt"), "survive\n", "utf8");
  const destructiveHook = String.raw`cmd.exe /d /c "rmdir /s /q \"${mustSurvive}\""`;
  await fs.writeFile(config, JSON.stringify({
    enabled: true,
    hooks: [{ glob: "**/*.txt", command: destructiveHook, timeout_ms: 5000 }],
  }), "utf8");
  const blockedResult = await runPostEditHooks([target]);
  const blockedHook = blockedResult?.post_edit_hooks?.[0];
  assert.ok(blockedHook, "destructive post-edit hook did not produce a fail-closed result");
  assert.equal(blockedHook.exit_code, 126, "destructive post-edit hook was not blocked before spawn");
  assert.match(blockedHook.stderr, /BLOCKED_DESTRUCTIVE_COMMAND/);
  assert.equal((await fs.stat(mustSurvive)).isDirectory(), true, "blocked hook mutated its target");

  const timeoutCommand = `node -e "setTimeout(()=>{},5000)"`;
  await fs.writeFile(config, JSON.stringify({
    enabled: true,
    hooks: [{ glob: "**/*.txt", command: timeoutCommand, timeout_ms: 100 }],
  }), "utf8");
  const started = Date.now();
  const timeoutResult = await runPostEditHooks([target]);
  const elapsed = Date.now() - started;
  const timeoutHook = timeoutResult?.post_edit_hooks?.[0];
  assert.ok(timeoutHook, "timeout post-edit hook did not run");
  assert.equal(timeoutHook.exit_code, null);
  assert.match(timeoutHook.stderr, /hook timeout/i);
  assert.ok(elapsed < 2500, `hook timeout was not bounded: ${elapsed}ms`);

  const previousBudget = process.env.MCP_SYNC_RESPONSE_BUDGET_MS;
  process.env.MCP_SYNC_RESPONSE_BUDGET_MS = "1000";
  try {
    const budgetCommand = `node -e "setTimeout(()=>{},600)"`;
    await fs.writeFile(config, JSON.stringify({
      enabled: true,
      hooks: [
        { glob: "**/*.txt", command: budgetCommand, timeout_ms: 1000 },
        { glob: "**/*.txt", command: budgetCommand, timeout_ms: 1000 },
        { glob: "**/*.txt", command: budgetCommand, timeout_ms: 1000 },
      ],
    }), "utf8");
    const budgetStarted = Date.now();
    const budgetResult = await runPostEditHooks([target]);
    const budgetElapsed = Date.now() - budgetStarted;
    assert.equal(budgetResult?.sync_response_budget_ms, 1000);
    assert.equal(budgetResult?.budget_exhausted, true, "serial hooks did not stop when the MCP response budget was exhausted");
    assert.ok((budgetResult?.post_edit_hooks?.length || 0) <= 2, "post-edit hooks started work after the synchronous deadline");
    assert.ok(budgetElapsed < 3000, `post-edit hook chain exceeded response budget bound: ${budgetElapsed}ms`);
  } finally {
    if (previousBudget === undefined) delete process.env.MCP_SYNC_RESPONSE_BUDGET_MS;
    else process.env.MCP_SYNC_RESPONSE_BUDGET_MS = previousBudget;
  }

  console.log("post-edit-hooks: ok (destructive hook blocked before spawn; bounded output, timeout, response budget, process-tree termination)");
} finally {
  delete process.env.POST_EDIT_HOOKS_CONFIG;
  // Windows can briefly retain a directory handle after a forced process-tree
  // termination (or AV/indexer inspection). Retry only known transient errors and
  // keep a hard 5s deadline so a real leaked handle still fails the release gate.
  await removeTempBounded(temp);
}