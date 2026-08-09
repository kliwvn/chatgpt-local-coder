import fs from "node:fs/promises";

export const DEFAULT_MANAGED_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Read the tail without emitting U+FFFD when the byte window starts mid-codepoint. */
export async function tailFile(file, maxBytes = 8000) {
  let fh = null;
  try {
    const st = await fs.stat(file);
    const size = Math.min(st.size, Math.max(0, maxBytes));
    if (size <= 0) return "";
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, st.size - size);
    let start = 0;
    while (start < bytesRead && (buf[start] & 0xc0) === 0x80) start++;
    return buf.subarray(start, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Rotate a stopped managed process log before the next spawn. The child owns its
 * stdout file descriptor while running, so rotation is intentionally performed
 * only at the safe pre-start boundary.
 */
export async function rotateLogFile(file, maxBytes = DEFAULT_MANAGED_LOG_MAX_BYTES, backups = 2) {
  try {
    const st = await fs.stat(file);
    if (st.size <= maxBytes) return false;
    const keep = Math.max(1, Math.floor(backups));
    await fs.rm(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      await fs.rename(`${file}.${i}`, `${file}.${i + 1}`).catch((err) => {
        if (err?.code !== "ENOENT") throw err;
      });
    }
    await fs.rename(file, `${file}.1`);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    return false;
  }
}
