import { createReadStream } from "node:fs";
import fs from "node:fs/promises";

export async function readBufferFileBounded(
  filePath: string,
  maxBytes: number,
  label = "file"
): Promise<Buffer> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("Path is not a regular file");
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes (${stat.size} bytes): ${filePath}`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const input = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      // Protect against a file that grows after stat() but before/during read.
      if (total > maxBytes) {
        throw new Error(`${label} exceeds ${maxBytes} bytes while reading: ${filePath}`);
      }
      chunks.push(buffer);
    }
  } finally {
    input.destroy();
  }
  return Buffer.concat(chunks, total);
}

export async function readUtf8FileBounded(
  filePath: string,
  maxBytes: number,
  label = "text file"
): Promise<string> {
  return (await readBufferFileBounded(filePath, maxBytes, label)).toString("utf8");
}

function decodeUtf8Prefix(buffer: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= 3 && trim <= buffer.length; trim++) {
    try {
      return decoder.decode(trim === 0 ? buffer : buffer.subarray(0, buffer.length - trim));
    } catch {}
  }
  return buffer.toString("utf8");
}

/** Read only the leading bytes needed by metadata/context loaders. */
export async function readUtf8FilePrefix(
  filePath: string,
  maxBytes: number
): Promise<{ text: string; truncated: boolean; sizeBytes: number }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("Path is not a regular file");
  const handle = await fs.open(filePath, "r");
  try {
    // Read up to 4 extra bytes solely to detect growth/truncation and allow a
    // valid UTF-8 boundary to be selected at maxBytes without loading the file.
    const buffer = Buffer.allocUnsafe(maxBytes + 4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    return {
      text: decodeUtf8Prefix(prefix),
      truncated: stat.size > maxBytes || bytesRead > maxBytes,
      sizeBytes: stat.size,
    };
  } finally {
    await handle.close();
  }
}
