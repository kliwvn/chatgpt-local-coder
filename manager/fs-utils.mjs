import fs from "node:fs/promises";
import path from "node:path";

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
