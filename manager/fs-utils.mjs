import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

let writeSeq = 0;

/** Serialize mutations by key and release the key once the newest mutation settles. */
export function enqueueKeyedMutation(chains, key, operation) {
  const previous = chains.get(key) || Promise.resolve();
  const run = previous.then(operation, operation);
  // Always-resolving tail keeps later mutations moving after an earlier failure.
  const settled = run.then(() => undefined, () => undefined);
  chains.set(key, settled);
  void settled.finally(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

/** Remove expired { at, ... } cache entries so TTL caches are also memory-bounded. */
export function pruneExpiredCache(cache, ttlMs, now = Date.now()) {
  for (const [key, value] of cache) {
    if (!value || !Number.isFinite(value.at) || now - value.at >= ttlMs) cache.delete(key);
  }
  return cache.size;
}

/** Detect a rebuilt runtime artifact that is newer than the running Gateway startup. */
export function isRuntimeArtifactStale(runtimeLoadedAt, artifactMtimeMs, toleranceMs = 1000) {
  const loadedAtMs = Date.parse(String(runtimeLoadedAt || ""));
  const artifactMs = Number(artifactMtimeMs);
  const tolerance = Number.isFinite(Number(toleranceMs)) ? Math.max(0, Number(toleranceMs)) : 1000;
  if (!Number.isFinite(artifactMs)) return false;
  // A live Gateway that cannot prove when its runtime was loaded must not be
  // presented as current. This also makes upgrades from builds without loaded_at
  // self-identify as needing one restart.
  if (!Number.isFinite(loadedAtMs)) return true;
  return artifactMs > loadedAtMs + tolerance;
}

/** Retry transient Windows filesystem sharing/permission failures, then surface the failure. */
export async function retryTransientFsMutation(operation, { attempts = 3, baseDelayMs = 150 } = {}) {
  const retryable = new Set(["EBUSY", "EPERM", "EACCES"]);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastError = err;
      if (!retryable.has(err?.code) || attempt === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
  }
  // Defensive fallback for invalid/custom attempt counts; normal execution either
  // returns or throws inside the loop.
  throw lastError ?? new Error("Filesystem mutation failed before any attempt completed");
}

/** Read UTF-8 without allowing a corrupted/manual-bloat state file to allocate unbounded memory. */
export async function readUtf8FileBounded(file, maxBytes, label = "file") {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${file}`);
    if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes (${stat.size} bytes): ${file}`);
    const chunks = [];
    let total = 0;
    let position = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw new Error(`${label} exceeds ${maxBytes} bytes while reading: ${file}`);
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      total += bytesRead;
      position += bytesRead;
      if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes while reading: ${file}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function appendBoundedTail(current, chunk, maxChars) {
  const text = String(chunk ?? "");
  if (!text) return current;
  if (text.length >= maxChars) return text.slice(-maxChars);
  const combined = current + text;
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

/** Read a Fetch Response body with a byte ceiling; cancel on overflow. */
export async function readResponseTextBounded(response, maxBytes, label = "response") {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
  if (!response?.body) return "";
  const rawLength = response.headers?.get?.("content-length");
  if (rawLength) {
    const contentLength = Number(rawLength);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds ${maxBytes} bytes (${contentLength} bytes declared)`);
    }
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds ${maxBytes} bytes while streaming (${total} bytes received)`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Stream a Fetch Response to disk with an exact byte ceiling. The payload is
 * written to a sibling temp file and committed only after the full stream fits,
 * so oversized/truncated downloads never replace a known-good destination.
 */
export async function streamResponseToFileBounded(response, file, maxBytes, label = "download") {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
  if (!response?.body) throw new Error(`${label} has no response body`);

  const rawLength = response.headers?.get?.("content-length");
  if (rawLength) {
    const contentLength = Number(rawLength);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds ${maxBytes} bytes (${contentLength} bytes declared)`);
    }
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = `${process.pid}-${Date.now().toString(36)}-${(++writeSeq).toString(36)}`;
  const tmp = `${file}.download-${token}`;
  const backup = `${file}.bak-${token}`;
  let handle = null;
  let backupCreated = false;
  let committed = false;
  let total = 0;

  try {
    handle = await fs.open(tmp, "wx");
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds ${maxBytes} bytes while streaming (${total} bytes received)`);
      }
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      await fs.rename(tmp, file);
      committed = true;
    } catch (firstError) {
      try {
        await fs.rename(file, backup);
        backupCreated = true;
      } catch (backupError) {
        if (backupError?.code === "ENOENT") throw firstError;
        throw backupError;
      }
      try {
        await fs.rename(tmp, file);
        committed = true;
      } catch (commitError) {
        try {
          await fs.rename(backup, file);
          backupCreated = false;
        } catch {
          // Preserve backup for manual recovery if rollback itself fails.
        }
        throw commitError;
      }
    }
    return total;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    if (committed && backupCreated) await fs.rm(backup, { force: true }).catch(() => undefined);
  }
}

/**
 * Windows-only: extract exactly one basename-matching ZIP entry with a hard
 * uncompressed-size ceiling. This avoids whole-archive extraction / ZIP bombs.
 */
export function extractSingleZipEntryBoundedWindows(zipFile, outputFile, entryBasename, maxBytes, {
  timeoutMs = 120000,
  maxBuffer = 16 * 1024,
} = {}) {
  if (process.platform !== "win32") throw new Error("bounded ZIP extraction helper currently supports Windows only");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
  const safeBasename = String(entryBasename || "").trim();
  if (!safeBasename || path.basename(safeBasename) !== safeBasename) throw new Error("entryBasename must be a file basename");

  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = [IO.Compression.ZipFile]::OpenRead($env:CLC_ZIP_PATH)",
    "$tmp = $env:CLC_ZIP_OUTPUT + '.extract-' + $PID",
    "try {",
    "  $target = $env:CLC_ZIP_BASENAME.ToLowerInvariant()",
    "  $entries = @($zip.Entries | Where-Object { [IO.Path]::GetFileName($_.FullName).ToLowerInvariant() -eq $target })",
    "  if ($entries.Count -ne 1) { throw ('Expected exactly one ' + $env:CLC_ZIP_BASENAME + ' entry; found ' + $entries.Count) }",
    "  $entry = $entries[0]",
    "  $max = [int64]$env:CLC_ZIP_MAX_BYTES",
    "  if ($entry.Length -le 0 -or $entry.Length -gt $max) { throw ('ZIP entry size out of bounds: ' + $entry.Length) }",
    "  $input = $entry.Open()",
    "  $output = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)",
    "  try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }",
    "  if ((Get-Item -LiteralPath $tmp).Length -ne $entry.Length) { throw 'Extracted ZIP entry length mismatch' }",
    "  Move-Item -LiteralPath $tmp -Destination $env:CLC_ZIP_OUTPUT -Force",
    "  Write-Output $entry.Length",
    "} finally {",
    "  $zip.Dispose()",
    "  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }",
    "}",
  ].join("; ");

  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer,
    env: {
      ...process.env,
      CLC_ZIP_PATH: zipFile,
      CLC_ZIP_OUTPUT: outputFile,
      CLC_ZIP_BASENAME: safeBasename,
      CLC_ZIP_MAX_BYTES: String(maxBytes),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(-500);
    throw new Error(`ZIP extraction failed${detail ? `: ${detail}` : ""}`);
  }
  return {
    bytes: Number(String(result.stdout || "").trim()) || 0,
    output: outputFile,
  };
}

/** Atomic same-directory replace with a Windows-safe backup/rollback fallback. */
export async function atomicWriteFile(file, data, encoding = "utf8") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = `${process.pid}-${Date.now().toString(36)}-${(++writeSeq).toString(36)}`;
  const tmp = `${file}.tmp-${token}`;
  const backup = `${file}.bak-${token}`;
  let backupCreated = false;
  let committed = false;
  await fs.writeFile(tmp, data, encoding);
  try {
    try {
      await fs.rename(tmp, file);
      committed = true;
      return;
    } catch (firstError) {
      // On Windows rename-over-existing may fail. Move the old file aside instead
      // of deleting it, so a second rename failure can restore the prior config.
      try {
        await fs.rename(file, backup);
        backupCreated = true;
      } catch (backupError) {
        if (backupError?.code === "ENOENT") throw firstError;
        throw backupError;
      }
      try {
        await fs.rename(tmp, file);
        committed = true;
      } catch (commitError) {
        try {
          await fs.rename(backup, file);
          backupCreated = false;
        } catch {
          // Leave the backup on disk for manual recovery if rollback itself fails.
        }
        throw commitError;
      }
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    if (committed && backupCreated) await fs.rm(backup, { force: true }).catch(() => undefined);
  }
}
