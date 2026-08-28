import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  OPENAI_TUNNEL_LAZY_CODEX_BINARY_SHA256,
  ensureLazyCodexTunnelRuntime,
  inspectLazyCodexTunnelRuntime,
  lazyCodexRuntimeLaunchIdentity,
  lazyCodexRuntimeMarker,
  lazyCodexRuntimePaths,
} from "../manager/tunnel-runtime.mjs";

async function writeValidRuntime(root, bytes = Buffer.from("patched-runtime")) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const paths = lazyCodexRuntimePaths(root, sha256);
  await fsp.mkdir(paths.dir, { recursive: true });
  await fsp.writeFile(paths.exe, bytes);
  await fsp.writeFile(paths.marker, JSON.stringify(lazyCodexRuntimeMarker(sha256)), "utf8");
  return { paths, sha256 };
}

async function withTempRoot(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "clc-tunnel-runtime-"));
  try {
    await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

await withTempRoot(async (root) => {
  const { paths, sha256 } = await writeValidRuntime(root);
  const inspected = await inspectLazyCodexTunnelRuntime({ root, expectedSha256: sha256 });
  assert.equal(inspected.valid, true);
  assert.equal(inspected.exe, paths.exe);

  await fsp.appendFile(paths.exe, "tamper");
  const tampered = await inspectLazyCodexTunnelRuntime({ root, expectedSha256: sha256 });
  assert.equal(tampered.valid, false);
  assert.equal(tampered.reason, "binary-hash-mismatch");
});

await withTempRoot(async (root) => {
  const { paths, sha256 } = await writeValidRuntime(root);
  const marker = JSON.parse(await fsp.readFile(paths.marker, "utf8"));
  marker.source_commit = "0".repeat(40);
  await fsp.writeFile(paths.marker, JSON.stringify(marker), "utf8");
  const inspected = await inspectLazyCodexTunnelRuntime({ root, expectedSha256: sha256 });
  assert.equal(inspected.valid, false);
  assert.equal(inspected.reason, "identity-mismatch");
});

await withTempRoot(async (root) => {
  const { paths, sha256 } = await writeValidRuntime(root, Buffer.from("internally-consistent-but-untrusted"));
  assert.notEqual(sha256, OPENAI_TUNNEL_LAZY_CODEX_BINARY_SHA256);
  assert.notEqual(paths.dir, lazyCodexRuntimePaths(root).dir, "each binary digest must use an isolated generation directory");
  const inspected = await inspectLazyCodexTunnelRuntime({ root });
  assert.equal(inspected.valid, false);
  assert.equal(inspected.exe, lazyCodexRuntimePaths(root).exe, "default verifier must stay pinned to the production generation");
});

await withTempRoot(async (root) => {
  let buildCount = 0;
  const rebuiltBytes = Buffer.from("rebuilt-runtime");
  const rebuiltSha256 = createHash("sha256").update(rebuiltBytes).digest("hex");
  const buildRuntime = async ({ root: buildRoot }) => {
    buildCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeValidRuntime(buildRoot, rebuiltBytes);
  };
  const [a, b] = await Promise.all([
    ensureLazyCodexTunnelRuntime({ root, platform: "win32", expectedSha256: rebuiltSha256, buildRuntime }),
    ensureLazyCodexTunnelRuntime({ root, platform: "win32", expectedSha256: rebuiltSha256, buildRuntime }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.path, b.path);
  assert.equal(a.runtimeIdentity, lazyCodexRuntimeLaunchIdentity());
  assert.equal(b.runtimeIdentity, lazyCodexRuntimeLaunchIdentity());
  assert.equal(buildCount, 1, "concurrent instances must share one rebuild");
});

await withTempRoot(async (root) => {
  const failed = await ensureLazyCodexTunnelRuntime({
    root,
    platform: "win32",
    buildRuntime: async () => { throw new Error("synthetic build failure"); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.path, null);
  assert.match(failed.error, /refusing known-bad official fallback/i);
});

await withTempRoot(async (root) => {
  const result = await ensureLazyCodexTunnelRuntime({ root, platform: "linux" });
  assert.equal(result.ok, true);
  assert.equal(result.required, false);
});

await withTempRoot(async (root) => {
  let buildCalled = false;
  const result = await ensureLazyCodexTunnelRuntime({
    root,
    platform: "win32",
    arch: "arm64",
    buildRuntime: async () => { buildCalled = true; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.path, null);
  assert.equal(result.reason, "unsupported-windows-architecture");
  assert.equal(buildCalled, false, "unsupported Windows architectures must fail closed before build/fallback");
});

console.log("manager-tunnel-runtime tests: ok");
