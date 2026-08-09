import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-post-edit-hooks-"));
const config = path.join(temp, "hooks.json");
const target = path.join(temp, "sample.txt");
await fs.writeFile(target, "x\n", "utf8");

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

  console.log("post-edit-hooks: ok (bounded output, normalized timeout, process-tree termination)");
} finally {
  delete process.env.POST_EDIT_HOOKS_CONFIG;
  await fs.rm(temp, { recursive: true, force: true });
}