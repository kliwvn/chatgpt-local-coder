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

import http from "node:http";
import {
  createSessionManager,
  isValidMcpSessionId,
  loopbackMcpPost,
  shouldLogSessionInitializeForClient,
} from "../dist/lib/mcp-session-manager.js";
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
  const samplingCases = [
    ["openai-mcp", 1, false],
    ["openai-mcp", 2, false],
    ["openai-mcp", 24, false],
    ["openai-mcp", 25, true],
    ["openai-mcp", 26, false],
    ["openai-mcp", 50, true],
    ["manager-warmup", 0, true],
    ["codex-mcp-session-recovery", 0, true],
  ];
  const samplingMismatch = samplingCases.find(
    ([name, count, expected]) => shouldLogSessionInitializeForClient(name, count) !== expected
  );
  if (samplingMismatch) {
    fail("session initialize sampling is client-local", JSON.stringify(samplingMismatch));
  } else {
    ok("session initialize sampling is client-local");
  }

  const sessionIdCases = [
    ["550e8400-e29b-41d4-a716-446655440000", true],
    ["__proto__", true],
    ["constructor", true],
    ["", false],
    ["contains space", false],
    ["line\nbreak", false],
    ["x".repeat(257), false],
    [["array-is-not-a-header-token"], false],
  ];
  const sessionIdMismatch = sessionIdCases.find(
    ([value, expected]) => isValidMcpSessionId(value) !== expected
  );
  if (sessionIdMismatch) fail("session ID validation is bounded/control-safe", JSON.stringify(sessionIdMismatch));
  else ok("session ID validation is bounded/control-safe");

  const prototypeProbeManager = createSessionManager({
    workspaceRoot: process.cwd(),
    shellTimeout: 30,
    workspaceRoots: [process.cwd()],
    port: 3997,
  });
  if (prototypeProbeManager.get("__proto__") !== undefined || prototypeProbeManager.get("constructor") !== undefined) {
    fail("wire session IDs cannot alias object prototype properties");
  } else {
    ok("wire session IDs cannot alias object prototype properties");
  }
  await prototypeProbeManager.shutdown();

  const hangingServer = http.createServer((_req, _res) => {
    // Intentionally never respond: recovery loopback must abort itself rather
    // than pinning recoveryInFlight/caller forever.
  });
  await new Promise((resolve, reject) => {
    hangingServer.once("error", reject);
    hangingServer.listen(0, "127.0.0.1", resolve);
  });
  const hangingPort = hangingServer.address().port;
  const started = Date.now();
  let timedOut = false;
  try {
    await loopbackMcpPost(
      hangingPort,
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      undefined,
      undefined,
      100
    );
  } catch (err) {
    timedOut = /loopback timed out after 100ms/i.test(String(err));
  } finally {
    await new Promise((resolve) => hangingServer.close(resolve));
  }
  const elapsed = Date.now() - started;
  if (!timedOut || elapsed > 2000) fail("recovery loopback is bounded", `timedOut=${timedOut} elapsed=${elapsed}ms`);
  else ok("recovery loopback is bounded");

  // A local wrong process can return headers and then stream forever. Recovery
  // does not need the response body, so it must stop draining after a small cap
  // instead of waiting for the global request timeout or allocating indefinitely.
  const streamingSockets = new Set();
  const streamingServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" });
    res.write(Buffer.alloc(96 * 1024, 0x61));
    // Deliberately do not end the response.
  });
  streamingServer.on("connection", (socket) => {
    streamingSockets.add(socket);
    socket.on("close", () => streamingSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    streamingServer.once("error", reject);
    streamingServer.listen(0, "127.0.0.1", resolve);
  });
  const streamingPort = streamingServer.address().port;
  const streamingStarted = Date.now();
  let streamingResult = null;
  let streamingError = null;
  try {
    streamingResult = await loopbackMcpPost(
      streamingPort,
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
      undefined,
      undefined,
      1500
    );
  } catch (err) {
    streamingError = err;
  } finally {
    for (const socket of streamingSockets) socket.destroy();
    await new Promise((resolve) => streamingServer.close(resolve));
  }
  const streamingElapsed = Date.now() - streamingStarted;
  if (streamingError || !streamingResult?.ok || streamingElapsed >= 1200) {
    fail(
      "recovery loopback stops draining oversized streaming bodies",
      `error=${String(streamingError || "")} status=${streamingResult?.status ?? "none"} elapsed=${streamingElapsed}ms`
    );
  } else {
    ok("recovery loopback stops draining oversized streaming bodies");
  }

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

  // --- handleRequest failure AFTER buildSession() returns but BEFORE the SDK
  // --- publishes onsessioninitialized. This used to leak the build reservation
  // --- and registered server because buildSession's catch no longer owned the
  // --- failure. A malformed response adapter gives us a deterministic failure
  // --- before publish without reaching into private manager state.
  let prePublishClosed = 0;
  const prePublishBaseline = upstreamManager.getRegisteredServerCount();
  const prePublishManager = createSessionManager({
    workspaceRoot: process.cwd(),
    shellTimeout: 30,
    workspaceRoots: [process.cwd()],
    port: 3998,
    createMcpServerOverride: async () => {
      const server = {
        server: { getClientVersion: () => undefined },
        connect: async () => {},
        close: async () => {
          prePublishClosed++;
        },
      };
      upstreamManager.registerMcpServer(server);
      return server;
    },
  });
  const badReq = { headers: {}, method: "POST" };
  const badRes = { locals: {}, headersSent: false, status() { return this; }, json() {} };
  let prePublishThrew = false;
  const originalConsoleError = console.error;
  try {
    // The intentionally malformed response adapter makes Hono print the expected
    // pre-publish TypeError before rejecting. Suppress only that fixture noise so
    // a green regression test cannot be mistaken for a production error in CI logs.
    console.error = () => {};
    await prePublishManager.createNew(badReq, badRes, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "prepublish-leak-test", version: "1" } },
    });
  } catch {
    prePublishThrew = true;
  } finally {
    console.error = originalConsoleError;
  }
  const prePublishCounts = prePublishManager.counts();
  if (!prePublishThrew) fail("pre-publish handleRequest rejection propagates", "createNew did not throw");
  else ok("pre-publish handleRequest rejection propagates");
  if (prePublishCounts.building !== 0 || prePublishCounts.registered !== 0) {
    fail(
      "pre-publish failure releases session reservation",
      `registered=${prePublishCounts.registered} building=${prePublishCounts.building}`
    );
  } else {
    ok("pre-publish failure releases session reservation");
  }
  const afterPrePublish = upstreamManager.getRegisteredServerCount();
  if (afterPrePublish !== prePublishBaseline) {
    fail("pre-publish failure unregisters server", `count ${prePublishBaseline} -> ${afterPrePublish}`);
  } else {
    ok("pre-publish failure unregisters server");
  }
  if (prePublishClosed !== 1) fail("pre-publish failure closes server once", `close() called ${prePublishClosed} times`);
  else ok("pre-publish failure closes server once");
  await prePublishManager.shutdown();

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
