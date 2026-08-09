import fs from "node:fs/promises";
import path from "node:path";

let writeSeq = 0;

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
