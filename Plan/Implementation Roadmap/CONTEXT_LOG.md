# CONTEXT_LOG — chatgpt-local-coder

## TX-2026-08-09-02 — why session initialize churn mattered

### Why
Live telemetry added for MCP sessions made a hidden lifecycle problem visible: ChatGPT/openai-mcp frequently establishes a fresh Streamable-HTTP transport session, nearly one per tool call in the observed workload. That client behavior is not itself a model-context reset, but the server retained every session for 24h, and each retained a complete `McpServer` + tool registry + upstream-manager registration. Live state reached 1013 sessions and >500MB working set.

### Key decisions
- **Bound retention, do not fake reuse:** final defaults 2m idle TTL / 15s sweep / 64 hard cap after measuring ~6.3 initializes/minute. Never merge by IP/User-Agent because parallel agents/chats must remain isolated.
- **Busy sessions are authority:** SSE-connected or op-chain/in-flight sessions cannot be TTL/cap evicted. Stale POST IDs remain recoverable.
- **One instruction document:** `instructionContext.instructionsText` is already the complete initialize instruction payload; do not wrap it again.
- **Tool readiness is part of initialize correctness:** await proxy-tool registration before session exposure; shared upstream MCP connections/cache remain global.
- **Session ID is credential-like:** retain full ID only internally for routing/recovery. Admin APIs/SSE and console/file logs expose short IDs only.
- **Telemetry should be cheap:** successful `/health` probes do not enter `server.log`; duplicate initialize console output removed; dashboard polls session state only while visible and never overlaps a prior poll.

### Context/agent-quality interpretation
- MCP session lifecycle is transport state, not LLM conversation history. Frequent initialize therefore does not directly erase chat context.
- Initialize does retransmit server instructions, so churn creates real CPU/network/parsing overhead; before this audit it also retransmitted a double-wrapped instruction document.
- Do not overstate connector internals: there is no evidence that every initialize instruction payload is appended as a new model conversation turn.
- Repo-specific quality is instead governed by the selected workspace/project context. The live default instance currently points at broad `E:\` (`git.is_repo=false`), so important repo work should explicitly call `project_context(repo)` or use a dedicated project instance.

## TX-2026-08-09-02 Fix 1 — manager env-injection staleness

### Why
The audit-log per-instance isolation fix (`audit.ts` resolves relative `AUDIT_LOG_PATH` against `MCP_ENV_FILE` dir) did not take effect on the live instance: `agent_status.audit_log` reported the repo-root path even though the instance `.env` had `AUDIT_LOG_PATH=.mcp-audit.log`.

### Root cause
The manager process (PID 17072) had been started at 04:00 — **before** the `startServer` env-injection change was written. Node keeps the loaded module code in memory, so the running manager spawned instances with the OLD `spawnDetached` env (no `AUDIT_LOG_PATH`/`MCP_ENV_FILE`). The on-disk `startServer → readInstanceEnv → spawnDetached({...env, MCP_ENV_FILE})` flow is correct; the live manager was simply stale.

### Key decisions
- **Restart, don't edit:** the advisory correctly identified the on-disk flow would necessarily work, so the fix was restarting :3300 from current `manager/server.mjs` (via `manager.bat`) and explicitly stop/start the instance — no code change needed.
- **Auto-start does not refresh a running instance:** `startServer` returns `alreadyRunning` when port 3000 is occupied; an explicit stop (graceful admin shutdown, port free) then start was required.
- **Verification via `agent_status.audit_log`:** this is the authoritative in-process audit path (`getAuditPath()`), not `Get-Process.StartInfo` (launch config, not readback).
- **Fresh manager pid 54744, fresh instance pid 55452:** audit writes now land in `manager/instances/default/.mcp-audit.log`; root `.mcp-audit.log` frozen at old pid 31604.

### Security note
`OPENAI_TUNNEL_API_KEY` value is present in instance `.env` (gitignored) and appeared in session transcripts during diagnostics. Not found in git history via `git log -S` fragment search; full sweep pending. Rotation recommended.

## TX-2026-08-08-01 — MCP session op-chain deadlock fix

### Why
The per-session op chain serialized every MCP request. The SSE GET (`transport.handleRequest` → hono write loop) stays pending for the stream lifetime, so any queued DELETE (needing `transport.close()` to close the stream) or POST waited behind it indefinitely — sessions could never be deleted/closed while an SSE was open.

### Key decisions
- **GET only bypasses the chain** (`bypassQueue=true` from `handleMcpGet`): the SDK itself rejects a 2nd concurrent standalone GET with 409, so GET needs no serialization; Express 409 is the fast-path guard.
- **DELETE stays on the chain**: `close()` must run after any in-flight POST so SDK `close()` (which clears `_streamMapping`/`_requestResponseMap`) cannot strand an `enableJsonResponse` POST response promise.
- **POSTs stay serialized** (unchanged).
- **Undici caveat**: `getReader().closed` doesn't resolve for an empty chunked SSE ended by the server; the regression uses bounded read-to-completion (`read()` until `done`). Curl/Bun observe the close correctly — server-side behavior is sound.
- **Admin UI proxy fixed client-side** (`public/ui/app.js` `API_BASE`/`?instance=`), not manager-wide `/api/*` proxying (advisory constraint).

### Decisions deferred / not taken
- No `res.destroyed`/`writableEnded` abort-guard on the GET op (superseded by the 409 fast-path).
- Structured `Plan/` scaffolding: LIGHTWEIGHT per `cross-project-delivery`; minimal mandated records created per project CLAUDE.md.
