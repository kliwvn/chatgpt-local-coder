import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertManagedWorkspaceRootsUnambiguous,
  configuredPrimaryWorkspaceRootsFromEnv,
  configuredWorkspaceRootsFromEnv,
  inspectManagedWorkspaceRoot,
  workspacePathParts,
} from "../manager/workspace-scope.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-manager-workspace-scope-"));
try {
  const project = path.join(root, "project");
  const nestedRepo = path.join(project, "packages", "nested");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.mkdir(path.join(nestedRepo, ".git"), { recursive: true });
  const projectInspection = await inspectManagedWorkspaceRoot(project);
  assert(projectInspection.projectRoot, "root owning .git was not recognized as an exact project root");
  assert(!projectInspection.ambiguousCollectionRoot, "project/monorepo root was incorrectly rejected because it contains nested repositories");
  await assertManagedWorkspaceRootsUnambiguous([project]);

  const collection = path.join(root, "collection");
  const childRepo = path.join(collection, "child");
  await fs.mkdir(path.join(childRepo, ".git"), { recursive: true });
  const collectionInspection = await inspectManagedWorkspaceRoot(collection);
  assert(collectionInspection.ambiguousCollectionRoot, "non-project parent containing a child Git repository was not flagged");
  let rejected = false;
  try {
    await assertManagedWorkspaceRootsUnambiguous([collection]);
  } catch (err) {
    rejected = /WORKSPACE_SCOPE_AMBIGUOUS/.test(String(err?.message || err));
  }
  assert(rejected, "ambiguous parent/container workspace was not rejected");
  await assertManagedWorkspaceRootsUnambiguous([collection], { fullDiskAccess: true });

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

  console.log("manager-workspace-scope: ok (exact single primary, strict exact roots, trusted full-disk collection roots, obsolete aliases ignored)");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
