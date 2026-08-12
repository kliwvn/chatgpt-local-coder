import path from "node:path";
import { getFullDiskAccess } from "./path-security.js";

export interface GitProcessInvocation {
  cwd: string;
  args: string[];
}

/**
 * Git for Windows is built on the MSYS runtime, which resolves getcwd() by
 * traversing path ancestry. Under AppContainer that would otherwise require
 * directory-enumeration access above an allowed workspace. Keep the OS boundary
 * narrow instead: strict mode starts Git at the drive root (granted traverse +
 * read-attributes only during explicit sandbox setup) and addresses the repo by
 * exact --git-dir/--work-tree paths whose target subtree has the sandbox RW ACE.
 *
 * Full-disk trusted mode preserves the historical native cwd behavior.
 */
export function buildGitProcessInvocation(repoRoot: string, args: string[]): GitProcessInvocation {
  const root = path.resolve(repoRoot);
  if (getFullDiskAccess()) {
    return { cwd: root, args: [...args] };
  }
  const driveRoot = path.parse(root).root;
  if (!driveRoot) {
    throw new Error(`OS_SANDBOX_LAUNCH_FAILED: cannot resolve drive root for git repository ${root}`);
  }
  return {
    cwd: driveRoot,
    args: [
      `--git-dir=${path.join(root, ".git")}`,
      `--work-tree=${root}`,
      ...args,
    ],
  };
}
