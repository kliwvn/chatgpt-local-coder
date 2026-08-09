import path from "path";

interface MutationJob<T = unknown> {
  keys: string[];
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const pending: MutationJob[] = [];
const active: MutationJob[] = [];

function mutationKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathConflicts(left: string, right: string): boolean {
  if (left === right) return true;
  const sep = path.sep;
  return left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function jobsConflict(left: MutationJob, right: MutationJob): boolean {
  return left.keys.some((a) => right.keys.some((b) => pathConflicts(a, b)));
}

function drainMutationQueue(): void {
  for (let i = 0; i < pending.length; ) {
    const job = pending[i];
    const blockedByActive = active.some((running) => jobsConflict(job, running));
    const blockedByEarlierPending = pending.slice(0, i).some((waiting) => jobsConflict(job, waiting));
    if (blockedByActive || blockedByEarlierPending) {
      i++;
      continue;
    }

    pending.splice(i, 1);
    active.push(job);
    void Promise.resolve()
      .then(job.operation)
      .then(job.resolve, job.reject)
      .finally(() => {
        const activeIndex = active.indexOf(job);
        if (activeIndex >= 0) active.splice(activeIndex, 1);
        drainMutationQueue();
      });
  }
}

/**
 * Serialize overlapping filesystem mutations while preserving concurrency for
 * unrelated paths. Prefix conflicts make directory operations mutually exclusive
 * with descendant file operations without globally serializing sibling files.
 */
export function withFileMutations<T>(filePaths: string[], operation: () => Promise<T>): Promise<T> {
  const keys = [...new Set(filePaths.map(mutationKey))].sort();
  if (keys.length === 0) return operation();

  return new Promise<T>((resolve, reject) => {
    pending.push({ keys, operation, resolve, reject } as MutationJob);
    drainMutationQueue();
  });
}

export function withFileMutation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  return withFileMutations([filePath], operation);
}