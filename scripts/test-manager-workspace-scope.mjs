import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configuredPrimaryWorkspaceRootsFromEnv,
  configuredWorkspaceRootsFromEnv,
  workspacePathParts,
} from "../manager/workspace-scope.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-manager-workspace-scope-"));
try {
  const project = path.join(root, "project");
  const collection = path.join(root, "collection");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.mkdir(path.join(collection, "repo-a", ".git"), { recursive: true });
  await fs.mkdir(path.join(collection, "repo-b", ".git"), { recursive: true });

  // Workspace parsing is intentionally VCS-agnostic. A collection root is an
  // explicit authority boundary just like a project root; FULL_DISK_ACCESS only
  // changes whether that boundary is enforced, not whether the root is valid.
  const collectionRoots = configuredWorkspaceRootsFromEnv({ WORKSPACE_PATH: collection }, root);
  assert(collectionRoots.length === 1 && path.resolve(collectionRoots[0]) === path.resolve(collection), "explicit collection root was not preserved as workspace authority");

  const extra = path.join(root, "extra");
  const alias = path.join(root, "alias");
  await fs.mkdir(extra, { recursive: true });
  await fs.mkdir(alias, { recursive: true });

  assert(workspacePathParts("").length === 0, "empty WORKSPACE_PATH unexpectedly produced a primary root");
  const invalidPrimary = configuredPrimaryWorkspaceRootsFromEnv({ WORKSPACE_PATH: `${project};${extra}` }, root);
  assert(invalidPrimary.length === 2, "multiple primary workspace roots were not detectable by manager validation");
  const exactPrimary = configuredPrimaryWorkspaceRootsFromEnv({ WORKSPACE_PATH: project }, root);
  assert(exactPrimary.length === 1 && path.resolve(exactPrimary[0]) === path.resolve(project), "exact primary workspace was not resolved deterministically");
  const roots = configuredWorkspaceRootsFromEnv({
    WORKSPACE_PATH: project,
    EXTRA_WORKSPACE_PATHS: `${extra};${project}`,
    WORKSPACE_PATHS: "alias",
    ALLOWED_WORKSPACE_PATHS: extra,
  }, root);
  const normalized = roots.map((item) => path.resolve(item).toLowerCase());
  assert(normalized.length === 2, `obsolete hidden workspace aliases affected authority: ${JSON.stringify(roots)}`);
  assert(normalized.includes(path.resolve(project).toLowerCase()), "primary workspace missing from configured roots");
  assert(normalized.includes(path.resolve(extra).toLowerCase()), "extra workspace missing from configured roots");
  assert(!normalized.includes(path.resolve(alias).toLowerCase()), "obsolete WORKSPACE_PATHS alias must not affect workspace authority");

  console.log("manager-workspace-scope: ok (single primary, explicit collection roots, additional roots, obsolete aliases ignored)");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
