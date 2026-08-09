# CONTEXT_LOG — chatgpt-local-coder



## TX-2026-08-09-03-R3 — round 3 audit: secret masking, activity redaction, session build leaks, runner parity (SHIPPED `5521ceb` + `4a4537f`)

### Why
Round 3 asked: audit thoroughly, fix every logic/perf/optimization gap, eliminate drift, ship. Three reviewer reports (core-server, manager/UI, scripts/harness) were collected and triaged against the actual code before any change.

### Key decisions
- **Manager env leak = generic sentinel round-trip, not tunnel-key special-casing.** `SECRET_KEY_RE` masks every secret key on the wire (covers `ADMIN_TOKEN`); `saveInstanceEnv` restores every `KEY=********` line from the original parsed `.env` on both raw and values paths. Raw editor stays power-user but is populated from masked values.
- **Upstream masking covers EVERY response path** (GET/PUT/POST/DELETE/imports) with one helper + sentinel-merge on write — `updateConfig`/`upsertServer` REPLACE (no internal merge), so an echoed sentinel would otherwise persist as the real secret.
- **Activity redaction at the API boundary** (JSON/history/SSE uniformly), not only at write time; audit FILE stays raw by design (local disk).
- **Hoist with definite-assignment assertion** (`let transport!: …`, `let mcpServer: McpServer | undefined`) over `| undefined` (7 TS closure errors) and over reverting (catch needs `transport?.sessionId`). Shutdown-branch callback unregisters before close (idempotent `Set.delete`).
- **Test seam for the leak:** `SessionManagerConfig.createMcpServerOverride` + `McpUpstreamManager.getRegisteredServerCount()` — the regression drives the real `createNew` path (real upstream singleton) with a failing `connect()`, asserting unregister + the server `close()` ran. The server object is a lightweight stand-in injected via the override (it registers with the real singleton like server-factory does), not a full `McpServer`; the close-fallback path (`server.close()` rejecting) is not exercised by the test.
- **Runner parity:** `npm test` and `run-all-tests.mjs` both run all 12 unit scripts (was drifted: `test:all` lacked `test-mcp-upstream`/`test-manager-log-utils`; `npm test` lacked `test-manager-env-redaction`).
- **False-green exit: NOT modified** (advisory-corrected) — `run-all-tests.mjs` has only `finally`, no `catch`; a failing unit already propagates nonzero exit.

### Evidence
- `npm run build` → tsc clean; `node --check` clean on all changed JS.
- `set -o pipefail; node scripts/run-all-tests.mjs` → **ALL TESTS PASSED**, `SUITE_EXIT=0` (12 unit + 15 integration).
- Leak test standalone: `3 passed, 0 failed`.
- Live post-restart: instance **2640** (:3000/:3001, health ok), manager **31400** (:3300). Env endpoint masks tunnel key `{set,last4}` + `ADMIN_TOKEN` sentinel, 0 plaintext `sk-`; activity JSON metadata-only.
- Commits `5521ceb` + `4a4537f` on `main`, pushed `a20a865..4a4537f` to `origin/main`.

## TX-2026-08-09-03 — cap-race fix, 429 mapping, manager start validation (SHIPPED `8bb68e2`)

### Why
The audit's cap-race fix and the manager restart surfaced two further correctness gaps that shipped in `8bb68e2`:
- `reserveBuildSlot()` originally only trimmed published sessions (`trimSessionCapacity(1)`); concurrent initializes (build runs outside any op-queue) could all pass admission before publish and exceed `MCP_MAX_SESSIONS`. The first repair counted in-flight but still let the 65th build through when 0 published + 64 in-flight (`trimSessionCapacity(65)` clamps target to 0 and returns true).
- Over-cap requests surfaced as HTTP 500 via the generic catch — client could not distinguish "over-cap, retry later" from a server fault.
- `startServer` (manager) wrote invalid session-policy values to `.env` unchanged; the spawned server silently ran with process defaults while the UI kept showing the saved value.

### Key decisions
- **Exact admission = published + in-flight ≤ MAX.** `reserveBuildSlot()` hard-rejects when `inFlightBuilds >= MAX` (no eviction possible), else trims to `MAX - (inFlightBuilds + 1)` and requires `published + inFlight + 1 <= MAX` before incrementing. Reservation is held until **publish** (`onsessioninitialized`), shutdown-publish, `disposePendingSession`, or build failure — never at `buildSession` return (initialize dispatch happens after return).
- **Transport-keyed `WeakMap` releaser** (`transportReservationReleases`) — keying a `Map` by `sid ?? randomUUID()` would leak because `transport.sessionId` is unset at build return on normal initializes, so the random key never matches the later SDK-generated sid.
- **Over-cap = deliberate HTTP 429** (JSON-RPC `-32029`) via a typed `SessionCapacityError`, mapped in `handleMcpPost` before the generic 500. Deterministic test fills the cap with connected (non-evictable) sessions, asserts next initialize is exactly 429.
- **Manager start validation:** `startServer` refuses to start on out-of-range policy instead of running with a hidden default.
- **Manager restart was required for the validation fix to be live** (Node keeps the loaded module in memory): stopped old manager 54744, started current `server.mjs`, which auto-started the instance (new pids 57452 / 56536). Verified health + policy + tunnel + audit writes under new pids.

### Evidence
- Full suite post-fix: `set -o pipefail; node scripts/run-all-tests.mjs` → **15 passed, 0 failed** (`SUITE_EXIT=0`), integration spawns with `MCP_MAX_SESSIONS=8`; parallel test `16 ok / 0 over-cap` (16 ≤ cap+8, idles evicted) and deterministic `held 8 connected → next initialize → 429, retained 8/8`.
- Reviewer subagents (core-server, manager/UI) found no blockers; two priority-2 findings fixed (`.env.example` missing `MCP_SESSION_DELETE_GRACE_MS`; startServer validation), others weighed and noted (audit-path nit was a false positive; `apiUrl` redundancy not a bug; `MCP_INSTANCE_NAME` dead-but-harmless).
- Commit `8bb68e2` on `main`, pushed `44c29e5..8bb68e2` to `origin/main`.

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
