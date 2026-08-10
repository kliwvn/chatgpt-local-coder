import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendBoundedTail,
  enqueueKeyedMutation,
  extractSingleZipEntryBoundedWindows,
  isRuntimeArtifactStale,
  pruneExpiredCache,
  readResponseTextBounded,
  readUtf8FileBounded,
  retryTransientFsMutation,
  streamResponseToFileBounded,
} from "../manager/fs-utils.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A rebuild after Gateway startup must be surfaced as runtime artifact drift.
{
  const loadedAt = "2026-08-11T00:00:00.000Z";
  assert.equal(isRuntimeArtifactStale(loadedAt, Date.parse("2026-08-11T00:00:00.500Z")), false);
  assert.equal(isRuntimeArtifactStale(loadedAt, Date.parse("2026-08-11T00:00:02.001Z")), true);
  assert.equal(isRuntimeArtifactStale("", Date.now()), true, "unknown live runtime age must fail closed as stale");
  assert.equal(isRuntimeArtifactStale(loadedAt, Number.NaN), false);
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
      const zipDirectory = async (sourceDir, zipFile) => {
        await fs.rm(zipFile, { force: true });
        const zipped = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Compress-Archive -Path (Join-Path $env:CLC_ZIP_SRC '*') -DestinationPath $env:CLC_ZIP_FILE -Force",
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30000,
            maxBuffer: 64 * 1024,
            env: { ...process.env, CLC_ZIP_SRC: sourceDir, CLC_ZIP_FILE: zipFile },
          }
        );
        assert.equal(zipped.status, 0, `fixture ZIP creation failed: ${zipped.stderr || zipped.stdout}`);
      };

      const zipSrc = path.join(dir, "zip-src");
      const zipFile = path.join(dir, "fixture.zip");
      const extracted = path.join(dir, "extracted.exe");

      await fs.mkdir(path.join(zipSrc, "pkg"), { recursive: true });
      await fs.writeFile(path.join(zipSrc, "pkg", "tunnel-client.exe"), "fixture-client", "utf8");
      await zipDirectory(zipSrc, zipFile);
      const goodZip = extractSingleZipEntryBoundedWindows(zipFile, extracted, "tunnel-client.exe", 1024);
      assert.equal(goodZip.bytes, Buffer.byteLength("fixture-client"));
      assert.equal(await fs.readFile(extracted, "utf8"), "fixture-client");

      await fs.rm(zipSrc, { recursive: true, force: true });
      await fs.mkdir(path.join(zipSrc, "a"), { recursive: true });
      await fs.mkdir(path.join(zipSrc, "b"), { recursive: true });
      await fs.writeFile(path.join(zipSrc, "a", "tunnel-client.exe"), "one", "utf8");
      await fs.writeFile(path.join(zipSrc, "b", "tunnel-client.exe"), "two", "utf8");
      await zipDirectory(zipSrc, zipFile);
      await fs.writeFile(extracted, "known-good", "utf8");
      assert.throws(
        () => extractSingleZipEntryBoundedWindows(zipFile, extracted, "tunnel-client.exe", 1024),
        /Expected exactly one tunnel-client\.exe entry; found 2/
      );
      assert.equal(await fs.readFile(extracted, "utf8"), "known-good", "duplicate ZIP replaced the prior output");

      await fs.rm(zipSrc, { recursive: true, force: true });
      await fs.mkdir(zipSrc, { recursive: true });
      await fs.writeFile(path.join(zipSrc, "tunnel-client.exe"), "x".repeat(64), "utf8");
      await zipDirectory(zipSrc, zipFile);
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

console.log("manager-fs-utils: ok (artifact drift, mutation keys/cache/retries plus bounded state reads/output)");