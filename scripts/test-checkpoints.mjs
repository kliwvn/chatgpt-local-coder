import fs from "fs/promises";
import os from "node:os";
import path from "path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-checkpoints-"));
const storeDir = path.join(tmpDir, "store");

// checkpoint.ts resolves its store path while the module is evaluated. Set the
// sandbox first; a static import here would silently pollute `.mcp-checkpoints`.
process.env.CHECKPOINT_PATH = storeDir;
process.env.CHECKPOINT_ENABLED = "true";
process.env.CHECKPOINT_MAX_COUNT = "50";
const {
  checkpointBefore,
  clearCheckpoints,
  listCheckpoints,
  previewRestore,
  restoreToCheckpoint,
} = await import("../dist/lib/checkpoint.js");

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

async function expectReject(fn, pattern, label) {
  let rejected = false;
  try {
    await fn();
  } catch (err) {
    rejected = pattern.test(String(err?.message || err));
    if (!rejected) throw err;
  }
  if (!rejected) throw new Error(`${label} did not fail closed`);
}

await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });
await clearCheckpoints();

await run("captures checkpoint before edit", async () => {
  const file = path.join(tmpDir, "alpha.txt");
  await fs.writeFile(file, "v1\n");
  const id = await checkpointBefore("write_file", [file]);
  if (!id) throw new Error("checkpoint id missing");
  await fs.writeFile(file, "v2\n");
  const text = await fs.readFile(file, "utf-8");
  if (text !== "v2\n") throw new Error("edit failed");
});

await run("lists checkpoints newest first", async () => {
  const list = await listCheckpoints(10);
  if (list.length < 1) throw new Error("expected checkpoints");
  if (!list[0].id.startsWith("cp_")) throw new Error(`bad id ${list[0].id}`);
});

await run("preview restore shows planned changes", async () => {
  const list = await listCheckpoints(1);
  const plan = await previewRestore(list[0].id);
  if (!plan.changes.some((c) => c.action === "restore")) throw new Error("no restore action");
});

await run("restore reverts file content", async () => {
  const file = path.join(tmpDir, "alpha.txt");
  const list = await listCheckpoints(1);
  const targetId = list[0].id;
  const result = await restoreToCheckpoint(targetId);
  const text = await fs.readFile(file, "utf-8");
  if (text !== "v1\n") throw new Error(`expected v1, got ${JSON.stringify(text)}`);
  if (!result.restored.includes(file)) throw new Error("file not in restored list");
});

await run("removes checkpoints at and after restore point", async () => {
  const list = await listCheckpoints(10);
  if (list.length !== 0) throw new Error(`expected 0 checkpoints after restore, got ${list.length}`);
});

await run("restores deleted file", async () => {
  const file = path.join(tmpDir, "gone.txt");
  await fs.writeFile(file, "keep-me\n");
  const id = await checkpointBefore("delete_file", [file]);
  await fs.unlink(file);
  let missing = false;
  try {
    await fs.access(file);
  } catch {
    missing = true;
  }
  if (!missing) throw new Error("file should be deleted");
  await restoreToCheckpoint(id);
  const text = await fs.readFile(file, "utf-8");
  if (text !== "keep-me\n") throw new Error(text);
});

await run("restores move by snapshotting source and destination", async () => {
  const src = path.join(tmpDir, "src.txt");
  const dest = path.join(tmpDir, "dest.txt");
  await fs.writeFile(src, "from-src\n");
  await fs.writeFile(dest, "old-dest\n");
  const id = await checkpointBefore("move_file", [src, dest]);
  await fs.rename(src, dest);
  await restoreToCheckpoint(id);
  const srcText = await fs.readFile(src, "utf-8");
  const destText = await fs.readFile(dest, "utf-8");
  if (srcText !== "from-src\n") throw new Error(`src: ${srcText}`);
  if (destText !== "old-dest\n") throw new Error(`dest: ${destText}`);
});

await run("rejects persisted checkpoint ids that can escape the owned data root", async () => {
  await clearCheckpoints();
  const sentinel = path.join(tmpDir, "checkpoint-id-sentinel.txt");
  await fs.writeFile(sentinel, "must-survive\n", "utf8");
  const corruptIndex = {
    version: 1,
    checkpoints: [{
      id: "../../checkpoint-id-sentinel.txt",
      created_at: new Date(0).toISOString(),
      tool: "write_file",
      summary: "corrupt-id",
      files: [sentinel],
      file_count: 1,
    }],
  };
  await fs.writeFile(path.join(storeDir, "index.json"), JSON.stringify(corruptIndex, null, 2), "utf8");
  await expectReject(() => clearCheckpoints(), /CHECKPOINT_CORRUPT_ID/i, "corrupt checkpoint id");
  if ((await fs.readFile(sentinel, "utf8")) !== "must-survive\n") throw new Error("corrupt id touched sentinel");
  await fs.writeFile(path.join(storeDir, "index.json"), JSON.stringify({ version: 1, checkpoints: [] }, null, 2), "utf8");
});

await run("binds manifest top-level paths to the persisted index summary", async () => {
  await clearCheckpoints();
  const file = path.join(tmpDir, "manifest-bound.txt");
  const victim = path.join(tmpDir, "manifest-victim.txt");
  await fs.writeFile(file, "before\n", "utf8");
  await fs.writeFile(victim, "victim\n", "utf8");
  const id = await checkpointBefore("write_file", [file]);
  const manifestFile = path.join(storeDir, "data", id, "manifest.json");
  const original = await fs.readFile(manifestFile, "utf8");
  const manifest = JSON.parse(original);
  manifest.files[0].path = victim;
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  await expectReject(() => previewRestore(id), /CHECKPOINT_CORRUPT_MANIFEST.*(?:index|path)/i, "manifest/index path mismatch");
  if ((await fs.readFile(victim, "utf8")) !== "victim\n") throw new Error("corrupt manifest touched victim");
  await fs.writeFile(manifestFile, original, "utf8");
  await clearCheckpoints();
});

await run("rejects malformed snapshot semantics before rewind mutation", async () => {
  await clearCheckpoints();
  const file = path.join(tmpDir, "manifest-semantics.txt");
  await fs.writeFile(file, "before\n", "utf8");
  const id = await checkpointBefore("write_file", [file]);
  const manifestFile = path.join(storeDir, "data", id, "manifest.json");
  const original = await fs.readFile(manifestFile, "utf8");
  const manifest = JSON.parse(original);
  manifest.files[0].existed = "yes";
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  await expectReject(() => previewRestore(id), /CHECKPOINT_CORRUPT_MANIFEST.*malformed snapshot fields/i, "malformed snapshot semantics");
  if ((await fs.readFile(file, "utf8")) !== "before\n") throw new Error("malformed manifest mutated live file");
  await fs.writeFile(manifestFile, original, "utf8");
  await clearCheckpoints();
});

await run("rejects nested snapshot paths that escape their persisted parent", async () => {
  await clearCheckpoints();
  const dir = path.join(tmpDir, "manifest-tree");
  const child = path.join(dir, "child.txt");
  const victim = path.join(tmpDir, "nested-victim.txt");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(child, "child\n", "utf8");
  await fs.writeFile(victim, "victim\n", "utf8");
  const id = await checkpointBefore("delete_directory", [dir]);
  const manifestFile = path.join(storeDir, "data", id, "manifest.json");
  const original = await fs.readFile(manifestFile, "utf8");
  const manifest = JSON.parse(original);
  manifest.files[0].children[0].path = victim;
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  await expectReject(() => previewRestore(id), /CHECKPOINT_CORRUPT_MANIFEST.*parent/i, "nested manifest path escape");
  if ((await fs.readFile(victim, "utf8")) !== "victim\n") throw new Error("nested corrupt manifest touched victim");
  await fs.writeFile(manifestFile, original, "utf8");
  await clearCheckpoints();
});

await run("refuses rewind when a restore parent becomes a symlink or junction alias", async () => {
  await clearCheckpoints();
  const originalParent = path.join(tmpDir, "restore-parent");
  const redirectedParent = path.join(tmpDir, "restore-redirected");
  const file = path.join(originalParent, "item.txt");
  const redirectedFile = path.join(redirectedParent, "item.txt");
  await fs.mkdir(originalParent, { recursive: true });
  await fs.mkdir(redirectedParent, { recursive: true });
  await fs.writeFile(file, "checkpoint-value\n", "utf8");
  await fs.writeFile(redirectedFile, "redirected-must-survive\n", "utf8");
  const id = await checkpointBefore("write_file", [file]);
  await fs.rm(originalParent, { recursive: true, force: true });
  await fs.symlink(redirectedParent, originalParent, process.platform === "win32" ? "junction" : "dir");
  await expectReject(() => restoreToCheckpoint(id), /CHECKPOINT_RESTORE_ALIAS_CHANGED/i, "restore alias change");
  if ((await fs.readFile(redirectedFile, "utf8")) !== "redirected-must-survive\n") {
    throw new Error("rewind followed alias and mutated redirected target");
  }
  await fs.rm(originalParent, { recursive: true, force: true });
  await clearCheckpoints();
});

await run("directory checkpoint propagates oversized child as incomplete", async () => {
  await clearCheckpoints();
  process.env.CHECKPOINT_MAX_FILE_BYTES = "1024";
  process.env.CHECKPOINT_MAX_TOTAL_BYTES = "65536";
  process.env.CHECKPOINT_MAX_NODES = "1000";
  const dir = path.join(tmpDir, "oversized-dir");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "large.txt"), "x".repeat(2048), "utf8");
  const id = await checkpointBefore("delete_directory", [dir]);
  if (!id) throw new Error("checkpoint id missing");
  const plan = await previewRestore(id);
  const top = plan.changes.find((change) => path.resolve(change.path) === path.resolve(dir));
  if (top?.action !== "skip") throw new Error(`incomplete directory was not skipped: ${JSON.stringify(plan)}`);
  if (!/directory snapshot incomplete/i.test(top.reason || "")) throw new Error(`missing incomplete reason: ${top.reason}`);
  if (!/CHECKPOINT_MAX_FILE_BYTES/i.test(top.reason || "")) throw new Error(`missing per-file cap reason: ${top.reason}`);
});

await run("directory checkpoint treats symlink child as incomplete", async () => {
  await clearCheckpoints();
  process.env.CHECKPOINT_MAX_FILE_BYTES = "65536";
  process.env.CHECKPOINT_MAX_TOTAL_BYTES = "65536";
  process.env.CHECKPOINT_MAX_NODES = "1000";
  const dir = path.join(tmpDir, "symlink-child-dir");
  const outside = path.join(tmpDir, "symlink-child-target");
  const outsideFile = path.join(outside, "must-survive.txt");
  const alias = path.join(dir, "alias-dir");
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(outsideFile, "outside\n", "utf8");
  await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  await expectReject(
    () => checkpointBefore("delete_directory", [dir], { require_complete: true }),
    /CHECKPOINT_INCOMPLETE.*symlink\/junction\/reparse alias/i,
    "directory symlink child checkpoint"
  );
  if ((await fs.readFile(outsideFile, "utf8")) !== "outside\n") throw new Error("symlink checkpoint touched target");
});

await run("directory checkpoint enforces aggregate byte budget", async () => {
  await clearCheckpoints();
  process.env.CHECKPOINT_MAX_FILE_BYTES = "65536";
  process.env.CHECKPOINT_MAX_TOTAL_BYTES = "65536";
  process.env.CHECKPOINT_MAX_NODES = "1000";
  const dir = path.join(tmpDir, "aggregate-dir");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "a.txt"), "a".repeat(40 * 1024), "utf8");
  await fs.writeFile(path.join(dir, "b.txt"), "b".repeat(40 * 1024), "utf8");
  const id = await checkpointBefore("delete_directory", [dir]);
  const plan = await previewRestore(id);
  const top = plan.changes.find((change) => path.resolve(change.path) === path.resolve(dir));
  if (top?.action !== "skip") throw new Error(`aggregate-limited directory was not skipped: ${JSON.stringify(plan)}`);
  if (!/CHECKPOINT_MAX_TOTAL_BYTES/i.test(top.reason || "")) throw new Error(`missing aggregate cap reason: ${top.reason}`);
});

await run("directory checkpoint enforces node budget without false restore", async () => {
  await clearCheckpoints();
  process.env.CHECKPOINT_MAX_FILE_BYTES = "65536";
  process.env.CHECKPOINT_MAX_TOTAL_BYTES = String(128 * 1024 * 1024);
  process.env.CHECKPOINT_MAX_NODES = "100";
  const dir = path.join(tmpDir, "node-dir");
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(Array.from({ length: 110 }, (_, i) => fs.writeFile(path.join(dir, `f-${i}.txt`), "x", "utf8")));
  const id = await checkpointBefore("delete_directory", [dir]);
  const plan = await previewRestore(id);
  const top = plan.changes.find((change) => path.resolve(change.path) === path.resolve(dir));
  if (top?.action !== "skip") throw new Error(`node-limited directory was not skipped: ${JSON.stringify(plan)}`);
  if (!/checkpoint node limit 100 reached/i.test(top.reason || "")) throw new Error(`missing node cap reason: ${top.reason}`);
});

await run("checkpoint snapshot read is bounded against file-growth TOCTOU", async () => {
  const source = await fs.readFile(new URL("../src/lib/checkpoint.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function snapshotFile(");
  const end = source.indexOf("async function snapshotDirectory(", start);
  if (start < 0 || end <= start) throw new Error("snapshotFile source block not found");
  const block = source.slice(start, end);
  if (!/readBufferFileBounded\(resolved,\s*readLimit,\s*"checkpoint file"\)/.test(block)) {
    throw new Error("snapshotFile is not wired to the bounded streaming reader");
  }
  if (/fs\.readFile\(resolved\)/.test(block)) {
    throw new Error("snapshotFile regressed to unbounded fs.readFile after stat guard");
  }
  if (!/grew beyond read budget/.test(block)) {
    throw new Error("snapshotFile does not fail closed when the source grows during read");
  }
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);