import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRepoCatalogCache,
  discoverRepoCatalog,
  formatRepoCatalogForInstructions,
} from "../dist/lib/repo-catalog.js";

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err?.message || err}`);
  failed++;
}

async function makeRepo(dir, kind = "repository") {
  await fs.mkdir(dir, { recursive: true });
  const marker = path.join(dir, ".git");
  if (kind === "worktree") {
    await fs.writeFile(marker, "gitdir: C:/fixture/.git/worktrees/example\n", "utf8");
  } else {
    await fs.mkdir(marker);
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-repo-catalog-"));
try {
  const repo = path.join(root, "repo-a");
  const worktree = path.join(root, "worktrees", "feature-a");
  const nestedInsideRepo = path.join(repo, "vendor", "nested-repo");
  const tooDeep = path.join(root, "deep", "a", "b", "repo-too-deep");

  await makeRepo(repo);
  await makeRepo(worktree, "worktree");
  await makeRepo(nestedInsideRepo);
  await makeRepo(tooDeep);

  try {
    clearRepoCatalogCache();
    const catalog = await discoverRepoCatalog([root], {
      maxDepth: 2,
      maxDirectories: 100,
      maxRepos: 20,
      cacheTtlMs: 60_000,
      scanConcurrency: 4,
    });
    const byName = new Map(catalog.repos.map((entry) => [entry.name, entry]));

    if (byName.get("repo-a")?.git_kind !== "repository") {
      throw new Error("normal repository was not discovered");
    }
    if (byName.get("feature-a")?.git_kind !== "worktree") {
      throw new Error(".git file worktree was not classified as worktree");
    }
    if (catalog.repos.some((entry) => entry.path.endsWith(path.join("vendor", "nested-repo")))) {
      throw new Error("catalog descended into a repository after identifying its boundary");
    }
    if (byName.has("repo-too-deep")) {
      throw new Error("catalog exceeded maxDepth");
    }
    const rendered = formatRepoCatalogForInstructions(catalog);
    if (!rendered.includes("repo-a") || !rendered.includes("feature-a") || !/narrow repo root/i.test(rendered)) {
      throw new Error("instruction formatter omitted routing guidance or discovered repositories");
    }
    ok("bounded catalog discovers repository/worktree boundaries without nested content traversal");
  } catch (err) {
    fail("repo/worktree discovery", err);
  }

  try {
    clearRepoCatalogCache();
    const first = await discoverRepoCatalog([root], {
      maxDepth: 2,
      maxDirectories: 100,
      maxRepos: 20,
      cacheTtlMs: 60_000,
      scanConcurrency: 4,
    });
    const added = path.join(root, "repo-after-cache");
    await makeRepo(added);
    const cached = await discoverRepoCatalog([root], {
      maxDepth: 2,
      maxDirectories: 100,
      maxRepos: 20,
      cacheTtlMs: 60_000,
      scanConcurrency: 4,
    });
    if (cached.generated_at !== first.generated_at || cached.repos.some((entry) => entry.name === "repo-after-cache")) {
      throw new Error("catalog cache did not preserve the cached snapshot");
    }

    clearRepoCatalogCache();
    const refreshed = await discoverRepoCatalog([root], {
      maxDepth: 2,
      maxDirectories: 100,
      maxRepos: 20,
      cacheTtlMs: 60_000,
      scanConcurrency: 4,
    });
    if (!refreshed.repos.some((entry) => entry.name === "repo-after-cache")) {
      throw new Error("cache clear did not refresh repository discovery");
    }
    ok("repo catalog cache is stable and refreshable");
  } catch (err) {
    fail("repo catalog cache", err);
  }

  try {
    clearRepoCatalogCache();
    const capped = await discoverRepoCatalog([root], {
      maxDepth: 4,
      maxDirectories: 2,
      maxRepos: 20,
      cacheTtlMs: 0,
      scanConcurrency: 2,
    });
    if (!capped.truncated || capped.scanned_directories > 2) {
      throw new Error(`directory cap failed: scanned=${capped.scanned_directories} truncated=${capped.truncated}`);
    }
    ok("repo catalog directory cap fails bounded");
  } catch (err) {
    fail("repo catalog cap", err);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(`\nRepo catalog tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
