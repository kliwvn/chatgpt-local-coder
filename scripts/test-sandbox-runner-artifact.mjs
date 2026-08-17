import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(repoRoot, "native", "windows-sandbox-runner");
const binRoot = path.join(nativeRoot, "bin");
const sourcePath = path.join(nativeRoot, "SandboxRunner.cs");
const executorSourcePath = path.join(repoRoot, "src", "lib", "process-executor.ts");
const setupSourcePath = path.join(repoRoot, "scripts", "setup-windows-sandbox.mjs");
const pointerPath = path.join(binRoot, "SandboxRunner.current");
const references = ["System.dll", "System.Core.dll", "System.Web.Extensions.dll"];

const sourceBytes = await fs.readFile(sourcePath);
const sourceText = sourceBytes.toString("utf8");
const executorSource = await fs.readFile(executorSourcePath, "utf8");
const setupSource = await fs.readFile(setupSourcePath, "utf8");
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
assert.match(
  setupSource,
  /const desiredCompatibilityState = \{[\s\S]{0,700}?version:\s*3,[\s\S]{0,700}?runnerArtifact:\s*path\.basename\(runner\)/,
  "privileged compatibility marker must be tied to the content-versioned runner artifact",
);
assert.match(
  setupSource,
  /recorded\?\.runnerArtifact === desired\.runnerArtifact/,
  "compatibility preflight must invalidate a marker produced by an older runner artifact",
);
assert.match(
  setupSource,
  /os\.uptime\(\)[\s\S]{0,520}?recordedAt >= currentBootStartedAtMs\(\) - 5000/,
  "NUL compatibility receipt must be current-boot scoped because the kernel-object ACL does not survive reboot",
);

const prepareIdentityBlock = sourceText.match(
  /private static AppContainerIdentity PrepareIdentity\(BrokerRequest request\)([\s\S]*?)private static IntPtr CreateOrDeriveSid/
)?.[1] || "";
assert.ok(prepareIdentityBlock, "failed to isolate PrepareIdentity for ACL reconciliation checks");

assert.doesNotMatch(
  prepareIdentityBlock,
  /RemoveRootsAcl\(identity\.SidString, request\.rwRoots\)/,
  "prepare must not revoke current rwRoots before SET_ACCESS; that doubles ACL propagation on broad roots",
);
assert.match(
  prepareIdentityBlock,
  /RemoveRootsAcl\(identity\.SidString, request\.removeRoots\);[\s\S]{0,240}?ApplyRootsAcl\(identity\.SidString, request\.rwRoots, true\);/,
  "prepare must revoke only stale roots, then apply the current rwRoots policy",
);
assert.match(
  executorSource,
  /previousSameProfile\.rwRoots\.filter\(\(root\) => !currentRootKeys\.has\(normalizeRootKey\(root\)\)\)/,
  "runtime reconciliation must pass only roots removed from the current policy to broker revoke",
);

console.log(`sandbox-runner-artifact: ok (${pointerName}; sha256=${actualHash})`);
