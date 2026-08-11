import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";
import {
  getDefaultCwd,
  getWorkspaceRoots,
  setDefaultCwd,
  setWorkspaceRoots,
} from "../dist/lib/path-security.js";
import {
  getMcpDispatchDiagnostics,
  recordMcpExecuted,
  recordMcpReached,
  recordMcpRejected,
} from "../dist/lib/mcp-dispatch-diagnostics.js";

const oldProfile = process.env.CHATGPT_TOOL_PROFILE;
const oldCwd = getDefaultCwd();
const oldRoots = getWorkspaceRoots();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-chatgpt-contract-"));

const expected = {
  write_file: {
    title: "Write File",
    description: "Create or replace a local text file inside the configured path scope. A recovery checkpoint is created before overwrite.",
    properties: ["content", "path"],
    required: ["content", "path"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  edit_file: {
    title: "Edit File",
    description: "Modify local text by exact replacement inside the configured path scope. Supports dry-run and creates a recovery checkpoint before changes.",
    properties: ["dry_run", "new_text", "old_text", "path", "replace_all"],
    required: ["new_text", "old_text", "path"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  multi_edit: {
    title: "Multi Edit",
    description: "Modify one local text file with multiple exact replacements atomically. Supports dry-run and creates a recovery checkpoint before changes.",
    properties: ["dry_run", "edits", "path"],
    required: ["edits", "path"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  apply_patch: {
    title: "Apply Patch",
    description: "Apply checkpointed local code edits with Codex @@ hunks or *** Begin Patch format. Supports dry-run. File removal is not allowed here; use the explicit removal tools.",
    properties: ["dry_run", "patch", "path"],
    required: ["patch"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  delete_file: {
    title: "Delete File",
    description: "Remove a file reversibly by moving it to the Windows Recycle Bin. Protected roots are refused.",
    properties: ["path"],
    required: ["path"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  delete_directory: {
    title: "Remove Local Folder",
    description: "Remove a folder reversibly by moving it to the Windows Recycle Bin. Workspace/repo/home/drive roots are refused.",
    properties: ["path"],
    required: ["path"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  run_command: {
    title: "Run Command",
    description: "Run shell commands to verify work (tests, build, lint). Cwd persists across ChatGPT tool calls (saved to disk). Use shell_status to check cwd. Use start_process for long jobs.",
    properties: ["command", "working_directory"],
    required: ["command"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  start_process: {
    title: "Start Background Process",
    description: "Start a long-running command in the background. Use process_output/process_status/stop_process afterwards.",
    properties: ["command", "working_directory"],
    required: ["command"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  git_commit: {
    title: "Git Commit",
    description: "Create a commit (stages all first unless stage_only=false).",
    properties: ["message", "path", "stage_all"],
    required: ["message"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
};

function normalize(tool) {
  const a = tool.annotations || {};
  return {
    title: tool.title,
    description: tool.description,
    properties: Object.keys(tool.inputSchema?.properties || {}).sort(),
    required: [...(tool.inputSchema?.required || [])].sort(),
    annotations: {
      readOnlyHint: Boolean(a.readOnlyHint),
      destructiveHint: Boolean(a.destructiveHint),
      idempotentHint: Boolean(a.idempotentHint),
      openWorldHint: Boolean(a.openWorldHint),
    },
  };
}

let server;
let client;
try {
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  setDefaultCwd(temp);
  setWorkspaceRoots([temp]);

  server = await createMcpServer(temp, 10, [temp], false);
  client = new Client({ name: "chatgpt-action-contract-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const [name, contract] of Object.entries(expected)) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} missing from slim tools/list`);
    assert.deepEqual(normalize(tool), contract, `${name} host-facing MCP contract drifted`);
  }

  const victim = path.join(temp, "must-survive.txt");
  await fs.writeFile(victim, "survive\n", "utf8");
  const patch = "*** Begin Patch\n*** Delete File: must-survive.txt\
*** End Patch";
  let blocked = false;
  try {
    const result = await client.callTool({ name: "apply_patch", arguments: { path: temp, patch } });
    blocked = JSON.stringify(result).includes("APPLY_PATCH_DELETE_UNSUPPORTED");
  } catch (err) {
    blocked = String(err?.message || err).includes("APPLY_PATCH_DELETE_UNSUPPORTED");
  }
  assert.equal(blocked, true, "apply_patch accepted a file-removal operation");
  assert.equal(await fs.readFile(victim, "utf8"), "survive\n", "blocked apply_patch mutated its target");

  const before = getMcpDispatchDiagnostics();
  const beforeReached = before.stages.MCP_REACHED.write_total;
  const beforeExecuted = before.stages.MCP_EXECUTED.write_total;
  const beforeRejected = before.stages.MCP_REJECTED.write_total;
  const beforeInFlight = before.stages.MCP_IN_FLIGHT.write_total;
  const tool = recordMcpReached({ method: "tools/call", params: { name: "write_file" } });
  assert.equal(tool, "write_file");
  let diag = getMcpDispatchDiagnostics();
  assert.equal(diag.stages.MCP_REACHED.write_total, beforeReached + 1);
  assert.equal(diag.stages.MCP_EXECUTED.write_total, beforeExecuted);
  assert.equal(diag.stages.MCP_REJECTED.write_total, beforeRejected);
  assert.equal(diag.stages.MCP_IN_FLIGHT.write_total, beforeInFlight + 1);
  assert.match(diag.interpretation, /HOST_NOT_INVOKED/);
  recordMcpExecuted(tool);
  diag = getMcpDispatchDiagnostics();
  assert.equal(diag.stages.MCP_EXECUTED.write_total, beforeExecuted + 1);
  assert.equal(diag.stages.MCP_IN_FLIGHT.write_total, beforeInFlight);

  const rejectedTool = recordMcpReached({ method: "tools/call", params: { name: "write_file" } });
  recordMcpRejected(rejectedTool, "MISSING_SESSION_ID");
  diag = getMcpDispatchDiagnostics();
  assert.equal(diag.stages.MCP_REACHED.write_total, beforeReached + 2);
  assert.equal(diag.stages.MCP_REJECTED.write_total, beforeRejected + 1);
  assert.equal(diag.stages.MCP_REJECTED.last_reason, "MISSING_SESSION_ID");
  assert.equal(diag.stages.MCP_REJECTED.last_write_reason, "MISSING_SESSION_ID");
  assert.ok(diag.stages.MCP_REJECTED.reasons.MISSING_SESSION_ID >= 1);
  assert.equal(diag.stages.MCP_IN_FLIGHT.write_total, beforeInFlight);
  assert.equal(
    diag.stages.MCP_REACHED.write_total,
    diag.stages.MCP_EXECUTED.write_total + diag.stages.MCP_REJECTED.write_total + diag.stages.MCP_IN_FLIGHT.write_total,
    "write dispatch stages must conserve reached requests"
  );

  console.log(`chatgpt-action-contract: ok (${Object.keys(expected).length} critical actions locked; apply_patch removal blocked; dispatch terminal states conserved)`);
} finally {
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  setDefaultCwd(oldCwd);
  setWorkspaceRoots(oldRoots);
  if (oldProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
  else process.env.CHATGPT_TOOL_PROFILE = oldProfile;
  await fs.rm(temp, { recursive: true, force: true });
}
