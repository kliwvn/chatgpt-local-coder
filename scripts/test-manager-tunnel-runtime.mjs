import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  ensureLazyCodexTunnelRuntime,
  inspectLazyCodexTunnelRuntime,
  lazyCodexRuntimeMarker,
  lazyCodexRuntimePaths,
} from "../manager/tunnel-runtime.mjs";

async function writeValidRuntime(root, bytes = Buffer.from("patched-runtime")) {
  const paths = lazyCodexRuntimePaths(root);
  await fsp.mkdir(paths.dir, { recursive: true });
  await fsp.writeFile(paths.exe, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fsp.writeFile(paths.marker, JSON.stringify(lazyCodexRuntimeMarker(sha256)), "utf8");
  return paths;
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
  const paths = await writeValidRuntime(root);
  const inspected = await inspectLazyCodexTunnelRuntime({ root });
  assert.equal(inspected.valid, true);
  assert.equal(inspected.exe, paths.exe);

  await fsp.appendFile(paths.exe, "tamper");
  const tampered = await inspectLazyCodexTunnelRuntime({ root });
  assert.equal(tampered.valid, false);
  assert.equal(tampered.reason, "binary-hash-mismatch");
});

await withTempRoot(async (root) => {
  const paths = await writeValidRuntime(root);
  const marker = JSON.parse(await fsp.readFile(paths.marker, "utf8"));
  marker.source_commit = "0".repeat(40);
  await fsp.writeFile(paths.marker, JSON.stringify(marker), "utf8");
  const inspected = await inspectLazyCodexTunnelRuntime({ root });
  assert.equal(inspected.valid, false);
  assert.equal(inspected.reason, "identity-mismatch");
});

await withTempRoot(async (root) => {
  let buildCount = 0;
  const buildRuntime = async ({ root: buildRoot }) => {
    buildCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeValidRuntime(buildRoot, Buffer.from("rebuilt-runtime"));
  };
  const [a, b] = await Promise.all([
    ensureLazyCodexTunnelRuntime({ root, platform: "win32", buildRuntime }),
    ensureLazyCodexTunnelRuntime({ root, platform: "win32", buildRuntime }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.path, b.path);
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
