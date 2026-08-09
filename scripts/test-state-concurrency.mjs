import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-state-concurrency-"));
try {
  process.env.CHECKPOINT_PATH = path.join(root, "checkpoints");
  process.env.CHECKPOINT_ENABLED = "true";
  process.env.CHECKPOINT_MAX_COUNT = "200";
  const checkpoints = await import("../dist/lib/checkpoint.js");
  await checkpoints.clearCheckpoints();
  const files = [];
  for (let i = 0; i < 30; i++) {
    const file = path.join(root, `file-${i}.txt`);
    await fs.writeFile(file, `v${i}`);
    files.push(file);
  }
  const ids = await Promise.all(files.map((file, i) => checkpoints.checkpointBefore("write_file", [file], { summary: `cp-${i}` })));
  const indexed = await checkpoints.listCheckpoints(100);
  if (ids.filter(Boolean).length !== 30 || indexed.length !== 30 || new Set(indexed.map((x) => x.id)).size !== 30) {
    throw new Error(`checkpoint lost update: ids=${ids.filter(Boolean).length} indexed=${indexed.length}`);
  }

  // Rewind and source edits use the same path-lock -> checkpoint-queue order.
  // This must finish without a lock inversion/deadlock regardless of which one
  // wins the file lock first.
  await checkpoints.clearCheckpoints();
  const rewindFile = path.join(root, "rewind-race.txt");
  await fs.writeFile(rewindFile, "OLD\n");
  const rewindTarget = await checkpoints.checkpointBefore("write_file", [rewindFile], { summary: "rewind-target" });
  if (!rewindTarget) throw new Error("failed to create rewind concurrency target");
  await fs.writeFile(rewindFile, "MID\n");
  const { withFileMutation } = await import("../dist/lib/file-mutation.js");
  const { atomicWriteFile } = await import("../dist/lib/atomic-write.js");
  const edit = withFileMutation(rewindFile, async () => {
    await fs.readFile(rewindFile, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await checkpoints.checkpointBefore("edit_file", [rewindFile], { summary: "concurrent-edit" });
    await atomicWriteFile(rewindFile, "EDIT\n", "utf8");
  });
  const restore = checkpoints.restoreToCheckpoint(rewindTarget);
  const settled = await Promise.race([
    Promise.allSettled([edit, restore]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("rewind/edit concurrency deadlocked")), 3000)),
  ]);
  if (settled.some((result) => result.status === "rejected")) {
    throw new Error(`rewind/edit concurrency failed: ${settled.map((result) => result.status === "rejected" ? String(result.reason) : "ok").join("; ")}`);
  }
  const rewindFinal = await fs.readFile(rewindFile, "utf8");
  if (rewindFinal !== "OLD\n" && rewindFinal !== "EDIT\n") {
    throw new Error(`rewind/edit race left invalid content: ${JSON.stringify(rewindFinal)}`);
  }

  process.env.CODEX_HOME = path.join(root, "codex-home");
  const memory = await import("../dist/lib/auto-memory.js");
  await Promise.all(Array.from({ length: 30 }, (_, i) => memory.appendAutoMemory("C:/concurrent-memory", `unique-note-${String(i).padStart(2, "0")}`)));
  const projectDirs = await fs.readdir(path.join(root, "codex-home", "projects"));
  const memoryText = await fs.readFile(path.join(root, "codex-home", "projects", projectDirs[0], "MEMORY.md"), "utf8");
  const noteLines = memoryText.split(/\r?\n/).filter((line) => line.startsWith("- "));
  if (noteLines.length !== 30 || new Set(noteLines).size !== 30) throw new Error(`auto-memory lost update: ${noteLines.length}/30`);

  // Auto memory is a recent-memory cache, not an append-only journal. Once it
  // exceeds the retention limit, newest notes must remain visible and the raw
  // file must stay bounded instead of growing forever while load() keeps reading
  // only old entries.
  await Promise.all(
    Array.from({ length: 210 }, (_, i) =>
      memory.appendAutoMemory("C:/concurrent-memory", `recent-note-${String(i).padStart(3, "0")}`)
    )
  );
  const boundedMemoryText = await fs.readFile(path.join(root, "codex-home", "projects", projectDirs[0], "MEMORY.md"), "utf8");
  const boundedLines = boundedMemoryText.split(/\r?\n/).filter((line) => line.startsWith("- "));
  if (boundedLines.length > 200) throw new Error(`auto-memory line retention exceeded: ${boundedLines.length}/200`);
  if (Buffer.byteLength(boundedMemoryText, "utf8") > 25_000) {
    throw new Error(`auto-memory byte retention exceeded: ${Buffer.byteLength(boundedMemoryText, "utf8")}/25000`);
  }
  const loadedMemory = await memory.loadAutoMemory("C:/concurrent-memory");
  if (!loadedMemory?.includes("recent-note-209")) throw new Error("auto-memory dropped newest retained note");
  if (loadedMemory.includes("unique-note-00")) throw new Error("auto-memory retained stale oldest note after compaction");

  process.env.MCP_SHELL_STATE_DIR = path.join(root, "shell-state");
  const shell = await import("../dist/lib/global-shell-state.js");
  await Promise.all(Array.from({ length: 30 }, (_, i) => shell.saveGlobalShellState("C:/concurrent-shell", "C:/concurrent-shell", `command-${String(i).padStart(2, "0")}`, null)));
  const state = await shell.loadGlobalShellState("C:/concurrent-shell", "C:/concurrent-shell");
  if (!state || state.recent_commands.length !== 20 || new Set(state.recent_commands).size !== 20) {
    throw new Error(`shell-state lost update: ${state?.recent_commands?.length ?? 0}/20`);
  }

  console.log("state-concurrency: ok (checkpoint 30/30, rewind/edit no-deadlock, memory concurrent+bounded-recent, shell recent 20/20)");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
