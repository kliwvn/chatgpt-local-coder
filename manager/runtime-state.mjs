import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, retryTransientFsMutation } from "./fs-utils.mjs";
import { recycleManagedDirectory } from "./safe-delete.mjs";

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

function normalizeStringSet(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string" || !value.trim()) continue;
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function parsePolicyManifest(raw, file) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`SANDBOX_POLICY_MIGRATION_CONFLICT: invalid JSON in ${file}: ${String(err?.message || err)}`);
  }
  if (
    parsed?.version !== 1 ||
    typeof parsed.profileName !== "string" ||
    typeof parsed.sid !== "string" ||
    !Array.isArray(parsed.rwRoots) || !parsed.rwRoots.every((item) => typeof item === "string") ||
    !Array.isArray(parsed.execRoots) || !parsed.execRoots.every((item) => typeof item === "string")
  ) {
    throw new Error(`SANDBOX_POLICY_MIGRATION_CONFLICT: invalid policy manifest shape in ${file}`);
  }
  return parsed;
}

/**
 * Preserve the AppContainer policy manifest when legacy .mcp-state is merged
 * into managed shell-state. Without this, the runtime loses the list of old RW
 * grants and cannot revoke a previously broader workspace ACL safely.
 */
export async function preserveLegacySandboxPolicyManifest({ legacyDir, targetDir, instanceId = "default" }) {
  const safeId = String(instanceId || "default").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 24) || "default";
  const fileName = `sandbox-policy-${safeId}.json`;
  const source = path.join(legacyDir, fileName);
  const target = path.join(targetDir, fileName);
  if (!(await exists(source))) return { action: "none", source, target };

  await fs.mkdir(targetDir, { recursive: true });
  if (!(await exists(target))) {
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    return { action: "copied", source, target };
  }

  const [sourceRaw, targetRaw] = await Promise.all([fs.readFile(source, "utf8"), fs.readFile(target, "utf8")]);
  if (sourceRaw === targetRaw) return { action: "identical", source, target };

  const sourcePolicy = parsePolicyManifest(sourceRaw, source);
  const targetPolicy = parsePolicyManifest(targetRaw, target);
  if (sourcePolicy.profileName !== targetPolicy.profileName || sourcePolicy.sid !== targetPolicy.sid) {
    throw new Error(
      `SANDBOX_POLICY_MIGRATION_CONFLICT: legacy and managed manifests use different AppContainer identities; ` +
      `legacy=${sourcePolicy.profileName}/${sourcePolicy.sid} managed=${targetPolicy.profileName}/${targetPolicy.sid}`
    );
  }

  // Union old roots so the next ProcessExecutor initialization can revoke every
  // historically granted RW root. Exec-root differences intentionally survive
  // into the merged manifest and trigger the existing privileged setup gate.
  const merged = {
    version: 1,
    profileName: targetPolicy.profileName,
    sid: targetPolicy.sid,
    rwRoots: normalizeStringSet([...sourcePolicy.rwRoots, ...targetPolicy.rwRoots]),
    execRoots: normalizeStringSet([...sourcePolicy.execRoots, ...targetPolicy.execRoots]),
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteFile(target, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { action: "merged", source, target, policy: merged };
}

/**
 * Shell-state migration owns the sandbox-policy manifest too. When the managed
 * target does not exist, move the whole legacy directory so shell state and the
 * policy manifest stay together. When both exist, preserve/merge the manifest
 * first, then archive the remaining legacy tree without overwriting target data.
 */
export async function reconcileLegacyShellStateDirectory({
  legacy,
  target,
  instanceDir,
  repoRoot,
  label,
  instanceId = "default",
}) {
  if (!(await exists(legacy))) return { action: "none", legacy, target };
  if (await exists(target)) {
    await preserveLegacySandboxPolicyManifest({ legacyDir: legacy, targetDir: target, instanceId });
  }
  return reconcileLegacyRuntimeDirectory({ legacy, target, instanceDir, repoRoot, label });
}

async function nextPreservedPath(instanceDir, label) {
  const archiveRoot = path.join(instanceDir, "legacy-runtime-state");
  await fs.mkdir(archiveRoot, { recursive: true });
  const stem = String(label || "runtime-state").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  for (let index = 0; index < 10_000; index++) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(archiveRoot, `${stem}${suffix}.legacy`);
    if (!(await exists(candidate))) return { archiveRoot, candidate };
  }
  throw new Error(`Legacy runtime-state archive capacity exhausted for ${label}`);
}

async function moveDirectoryRecoverably(source, target, sourceParent, targetParent) {
  try {
    await retryTransientFsMutation(() => fs.rename(source, target));
    return;
  } catch (err) {
    if (err?.code !== "EXDEV") throw err;
  }

  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
  try {
    await recycleManagedDirectory(source, sourceParent);
  } catch (recycleErr) {
    // The source is still durable. Roll back only the transaction-created copy,
    // using the Recycle Bin as well. If rollback fails, preserve both copies and
    // fail closed rather than permanently deleting either side.
    try {
      await recycleManagedDirectory(target, targetParent);
    } catch (rollbackErr) {
      throw new Error(
        `Legacy runtime state source recycle failed and rollback copy was preserved: ${target}; ` +
        `source error=${String(recycleErr?.message || recycleErr)}; rollback error=${String(rollbackErr?.message || rollbackErr)}`
      );
    }
    throw recycleErr;
  }
}

/**
 * Reconcile one legacy managed-state directory without data loss.
 *
 * - legacy only: move it into the managed target;
 * - target only / neither: no-op;
 * - both: keep target authoritative and move the legacy tree intact into an
 *   instance-local recovery archive instead of throwing, deleting, or overwriting.
 *
 * A completed reconciliation is idempotent because the legacy source no longer
 * exists. All copy fallbacks use recoverable Recycle Bin cleanup and preserve
 * both copies if rollback cannot be proven safe.
 */
export async function reconcileLegacyRuntimeDirectory({ legacy, target, instanceDir, repoRoot, label }) {
  const legacyExists = await exists(legacy);
  if (!legacyExists) return { action: "none", legacy, target };

  const targetExists = await exists(target);
  await fs.mkdir(instanceDir, { recursive: true });

  if (!targetExists) {
    await moveDirectoryRecoverably(legacy, target, repoRoot, instanceDir);
    return { action: "migrated", legacy, target };
  }

  const { archiveRoot, candidate } = await nextPreservedPath(instanceDir, label);
  await moveDirectoryRecoverably(legacy, candidate, repoRoot, archiveRoot);
  return {
    action: "preserved_conflict",
    legacy,
    target,
    preserved: candidate,
  };
}
