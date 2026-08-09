import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Set tight test budgets before importing modules that capture env at load time.
process.env.MCP_TOOL_RESULT_MAX_BYTES = "262144";
process.env.MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES = "16384";
process.env.SHELL_OUTPUT_MAX_CHARS = "4096";
process.env.READ_TEXT_MAX_BYTES = "65536";

const { toolResult } = await import("../dist/lib/tool-result.js");
const { execInShellSession, initShellSession } = await import("../dist/lib/persistent-shell.js");
const { registerFilesystemTools } = await import("../dist/tools/filesystem.js");

const mediumText = "m".repeat(64 * 1024);
const medium = toolResult("medium", { output: mediumText });
assert.equal(medium.structuredContent.data.output, mediumText, "medium structured payload lost data");
assert.ok(medium.content[0].text.length < 4096, "medium payload was duplicated into text content");
assert.ok(Buffer.byteLength(JSON.stringify(medium), "utf8") < 262144, "medium result exceeded wire budget");

const huge = toolResult("huge", { output: "x".repeat(512 * 1024) });
assert.equal(huge.structuredContent.data.truncated, true, "oversized result did not activate wire guard");
assert.ok(huge.structuredContent.data.original_payload_bytes > 262144);
assert.ok(Buffer.byteLength(JSON.stringify(huge), "utf8") < 262144, "guarded result still exceeded wire budget");

initShellSession(process.cwd());
const shell = await execInShellSession(
  `node -e "process.stdout.write('x'.repeat(20000)); process.stderr.write('y'.repeat(12000))"`,
  process.cwd(),
  10000
);
assert.equal(shell.stdout_truncated, true);
assert.equal(shell.stderr_truncated, true);
assert.ok(shell.stdout.length <= 4096);
assert.ok(shell.stderr.length <= 4096);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-output-budget-"));
try {
  const largeFile = path.join(temp, "large.txt");
  await fs.writeFile(largeFile, "z".repeat(80 * 1024), "utf8");
  let readHandler;
  const fakeServer = {
    registerTool(name, _definition, handler) {
      if (name === "read_text_file") readHandler = handler;
      return { remove() {}, update() {}, enable() {}, disable() {} };
    },
  };
  registerFilesystemTools(fakeServer);
  assert.equal(typeof readHandler, "function");
  const read = await readHandler({ path: largeFile });
  assert.equal(read.structuredContent.data.truncated, true, "large full-text read did not require partial mode");
  assert.equal(read.structuredContent.data.content, "");
  assert.ok(read.structuredContent.data.size_bytes > 65536);

  await assert.rejects(
    () => readHandler({ path: largeFile, head: 1 }),
    /READ_TEXT_MAX_BYTES/,
    "oversized single-line head read was allowed to accumulate past the memory budget"
  );
  await assert.rejects(
    () => readHandler({ path: largeFile, tail: 1 }),
    /READ_TEXT_MAX_BYTES/,
    "oversized single-line tail read was allowed to accumulate past the memory budget"
  );
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

console.log("output-budget: ok (wire guard, no large duplication, bounded shell output, large text partial-read gate)");