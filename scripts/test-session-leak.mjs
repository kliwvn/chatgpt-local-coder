// Targeted regression test for the buildSession resource-leak fix.
//
// buildSession() hoists `transport`/`mcpServer` so the catch can close and
// unregister them when createMcpServer succeeds but connect() fails (or
// shutdown flips mid-build). Before the fix, a connect() rejection leaked:
//   - the McpServer stayed registered in the upstream manager (never unregistered)
//   - the transport/server were never closed
//
// This test drives the REAL code path (createNew → buildSession) with a
// createMcpServerOverride that:
//   1. registers the server with the real upstream singleton (like server-factory)
//   2. returns a server whose connect() rejects
// and asserts the singleton's registered-server count returns to baseline and
// the server's close() was attempted.

import { createSessionManager } from "../dist/lib/mcp-session-manager.js";
import { getUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, detail) {
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

function fakeMcpServer(connectThrows) {
  let closed = 0;
  const transportLike = { close: async () => {} };
  const server = {
    server: { getClientVersion: () => undefined },
    connect: async () => {
      if (connectThrows) throw new Error("simulated connect failure");
    },
    close: async () => {
      closed++;
    },
  };
  return { server, transportLike, get closed() { return closed; } };
}

// Minimal express-like req/res. buildSession itself never touches them; the
// failing connect happens inside createNew's run() BEFORE handleRequest, so
// res is never used on the failure path (the throw propagates to createNew).
function fakeReqRes() {
  const res = {
    locals: {},
    status() { return this; },
    json() {},
  };
  return { req: { headers: {} }, res };
}

async function main() {
  const baseline = getUpstreamManager().getRegisteredServerCount();
  const fake = fakeMcpServer(true);
  const upstreamManager = getUpstreamManager();

  const manager = createSessionManager({
    workspaceRoot: process.cwd(),
    shellTimeout: 30,
    workspaceRoots: [process.cwd()],
    port: 3999,
    // Mirrors server-factory: registers with the real singleton before connect.
    createMcpServerOverride: async () => {
      upstreamManager.registerMcpServer(fake.server);
      return fake.server;
    },
  });

  const { req, res } = fakeReqRes();
  let threw = false;
  try {
    await manager.createNew(req, res, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "leak-test", version: "1" } },
    });
  } catch {
    threw = true;
  }

  if (!threw) fail("connect rejection propagates out of createNew", "createNew did not throw");
  else ok("connect rejection propagates out of createNew");

  // Allow the immediate setImmediate cleanup (shutdown branch) to settle.
  await new Promise((r) => setTimeout(r, 50));

  const after = upstreamManager.getRegisteredServerCount();
  if (after !== baseline) {
    fail("failed build unregisters server from upstream manager", `count ${baseline} -> ${after}`);
  } else {
    ok("failed build unregisters server from upstream manager");
  }

  if (fake.closed < 1) fail("failed build closes the server", `close() called ${fake.closed} times`);
  else if (fake.closed > 1) fail("failed build closes the server", `close() called ${fake.closed} times (expected exactly 1)`);
  else ok("failed build closes the server");

  // --- Shutdown-race path: createMcpServer resolves but shutdown flips before
  // --- onsessioninitialized. That timing cannot be driven deterministically
  // --- through the public API; the connect-failure path above is the
  // --- deterministic regression for the catch cleanup.

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("test-session-leak crashed:", err);
  process.exitCode = 1;
});
