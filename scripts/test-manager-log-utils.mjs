import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rotateLogFile, tailFile } from "../manager/log-utils.mjs";

const managerApp = await fs.readFile(new URL("../manager/app.js", import.meta.url), "utf8");
assert.match(managerApp, /COMMAND \(\?:FAILED\|NO MATCH\)/, "MCP-only filter must include command outcomes");
assert.match(managerApp, /TOOL FAILED\|COMMAND FAILED/, "error styling must include the new failure taxonomy");
assert.doesNotMatch(
  managerApp,
  /MCP ERROR\|TOOL ERROR\|\\\[err[^\n]+cls = "err"/,
  "error styling must not remain on the legacy-only taxonomy"
);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-local-coder-log-"));
try {
  const utf8 = path.join(dir, "utf8.log");
  await fs.writeFile(utf8, "xx🙂Z", "utf8");
  assert.equal(await tailFile(utf8, 4), "Z", "tail should skip leading UTF-8 continuation bytes");
  assert.equal((await tailFile(utf8, 64)).includes("\uFFFD"), false, "full tail must not inject replacement chars");
  assert.equal(await tailFile(utf8, 64), "xx🙂Z", "tail must preserve a complete trailing multibyte codepoint");

  const log = path.join(dir, "server.log");
  await fs.writeFile(log, "first-generation", "utf8");
  assert.equal(await rotateLogFile(log, 4, 2), true);
  assert.equal(await fs.readFile(`${log}.1`, "utf8"), "first-generation");
  await fs.writeFile(log, "second-generation", "utf8");
  assert.equal(await rotateLogFile(log, 4, 2), true);
  assert.equal(await fs.readFile(`${log}.1`, "utf8"), "second-generation");
  assert.equal(await fs.readFile(`${log}.2`, "utf8"), "first-generation");
  assert.equal(await rotateLogFile(log, 4, 2), false, "missing active log is a no-op");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
console.log("manager-log-utils: ok");
