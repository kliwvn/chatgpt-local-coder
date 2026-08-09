import fs from "fs/promises";

/** Read UTF-8 text when it exists; only ENOENT is treated as "not present". */
export async function readUtf8FileIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}