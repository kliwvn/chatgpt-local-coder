import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-output-budget-"));

// Set tight test budgets before importing modules that capture env at load time.
process.env.MCP_TOOL_RESULT_MAX_BYTES = "262144";
process.env.MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES = "16384";
process.env.SHELL_OUTPUT_MAX_CHARS = "4096";
process.env.READ_TEXT_MAX_BYTES = "65536";
process.env.EDIT_TEXT_MAX_BYTES = "65536";
process.env.CHECKPOINT_PATH = path.join(temp, "checkpoints");
process.env.MCP_SHELL_STATE_DIR = path.join(temp, "shell-state");

const { toolResult } = await import("../dist/lib/tool-result.js");
const { execInShellSession, initShellSession } = await import("../dist/lib/persistent-shell.js");
const { registerFilesystemTools } = await import("../dist/tools/filesystem.js");
const { readUtf8FilePrefix, readUtf8FileTail } = await import("../dist/lib/bounded-file.js");

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

const timeoutStarted = Date.now();
await assert.rejects(
  () => execInShellSession(process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5", process.cwd(), 100),
  /Command timed out after/,
  "persistent shell timeout did not reject"
);
assert.ok(Date.now() - timeoutStarted < 2500, "persistent shell timeout waited indefinitely for child close");

try {
  const largeFile = path.join(temp, "large.txt");
  await fs.writeFile(largeFile, "z".repeat(80 * 1024), "utf8");
  let readHandler;
  let editHandler;
  let writeBase64Handler;
  const fakeServer = {
    registerTool(name, _definition, handler) {
      if (name === "read_text_file") readHandler = handler;
      if (name === "edit_file") editHandler = handler;
      if (name === "write_file_base64") writeBase64Handler = handler;
      return { remove() {}, update() {}, enable() {}, disable() {} };
    },
  };
  registerFilesystemTools(fakeServer);
  assert.equal(typeof readHandler, "function");
  assert.equal(typeof editHandler, "function");
  assert.equal(typeof writeBase64Handler, "function");
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

  await assert.rejects(
    () => editHandler({ path: largeFile, old_text: "z", new_text: "q", replace_all: false, dry_run: true }),
    /EDIT_TEXT_MAX_BYTES/,
    "edit_file materialized an oversized source file"
  );

  const amplificationFile = path.join(temp, "amplification.txt");
  await fs.writeFile(amplificationFile, "x".repeat(40 * 1024), "utf8");
  await assert.rejects(
    () => editHandler({ path: amplificationFile, old_text: "x", new_text: "yy", replace_all: true, dry_run: true }),
    /EDIT_TEXT_MAX_BYTES/,
    "replace_all amplification was allowed to construct an oversized edit result"
  );
  assert.equal((await fs.stat(amplificationFile)).size, 40 * 1024, "rejected amplification mutated the source file");

  const binaryFile = path.join(temp, "binary.bin");
  await assert.rejects(
    () => writeBase64Handler({ path: binaryFile, content: "%%%%" }),
    /Invalid base64 content/,
    "invalid base64 was silently decoded"
  );
  const validBinary = await writeBase64Handler({ path: binaryFile, content: "aGVsbG8" });
  assert.equal(validBinary.structuredContent.data.bytes, 5, "unpadded valid base64 was rejected/corrupted");
  assert.equal((await fs.readFile(binaryFile)).toString("utf8"), "hello");

  const utf8File = path.join(temp, "utf8-prefix.txt");
  await fs.writeFile(utf8File, "abcữdef", "utf8");
  const utf8Prefix = await readUtf8FilePrefix(utf8File, 4);
  assert.equal(utf8Prefix.truncated, true);
  assert.equal(utf8Prefix.text.includes("\uFFFD"), false, "UTF-8 prefix ended on an invalid code-point boundary");
  assert.equal(utf8Prefix.text, "abc", `unexpected UTF-8-safe prefix: ${JSON.stringify(utf8Prefix.text)}`);

  const utf8Tail = await readUtf8FileTail(utf8File, 5);
  assert.equal(utf8Tail.truncated, true);
  assert.equal(utf8Tail.text.includes("\uFFFD"), false, "UTF-8 tail began on an invalid code-point boundary");
  assert.equal(utf8Tail.text, "def", `unexpected UTF-8-safe tail: ${JSON.stringify(utf8Tail.text)}`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

console.log("output-budget: ok (wire/edit guards, no large duplication, bounded shell output, strict base64)");