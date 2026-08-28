import assert from "node:assert/strict";
import { appendActivity, getRecentActivity, logMcpHttpEvent, logMcpRequest, summarizeToolArgs } from "../dist/lib/activity-log.js";
import { classifyCommandOutcome, isGitGrepCommand } from "../dist/lib/command-outcome.js";

// summarizeToolArgs
assert.equal(summarizeToolArgs("run_command", { command: "npm test" }), "npm test");
assert.equal(summarizeToolArgs("read_text_file", { path: "C:\\foo.ts" }), "C:\\foo.ts");

// command semantics: git grep exit 1 means no-match; other non-zero exits fail
assert.equal(isGitGrepCommand('git grep -n -I -E "retry|RETRY" -- src | Select-Object -First 20'), true);
assert.equal(isGitGrepCommand('git -C "C:\\repo" grep foo -- src'), true);
assert.equal(isGitGrepCommand("pytest -q"), false);
assert.equal(classifyCommandOutcome("git grep impossible-pattern -- src", 1, ""), "no_match");
assert.equal(classifyCommandOutcome("git grep impossible-pattern -- src", 128, "fatal"), "failed");
assert.equal(classifyCommandOutcome("pytest -q", 1, "1 failed"), "failed");
assert.equal(classifyCommandOutcome("npm test", null, "", true), "timed_out");

// console taxonomy: command/business failures are not MCP transport failures
const warnLines = [];
const originalWarn = console.warn;
console.warn = (...args) => warnLines.push(args.join(" "));
try {
  appendActivity({
    kind: "tool",
    tool: "run_command",
    target: "C:\\repo",
    status: "error",
    summary: "pytest -q",
    details: { exit_code: 1, command_outcome: "failed" },
  });
  appendActivity({ kind: "tool", tool: "mcp_call", status: "error", summary: "upstream rejected" });
  appendActivity({ kind: "mcp", action: "POST /mcp", status: "error", summary: "transport failed" });
} finally {
  console.warn = originalWarn;
}
assert.match(warnLines[0], /\[COMMAND FAILED\]/);
assert.match(warnLines[0], /exit=1/);
assert.match(warnLines[0], /cwd=C:\\repo/);
assert.doesNotMatch(warnLines[0], /\[MCP ERROR\]/);
assert.match(warnLines[1], /\[TOOL FAILED\]/);
assert.match(warnLines[2], /\[MCP ERROR\]/);

const timeoutLines = [];
const originalTimeoutWarn = console.warn;
console.warn = (...args) => timeoutLines.push(args.join(" "));
try {
  appendActivity({
    kind: "tool",
    tool: "run_command",
    target: "C:\\repo",
    status: "error",
    summary: "sync response budget exhausted",
    details: { exit_code: null, command_outcome: "timed_out" },
  });
} finally {
  console.warn = originalTimeoutWarn;
}
assert.equal(timeoutLines.length, 1);
assert.match(timeoutLines[0], /\[COMMAND TIMED OUT\]/);
assert.doesNotMatch(timeoutLines[0], /\[COMMAND FAILED\]|\[MCP ERROR\]/);

const noMatchLines = [];
const originalNoMatchLog = console.log;
console.log = (...args) => noMatchLines.push(args.join(" "));
try {
  appendActivity({
    kind: "tool",
    tool: "run_command",
    target: "C:\\repo",
    status: "ok",
    summary: "git grep impossible-pattern -- src",
    details: { exit_code: 1, command_outcome: "no_match" },
  });
} finally {
  console.log = originalNoMatchLog;
}
assert.equal(noMatchLines.length, 1);
assert.match(noMatchLines[0], /\[COMMAND NO MATCH\]/);
assert.match(noMatchLines[0], /exit=1/);
// successful TOOL entry stays in activity but does not duplicate the MCP console line
const infoLines = [];
const originalLog = console.log;
console.log = (...args) => infoLines.push(args.join(" "));
try {
  appendActivity({ kind: "tool", tool: "grep", status: "ok", summary: "pattern: duplicate-check" });
} finally {
  console.log = originalLog;
}
assert.equal(infoLines.length, 0);
// append + retrieve
const before = getRecentActivity(500).length;
appendActivity({ kind: "tool", tool: "grep", status: "ok", summary: "pattern: foo" });
assert.equal(getRecentActivity(500).length, before + 1);
const latest = getRecentActivity(1)[0];
assert.equal(latest.tool, "grep");
assert.equal(latest.kind, "tool");

// logMcpRequest tools/call
logMcpRequest(
  { method: "tools/call", params: { name: "read_text_file", arguments: { path: "/tmp/x" } } },
  "sess-abc-123",
  42,
  200
);
const mcp = getRecentActivity(5).find((e) => e.kind === "mcp" && e.tool === "read_text_file");
assert.ok(mcp, "expected mcp tools/call entry");
assert.equal(mcp.client, "chatgpt");
assert.equal(mcp.duration_ms, 42);
assert.equal(mcp.summary, "/tmp/x");

// filter since
const all = getRecentActivity(500);
const since = all[1]?.id;
if (since) {
  const newer = getRecentActivity(500, since);
  assert.ok(newer.length < all.length);
}

// limit must still apply when polling incrementally with since=<id>
const incrementalMarker = getRecentActivity(1)[0].id;
for (let i = 0; i < 5; i++) {
  appendActivity({ kind: "tool", tool: "grep", status: "ok", summary: `incremental-${i}` });
}
const incremental = getRecentActivity(2, incrementalMarker);
assert.equal(incremental.length, 2);
assert.equal(incremental[0].summary, "incremental-4");
assert.equal(incremental[1].summary, "incremental-3");

// expected client-state errors should be warnings, not server errors
logMcpRequest(
  { method: "tools/list", params: {} },
  undefined,
  1,
  400,
  "Bad Request: Mcp-Session-Id header is required"
);
assert.equal(getRecentActivity(1)[0].status, "warn");
logMcpHttpEvent({
  method: "GET",
  path: "/mcp",
  httpStatus: 409,
  durationMs: 1,
  errorMessage: "Conflict: Only one SSE stream is allowed per session",
});
assert.equal(getRecentActivity(1)[0].status, "warn");
// error logging with message
logMcpRequest(
  { method: "tools/call", params: { name: "write_file", arguments: { path: "/x" } } },
  "sess-err",
  2,
  400,
  "Bad Request: Server not initialized"
);
const errEntry = getRecentActivity(3).find((e) => e.status === "error" && e.tool === "write_file");
assert.ok(errEntry, "expected error activity entry");
assert.equal(errEntry.summary, "Bad Request: Server not initialized");

console.log("activity-log: ok");