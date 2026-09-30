import fs from "node:fs/promises";
import path from "node:path";

export interface RepoCatalogEntry {
  name: string;
  path: string;
  workspace_root: string;
  relative_path: string;
  depth: number;
  git_kind: "repository" | "worktree";
  archive_like: boolean;
}

export interface RepoCatalog {
  generated_at: string;
  roots: string[];
  repos: RepoCatalogEntry[];
  repo_count: number;
  scanned_directories: number;
  truncated: boolean;
  limits: {
    max_depth: number;
    max_directories: number;
    max_repos: number;
    cache_ttl_ms: number;
    scan_concurrency: number;
  };
  guidance: string;
}

interface RepoCatalogOptions {
  maxDepth?: number;
  maxDirectories?: number;
  maxRepos?: number;
  cacheTtlMs?: number;
  scanConcurrency?: number;
  bypassCache?: boolean;
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<RepoCatalog>;
}

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_DIRECTORIES = 1500;
const DEFAULT_MAX_REPOS = 256;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_SCAN_CONCURRENCY = 24;

const SKIP_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  ".pytest_cache",
  ".tool-test-tmp",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
]);

let cache = new Map<string, CacheEntry>();

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function optionValue(value: number | undefined, envName: string, fallback: number, min: number, max: number): number {
  if (Number.isFinite(value)) return Math.min(max, Math.max(min, Math.trunc(value!)));
  return boundedInteger(process.env[envName], fallback, min, max);
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  const normalized = process.platform === "win32" ? rel.toLowerCase() : rel;
  return normalized === "" || (
    normalized !== ".." &&
    !normalized.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(normalized)
  );
}

function isArchiveLike(value: string): boolean {
  return /(^|[-_.])(archive|backup|bak|baseline|preserve|retired|old)([-_.]|$)/i.test(value);
}

async function gitMarkerKind(repoPath: string): Promise<RepoCatalogEntry["git_kind"] | null> {
  const marker = path.join(repoPath, ".git");
  try {
    const stat = await fs.lstat(marker);
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) return "repository";
    if (stat.isFile()) return "worktree";
  } catch {}
  return null;
}

async function safeChildDirectories(dir: string): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  const out: string[] = [];
  try {
    handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      out.push(path.join(dir, entry.name));
    }
  } catch {
    return out;
  } finally {
    if (handle) {
      await handle.close().catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ERR_DIR_CLOSED") throw err;
      });
    }
  }
  return out;
}

function sortEntries(entries: RepoCatalogEntry[]): RepoCatalogEntry[] {
  return entries.sort((a, b) => {
    if (a.archive_like !== b.archive_like) return a.archive_like ? 1 : -1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  });
}

function cacheKey(
  roots: string[],
  limits: { maxDepth: number; maxDirectories: number; maxRepos: number; cacheTtlMs: number; scanConcurrency: number }
): string {
  return JSON.stringify({
    roots: roots.map(pathIdentity),
    ...limits,
  });
}

export function clearRepoCatalogCache(): void {
  cache = new Map();
}

export async function discoverRepoCatalog(
  workspaceRoots: string[],
  options: RepoCatalogOptions = {}
): Promise<RepoCatalog> {
  const lexicalRoots = [...new Map(
    workspaceRoots
      .map((root) => path.resolve(root))
      .map((root) => [pathIdentity(root), root] as const)
  ).values()];
  const canonicalRoots = await Promise.all(lexicalRoots.map(async (root) => {
    try {
      const stat = await fs.lstat(root);
      if (!stat.isDirectory()) return null;
      return await fs.realpath(root);
    } catch {
      return null;
    }
  }));
  const roots = [...new Map(
    canonicalRoots
      .filter((root): root is string => Boolean(root))
      .map((root) => [pathIdentity(root), root] as const)
  ).values()];

  const maxDepth = optionValue(options.maxDepth, "REPO_CATALOG_MAX_DEPTH", DEFAULT_MAX_DEPTH, 0, 8);
  const maxDirectories = optionValue(options.maxDirectories, "REPO_CATALOG_MAX_DIRS", DEFAULT_MAX_DIRECTORIES, 1, 20_000);
  const maxRepos = optionValue(options.maxRepos, "REPO_CATALOG_MAX_REPOS", DEFAULT_MAX_REPOS, 1, 2_000);
  const cacheTtlMs = optionValue(options.cacheTtlMs, "REPO_CATALOG_TTL_MS", DEFAULT_CACHE_TTL_MS, 0, 3_600_000);
  const scanConcurrency = optionValue(options.scanConcurrency, "REPO_CATALOG_CONCURRENCY", DEFAULT_SCAN_CONCURRENCY, 1, 64);
  const limits = { maxDepth, maxDirectories, maxRepos, cacheTtlMs, scanConcurrency };
  const key = cacheKey(roots, limits);
  const now = Date.now();

  if (!options.bypassCache) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt >= now) return cached.value;
  }

  const value = (async (): Promise<RepoCatalog> => {
    const repos: RepoCatalogEntry[] = [];
    const seenDirs = new Set<string>();
    let scannedDirectories = 0;
    let truncated = false;

    for (const workspaceRoot of roots) {
      const queue: Array<{ dir: string; depth: number }> = [{ dir: workspaceRoot, depth: 0 }];

      while (queue.length > 0) {
        if (scannedDirectories >= maxDirectories || repos.length >= maxRepos) {
          truncated = true;
          break;
        }

        const batch: Array<{ dir: string; depth: number }> = [];
        while (
          batch.length < scanConcurrency &&
          queue.length > 0 &&
          scannedDirectories < maxDirectories
        ) {
          const current = queue.shift()!;
          const identity = pathIdentity(current.dir);
          if (seenDirs.has(identity)) continue;
          seenDirs.add(identity);
          scannedDirectories++;
          batch.push(current);
        }
        if (batch.length === 0) continue;

        const inspected = await Promise.all(batch.map(async (current) => {
          try {
            const stat = await fs.lstat(current.dir);
            if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
          } catch {
            return null;
          }

          const gitKind = await gitMarkerKind(current.dir);
          if (gitKind) {
            // Canonicalize only actual repository hits. Traversal itself never
            // follows symlink Dirents, so paying realpath I/O on every ordinary
            // collection directory is unnecessary and very expensive on Windows.
            let repoPath: string;
            try {
              repoPath = await fs.realpath(current.dir);
            } catch {
              return null;
            }
            if (!isWithin(workspaceRoot, repoPath)) return null;
            return {
              repo: {
                name: path.basename(repoPath) || repoPath,
                path: repoPath,
                workspace_root: workspaceRoot,
                relative_path: path.relative(workspaceRoot, repoPath) || ".",
                depth: current.depth,
                git_kind: gitKind,
                archive_like: isArchiveLike(repoPath),
              } satisfies RepoCatalogEntry,
              children: [] as string[],
            };
          }

          if (current.depth >= maxDepth) return { repo: null, children: [] as string[] };
          return {
            repo: null,
            children: await safeChildDirectories(current.dir),
          };
        }));

        for (let i = 0; i < inspected.length; i++) {
          const result = inspected[i];
          if (!result) continue;
          if (result.repo) {
            if (repos.length >= maxRepos) {
              truncated = true;
              break;
            }
            repos.push(result.repo);
            // A repository is already the semantic routing boundary. Do not
            // crawl through its working tree looking for vendor/nested repos.
            continue;
          }
          const childDepth = batch[i].depth + 1;
          for (const child of result.children) {
            if (scannedDirectories + queue.length >= maxDirectories) {
              truncated = true;
              break;
            }
            queue.push({ dir: child, depth: childDepth });
          }
        }
      }

      if (scannedDirectories >= maxDirectories || repos.length >= maxRepos) {
        truncated = true;
        break;
      }
    }

    const sorted = sortEntries(repos);
    return {
      generated_at: new Date().toISOString(),
      roots,
      repos: sorted,
      repo_count: sorted.length,
      scanned_directories: scannedDirectories,
      truncated,
      limits: {
        max_depth: maxDepth,
        max_directories: maxDirectories,
        max_repos: maxRepos,
        cache_ttl_ms: cacheTtlMs,
        scan_concurrency: scanConcurrency,
      },
      guidance:
        "Choose the narrowest matching repo path before glob/grep/project_context. Use a collection root only when the target repo is unknown or the task genuinely spans repositories.",
    };
  })();

  if (!options.bypassCache && cacheTtlMs > 0) {
    cache.set(key, { expiresAt: now + cacheTtlMs, value });
  }

  return value;
}

export function formatRepoCatalogForInstructions(catalog: RepoCatalog, maxEntries = 48): string {
  if (catalog.repos.length === 0) return "";
  const shown = catalog.repos.slice(0, Math.max(1, maxEntries));
  const lines = [
    "## Repository catalog",
    "Use this catalog to choose a narrow repo root before recursive glob/grep. Do not scan a broad collection root when a matching repo is listed.",
    ...shown.map((repo) => `- ${repo.name}: ${repo.path}${repo.git_kind === "worktree" ? " [worktree]" : ""}${repo.archive_like ? " [archive-like]" : ""}`),
  ];
  if (catalog.repos.length > shown.length || catalog.truncated) {
    lines.push(
      `- Catalog is bounded: showing ${shown.length}/${catalog.repo_count} discovered repos${catalog.truncated ? "; discovery hit a configured cap" : ""}. agent_status.repo_catalog contains the current catalog metadata.`
    );
  }
  return lines.join("\n");
}
