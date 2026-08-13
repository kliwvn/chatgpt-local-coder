import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(repoRoot, "native", "windows-sandbox-runner");
const binRoot = path.join(nativeRoot, "bin");
const sourcePath = path.join(nativeRoot, "SandboxRunner.cs");
const pointerPath = path.join(binRoot, "SandboxRunner.current");
const references = ["System.dll", "System.Core.dll", "System.Web.Extensions.dll"];

const sourceBytes = await fs.readFile(sourcePath);
const sourceFingerprint = createHash("sha256")
  .update(sourceBytes)
  .update("\0", "utf8")
  .update(references.join("\0"), "utf8")
  .digest("hex");
const expectedName = `SandboxRunner.${sourceFingerprint.slice(0, 16)}.exe`;
const pointerName = (await fs.readFile(pointerPath, "utf8")).trim();

assert.match(pointerName, /^SandboxRunner\.[a-f0-9]{16}\.exe$/i, "sandbox runner pointer is not a versioned basename");
assert.equal(path.basename(pointerName), pointerName, "sandbox runner pointer must not contain a path");
assert.equal(pointerName, expectedName, "sandbox runner pointer is stale relative to SandboxRunner.cs");

const runnerPath = path.join(binRoot, pointerName);
const bytes = await fs.readFile(runnerPath);
const actualHash = createHash("sha256").update(bytes).digest("hex");
const expectedHash = (await fs.readFile(`${runnerPath}.sha256`, "utf8")).trim().toLowerCase();
assert.match(expectedHash, /^[a-f0-9]{64}$/, "sandbox runner sidecar hash is malformed");
assert.equal(actualHash, expectedHash, "sandbox runner binary does not match its integrity sidecar");

console.log(`sandbox-runner-artifact: ok (${pointerName}; sha256=${actualHash})`);
