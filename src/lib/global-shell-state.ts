import { createHash } from "node:crypto";
import path from "path";
import { atomicWriteFile } from "./atomic-write.js";
import { enqueueKeyedMutation } from "./keyed-mutation.js";
import { readUtf8FileIfExists } from "./optional-file.js";

export interface GlobalShellState {
  workspace_key: string;
  cwd: string;
  updated_at: string;
  recent_commands: string[];
}

// Đọc env tại call time (không capture lúc import) — test set MCP_SHELL_STATE_DIR
// sau import vẫn có hiệu lực, và thay đổi env runtime được tôn trọng.
function stateDir(): string {
  return process.env.MCP_SHELL_STATE_DIR || path.join(process.cwd(), ".mcp-state");
}

const MAX_RECENT = 20;

const shellStateWriteChains = new Map<string, Promise<void>>();

function enqueueShellStateWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return enqueueKeyedMutation(shellStateWriteChains, file, operation);
}

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function statePath(workspaceRoot: string): string {
  return path.join(stateDir(), `shell-${workspaceKey(workspaceRoot)}.json`);
}

async function readGlobalShellStateStrict(workspaceRoot: string): Promise<GlobalShellState | null> {
  const raw = await readUtf8FileIfExists(statePath(workspaceRoot));
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as GlobalShellState;
  if (!parsed.cwd) return null;
  return parsed;
}

export async function loadGlobalShellState(
  workspaceRoot: string,
  _defaultCwd: string
): Promise<GlobalShellState | null> {
  try {
    return await readGlobalShellStateStrict(workspaceRoot);
  } catch {
    // Startup/status reads are best-effort; saveGlobalShellState uses the strict
    // path below so transient read/corruption cannot silently overwrite history.
    return null;
  }
}

export async function saveGlobalShellState(
  workspaceRoot: string,
  cwd: string,
  command?: string,
  previous?: GlobalShellState | null
): Promise<void> {
  const file = statePath(workspaceRoot);
  await enqueueShellStateWrite(file, async () => {
    // Re-read inside the serialized mutation so concurrent tool completions merge
    // into the latest persisted history instead of overwriting each other.
    const latest = await readGlobalShellStateStrict(workspaceRoot);
    const base = latest ?? previous ?? null;
    const recent = [...(base?.recent_commands ?? [])];
    if (command) {
      recent.push(command);
      while (recent.length > MAX_RECENT) recent.shift();
    }

    const state: GlobalShellState = {
      workspace_key: workspaceKey(workspaceRoot),
      cwd: path.resolve(cwd),
      updated_at: new Date().toISOString(),
      recent_commands: recent,
    };

    await atomicWriteFile(file, JSON.stringify(state, null, 2), "utf8");
  });
}

/** Persist an authoritative in-memory shell snapshot in one serialized write. */
export async function saveGlobalShellSnapshot(
  workspaceRoot: string,
  cwd: string,
  recentCommands: string[]
): Promise<void> {
  const file = statePath(workspaceRoot);
  await enqueueShellStateWrite(file, async () => {
    // Fail closed if an existing state file suddenly becomes unreadable instead
    // of silently replacing operator-visible/corrupt state with a new snapshot.
    await readGlobalShellStateStrict(workspaceRoot);
    const state: GlobalShellState = {
      workspace_key: workspaceKey(workspaceRoot),
      cwd: path.resolve(cwd),
      updated_at: new Date().toISOString(),
      recent_commands: recentCommands.slice(-MAX_RECENT),
    };
    await atomicWriteFile(file, JSON.stringify(state, null, 2), "utf8");
  });
}

export async function restoreShellFromDisk(
  workspaceRoot: string,
  defaultCwd: string
): Promise<string> {
  const saved = await loadGlobalShellState(workspaceRoot, defaultCwd);
  return saved?.cwd ?? path.resolve(defaultCwd);
}