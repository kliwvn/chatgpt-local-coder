import fs from "fs/promises";
import path from "path";
import { randomUUID, createHash } from "node:crypto";
import { atomicWriteFile } from "./atomic-write.js";
import { withFileMutations } from "./file-mutation.js";
import { envBoundedInteger } from "./env-utils.js";
import { readBufferFileBounded, readUtf8FileBounded } from "./bounded-file.js";
import { safeDelete } from "./safe-delete.js";

export interface CheckpointFileSnapshot {
  path: string;
  existed: boolean;
  is_directory?: boolean;
  encoding?: "utf-8" | "base64";
  content?: string;
  children?: CheckpointFileSnapshot[];
  skipped?: boolean;
  skip_reason?: string;
}

export interface CheckpointSummary {
  id: string;
  created_at: string;
  tool: string;
  summary: string;
  files: string[];
  file_count: number;
}

interface CheckpointManifest {
  version: 1;
  id: string;
  created_at: string;
  tool: string;
  summary: string;
  files: CheckpointFileSnapshot[];
}

interface CheckpointIndex {
  version: 1;
  checkpoints: CheckpointSummary[];
}

const INDEX_VERSION = 1 as const;
const DEFAULT_MAX_COUNT = 500;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_NODES = 10_000;
const MAX_DIRECTORY_DEPTH = 32;
const CHECKPOINT_INDEX_MAX_BYTES = 32 * 1024 * 1024;
const CHECKPOINT_MANIFEST_MAX_BYTES = 64 * 1024 * 1024;

let checkpointMutationChain: Promise<void> = Promise.resolve();

function enqueueCheckpointMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = checkpointMutationChain.then(operation, operation);
  checkpointMutationChain = run.then(() => undefined, () => undefined);
  return run;
}

async function waitForCheckpointMutations(): Promise<void> {
  await checkpointMutationChain.catch(() => undefined);
}

function isEnabled(): boolean {
  const raw = (process.env.CHECKPOINT_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function getStoreRoot(): string {
  return process.env.CHECKPOINT_PATH || path.resolve(process.cwd(), ".mcp-checkpoints");
}

function getMaxCount(): number {
  return envBoundedInteger("CHECKPOINT_MAX_COUNT", DEFAULT_MAX_COUNT, 1, 100_000);
}

function getRetentionDays(): number {
  return envBoundedInteger("CHECKPOINT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, 1, 3_650);
}

function getMaxFileBytes(): number {
  return envBoundedInteger("CHECKPOINT_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES, 1_024, 1_073_741_824);
}

function getMaxTotalBytes(): number {
  return envBoundedInteger("CHECKPOINT_MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES, 64 * 1024, 128 * 1024 * 1024);
}

function getMaxNodes(): number {
  return envBoundedInteger("CHECKPOINT_MAX_NODES", DEFAULT_MAX_NODES, 100, 100_000);
}

function checkpointDir(id: string): string {
  return path.join(getStoreRoot(), "data", id);
}

function indexPath(): string {
  return path.join(getStoreRoot(), "index.json");
}

function manifestPath(id: string): string {
  return path.join(checkpointDir(id), "manifest.json");
}

function isUtf8(buffer: Buffer): boolean {
  try {
    const text = buffer.toString("utf-8");
    return Buffer.from(text, "utf-8").equals(buffer);
  } catch {
    return false;
  }
}

async function readIndex(): Promise<CheckpointIndex> {
  try {
    const raw = await readUtf8FileBounded(indexPath(), CHECKPOINT_INDEX_MAX_BYTES, "checkpoint index");
    const parsed = JSON.parse(raw) as CheckpointIndex;
    if (parsed.version === INDEX_VERSION && Array.isArray(parsed.checkpoints)) {
      return parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { version: INDEX_VERSION, checkpoints: [] };
}

async function writeIndex(index: CheckpointIndex): Promise<void> {
  const root = getStoreRoot();
  await fs.mkdir(root, { recursive: true });
  const serialized = JSON.stringify(index, null, 2);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > CHECKPOINT_INDEX_MAX_BYTES) {
    throw new Error(`checkpoint index exceeds ${CHECKPOINT_INDEX_MAX_BYTES} bytes (${bytes})`);
  }
  await atomicWriteFile(indexPath(), serialized, "utf8");
}

async function readManifest(id: string): Promise<CheckpointManifest | null> {
  try {
    const raw = await readUtf8FileBounded(manifestPath(id), CHECKPOINT_MANIFEST_MAX_BYTES, "checkpoint manifest");
    return JSON.parse(raw) as CheckpointManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

interface SnapshotBudget {
  maxTotalBytes: number;
  maxNodes: number;
  totalBytes: number;
  nodes: number;
}

function skippedSnapshot(
  filePath: string,
  reason: string,
  isDirectory = false
): CheckpointFileSnapshot {
  return {
    path: path.resolve(filePath),
    existed: true,
    is_directory: isDirectory || undefined,
    skipped: true,
    skip_reason: reason,
    ...(isDirectory ? { children: [] } : {}),
  };
}

function reserveSnapshotNode(
  filePath: string,
  budget: SnapshotBudget,
  isDirectory: boolean
): CheckpointFileSnapshot | null {
  if (budget.nodes >= budget.maxNodes) {
    return skippedSnapshot(filePath, `checkpoint node limit ${budget.maxNodes} reached`, isDirectory);
  }
  budget.nodes++;
  return null;
}

async function snapshotFile(filePath: string, budget: SnapshotBudget): Promise<CheckpointFileSnapshot> {
  const resolved = path.resolve(filePath);
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return snapshotDirectory(resolved, 0, budget);
    }
    const nodeLimit = reserveSnapshotNode(resolved, budget, false);
    if (nodeLimit) return nodeLimit;
    if (stat.size > getMaxFileBytes()) {
      return skippedSnapshot(resolved, `file exceeds CHECKPOINT_MAX_FILE_BYTES (${stat.size} bytes)`);
    }
    if (budget.totalBytes + stat.size > budget.maxTotalBytes) {
      return skippedSnapshot(
        resolved,
        `checkpoint aggregate bytes would exceed CHECKPOINT_MAX_TOTAL_BYTES=${budget.maxTotalBytes} (${budget.totalBytes + stat.size} bytes)`
      );
    }
    const remainingBudget = budget.maxTotalBytes - budget.totalBytes;
    const readLimit = Math.min(getMaxFileBytes(), remainingBudget);
    let buffer: Buffer;
    try {
      // Use the streaming bounded reader rather than fs.readFile(). The file may
      // grow after the stat() guards above; bounding the read itself prevents a
      // TOCTOU race from allocating beyond the checkpoint memory budget.
      buffer = await readBufferFileBounded(resolved, readLimit, "checkpoint file");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/checkpoint file exceeds \d+ bytes/i.test(message)) {
        return skippedSnapshot(resolved, `checkpoint file grew beyond read budget (${readLimit} bytes)`);
      }
      throw err;
    }
    budget.totalBytes += buffer.length;
    if (isUtf8(buffer)) {
      return { path: resolved, existed: true, encoding: "utf-8", content: buffer.toString("utf-8") };
    }
    return { path: resolved, existed: true, encoding: "base64", content: buffer.toString("base64") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: resolved, existed: false };
    }
    throw err;
  }
}

async function snapshotDirectory(
  dirPath: string,
  depth: number,
  budget: SnapshotBudget
): Promise<CheckpointFileSnapshot> {
  const nodeLimit = reserveSnapshotNode(dirPath, budget, true);
  if (nodeLimit) return nodeLimit;
  if (depth > MAX_DIRECTORY_DEPTH) {
    return skippedSnapshot(dirPath, `directory depth exceeds ${MAX_DIRECTORY_DEPTH}`, true);
  }

  const children: CheckpointFileSnapshot[] = [];
  const handle = await fs.opendir(dirPath);
  let incompleteReason: string | undefined;
  try {
    for await (const entry of handle) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dirPath, entry.name);
      let child: CheckpointFileSnapshot | null = null;
      if (entry.isDirectory()) child = await snapshotDirectory(full, depth + 1, budget);
      else if (entry.isFile()) child = await snapshotFile(full, budget);
      if (!child) continue;
      children.push(child);
      if (child.skipped && !incompleteReason) {
        incompleteReason = `directory snapshot incomplete: ${child.path}: ${child.skip_reason || "skipped child"}`;
      }
      if (
        child.skipped &&
        (/checkpoint node limit/i.test(child.skip_reason || "") ||
          /CHECKPOINT_MAX_TOTAL_BYTES/i.test(child.skip_reason || ""))
      ) {
        break;
      }
    }
  } finally {
    await handle.close().catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ERR_DIR_CLOSED") throw err;
    });
  }

  return {
    path: dirPath,
    existed: true,
    is_directory: true,
    children,
    ...(incompleteReason ? { skipped: true, skip_reason: incompleteReason } : {}),
  };
}

async function restoreSnapshot(snapshot: CheckpointFileSnapshot): Promise<void> {
  const target = snapshot.path;

  if (!snapshot.existed) {
    try {
      await fs.lstat(target);
      await safeDelete(target, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }

  if (snapshot.skipped) {
    throw new Error(`Cannot restore skipped snapshot for ${target}: ${snapshot.skip_reason || "unknown"}`);
  }

  if (snapshot.is_directory) {
    await fs.mkdir(target, { recursive: true });
    for (const child of snapshot.children || []) {
      await restoreSnapshot(child);
    }
    return;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const buffer =
    snapshot.encoding === "base64"
      ? Buffer.from(snapshot.content || "", "base64")
      : Buffer.from(snapshot.content || "", "utf-8");
  await atomicWriteFile(target, buffer);
}

async function removeCheckpointData(id: string): Promise<void> {
  await fs.rm(checkpointDir(id), { recursive: true, force: true });
}

async function pruneCheckpoints(index: CheckpointIndex): Promise<CheckpointIndex> {
  const maxCount = getMaxCount();
  const retentionMs = getRetentionDays() * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  let checkpoints = [...index.checkpoints];
  const toDelete: string[] = [];

  checkpoints = checkpoints.filter((cp) => {
    const created = Date.parse(cp.created_at);
    if (Number.isFinite(created) && created < cutoff) {
      toDelete.push(cp.id);
      return false;
    }
    return true;
  });

  while (checkpoints.length > maxCount) {
    const removed = checkpoints.shift();
    if (removed) toDelete.push(removed.id);
  }

  for (const id of toDelete) {
    await removeCheckpointData(id);
  }

  return { version: INDEX_VERSION, checkpoints };
}

function buildSummary(manifest: CheckpointManifest): CheckpointSummary {
  return {
    id: manifest.id,
    created_at: manifest.created_at,
    tool: manifest.tool,
    summary: manifest.summary,
    files: manifest.files.map((f) => f.path),
    file_count: manifest.files.length,
  };
}

export function getCheckpointConfig(): Record<string, unknown> {
  return {
    enabled: isEnabled(),
    store_path: getStoreRoot(),
    max_count: getMaxCount(),
    retention_days: getRetentionDays(),
    max_file_bytes: getMaxFileBytes(),
    max_total_bytes: getMaxTotalBytes(),
    max_nodes: getMaxNodes(),
    index_max_bytes: CHECKPOINT_INDEX_MAX_BYTES,
    manifest_max_bytes: CHECKPOINT_MANIFEST_MAX_BYTES,
    note: "Only file-editing MCP tools are tracked. Shell/bash file changes are not captured.",
  };
}

async function checkpointBeforeUnlocked(
  tool: string,
  paths: string[],
  options?: { summary?: string; dry_run?: boolean; require_complete?: boolean }
): Promise<string | null> {
  if (options?.dry_run) return null;
  if (!isEnabled()) {
    if (options?.require_complete) {
      throw new Error(`CHECKPOINT_REQUIRED: ${tool} requires checkpoints to be enabled before destructive overwrite`);
    }
    return null;
  }

  const uniquePaths = [...new Set(paths.map((p) => path.resolve(p)))];
  if (uniquePaths.length === 0) return null;

  const budget: SnapshotBudget = {
    maxTotalBytes: getMaxTotalBytes(),
    maxNodes: getMaxNodes(),
    totalBytes: 0,
    nodes: 0,
  };
  const snapshots: CheckpointFileSnapshot[] = [];
  for (const filePath of uniquePaths) {
    snapshots.push(await snapshotFile(filePath, budget));
  }
  if (options?.require_complete) {
    const skipped = snapshots.filter((snapshot) => snapshot.skipped);
    if (skipped.length) {
      throw new Error(
        `CHECKPOINT_INCOMPLETE: refusing ${tool} because recovery snapshot is incomplete: ` +
          skipped.map((snapshot) => `${snapshot.path}: ${snapshot.skip_reason || "skipped"}`).join("; ")
      );
    }
  }

  const id = `cp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  const summary =
    options?.summary ||
    `${tool}: ${uniquePaths.length} path(s) — ${uniquePaths.map((p) => path.basename(p)).join(", ")}`;

  const manifest: CheckpointManifest = {
    version: INDEX_VERSION,
    id,
    created_at: createdAt,
    tool,
    summary,
    files: snapshots,
  };

  const dir = checkpointDir(id);
  await fs.mkdir(dir, { recursive: true });
  const serializedManifest = JSON.stringify(manifest, null, 2);
  const manifestBytes = Buffer.byteLength(serializedManifest, "utf8");
  if (manifestBytes > CHECKPOINT_MANIFEST_MAX_BYTES) {
    await removeCheckpointData(id).catch(() => undefined);
    throw new Error(`checkpoint manifest exceeds ${CHECKPOINT_MANIFEST_MAX_BYTES} bytes (${manifestBytes})`);
  }
  await atomicWriteFile(manifestPath(id), serializedManifest, "utf8");

  try {
    const index = await readIndex();
    index.checkpoints.push(buildSummary(manifest));
    const pruned = await pruneCheckpoints(index);
    await writeIndex(pruned);
  } catch (err) {
    await removeCheckpointData(id).catch(() => undefined);
    throw err;
  }

  return id;
}


export async function checkpointBefore(
  tool: string,
  paths: string[],
  options?: { summary?: string; dry_run?: boolean; require_complete?: boolean }
): Promise<string | null> {
  return enqueueCheckpointMutation(() => checkpointBeforeUnlocked(tool, paths, options));
}

export async function listCheckpoints(limit = 50): Promise<CheckpointSummary[]> {
  await waitForCheckpointMutations();
  const index = await readIndex();
  return [...index.checkpoints].reverse().slice(0, Math.max(1, limit));
}

export async function getCheckpoint(id: string): Promise<CheckpointSummary | null> {
  await waitForCheckpointMutations();
  const index = await readIndex();
  return index.checkpoints.find((cp) => cp.id === id) ?? null;
}

function findCheckpointIndex(checkpoints: CheckpointSummary[], id: string): number {
  return checkpoints.findIndex((cp) => cp.id === id);
}

async function collectRestorePlan(targetId: string): Promise<{
  target: CheckpointSummary;
  files: Map<string, CheckpointFileSnapshot>;
  skipped: CheckpointFileSnapshot[];
}> {
  const index = await readIndex();
  const targetIndex = findCheckpointIndex(index.checkpoints, targetId);
  if (targetIndex < 0) {
    throw new Error(`Checkpoint not found: ${targetId}`);
  }

  const target = index.checkpoints[targetIndex];
  const affected = index.checkpoints.slice(targetIndex);
  const files = new Map<string, CheckpointFileSnapshot>();
  const skipped: CheckpointFileSnapshot[] = [];

  for (let i = 0; i < affected.length; i++) {
    const manifest = await readManifest(affected[i].id);
    if (!manifest) continue;
    for (const snapshot of manifest.files) {
      if (!files.has(snapshot.path)) {
        files.set(snapshot.path, snapshot);
        if (snapshot.skipped) skipped.push(snapshot);
      }
    }
  }

  return { target, files, skipped };
}

type RestorePlan = Awaited<ReturnType<typeof collectRestorePlan>>;

class RestorePlanChangedError extends Error {}

function normalizeRestorePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function restorePathSet(plan: RestorePlan): string[] {
  return [...plan.files.keys()].map(normalizeRestorePath).sort();
}

function sameRestorePathSet(left: RestorePlan, right: RestorePlan): boolean {
  const a = restorePathSet(left);
  const b = restorePathSet(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function previewRestore(targetId: string): Promise<{
  checkpoint: CheckpointSummary;
  changes: Array<{
    path: string;
    action: "restore" | "delete" | "skip";
    existed_before_edit: boolean;
    reason?: string;
  }>;
  skipped_snapshots: Array<{ path: string; reason?: string }>;
}> {
  await waitForCheckpointMutations();
  const { target, files, skipped } = await collectRestorePlan(targetId);
  const changes: Array<{
    path: string;
    action: "restore" | "delete" | "skip";
    existed_before_edit: boolean;
    reason?: string;
  }> = [];

  for (const [filePath, snapshot] of files) {
    if (snapshot.skipped) {
      changes.push({
        path: filePath,
        action: "skip",
        existed_before_edit: snapshot.existed,
        reason: snapshot.skip_reason,
      });
      continue;
    }

    let existsNow = false;
    try {
      await fs.access(filePath);
      existsNow = true;
    } catch {}

    if (!snapshot.existed) {
      changes.push({
        path: filePath,
        action: existsNow ? "delete" : "skip",
        existed_before_edit: false,
        reason: existsNow ? "file was created after checkpoint" : "already absent",
      });
      continue;
    }

    changes.push({
      path: filePath,
      action: "restore",
      existed_before_edit: true,
    });
  }

  return {
    checkpoint: target,
    changes,
    skipped_snapshots: skipped.map((s) => ({ path: s.path, reason: s.skip_reason })),
  };
}

async function restoreToCheckpointUnlocked(targetId: string, plan?: RestorePlan): Promise<{
  checkpoint: CheckpointSummary;
  restored: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason?: string }>;
}> {
  const { target, files } = plan ?? (await collectRestorePlan(targetId));
  const restored: string[] = [];
  const deleted: string[] = [];
  const skipped: Array<{ path: string; reason?: string }> = [];

  // Apply in reverse path order so nested directory restores stay consistent.
  const ordered = [...files.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const [filePath, snapshot] of ordered) {
    if (snapshot.skipped) {
      skipped.push({ path: filePath, reason: snapshot.skip_reason });
      continue;
    }

    if (!snapshot.existed) {
      try {
        await fs.lstat(filePath);
        await safeDelete(filePath, filePath);
        deleted.push(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      continue;
    }

    await restoreSnapshot(snapshot);
    restored.push(filePath);
  }

  // Remove checkpoints after the restore point (they are now stale).
  const index = await readIndex();
  const targetIndex = findCheckpointIndex(index.checkpoints, targetId);
  const removed = index.checkpoints.splice(targetIndex);
  for (const cp of removed) {
    await removeCheckpointData(cp.id);
  }
  await writeIndex(index);

  return { checkpoint: target, restored, deleted, skipped };
}


export async function restoreToCheckpoint(targetId: string): Promise<{
  checkpoint: CheckpointSummary;
  restored: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason?: string }>;
}> {
  // File-edit tools acquire source-path locks before entering the checkpoint
  // mutation queue. Restore must use the same lock order or it can deadlock an
  // edit that is checkpointing. Build a read-only plan first, release the queue,
  // acquire all affected path locks, then re-check the plan under the queue.
  // If another checkpoint added a newly affected path in between, retry before
  // writing anything so the restore remains complete and race-safe.
  for (let attempt = 0; attempt < 8; attempt++) {
    const planned = await enqueueCheckpointMutation(() => collectRestorePlan(targetId));
    const paths = [...planned.files.keys()];
    try {
      return await withFileMutations(paths, () =>
        enqueueCheckpointMutation(async () => {
          const current = await collectRestorePlan(targetId);
          if (!sameRestorePathSet(planned, current)) throw new RestorePlanChangedError();
          return restoreToCheckpointUnlocked(targetId, current);
        })
      );
    } catch (err) {
      if (err instanceof RestorePlanChangedError) continue;
      throw err;
    }
  }
  throw new Error("Checkpoint restore plan kept changing; retry after concurrent edits settle");
}

async function clearCheckpointsUnlocked(): Promise<number> {
  const index = await readIndex();
  const count = index.checkpoints.length;
  for (const cp of index.checkpoints) {
    await removeCheckpointData(cp.id);
  }
  await writeIndex({ version: INDEX_VERSION, checkpoints: [] });
  return count;
}


export async function clearCheckpoints(): Promise<number> {
  return enqueueCheckpointMutation(clearCheckpointsUnlocked);
}

export function checkpointFingerprint(paths: string[]): string {
  const normalized = [...new Set(paths.map((p) => path.resolve(p)))].sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 12);
}