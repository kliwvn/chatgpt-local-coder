export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Project memory + git state are already in MCP instructions from WORKSPACE_PATH.
2. Stay in the primary WORKSPACE_PATH by default. Do not discover or switch to another repo on your own.
3. project_context(path) may target only an exact configured workspace root; use an extra root only when the user's current request explicitly targets it.
4. Explore with glob (file names) and grep (content), then read_text_file.
5. Edit with apply_patch (preferred), multi_edit, or write_file for new files.
6. Run builds/tests with run_command (short) or start_process + process_output (long).
7. Undo file edits with rewind (list → preview → restore). Shell/bash file changes are not tracked.

Use typed file/Git mutation tools whenever one exists; do not retry a host-blocked typed write through run_command/start_process. Generic shell is a broader action, not a permission workaround.
mcp_servers(refresh=true) refreshes Local Coder upstream MCPs only; it does not refresh/rebind the ChatGPT → Local Coder connector, ChatGPT app permissions, or host session/cache state.
tunnel_id/client_instance_id/boot_id/PID/MCP session ids are transport/runtime identities, not ChatGPT app/install permission identities; Local Coder cannot observe the host app/install id.
agent_status.mcp_dispatch aggregate counters are process-global across MCP sessions. For host-gate diagnosis follow mcp_dispatch.protocol v2: use write_file on a fresh canonical .clc-host-gate-canary-<UTC>-<nonce>.tmp (8-64 char nonce) with the exact canonical canary content inside an already authorized scratch/project directory, then immediately call agent_status and match host_gate_canaries/recent_dispatches by exact basename + timestamp. A match with state=reached => MCP_REACHED_UNSETTLED; state=rejected => MCP_REJECTED; state=executed => MCP_EXECUTED. Absence + a host disabled/not-dispatched result is HOST_NOT_INVOKED only when mcp_dispatch.coverage.canary.complete_since proves that attempt is covered by the same live Local Coder process; otherwise classify INDETERMINATE_NO_COVERAGE and run a fresh canary. The agent_status call used to inspect diagnostics appears as its own temporary state=reached until the response completes. A counter delta alone is never per-chat attribution.

## Output format
All tools return JSON: { ok, tool, summary, data }

## Tool cheat sheet
- glob / grep / read_text_file: explore (offset+limit for partial reads)
- apply_patch: single-file @@ hunks OR multi-file *** Begin Patch format
- create_directory / delete_directory / copy_file / move_file / delete_file
- run_command: persistent shell (cd persists); shell_status / shell_reset
- git_status / git_diff / git_add / git_commit / git_branch / git_restore / git_stash
- rewind: action=list|preview|restore|status — undo file edits via automatic checkpoints
- mcp_servers / mcp_tools / mcp_call — delegate to upstream MCP servers on this machine
- delete_file / delete_directory: recoverable Recycle Bin removal; protected roots are refused
- run_command / start_process: destructive delete, forced git clean/reset, and shell tracked-file restore commands are blocked; never use shell to bypass deletion safety

## apply_patch — single file
@@
-old line
+new line
 context unchanged

## apply_patch — multi file
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch

## Paths
Path-aware tools follow FULL_DISK_ACCESS + workspace roots. Relative paths resolve from default cwd.
With FULL_DISK_ACCESS=false, agent-triggered shell/Git/hook/child process trees must pass the Windows AppContainer self-test and stay within configured workspace roots; sandbox failure is fail-closed. FULL_DISK_ACCESS=true is explicit trusted native full-machine mode.
`.trim();

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const header = [
    "# Codex Local Coder MCP",
    `Default project: ${workspaceRoot}`,
    fullDiskAccess
      ? "Path-aware/process access: explicit trusted native full-machine mode."
      : "Path-aware access: exact workspace roots only. Agent-triggered local process trees require the Windows AppContainer sandbox and fail closed if its self-test is unhealthy.",
    "Tag this connector in ChatGPT before every task.",
  ].join("\n");

  const footer = [
    "## Quick pointers",
    `Workspace roots: ${workspaceRoots.join("; ")}`,
    "agent_status — full tool cheat sheet + apply_patch format",
    "project_context(path) — load context only from an exact configured workspace root; never auto-switch projects",
  ].join("\n");

  const body = contextBlock?.trim();
  if (!body) return `${header}\n\n${footer}`;
  return `${header}\n\n${body}\n\n${footer}`;
}