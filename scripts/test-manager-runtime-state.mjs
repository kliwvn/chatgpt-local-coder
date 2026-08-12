import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  preserveLegacySandboxPolicyManifest,
  reconcileLegacyRuntimeDirectory,
  reconcileLegacyShellStateDirectory,
} from "../manager/runtime-state.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-manager-runtime-state-"));
try {
  const repoRoot = path.join(root, "repo");
  const instanceDir = path.join(repoRoot, "manager", "instances", "default");
  const legacy = path.join(repoRoot, ".mcp-checkpoints");
  const target = path.join(instanceDir, "checkpoints");
  await fs.mkdir(legacy, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(legacy, "legacy.txt"), "legacy-state\n");
  await fs.writeFile(path.join(target, "managed.txt"), "managed-state\n");

  const conflict = await reconcileLegacyRuntimeDirectory({
    legacy,
    target,
    instanceDir,
    repoRoot,
    label: "CHECKPOINT_PATH",
  });
  assert(conflict.action === "preserved_conflict", `expected preserved_conflict, got ${conflict.action}`);
  assert(!(await exists(legacy)), "legacy conflict source still exists after successful preservation move");
  assert((await fs.readFile(path.join(target, "managed.txt"), "utf8")) === "managed-state\n", "managed target was overwritten during conflict reconciliation");
  assert(conflict.preserved && await exists(conflict.preserved), "preserved legacy archive was not created");
  assert((await fs.readFile(path.join(conflict.preserved, "legacy.txt"), "utf8")) === "legacy-state\n", "legacy state was not preserved intact");

  const idempotent = await reconcileLegacyRuntimeDirectory({
    legacy,
    target,
    instanceDir,
    repoRoot,
    label: "CHECKPOINT_PATH",
  });
  assert(idempotent.action === "none", `second reconciliation was not idempotent: ${idempotent.action}`);
  assert((await fs.readFile(path.join(target, "managed.txt"), "utf8")) === "managed-state\n", "idempotent reconciliation changed managed target");
  assert((await fs.readFile(path.join(conflict.preserved, "legacy.txt"), "utf8")) === "legacy-state\n", "idempotent reconciliation changed preserved legacy state");

  const legacyOnly = path.join(repoRoot, ".mcp-state");
  const targetOnly = path.join(instanceDir, "shell-state");
  await fs.mkdir(legacyOnly, { recursive: true });
  await fs.writeFile(path.join(legacyOnly, "shell.json"), "{\"cwd\":\"project\"}\n");
  const policyFile = "sandbox-policy-default.json";
  const legacyPolicy = {
    version: 1,
    profileName: "ChatGPTLocalCoder.default",
    sid: "S-1-15-2-test-default",
    rwRoots: [path.join(repoRoot, "old-workspace")],
    execRoots: [path.join(repoRoot, "toolchain")],
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  await fs.writeFile(path.join(legacyOnly, "sandbox-policy-default.json"), `${JSON.stringify(legacyPolicy, null, 2)}\n`);
  const migrated = await reconcileLegacyShellStateDirectory({
    legacy: legacyOnly,
    target: targetOnly,
    instanceDir,
    repoRoot,
    label: "MCP_SHELL_STATE_DIR",
    instanceId: "default",
  });
  assert(migrated.action === "migrated", `legacy-only state was not migrated: ${migrated.action}`);
  assert(!(await exists(legacyOnly)), "legacy-only source remained after migration");
  assert((await fs.readFile(path.join(targetOnly, "shell.json"), "utf8")) === "{\"cwd\":\"project\"}\n", "legacy-only state content changed during migration");
  assert(
    (await fs.readFile(path.join(targetOnly, "sandbox-policy-default.json"), "utf8")) === `${JSON.stringify(legacyPolicy, null, 2)}\n`,
    "legacy-only sandbox policy was not migrated with shell state"
  );

  // Historical manager builds could preserve a conflicting shell tree under
  // shell-state.legacy-orphan. Recover only its sandbox authority ledger into a
  // fresh canonical shell-state directory, while keeping the orphan intact for
  // manual recovery/audit.
  const historicalOrphan = path.join(instanceDir, "shell-state.legacy-orphan");
  const historicalCanonical = path.join(instanceDir, "shell-state-from-orphan");
  await fs.mkdir(historicalOrphan, { recursive: true });
  await fs.writeFile(path.join(historicalOrphan, policyFile), `${JSON.stringify(legacyPolicy, null, 2)}\n`);
  await fs.writeFile(path.join(historicalOrphan, "old-shell.json"), "preserve-me\n");
  const orphanRecovery = await preserveLegacySandboxPolicyManifest({
    legacyDir: historicalOrphan,
    targetDir: historicalCanonical,
    instanceId: "default",
  });
  assert(orphanRecovery.action === "copied", `historical orphan policy was not recovered: ${orphanRecovery.action}`);
  assert(await exists(path.join(historicalOrphan, "old-shell.json")), "historical orphan shell tree was mutated during policy recovery");
  assert(
    (await fs.readFile(path.join(historicalCanonical, policyFile), "utf8")) === `${JSON.stringify(legacyPolicy, null, 2)}\n`,
    "historical orphan sandbox policy was not copied exactly"
  );

  // Dual shell-state roots: retain managed shell state, merge same-identity
  // sandbox policy roots for stale-ACL cleanup, then archive legacy intact.
  const legacyDual = path.join(repoRoot, ".mcp-state-dual");
  const targetDual = path.join(instanceDir, "shell-state-dual");
  await fs.mkdir(legacyDual, { recursive: true });
  await fs.mkdir(targetDual, { recursive: true });
  const oldRoot = path.join(repoRoot, "workspace-parent-old");
  const currentRoot = path.join(repoRoot, "workspace-current");
  const oldExec = path.join(repoRoot, "toolchain-old");
  const currentExec = path.join(repoRoot, "toolchain-current");
  const legacyDualPolicy = {
    ...legacyPolicy,
    rwRoots: [oldRoot],
    execRoots: [oldExec],
  };
  const managedDualPolicy = {
    ...legacyPolicy,
    rwRoots: [currentRoot],
    execRoots: [currentExec],
  };
  await fs.writeFile(path.join(legacyDual, policyFile), `${JSON.stringify(legacyDualPolicy, null, 2)}\n`);
  await fs.writeFile(path.join(targetDual, policyFile), `${JSON.stringify(managedDualPolicy, null, 2)}\n`);
  await fs.writeFile(path.join(legacyDual, "legacy-shell.json"), "legacy-shell\n");
  await fs.writeFile(path.join(targetDual, "managed-shell.json"), "managed-shell\n");

  const dualShell = await reconcileLegacyShellStateDirectory({
    legacy: legacyDual,
    target: targetDual,
    instanceDir,
    repoRoot,
    label: "MCP_SHELL_STATE_DIR_DUAL",
    instanceId: "default",
  });
  assert(dualShell.action === "preserved_conflict", `dual shell state was not preserved safely: ${dualShell.action}`);
  const mergedPolicy = JSON.parse(await fs.readFile(path.join(targetDual, policyFile), "utf8"));
  assert(mergedPolicy.rwRoots.includes(oldRoot) && mergedPolicy.rwRoots.includes(currentRoot), "sandbox RW root history was not unioned for ACL reconciliation");
  assert(mergedPolicy.execRoots.includes(oldExec) && mergedPolicy.execRoots.includes(currentExec), "sandbox RX root history was not preserved for privileged reconciliation");
  assert((await fs.readFile(path.join(targetDual, "managed-shell.json"), "utf8")) === "managed-shell\n", "managed shell state was overwritten during dual-state reconciliation");
  assert(dualShell.preserved && await exists(path.join(dualShell.preserved, "legacy-shell.json")), "legacy dual shell state was not archived intact");

  // Two different AppContainer identities are not safe to merge silently.
  const identityLegacy = path.join(repoRoot, ".mcp-state-identity");
  const identityTarget = path.join(instanceDir, "shell-state-identity");
  await fs.mkdir(identityLegacy, { recursive: true });
  await fs.mkdir(identityTarget, { recursive: true });
  await fs.writeFile(path.join(identityLegacy, policyFile), `${JSON.stringify(legacyPolicy, null, 2)}\n`);
  await fs.writeFile(path.join(identityTarget, policyFile), `${JSON.stringify({ ...legacyPolicy, profileName: "ChatGPTLocalCoder.other", sid: "S-1-15-2-other" }, null, 2)}\n`);
  let identityRejected = false;
  try {
    await preserveLegacySandboxPolicyManifest({ legacyDir: identityLegacy, targetDir: identityTarget, instanceId: "default" });
  } catch (err) {
    identityRejected = /SANDBOX_POLICY_MIGRATION_CONFLICT/.test(String(err?.message || err));
  }
  assert(identityRejected, "different AppContainer identities were merged instead of failing closed");

  console.log("manager-runtime-state: ok (dual-state preserved, policy continuity merged, identity conflicts fail closed, migration idempotent)");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
