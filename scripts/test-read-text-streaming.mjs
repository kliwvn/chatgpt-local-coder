import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.FULL_DISK_ACCESS = "true";
const { registerFilesystemTools } = await import("../dist/tools/filesystem.js");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-read-streaming-"));
const handlers = new Map();
registerFilesystemTools({ registerTool(name, _definition, handler) { handlers.set(name, handler); } }, root);
const read = handlers.get("read_text_file");
assert.equal(typeof read, "function");

try {
  const sample = path.join(root, "sample.txt");
  await fs.writeFile(sample, "\ufeffalpha\r\nbeta\r\ngamma\r\ndelta\r\n", "utf8");
  const head = (await read({ path: sample, head: 2 })).structuredContent.data.content;
  const offset = (await read({ path: sample, offset: 2, limit: 2 })).structuredContent.data.content;
  const tail = (await read({ path: sample, tail: 2 })).structuredContent.data.content;
  assert.equal(head, "alpha\r\nbeta\r");
  assert.equal(offset, "     2|beta\r\n     3|gamma\r");
  assert.equal(tail, "delta\r\n");

  const big = path.join(root, "big.txt");
  const line = "0123456789abcdef".repeat(2047) + "\n";
  const handle = await fs.open(big, "w");
  for (let i = 0; i < 512; i++) await handle.write(line);
  await handle.close();
  const stat = await fs.stat(big);
  assert.ok(stat.size > 15 * 1024 * 1024);

  global.gc?.();
  const before = process.memoryUsage().rss;
  const started = performance.now();
  const partial = (await read({ path: big, head: 3 })).structuredContent.data.content;
  const elapsed = performance.now() - started;
  global.gc?.();
  const rssDelta = Math.max(0, process.memoryUsage().rss - before);
  assert.equal(partial.split("\n").length, 3);
  // A full fs.readFile/split of this fixture typically adds >15 MiB RSS. Keep a
  // generous bound so the test catches whole-file regressions without depending
  // on exact allocator behavior across Node/OS versions.
  assert.ok(rssDelta < 12 * 1024 * 1024, `partial read allocated too much RSS: ${(rssDelta / 1048576).toFixed(1)} MiB`);
  assert.ok(elapsed < 1500, `partial read unexpectedly slow: ${elapsed.toFixed(1)}ms`);
  console.log(`read-text-streaming: ok (${(stat.size / 1048576).toFixed(1)} MiB fixture, ${elapsed.toFixed(1)}ms, +${(rssDelta / 1048576).toFixed(1)} MiB RSS)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
