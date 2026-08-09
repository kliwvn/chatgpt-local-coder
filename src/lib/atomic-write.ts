import fs from "fs/promises";
import path from "path";

let atomicWriteSeq = 0;

function tempPaths(file: string): { tmp: string; backup: string } {
  const token = `${process.pid}-${Date.now().toString(36)}-${(++atomicWriteSeq).toString(36)}`;
  return { tmp: `${file}.tmp-${token}`, backup: `${file}.bak-${token}` };
}

async function commitTempFile(file: string, tmp: string, backup: string): Promise<void> {
  let backupCreated = false;
  let committed = false;
  try {
    try {
      await fs.rename(tmp, file);
      committed = true;
      return;
    } catch (firstError) {
      try {
        await fs.rename(file, backup);
        backupCreated = true;
      } catch (backupError) {
        if ((backupError as NodeJS.ErrnoException).code === "ENOENT") throw firstError;
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
          // Preserve the backup for manual recovery if rollback itself fails.
        }
        throw commitError;
      }
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    if (committed && backupCreated) await fs.rm(backup, { force: true }).catch(() => undefined);
  }
}

/** Atomic same-directory replace with Windows-safe backup/rollback semantics. */
export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  encoding: BufferEncoding | undefined = typeof data === "string" ? "utf8" : undefined
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const { tmp, backup } = tempPaths(file);
  if (typeof data === "string") await fs.writeFile(tmp, data, encoding ?? "utf8");
  else await fs.writeFile(tmp, data);
  await commitTempFile(file, tmp, backup);
}

/** Copy a potentially large file without exposing a partially-written destination. */
export async function atomicCopyFile(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const { tmp, backup } = tempPaths(destination);
  try {
    await fs.copyFile(source, tmp);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await commitTempFile(destination, tmp, backup);
}
