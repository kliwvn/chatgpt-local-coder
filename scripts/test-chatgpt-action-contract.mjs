import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  getDefaultCwd,
  getWorkspaceRoots,
  setDefaultCwd,
  setWorkspaceRoots,
} from "../dist/lib/path-security.js";
import {
  getMcpDispatchDiagnostics,
  isWriteLikeTool,
  recordMcpExecuted,
  recordMcpReached,
  recordMcpRejected,
} from "../dist/lib/mcp-dispatch-diagnostics.js";
import { SESSION_NOT_FOUND_MESSAGE } from "../dist/lib/mcp-session-manager.js";

const oldProfile = process.env.CHATGPT_TOOL_PROFILE;
const oldRuntimeEnv = Object.fromEntries([
  "FULL_DISK_ACCESS",
  "LOCAL_CODER_INSTANCE_ID",
  "CLC_SANDBOX_PROFILE_NAME",
  "CLC_SANDBOX_STATE_DIR",
  "MCP_SHELL_STATE_DIR",
].map((key) => [key, process.env[key]]));
const oldCwd = getDefaultCwd();
const oldRoots = getWorkspaceRoots();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(repoRoot, ".tool-test-tmp");
await fs.mkdir(testRoot, { recursive: true });
const temp = await fs.mkdtemp(path.join(testRoot, "clc-chatgpt-contract-"));

const expected = {
  write_file: {
    title: "Write File",
    description: "Create or replace a local text file inside the configured path scope. A recovery checkpoint is created before overwrite.",
    properties: ["content", "path"],
    required: ["content", "path"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  edit_file: {
    title: "Edit File",
    description: "Modify local text by exact replacement inside the configured path scope. Supports dry-run and creates a recovery checkpoint before changes.",
    properties: ["dry_run", "new_text", "old_text", "path", "replace_all"],
    required: ["new_text", "old_text", "path"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  multi_edit: {
    title: "Multi Edit",
    description: "Modify one local text file with multiple exact replacements atomically. Supports dry-run and creates a recovery checkpoint before changes.",
    properties: ["dry_run", "edits", "path"],
    required: ["edits", "path"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  apply_patch: {
    title: "Apply Patch",
    description: "Apply checkpointed local code edits with Codex @@ hunks or *** Begin Patch format. Supports dry-run. File removal is not allowed here; use the explicit removal tools.",
    properties: ["dry_run", "patch", "path"],
    required: ["patch"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  delete_file: {
    title: "Delete File",
    description: "Remove a file reversibly by moving it to the Windows Recycle Bin. Protected roots are refused.",
    properties: ["path"],
    required: ["path"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  delete_directory: {
    title: "Delete Directory",
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  start_process: {
    title: "Start Background Process",
    description: "Start a long-running command in the background. Use process_output/process_status/stop_process afterwards.",
    properties: ["command", "working_directory"],
    required: ["command"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  git_commit: {
    title: "Git Commit",
    description: "Create a commit (stages all first unless stage_only=false).",
    properties: ["message", "path", "stage_all"],
    required: ["message"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  remember: {
    title: "Remember",
    description: "Save a note to auto memory for future ChatGPT sessions (like Claude Code MEMORY.md).",
    properties: ["note"],
    required: ["note"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
let fullServer;
try {
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  process.env.FULL_DISK_ACCESS = "true";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(temp, ".sandbox-state");
  process.env.MCP_SHELL_STATE_DIR = path.join(temp, ".shell-state");
  setDefaultCwd(temp);
  setWorkspaceRoots([temp]);

  const { createMcpServer } = await import("../dist/server-factory.js");
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

  process.env.CHATGPT_TOOL_PROFILE = "full";
  fullServer = await createMcpServer(temp, 10, [temp], false);
  for (const [name, registered] of Object.entries(fullServer._registeredTools)) {
    if (registered?.annotations?.readOnlyHint === true) continue;
    assert.equal(isWriteLikeTool(name), true, `${name} is host-annotated write-capable but missing from dispatch write-like classification`);
  }
  assert.equal(isWriteLikeTool("upstream__future_tool"), true, "dynamic upstream proxy names must fail conservative as write-like");
  await fullServer.close();
  fullServer = undefined;
  process.env.CHATGPT_TOOL_PROFILE = "slim";

  const victim = path.join(temp, "must-survive.txt");
  await fs.writeFile(victim, "survive\n", "utf8");
  const patch = [
    "*** Begin Patch",
    "*** Delete File: must-survive.txt",
    "*** End Patch",
  ].join("\n");
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
  const rawSessionId = "session-secret-must-not-leak";
  const probeName = ".clc-host-gate-canary-20260814T100600Z-testnonce01.tmp";
  const canaryContent = "host-gate diagnostic canary\n";
  const tool = recordMcpReached(
    { method: "tools/call", params: { name: "write_file", arguments: { path: `C:\\private\\parent\\${probeName}`, content: canaryContent } } },
    rawSessionId
  );
  assert.equal(tool?.tool, "write_file");
  assert.equal(tool?.host_gate_canary, true);
  let diag = getMcpDispatchDiagnostics();
  assert.equal(diag.stages.MCP_REACHED.write_total, beforeReached + 1);
  assert.equal(diag.stages.MCP_EXECUTED.write_total, beforeExecuted);
  assert.equal(diag.stages.MCP_REJECTED.write_total, beforeRejected);
  assert.equal(diag.stages.MCP_IN_FLIGHT.write_total, beforeInFlight + 1);
  assert.match(diag.interpretation, /HOST_NOT_INVOKED/);
  let recent = diag.recent_dispatches.find((entry) => entry.dispatch_id === tool.dispatch_id);
  assert.equal(recent?.state, "reached");
  assert.equal(recent?.correlation_hint, `path:${probeName}`);
  assert.match(recent?.session_fingerprint || "", /^[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(recent), /session-secret-must-not-leak|private/);
  recordMcpExecuted(tool);
  diag = getMcpDispatchDiagnostics();
  assert.equal(diag.stages.MCP_EXECUTED.write_total, beforeExecuted + 1);
  assert.equal(diag.stages.MCP_IN_FLIGHT.write_total, beforeInFlight);
  recent = diag.recent_dispatches.find((entry) => entry.dispatch_id === tool.dispatch_id);
  assert.equal(recent?.state, "executed");
  assert.ok(recent?.settled_at);
  let canary = diag.host_gate_canaries.find((entry) => entry.dispatch_id === tool.dispatch_id);
  assert.equal(canary?.correlation_hint, `path:${probeName}`);
  assert.equal(canary?.state, "executed");
  assert.equal(diag.protocol?.version, 2);
  assert.equal(diag.protocol?.canary?.basename_prefix, ".clc-host-gate-canary-");
  assert.match(String(diag.protocol?.classification?.HOST_NOT_INVOKED?.evidence || ""), /coverage\.canary\.complete_since/i);
  assert.match(String(diag.protocol?.classification?.INDETERMINATE_NO_COVERAGE?.evidence || ""), /evicted\/reset record/i);
  assert.match(String(diag.protocol?.classification?.MCP_REACHED_UNSETTLED?.evidence || ""), /state=reached/i);
  assert.equal(diag.protocol?.host_surface_checklist?.observable_by_server, false);
  assert.match(String(diag.protocol?.support_bundle?.privacy || ""), /raw MCP session IDs/i);
  assert.match(String(diag.coverage?.absence_rule || ""), /evicted attempt makes absence indeterminate/i);
  assert.ok(!Number.isNaN(Date.parse(diag.coverage?.canary?.complete_since || "")), "canary coverage start must be parseable");
  assert.ok(Array.isArray(diag.protocol?.prohibitions));
  assert.ok(diag.protocol.prohibitions.some((item) => /Do not weaken or falsify MCP annotations/i.test(String(item))));
  recordMcpExecuted(tool);
  let duplicateDiag = getMcpDispatchDiagnostics();
  assert.equal(duplicateDiag.stages.MCP_EXECUTED.write_total, beforeExecuted + 1, "duplicate terminal callback changed executed total");

  const prefixOnly = recordMcpReached({
    method: "tools/call",
    params: { name: "write_file", arguments: { path: ".clc-host-gate-canary-not-canonical.txt", content: canaryContent } },
  });
  assert.equal(prefixOnly?.host_gate_canary, false, "prefix-only filename was incorrectly recognized as a host-gate canary");
  recordMcpExecuted(prefixOnly);

  const wrongContentName = ".clc-host-gate-canary-20260814T100601Z-wrongcontent01.tmp";
  const wrongContent = recordMcpReached({
    method: "tools/call",
    params: { name: "write_file", arguments: { path: wrongContentName, content: "not the diagnostic canary" } },
  });
  assert.equal(wrongContent?.host_gate_canary, false, "wrong-content write was incorrectly recognized as a host-gate canary");
  recordMcpExecuted(wrongContent);
  diag = getMcpDispatchDiagnostics();
  assert.ok(!diag.host_gate_canaries.some((entry) => entry.dispatch_id === prefixOnly.dispatch_id || entry.dispatch_id === wrongContent.dispatch_id));

  const beforeRejectedProbe = getMcpDispatchDiagnostics();
  const rejectedTool = recordMcpReached({ method: "tools/call", params: { name: "write_file", arguments: { path: "rejected-probe.txt", content: "x" } } });
  recordMcpRejected(rejectedTool, "MISSING_SESSION_ID");
  diag = getMcpDispatchDiagnostics();
  assert.equal(diag.stages.MCP_REACHED.write_total, beforeRejectedProbe.stages.MCP_REACHED.write_total + 1);
  assert.equal(diag.stages.MCP_REJECTED.write_total, beforeRejectedProbe.stages.MCP_REJECTED.write_total + 1);
  assert.equal(diag.stages.MCP_REJECTED.last_reason, "MISSING_SESSION_ID");
  assert.equal(diag.stages.MCP_REJECTED.last_write_reason, "MISSING_SESSION_ID");
  assert.ok(diag.stages.MCP_REJECTED.reasons.MISSING_SESSION_ID >= 1);
  assert.equal(diag.stages.MCP_IN_FLIGHT.write_total, beforeInFlight);
  recent = diag.recent_dispatches.find((entry) => entry.dispatch_id === rejectedTool.dispatch_id);
  assert.equal(recent?.state, "rejected");
  assert.equal(recent?.reason, "MISSING_SESSION_ID");

  const shellSecret = "sk-shell-secret-must-not-leak";
  const shellDispatch = recordMcpReached({ method: "tools/call", params: { name: "run_command", arguments: { command: `echo ${shellSecret}` } } }, "shell-session");
  assert.equal(shellDispatch?.correlation_hint, null);
  recordMcpExecuted(shellDispatch);
  diag = getMcpDispatchDiagnostics();
  const shellRecent = diag.recent_dispatches.find((entry) => entry.dispatch_id === shellDispatch.dispatch_id);
  assert.doesNotMatch(JSON.stringify(shellRecent), new RegExp(shellSecret));
  assert.equal(
    diag.stages.MCP_REACHED.write_total,
    diag.stages.MCP_EXECUTED.write_total + diag.stages.MCP_REJECTED.write_total + diag.stages.MCP_IN_FLIGHT.write_total,
    "write dispatch stages must conserve reached requests"
  );

  const ringLimit = diag.correlation.recent_limit;
  for (let i = 0; i < ringLimit + 8; i++) {
    const readDispatch = recordMcpReached({ method: "tools/call", params: { name: "read_text_file", arguments: { path: `ring-${i}.txt` } } }, `ring-session-${i}`);
    recordMcpExecuted(readDispatch);
  }
  duplicateDiag = getMcpDispatchDiagnostics();
  assert.equal(duplicateDiag.recent_dispatches.length, ringLimit, "recent dispatch ring exceeded its configured bound");
  assert.ok(duplicateDiag.recent_dispatches.every((entry) => !String(entry.session_fingerprint || "").includes("ring-session")), "raw session id leaked into bounded ring");
  canary = duplicateDiag.host_gate_canaries.find((entry) => entry.dispatch_id === tool.dispatch_id);
  assert.equal(canary?.state, "executed", "dedicated host-gate canary ledger lost the canary after general dispatch-ring churn");

  const canaryLimit = duplicateDiag.correlation.canary_limit;
  for (let i = 0; i < canaryLimit + 5; i++) {
    const canaryDispatch = recordMcpReached(
      {
        method: "tools/call",
        params: {
          name: "write_file",
          arguments: {
            path: `.clc-host-gate-canary-20260814T100602Z-bound${String(i).padStart(4, "0")}.tmp`,
            content: canaryContent,
          },
        },
      },
      `canary-session-${i}`
    );
    assert.equal(canaryDispatch?.host_gate_canary, true);
    recordMcpExecuted(canaryDispatch);
  }
  const boundedCanaryDiag = getMcpDispatchDiagnostics();
  assert.equal(boundedCanaryDiag.host_gate_canaries.length, canaryLimit, "host-gate canary ledger exceeded its configured bound");
  assert.ok(boundedCanaryDiag.host_gate_canaries.every((entry) => !JSON.stringify(entry).includes("canary-session-")), "raw canary session id leaked into host-gate ledger");
  assert.ok(boundedCanaryDiag.coverage.canary.evicted_total >= 5, "canary eviction accounting did not advance");
  assert.ok(!boundedCanaryDiag.host_gate_canaries.some((entry) => entry.dispatch_id === tool.dispatch_id), "evicted canary unexpectedly remained in dedicated ledger");
  assert.ok(
    Date.parse(boundedCanaryDiag.coverage.canary.complete_since) > Date.parse(boundedCanaryDiag.coverage.canary.oldest_retained_started_at),
    "coverage start must be strictly later than the oldest retained canary after eviction to avoid same-millisecond ambiguity"
  );
  assert.equal(
    boundedCanaryDiag.stages.MCP_REACHED.write_total,
    boundedCanaryDiag.stages.MCP_EXECUTED.write_total + boundedCanaryDiag.stages.MCP_REJECTED.write_total + boundedCanaryDiag.stages.MCP_IN_FLIGHT.write_total,
    "write dispatch conservation broke after bounded canary churn"
  );

  assert.match(SESSION_NOT_FOUND_MESSAGE, /reconnect or open a new chat/i);
  assert.match(SESSION_NOT_FOUND_MESSAGE, /only if the public MCP contract version\/hash changed/i);
  assert.doesNotMatch(SESSION_NOT_FOUND_MESSAGE, /refresh connector and open a new chat/i);

  console.log(`chatgpt-action-contract: ok (${Object.keys(expected).length} critical actions locked; apply_patch removal blocked; dispatch terminal states conserved)`);
} finally {
  await fullServer?.close().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  setDefaultCwd(oldCwd);
  setWorkspaceRoots(oldRoots);
  if (oldProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
  else process.env.CHATGPT_TOOL_PROFILE = oldProfile;
  for (const [key, value] of Object.entries(oldRuntimeEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(temp, { recursive: true, force: true });
}
