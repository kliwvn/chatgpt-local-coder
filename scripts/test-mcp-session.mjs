/**
 * Integration test: MCP session init, tool call, stale-session recovery.
 * Requires server running on PORT (default 3000).
 */
const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function mcpPost(path, body, sessionId, extraHeaders = {}, method = "POST") {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const init = { method, headers };
  if (method === "POST") init.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

async function initialize(path = "/mcp") {
  const { status, headers, json } = await mcpPost(
    path,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-mcp-session", version: "1.0.0" },
      },
    },
    null
  );

  if (status !== 200) throw new Error(`initialize HTTP ${status}: ${JSON.stringify(json)}`);
  const sessionId = headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing mcp-session-id header");
  return { sessionId, json };
}

await run("health endpoint", async () => {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== "ok") throw new Error(JSON.stringify(data));
});

const ADMIN = parseInt(process.env.ADMIN_PORT || String(PORT + 1), 10);
const ADMIN_BASE = `http://127.0.0.1:${ADMIN}`;

async function adminSessions() {
  const res = await fetch(`${ADMIN_BASE}/api/sessions`);
  if (!res.ok) throw new Error(`admin /api/sessions HTTP ${res.status}`);
  return res.json();
}

async function waitForSessionGone(rawSessionId, timeoutMs = 1500) {
  const prefix = rawSessionId.slice(0, 8);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await adminSessions();
    if (!data.sessions.some((x) => x.shortId.startsWith(prefix))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}


let sessionId;
await run("initialize session on /mcp", async () => {
  const out = await initialize("/mcp");
  sessionId = out.sessionId;
  const instructions = out.json?.result?.instructions;
  if (typeof instructions !== "string" || instructions.length === 0) {
    throw new Error("initialize response missing server instructions");
  }
  const headerCount = (instructions.match(/^# Codex Local Coder MCP$/gm) || []).length;
  if (headerCount !== 1) {
    throw new Error(`server instructions wrapped ${headerCount} times; expected exactly once`);
  }
});

await run("admin /api/sessions lists redacted session", async () => {
  const data = await adminSessions();
  if (!data.ok || data.total < 1 || data.sessions.length !== data.total) {
    throw new Error(`unexpected ${JSON.stringify(data)}`);
  }
  const s = data.sessions.find((x) => x.shortId.startsWith(sessionId.slice(0, 8)));
  if (!s) throw new Error("session not listed");
  if (s.shortId.includes(sessionId.slice(8)) || s.shortId.length > 9) {
    throw new Error(`shortId leaks raw id: ${s.shortId}`);
  }
  if (s.status !== "registered") throw new Error(`expected registered, got ${s.status}`);
  if (s.connected) throw new Error(`expected connected=false right after initialize, got ${JSON.stringify(s)}`);
  if (data.sessions.some((x) => x.id || (x.sid && x.sid !== x.shortId))) {
    throw new Error("raw session id leaked");
  }
});
await run("SSE GET marks session connected, close clears it", async () => {
  // Mở SSE stream: đây là kết nối bền duy nhất — session phải chuyển connected=true.
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/mcp`, {
    headers: {
      Accept: "text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    signal: ac.signal,
  });
  if (sse.status !== 200) throw new Error(`SSE GET HTTP ${sse.status}`);
  const reader = sse.body.getReader();
  // Chờ một chút để server kịp ghi nhận stream đang mở.
  await new Promise((r) => setTimeout(r, 150));
  let data = await adminSessions();
  let s = data.sessions.find((x) => x.shortId.startsWith(sessionId.slice(0, 8)));
  if (!s || !s.connected) {
    throw new Error(`expected connected=true while SSE open, got ${JSON.stringify(s)}`);
  }
  if (data.connected < 1) throw new Error(`expected connected count >= 1, got ${data.connected}`);

  // Đóng stream (client ngắt) — connected phải quay về false.
  ac.abort();
  try {
    await reader.closed;
  } catch {
    // abort làm reader reject — OK
  }
  await new Promise((r) => setTimeout(r, 200));
  data = await adminSessions();
  s = data.sessions.find((x) => x.shortId.startsWith(sessionId.slice(0, 8)));
  if (s && s.connected) throw new Error(`expected connected=false after SSE close, got ${JSON.stringify(s)}`);
});
await run("concurrent GET: 2nd GET gets 409, session stays connected", async () => {
  // Server chặn GET thứ 2 ngay tại Express layer (409, trước enqueueSessionOp)
  // để nó không xếp hàng sau stream đang mở — nếu xếp hàng rồi client abort,
  // op sẽ stream vào socket chết và kẹt vĩnh viễn hàng đợi của session.
  const ac1 = new AbortController();
  const sse1 = await fetch(`${BASE}/mcp`, {
    headers: { Accept: "text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" },
    signal: ac1.signal,
  });
  if (sse1.status !== 200) throw new Error(`first SSE GET HTTP ${sse1.status}`);
  await new Promise((r) => setTimeout(r, 150));
  let data = await adminSessions();
  let s = data.sessions.find((x) => x.shortId.startsWith(sessionId.slice(0, 8)));
  if (!s || !s.connected) {
    throw new Error(`expected connected after first SSE open, got ${JSON.stringify(s)}`);
  }

  // GET thứ 2 — phải bị từ chối ngay lập tức với 409 (response hữu hạn).
  const sse2 = await fetch(`${BASE}/mcp`, {
    headers: { Accept: "text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" },
  });
  const sse2Status = sse2.status;
  await sse2.text();
  if (sse2Status !== 409) throw new Error(`expected 409 for 2nd SSE GET, got ${sse2Status}`);
  await new Promise((r) => setTimeout(r, 150));

  // SSE1 vẫn đang mở — connected phải còn true (GET 409 không ghi ref nào).
  data = await adminSessions();
  s = data.sessions.find((x) => x.shortId.startsWith(sessionId.slice(0, 8)));
  if (!s || !s.connected) {
    throw new Error(`expected still connected after 409, got ${JSON.stringify(s)}`);
  }

  // Đóng SSE1 — connected phải về false, không còn ref nào.
  ac1.abort();
  try {
    await sse1.body.getReader().closed;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
  data = await adminSessions();
  s = data.sessions.find((x) => x.shortId.startsWith(sessionId.slice(0, 8)));
  if (s && s.connected) {
    throw new Error(`expected disconnected after closing SSE1, got ${JSON.stringify(s)}`);
  }
});


await run("tools/list with valid session", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (!json?.result?.tools?.some((t) => t.name === "run_command")) {
    throw new Error("run_command not in tools/list");
  }
});

await run("sessionless tool call is rejected and settles dispatch diagnostics", async () => {
  const beforeRes = await fetch(`${BASE}/health`);
  if (!beforeRes.ok) throw new Error(`health before HTTP ${beforeRes.status}`);
  const before = await beforeRes.json();
  const beforeStages = before.mcpDispatch?.stages;
  if (!beforeStages?.MCP_REJECTED || !beforeStages?.MCP_IN_FLIGHT) {
    throw new Error(`missing dispatch rejection diagnostics: ${JSON.stringify(before.mcpDispatch)}`);
  }

  const body = {
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: { name: "run_command", arguments: { command: "echo must-not-run-without-session" } },
  };
  const { status, json } = await mcpPost(
    "/mcp",
    body,
    null,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 400) throw new Error(`expected HTTP 400, got ${status}: ${JSON.stringify(json)}`);

  const afterRes = await fetch(`${BASE}/health`);
  if (!afterRes.ok) throw new Error(`health after HTTP ${afterRes.status}`);
  const after = await afterRes.json();
  const afterStages = after.mcpDispatch?.stages;
  if (afterStages.MCP_REACHED.write_total !== beforeStages.MCP_REACHED.write_total + 1) {
    throw new Error("sessionless write-like call did not increment MCP_REACHED.write_total exactly once");
  }
  if (afterStages.MCP_REJECTED.write_total !== beforeStages.MCP_REJECTED.write_total + 1) {
    throw new Error("sessionless write-like call did not increment MCP_REJECTED.write_total exactly once");
  }
  if (afterStages.MCP_REJECTED.last_reason !== "MISSING_SESSION_ID") {
    throw new Error(`unexpected rejection reason: ${afterStages.MCP_REJECTED.last_reason}`);
  }
  if (afterStages.MCP_REJECTED.last_write_reason !== "MISSING_SESSION_ID") {
    throw new Error(`unexpected write rejection reason: ${afterStages.MCP_REJECTED.last_write_reason}`);
  }
  if (afterStages.MCP_REJECTED.reasons?.MISSING_SESSION_ID !== beforeStages.MCP_REJECTED.reasons?.MISSING_SESSION_ID + 1) {
    throw new Error("sessionless call did not increment the MISSING_SESSION_ID reason counter exactly once");
  }
  if (afterStages.MCP_IN_FLIGHT.write_total !== beforeStages.MCP_IN_FLIGHT.write_total) {
    throw new Error("sessionless rejected call leaked into MCP_IN_FLIGHT");
  }
});

await run("stale session auto-recovery", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000099";
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "run_command", arguments: { command: "echo stale-test" } },
    },
    fakeId,
    { "mcp-protocol-version": "2025-03-26" }
  );

  if (status !== 200) {
    throw new Error(`expected recovery HTTP 200, got ${status}: ${JSON.stringify(json)}`);
  }
  if (!json?.result) throw new Error(`recovery missing result: ${JSON.stringify(json)}`);
});

await run("re-initialize with stale session header", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000088";
  const { status, headers, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-reinit", version: "1.0.0" },
      },
    },
    fakeId
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const newSession = headers.get("mcp-session-id");
  if (!newSession) throw new Error("missing new session id");
  sessionId = newSession;
});

await run("run_command after re-init", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "run_command",
        arguments: { command: process.platform === "win32" ? "echo mcp-ok" : "echo mcp-ok" },
      },
    },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const text = JSON.stringify(json?.result ?? json);
  if (!text.includes("mcp-ok") && !json?.result?.content) {
    throw new Error(`unexpected result: ${text.slice(0, 300)}`);
  }
});
await run("explicit DELETE disposes session promptly after op drain", async () => {
  const out = await initialize("/mcp");
  const { status } = await mcpPost("/mcp", undefined, out.sessionId, {}, "DELETE");
  if (status !== 200) throw new Error(`DELETE HTTP ${status}`);
  if (!(await waitForSessionGone(out.sessionId))) {
    throw new Error("explicit DELETE retained session instead of disposing after serialized op drain");
  }
});
await run("POST tools/list succeeds while SSE open (GET not in op queue)", async () => {
  // GET (SSE) chạy ngoài hàng đợi op của session → POST ngắn không phải chờ stream.
  const out = await initialize("/mcp");
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/mcp`, {
    headers: { Accept: "text/event-stream", "mcp-session-id": out.sessionId, "mcp-protocol-version": "2025-03-26" },
    signal: ac.signal,
  });
  if (sse.status !== 200) throw new Error(`SSE HTTP ${sse.status}`);
  await new Promise((r) => setTimeout(r, 100));

  // POST phải trả bounded response (không chờ sau stream), có timeout bảo vệ.
  const result = await Promise.race([
    (async () => {
      const r = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": out.sessionId,
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list", params: {} }),
      });
      const j = await r.json();
      return { status: r.status, hasTools: !!j?.result?.tools, hasRunCommand: j?.result?.tools?.some((t) => t.name === "run_command") };
    })(),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 8000)),
  ]);
  if (result.timeout) throw new Error("POST tools/list hung while SSE open");
  if (result.status !== 200 || !result.hasTools || !result.hasRunCommand) {
    throw new Error(`POST while SSE open failed: ${JSON.stringify(result)}`);
  }

  // SSE vẫn mở sau POST — connected phải còn true.
  const data = await adminSessions();
  const s = data.sessions.find((x) => x.shortId.startsWith(out.sessionId.slice(0, 8)));
  if (!s || !s.connected) throw new Error(`SSE lost after POST, got ${JSON.stringify(s)}`);
  ac.abort();
  try { await sse.body.getReader().closed; } catch {}
});

await run("DELETE returns 200 and closes open SSE (not queued behind stream)", async () => {
  const out = await initialize("/mcp");
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/mcp`, {
    headers: { Accept: "text/event-stream", "mcp-session-id": out.sessionId, "mcp-protocol-version": "2025-03-26" },
    signal: ac.signal,
  });
  if (sse.status !== 200) throw new Error(`SSE HTTP ${sse.status}`);
  await new Promise((r) => setTimeout(r, 100));
  const reader = sse.body.getReader();
  // Đọc tới khi stream kết thúc (done) — không dựa vào getReader().closed,
  // vì undici có thể không resolve promise đó cho chunked response rỗng.
  const drain = (async () => {
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return true;
      }
    } catch {
      return true;
    }
  })();

  // DELETE phải trả 200 nhanh và làm SSE đóng (transport.close()).
  const result = await Promise.race([
    (async () => {
      const r = await fetch(`${BASE}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": out.sessionId, "mcp-protocol-version": "2025-03-26" },
      });
      return { status: r.status };
    })(),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 8000)),
  ]);
  if (result.timeout) throw new Error("DELETE hung while SSE open");
  if (result.status !== 200) throw new Error(`DELETE while SSE open HTTP ${result.status}`);

  const closed = await Promise.race([
    drain,
    new Promise((res) => setTimeout(() => res(false), 5000)),
  ]);
  if (!closed) throw new Error("SSE stream did not close after DELETE");
  const data = await adminSessions();
  const s = data.sessions.find((x) => x.shortId.startsWith(out.sessionId.slice(0, 8)));
  if (s?.connected) throw new Error(`expected disconnected/removed after DELETE, got ${JSON.stringify(s)}`);
  if (!(await waitForSessionGone(out.sessionId))) throw new Error("DELETE closed SSE but retained session");
  ac.abort();
});

await run("DELETE waits for in-flight POST then closes (op chain serialized)", async () => {
  // DELETE ở trên hàng đợi op → chờ POST đang chạy xong (enableJsonResponse
  // resolve xong) rồi mới close() — không được đua làm strand response promise.
  const out = await initialize("/mcp");
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/mcp`, {
    headers: { Accept: "text/event-stream", "mcp-session-id": out.sessionId, "mcp-protocol-version": "2025-03-26" },
    signal: ac.signal,
  });
  if (sse.status !== 200) throw new Error(`SSE HTTP ${sse.status}`);
  await new Promise((r) => setTimeout(r, 100));
  const reader = sse.body.getReader();
  const drain = (async () => {
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return true;
      }
    } catch {
      return true;
    }
  })();

  // POST tools/call chạy lệnh chậm ~2s, không await — DELETE bắn ngay sau,
  // phải chờ POST xong (enableJsonResponse resolve) rồi mới close().
  // Command phải là lệnh sleep hợp lệ cho cả Windows (PowerShell) và
  // non-Windows (bash): nếu lệnh fail nhanh, exit_code != 0 và HTTP vẫn 200
  // → assertion dưới sẽ bắt được, không thể pass mà không chạy thật.
  const slowCommand =
    process.platform === "win32"
      ? "Start-Sleep -Seconds 2; Write-Output slow-sleep-done"
      : "sleep 2 && echo slow-sleep-done";
  const postStarted = Date.now();
  const slowPost = fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": out.sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "run_command", arguments: { command: slowCommand } },
    }),
  });
  await new Promise((r) => setTimeout(r, 100));
  const result = await Promise.race([
    (async () => {
      const r = await fetch(`${BASE}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": out.sessionId, "mcp-protocol-version": "2025-03-26" },
      });
      return { status: r.status };
    })(),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 12000)),
  ]);
  if (result.timeout) throw new Error("DELETE hung behind in-flight POST");
  if (result.status !== 200) throw new Error(`DELETE after in-flight POST HTTP ${result.status}`);

  const post = await Promise.race([
    slowPost,
    new Promise((res) => setTimeout(() => res({ timeout: true }), 12000)),
  ]);
  if (post.timeout) throw new Error("slow POST stranded by DELETE (close raced response promise)");
  if (post.status !== 200) throw new Error(`slow POST HTTP ${post.status}`);

  // Tool result phải thực sự thành công (exit 0, không phải lỗi) — nếu command
  // không chạy được (vd. Start-Sleep không tồn tại trên bash), ok=false và
  // assertion này fail dù HTTP là 200. Đồng thời yêu cầu thời gian thực thi
  // ≥1.5s: nếu lệnh fail tức thì, elapsed < 1.5s → test fail.
  const postJson = await post.json();
  const sc = postJson?.result?.structuredContent;
  if (!sc || sc.ok !== true) {
    throw new Error(`slow POST tool result not ok: ${JSON.stringify(postJson)?.slice(0, 300)}`);
  }
  if (sc.data?.exit_code !== 0) {
    throw new Error(`slow POST exit_code != 0: ${JSON.stringify(sc.data)?.slice(0, 300)}`);
  }
  const postElapsed = Date.now() - postStarted;
  if (postElapsed < 1500) {
    throw new Error(`slow POST did not actually sleep (elapsed ${postElapsed}ms < 1500ms)`);
  }
  if (sc.data?.stdout && !String(sc.data.stdout).includes("slow-sleep-done")) {
    throw new Error(`slow POST stdout missing marker: ${JSON.stringify(sc.data.stdout)}`);
  }

  const closed = await Promise.race([
    drain,
    new Promise((res) => setTimeout(() => res(false), 5000)),
  ]);
  if (!closed) throw new Error("SSE stream did not close after DELETE (in-flight POST case)");
  if (!(await waitForSessionGone(out.sessionId))) {
    throw new Error("DELETE waited for slow POST but retained session after the op chain drained");
  }
  ac.abort();
});
await run("parallel initializes respect hard cap (bounded, no hang)", async () => {
  // Fire MORE initializes than the cap at once — phải ép admission chạy thật:
  // published + in-flight <= maxRetained. Mọi response phải hữu hạn (200 kèm
  // session id, hoặc 429 over-cap) — KHÔNG được treo, KHÔNG được 500. Retained
  // không được vượt cap.
  const before = await adminSessions();
  const max = before.policy?.max_retained;
  if (!Number.isInteger(max) || max < 1) throw new Error(`bad max_retained ${JSON.stringify(before.policy)}`);
  const total = max + 8; // vượt cap chắc chắn
  const batch = (async () =>
    Promise.all(
      Array.from({ length: total }, async () => {
        const res = await mcpPost(
          "/mcp",
          {
            jsonrpc: "2.0",
            id: 100,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "test-parallel-cap", version: "1.0.0" },
            },
          },
          null
        );
        return { status: res.status, sid: res.headers.get("mcp-session-id"), json: res.json };
      })
    ))();
  // Batch timeout: Promise.all tự nó có thể treo vô hạn — race với timeout.
  const results = await Promise.race([
    batch,
    new Promise((res) => setTimeout(() => res({ timeout: true }), 15000)),
  ]);
  if (results.timeout) throw new Error(`parallel initializes hung (batch > 15s)`);
  const bounded = results.filter((r) => r.status === 200 && r.sid).length;
  const rejected = results.filter((r) => r.status === 429).length;
  const unexpected = results.filter((r) => !((r.status === 200 && r.sid) || r.status === 429));
  if (bounded + rejected !== total) {
    throw new Error(
      `unexpected statuses: ${JSON.stringify(results.map((r) => r.status).slice(0, 20))} ` +
        `(${bounded} ok, ${rejected} 429, ${unexpected.length} unexpected of ${total})`
    );
  }
  if (bounded < 1) throw new Error(`expected at least one successful initialize, got ${bounded}`);
  // Mọi reject phải là 429 admission — không phải 500 (bug) hay timeout.
  if (unexpected.length) throw new Error(`over-cap returned non-429: ${JSON.stringify(unexpected.map((r) => r.status))}`);
  const after = await adminSessions();
  if (after.total > max) throw new Error(`retained ${after.total} > max ${max} after ${total} parallel initializes`);
  console.log(`     (parallel init: ${bounded} ok, ${rejected} over-cap 429, retained ${after.total}/${max})`);
});

await run("over-cap initialize rejected with exactly 429 when all sessions connected", async () => {
  // Deterministic: fill the cap with CONNECTED (non-evictable) sessions, then
  // the next initialize must be a hard 429 — proves the reserveBuildSlot reject
  // path and the index.ts SessionCapacityError → 429 mapping (not a 500).
  const max = (await adminSessions()).policy?.max_retained;
  if (!Number.isInteger(max) || max < 1) throw new Error(`bad max_retained ${JSON.stringify((await adminSessions()).policy)}`);
  const held = [];
  const acs = [];
  try {
    for (let i = 0; i < max; i++) {
      const { sessionId } = await initialize("/mcp");
      const ac = new AbortController();
      const sse = await fetch(`${BASE}/mcp`, {
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-03-26",
        },
        signal: ac.signal,
      });
      if (sse.status !== 200) throw new Error(`SSE GET for held session ${i} HTTP ${sse.status}`);
      acs.push(ac);
      held.push({ sessionId, sse });
      await new Promise((r) => setTimeout(r, 50)); // cho server kịp ghi nhận connected
    }
    const before = await adminSessions();
    if (before.connected < max) throw new Error(`expected ${max} connected held sessions, got ${before.connected}`);
    if (before.total !== max) throw new Error(`expected ${max} retained, got ${before.total}`);
    const res = await mcpPost(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 200,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-over-cap", version: "1.0.0" },
        },
      },
      null
    );
    if (res.status !== 429) {
      throw new Error(`expected exactly 429 over-cap, got HTTP ${res.status}: ${JSON.stringify(res.json)}`);
    }
    const after = await adminSessions();
    if (after.total > max) throw new Error(`retained ${after.total} > max ${max} after over-cap reject`);
    console.log(`     (over-cap: held ${max} connected, next initialize → 429, retained ${after.total}/${max})`);
  } finally {
    for (const ac of acs) ac.abort();
    await new Promise((r) => setTimeout(r, 200));
    for (const h of held) {
      try {
        await h.sse.body.getReader().closed;
      } catch {}
      await mcpPost("/mcp", undefined, h.sessionId, {}, "DELETE").catch(() => undefined);
    }
  }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);