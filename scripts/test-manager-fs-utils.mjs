import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendBoundedTail,
  atomicWriteSecretFile,
  enqueueKeyedMutation,
  extractSingleZipEntryBoundedWindows,
  fingerprintRuntimeSources,
  isRuntimeArtifactStale,
  inspectRuntimeBuildFreshness,
  hardenSecretFilePermissions,
  pruneExpiredCache,
  readResponseLineByPrefixBounded,
  readResponseTextBounded,
  readUtf8FileBounded,
  retryTransientFsMutation,
  streamResponseToFileBounded,
} from "../manager/fs-utils.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeStoredZip(zipFile, entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replaceAll("\\", "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    assert.ok(name.length > 0 && name.length <= 0xffff, "ZIP fixture entry name must fit the classic ZIP header");
    assert.ok(data.length <= 0xffffffff, "ZIP fixture entry data must fit the classic ZIP header");
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + data.length;
  }

  assert.ok(entries.length <= 0xffff, "ZIP fixture must fit the classic ZIP entry-count limit");
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  await fs.writeFile(zipFile, Buffer.concat([...localParts, centralDirectory, end]));
}

const managerFsUtilsSource = await fs.readFile(path.resolve("manager", "fs-utils.mjs"), "utf8");

assert.match(
  managerFsUtilsSource,
  /function atomicRollbackFailure\([\s\S]{0,900}?ATOMIC_REPLACE_ROLLBACK_FAILED[\s\S]{0,500}?rollbackFailed = true[\s\S]{0,220}?backupPath = backupPath/,
  "atomic replace rollback failure must surface a typed error and exact retained backup path",
);
const rollbackEscalations = [...managerFsUtilsSource.matchAll(/if \(rollbackError\) throw atomicRollbackFailure\(commitError, rollbackError, backup\);/g)];
assert.equal(rollbackEscalations.length, 2, "both streamed-download and atomic config writes must surface rollback-recovery evidence");

// A rebuild after Gateway startup must be surfaced as runtime artifact drift.
{
  const loadedAt = "2026-08-11T00:00:00.000Z";
  assert.equal(isRuntimeArtifactStale(loadedAt, Date.parse("2026-08-11T00:00:00.500Z")), false);
  assert.equal(isRuntimeArtifactStale(loadedAt, Date.parse("2026-08-11T00:00:02.001Z")), true);
  assert.equal(isRuntimeArtifactStale("", Date.now()), true, "unknown live runtime age must fail closed as stale");
  assert.equal(isRuntimeArtifactStale(loadedAt, Number.NaN), false);
}

// Source-to-dist freshness must inspect the complete runtime tree, not only dist/index.js.
{
  const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clc-build-freshness-"));
  const src = path.join(freshRoot, "src");
  const dist = path.join(freshRoot, "dist");
  try {
    await fs.mkdir(path.join(src, "tools"), { recursive: true });
    await fs.mkdir(path.join(dist, "tools"), { recursive: true });
    const sourceFile = path.join(src, "tools", "writer.ts");
    const entryFile = path.join(dist, "index.js");
    const moduleFile = path.join(dist, "tools", "writer.js");
    await fs.writeFile(sourceFile, "export const x = 1;\n");
    await fs.writeFile(entryFile, "export {};\n");
    await fs.writeFile(moduleFile, "export const x = 1;\n");

    const base = Date.now() - 30_000;
    await fs.utimes(sourceFile, new Date(base), new Date(base));
    await fs.utimes(entryFile, new Date(base + 5_000), new Date(base + 5_000));
    await fs.utimes(moduleFile, new Date(base + 6_000), new Date(base + 6_000));
    let state = await inspectRuntimeBuildFreshness({ sourceRoot: src, artifactRoot: dist, toleranceMs: 0 });
    assert.equal(state.sourceNewerThanBuild, false, "fresh dist was reported stale");

    await fs.utimes(sourceFile, new Date(base + 10_000), new Date(base + 10_000));
    state = await inspectRuntimeBuildFreshness({ sourceRoot: src, artifactRoot: dist, toleranceMs: 0 });
    assert.equal(state.sourceNewerThanBuild, true, "source newer than dist was not detected");

    await fs.utimes(sourceFile, new Date(base), new Date(base));
    await fs.utimes(moduleFile, new Date(base + 20_000), new Date(base + 20_000));
    state = await inspectRuntimeBuildFreshness({ sourceRoot: src, artifactRoot: dist, toleranceMs: 0 });
    assert.equal(state.newestArtifactMtimeMs > Number((await fs.stat(entryFile)).mtimeMs), true, "non-entry dist module was ignored");
    assert.equal(
      isRuntimeArtifactStale(new Date(base + 10_000).toISOString(), state.newestArtifactMtimeMs, 0),
      true,
      "running process drift ignored a rebuilt non-entry module",
    );
  } finally {
    await fs.rm(freshRoot, { recursive: true, force: true });
  }
}

// Build/deploy stability must use content identity, not only filesystem mtimes.
{
  const fingerprintRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clc-runtime-fingerprint-"));
  const src = path.join(fingerprintRoot, "src");
  try {
    await fs.mkdir(src, { recursive: true });
    const sourceFile = path.join(src, "index.ts");
    const packageFile = path.join(fingerprintRoot, "package.json");
    await fs.writeFile(sourceFile, "export const generation = 1;\n", "utf8");
    await fs.writeFile(packageFile, "{\"name\":\"fixture\"}\n", "utf8");
    const fixedTime = new Date(Date.now() - 60_000);
    await fs.utimes(sourceFile, fixedTime, fixedTime);
    const first = await fingerprintRuntimeSources({
      sourceRoot: src,
      sourceFiles: [packageFile],
      baseDir: fingerprintRoot,
    });
    await fs.writeFile(sourceFile, "export const generation = 2;\n", "utf8");
    await fs.utimes(sourceFile, fixedTime, fixedTime);
    const second = await fingerprintRuntimeSources({
      sourceRoot: src,
      sourceFiles: [packageFile],
      baseDir: fingerprintRoot,
    });
    assert.notEqual(second.fingerprint, first.fingerprint, "same-mtime source byte changes must move the runtime generation fingerprint");
    assert.equal(first.fileCount, 2);
    assert.equal(second.fileCount, 2);
  } finally {
    await fs.rm(fingerprintRoot, { recursive: true, force: true });
  }
}

// Same-key work must serialize, and the queue must not retain settled keys.
{
  const chains = new Map();
  const order = [];
  const first = enqueueKeyedMutation(chains, "same", async () => {
    order.push("first-start");
    await sleep(30);
    order.push("first-end");
  });
  const second = enqueueKeyedMutation(chains, "same", async () => {
    order.push("second-start");
    order.push("second-end");
  });
  await Promise.all([first, second]);
  await Promise.resolve();
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
  assert.equal(chains.size, 0, "settled keyed mutations must release Map keys");
}

// Manager state/env reads and captured child output must stay bounded.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-manager-fs-"));
  try {
    const file = path.join(dir, "state.json");
    await fs.writeFile(file, "hello", "utf8");
    assert.equal(await readUtf8FileBounded(file, 5, "test state"), "hello");
    await fs.writeFile(file, "123456", "utf8");
    await assert.rejects(() => readUtf8FileBounded(file, 5, "test state"), /exceeds 5 bytes/);
    assert.equal(appendBoundedTail("abc", "defgh", 5), "defgh");
    assert.equal(appendBoundedTail("abcdef", "XYZ", 5), "efXYZ");
    assert.equal(await readResponseTextBounded(new Response("hello"), 5, "test response"), "hello");
    await assert.rejects(
      () => readResponseTextBounded(new Response("123456"), 5, "test response"),
      /exceeds 5 bytes/
    );

    const secretFile = path.join(dir, "managed-secret.env");
    await atomicWriteSecretFile(secretFile, "TOKEN=test-placeholder\n", "utf8");
    assert.equal(await fs.readFile(secretFile, "utf8"), "TOKEN=test-placeholder\n");
    if (process.platform === "win32") {
      const acl = spawnSync("icacls.exe", [secretFile], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      assert.equal(acl.status, 0, acl.stderr || acl.stdout);
      assert.doesNotMatch(acl.stdout, /Everyone/i, "secret authority must not grant Everyone access");
      assert.doesNotMatch(acl.stdout, /\(I\)/, "secret authority must not retain inherited ACEs");
      assert.match(acl.stdout, /SYSTEM/i, "secret authority must preserve SYSTEM recovery access");
      assert.match(acl.stdout, /Administrators/i, "secret authority must preserve Administrators recovery access");
    } else {
      const mode = (await fs.stat(secretFile)).mode & 0o777;
      assert.equal(mode, 0o600, "secret authority must be owner-only on POSIX");
    }

    const existingSecret = path.join(dir, "legacy-secret.env");
    await fs.writeFile(existingSecret, "TOKEN=legacy-placeholder\n", "utf8");
    const beforeSecretBytes = await fs.readFile(existingSecret);
    await hardenSecretFilePermissions(existingSecret);
    assert.deepEqual(await fs.readFile(existingSecret), beforeSecretBytes);

    const largeMetricsPrefix = [
      "# HELP noisy_metric noisy",
      "# TYPE noisy_metric gauge",
      `noisy_metric{blob="${"x".repeat(320 * 1024)}"} 1`,
    ].join("\n");
    const freshnessLine = 'commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} 1.79073889e+09';
    const largeMetricsResponse = new Response(
      `${largeMetricsPrefix}\n${freshnessLine}\ntrailing_metric 1\n`
    );
    assert.equal(
      await readResponseLineByPrefixBounded(
        largeMetricsResponse,
        "commands_poll_last_successful_timestamp_seconds",
        512 * 1024,
        "test metrics"
      ),
      freshnessLine,
      "streaming metric lookup must find a target after the old 256 KiB whole-body ceiling without buffering the full body"
    );
    await assert.rejects(
      () => readResponseLineByPrefixBounded(
        new Response(`${"x".repeat(2048)}\ntarget_metric 1\n`),
        "target_metric",
        1024,
        "test metrics"
      ),
      /exceeds 1024 bytes/,
      "streaming lookup must remain byte bounded when the target is too late"
    );

    const download = path.join(dir, "download.bin");
    const bytes = await streamResponseToFileBounded(
      new Response(new TextEncoder().encode("hello"), { headers: { "content-length": "5" } }),
      download,
      5,
      "test download"
    );
    assert.equal(bytes, 5);
    assert.equal(await fs.readFile(download, "utf8"), "hello");

    const oversizedDownload = path.join(dir, "too-big.bin");
    await fs.writeFile(oversizedDownload, "known-good", "utf8");
    await assert.rejects(
      () => streamResponseToFileBounded(new Response("123456"), oversizedDownload, 5, "test download"),
      /exceeds 5 bytes/
    );
    assert.equal(await fs.readFile(oversizedDownload, "utf8"), "known-good", "oversized download replaced the prior file");

    if (process.platform === "win32") {
      const zipFile = path.join(dir, "fixture.zip");
      const extracted = path.join(dir, "extracted.exe");

      await writeStoredZip(zipFile, [{ name: "pkg/tunnel-client.exe", data: "fixture-client" }]);
      const goodZip = extractSingleZipEntryBoundedWindows(zipFile, extracted, "tunnel-client.exe", 1024);
      assert.equal(goodZip.bytes, Buffer.byteLength("fixture-client"));
      assert.equal(await fs.readFile(extracted, "utf8"), "fixture-client");

      await writeStoredZip(zipFile, [
        { name: "a/tunnel-client.exe", data: "one" },
        { name: "b/tunnel-client.exe", data: "two" },
      ]);
      await fs.writeFile(extracted, "known-good", "utf8");
      assert.throws(
        () => extractSingleZipEntryBoundedWindows(zipFile, extracted, "tunnel-client.exe", 1024),
        /Expected exactly one tunnel-client\.exe entry; found 2/
      );
      assert.equal(await fs.readFile(extracted, "utf8"), "known-good", "duplicate ZIP replaced the prior output");

      await writeStoredZip(zipFile, [{ name: "tunnel-client.exe", data: "x".repeat(64) }]);
      await fs.writeFile(extracted, "known-good", "utf8");
      assert.throws(
        () => extractSingleZipEntryBoundedWindows(zipFile, extracted, "tunnel-client.exe", 16),
        /ZIP entry size out of bounds: 64/
      );
      assert.equal(await fs.readFile(extracted, "utf8"), "known-good", "oversized ZIP entry replaced the prior output");
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// TTL cache pruning must remove old/invalid entries while retaining fresh ones.
{
  const cache = new Map([
    ["old", { at: 100 }],
    ["fresh", { at: 950 }],
    ["invalid", {}],
  ]);
  pruneExpiredCache(cache, 200, 1000);
  assert.deepEqual([...cache.keys()], ["fresh"]);
}

// Retriable filesystem errors must be bounded and surface after exhaustion.
{
  let attempts = 0;
  await assert.rejects(
    retryTransientFsMutation(
      async () => {
        attempts++;
        throw Object.assign(new Error("busy forever"), { code: "EBUSY" });
      },
      { attempts: 3, baseDelayMs: 1 }
    ),
    /busy forever/
  );
  assert.equal(attempts, 3);
}

// A transient failure followed by success should return the successful value.
{
  let attempts = 0;
  const value = await retryTransientFsMutation(
    async () => {
      attempts++;
      if (attempts < 2) throw Object.assign(new Error("temporary access"), { code: "EACCES" });
      return "ok";
    },
    { attempts: 3, baseDelayMs: 1 }
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 2);
}

console.log("manager-fs-utils: ok (artifact/build drift, byte fingerprints, mutation keys/cache/retries plus bounded state reads/output)");
