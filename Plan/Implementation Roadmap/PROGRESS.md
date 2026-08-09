# PROGRESS — chatgpt-local-coder



## TX-2026-08-09-03-R3 — round 3 audit: secret masking, activity redaction, session build leaks, test-runner drift

### Status: SHIPPED — committed `5521ceb` + `4a4537f` on `main`, pushed to `origin/main`

### Findings triaged (reviewer reports)
- **REAL (fixed):** manager env endpoints returned plaintext `.env` to the browser (`OPENAI_TUNNEL_API_KEY`, `ADMIN_TOKEN`); upstream-config API echoed header/env secrets; activity feed shipped raw `details` (tool arguments/commands) at the API boundary; `buildSession` leaked `McpServer` + upstream registration when `connect()` failed; shutdown-branch callback closed without unregistering; test runners omitted real scripts (`test:all` lacked `test-mcp-upstream`/`test-manager-log-utils`; `npm test` lacked `test-manager-env-redaction`).
- **SKIP (by design/localhost trust, documented):** per-poll `spawnSync`, audit-file raw command lines, tunnel.log rotation, adminAuth non-constant-time + `0.0.0.0`/`::` acceptance, manager zero-auth, DELETE-grace log volume, audit fs-write batching.
- **FALSE POSITIVES (advisory-corrected):** "false-green exit" — `run-all-tests.mjs` has only `finally`, no `catch`; failures already exit nonzero. Do not modify.

### What changed (5521ceb)
- **Manager env leak closed:** GET `/api/instances/:name/env` + legacy `/api/env` return masked values only (`SECRET_KEY_RE` + sentinel `********`; tunnel key keeps `{set,last4}`). `saveInstanceEnv` restores every sentinel from the original `.env` on both raw and values paths. Raw editor (`manager/app.js`) is populated from masked values, never plaintext.
- **Admin routes:** `SENSITIVE_HEADER_NAMES`/`isSensitiveHeader`/`maskUpstreamConfig`/`restoreUpstreamSecrets` inside `createAdminRouter`; every `/api/upstream` response (GET/PUT/POST/DELETE/imports) masked; write paths restore sentinels before `updateConfig`/`upsertServer` (both REPLACE).
- **Activity-feed redaction at API boundary:** `/api/activity`, `/api/activity/history`, `/api/activity/stream` — metadata-only `details` (`{redacted:true}`/`{exit_code}`) + sanitized `summary` for tool entries; audit FILE stays raw by design.
- **DELETE-grace re-init (index.ts):** an initialize during DELETE grace disposes the closing session first instead of routing to the closed SDK transport (was HTTP 400 for the whole grace window).
- **clientInfo sanitization:** control chars stripped, name truncated to 120 / version 60, fallback `unknown` (log-injection defense).
- **`isSessionConnected` restored** to the `SessionManager` interface; `lastTransportErrors` cleanup in `buildSession` catch.
- **Docs drift:** `.env.example`/README add `WORKSPACE_PATHS`/`ALLOWED_WORKSPACE_PATHS`/`ACTIVITY_LOG_MAX`.
- **Regression test:** `scripts/test-manager-env-redaction.mjs` (both GET routes masked, sentinel round-trip preserves on-disk secrets), wired into `run-all-tests.mjs`.

### What changed (4a4537f — build-leak + runner parity)
- **`buildSession` leak fixed:** `mcpServer` hoisted alongside `transport`; catch closes server+transport AND unregisters from the upstream manager. Shutdown-branch callback unregisters before close (idempotent `Set.delete`).
- **Test seam:** `SessionManagerConfig.createMcpServerOverride`; `McpUpstreamManager.getRegisteredServerCount()`.
- **`scripts/test-session-leak.mjs`:** drives the real `createNew` path with a failing `connect()`; asserts the rejection propagates, the singleton count returns to baseline, and `close()` ran exactly once.
- **Runner parity:** both `npm test` and `run-all-tests.mjs` now run all 12 unit scripts (added `test-mcp-upstream`, `test-manager-log-utils`, `test-manager-env-redaction`, `test-session-leak`).

### Evidence
- `npm run build` → tsc clean.
- `set -o pipefail; node scripts/run-all-tests.mjs` → **ALL TESTS PASSED**, `SUITE_EXIT=0` (12 unit scripts + 15 integration).
- Leak test standalone: `3 passed, 0 failed`.
- `node --check manager/server.mjs` / `manager/app.js` / `scripts/test-session-leak.mjs` → clean.
- Live (post-restart): instance PID **2640** on :3000/:3001 (health `ok`), manager PID **31400** on :3300. Env endpoint: tunnel key `{set:true,last4:"JesA"}`, `ADMIN_TOKEN` sentinel, 0 plaintext `sk-`; activity JSON metadata-only.

## TX-2026-08-09-02 — session churn / performance / context-quality audit

### Status: SHIPPED — committed `8bb68e2` on `main`, pushed to `origin/main`

### Root causes found and fixed
- **Unbounded practical retention:** ChatGPT/openai-mcp creates transport sessions very aggressively (observed almost one initialize per tool call). With the old 24h TTL and unreliable client DELETE, live state reached **1013 retained sessions**, ~**529 MB working set / 583 MB private memory**. Final default retention is **2m idle TTL**, **15s cleanup**, **64 hard cap**; connected SSE and in-flight sessions are never evicted. Oldest idle sessions are reclaimed first and stale IDs still use the existing recovery path.
- **Instruction double-wrap:** the already-complete `instructionContext.instructionsText` was passed as if it were project-memory-only and wrapped again by `buildServerInstructions()`. Initialize now returns one instruction document/header only (live ≈8447 bytes), avoiding duplicate connector metadata and wire/parse overhead.
- **Proxy-tool readiness race:** `refreshProxiedTools()` was fire-and-forget, so `tools/list` immediately after initialize could miss proxy tools. `createMcpServer()` is async and awaits proxy registration before the session becomes usable; upstream transport/tool caches remain shared globally.
- **Noisy diagnostics:** successful `/health` polls are no longer access-logged; duplicate generic `session initialize` console lines are suppressed while the canonical line retains real `clientInfo`.
- **Session credential exposure:** `/api/activity`, history, activity SSE and console/server logs now expose only `8 chars + …`; raw MCP session UUIDs remain internal. `/api/sessions` was already redacted.
- **Stale dashboard telemetry:** session dashboard now refreshes every 5s only while visible, with a single-flight guard, and shows `active/max`, idle TTL and cleanup cadence.
- **Test-harness drift:** `run-all-tests.mjs` spawned a random admin port but forgot to pass `ADMIN_PORT` to `test-mcp-session.mjs`, causing false failures against live :3001. Fixed; integration again exercises the sandbox instance it spawned.

### This commit round (8bb68e2)
- **Cap admission race (real, verified in code):** `buildSession()` counted only *published* sessions at admission; concurrent initializes (build runs outside any op-queue) all passed `trimSessionCapacity(1)` before `onsessioninitialized` published → could exceed `MCP_MAX_SESSIONS=64`. `reserveBuildSlot()` now counts **published + in-flight**; hard-rejects when in-flight already fills the cap (no eviction possible), evicts idle sessions otherwise. Reservation held until publish (or shutdown/dispose/build-fail) via a transport-keyed `WeakMap` releaser.
- **Over-cap now deliberate HTTP 429:** `SessionCapacityError` maps to 429 (JSON-RPC `-32029`) instead of a generic 500, so clients can retry after over-cap.
- **Recovery leak closed:** `tryRecoverStale` disposes a built-but-unpublished pending session on failure; `disposePendingSession` is the single idempotent release point.
- **Manager start validation:** `startServer` refuses to start when the instance session policy is out of range, instead of silently running with process defaults while the UI shows the saved value.
- **Docs:** `.env.example`/README surface `MCP_SESSION_DELETE_GRACE_MS`, hard-cap semantics, per-instance audit-path isolation, log-viewer scope.
- **Tests:** deterministic over-cap test (fill cap with connected sessions → next initialize exactly 429); parallel-init cap test now actually exceeds the cap (no 48 clamp) with a batch timeout; integration spawns with `MCP_MAX_SESSIONS=8`; suite **15/15 green** (`SUITE_EXIT=0`).

### Evidence
- Earlier TX-02 live verification (pre-Fix-1): server PID **56052** after managed restart; health policy `maxRetained=64`, `idleTtlMs=120000`, `cleanupIntervalMs=15000`; measured ~**93.8 MB working set / 84.6 MB private memory** shortly after connector reconnect; log had **0 MCP errors, 0 tool errors, 0 recovery errors, 0 session-not-found, 0 capacity errors, 0 `/health` log spam, 0 UTF-8 replacement characters**.
- Live redaction probe: initialize → tools/list → Activity JSON/SSE; raw UUID absent, redacted `xxxxxxxx…` present; DELETE HTTP 200. Live `server.log` also contains only redacted session IDs.
- **Fix 1 (this follow-up):** manager restart required to pick up the env-injection fix. The stale manager (PID 17072, started 04:00 pre-edit) spawned instances without `AUDIT_LOG_PATH`/`MCP_ENV_FILE`, so audit wrote to repo root. After restarting the manager from current `server.mjs` and explicitly stop/start the instance: fresh PID **55452**, `agent_status.audit_log` = `manager/instances/default/.mcp-audit.log` (instance-scoped), audit writes verified to instance file, root audit frozen. Health policy consistent on all three surfaces (MCP :3000, admin :3001, manager :3300). Session integration 13/13 + unit suite green (`set -o pipefail; node scripts/run-all-tests.mjs` → `EXIT=0`).
- **This round live verification (post-commit restart):** stopped old instance + manager, restarted manager from current `server.mjs` (new pid **57452** on :3300), which auto-started the instance (new pid **56536** on :3000/:3001). Health `status:"ok"`, `activeSessions:4`, `sessionPolicy {maxRetained:64, idleTtlMs:120000, cleanupIntervalMs:15000}`, tunnel running (OpenAI). Audit log writes now under new pid; server.log shows fresh `Session initialized … client=manager-warmup … retained=1/64`.
- Full suite post-fix: `set -o pipefail; node scripts/run-all-tests.mjs` → **15 passed, 0 failed**, `SUITE_EXIT=0` (integration spawns with `MCP_MAX_SESSIONS=8`).

### Remaining / external behavior
- The connector still creates fresh MCP transport sessions very frequently; this is client behavior and is now bounded server-side. Do **not** merge sessions by IP/User-Agent because parallel chats/agents could cross-contaminate state.
- The default live instance uses broad workspace `E:\` (`git.is_repo=false`), so repo-specific AGENTS/CLAUDE context is not automatically loaded for every target repo. For quality-critical work, use `project_context(<repo>)` when entering a repo or a per-project MCP instance; do not inject every repo's memory into every initialize.
- **Credential-history status: UNVERIFIED** — `OPENAI_TUNNEL_API_KEY` value present in instance `.env` (gitignored); `git log -S <fragment>` found no committed value, but a full history sweep is not yet performed. Recommend rotation.

## TX-2026-08-08-01 — MCP session op-chain deadlock fix

### Status: IMPLEMENTED + VERIFIED (records sync done)

### What changed
- **`src/lib/mcp-session-manager.ts`**: `handleExisting(..., bypassQueue = false)` — GET (SSE, long-lived stream) runs outside the per-session op chain; POST/DELETE stay serialized. `isSessionConnected()` added; `list()`/`counts()` expose `connected` / `connected_sessions`.
- **`src/index.ts`**: `handleMcpGet` passes `bypassQueue=true`; 2nd concurrent GET rejected with 409 before enqueueing; `connected` ref-count cleanup on stream finish/close.
- **`public/ui/app.js`**: manager-proxied admin UI (`/admin/...` + `?instance=`) — `IS_PROXIED`/`API_BASE`/`API_INSTANCE`/`apiUrl()` wired into `api()` and the activity EventSource.
- **`scripts/test-mcp-session.mjs`**: 3 new regressions (POST-while-SSE, DELETE-closes-SSE, DELETE-after-in-flight-POST); DELETE close detection switched to bounded read-to-completion (undici `.closed` unreliable for empty chunked SSE).

### Evidence (exact candidates)
- `CHATGPT_TOOL_PROFILE=slim node scripts/run-all-tests.mjs` → **13 passed, 0 failed**, "=== ALL TESTS PASSED ===" (≈8s; was 240s-hang pre-fix).
- `npm run build` (tsc) → clean.
- `node --check scripts/test-mcp-session.mjs` + `node --check public/ui/app.js` → clean.
- Proxied admin API: `GET /admin/health?instance=default` → `connected_sessions: 1` while SSE open; session row `3763eebb… registered connected:true`.
- `.workspace/probes/ui_check.mjs` → all 5 UI wiring assertions pass.
- **Browser-verified UI render** (headless Chromium, after manual "refresh-all" — dashboard has no auto-poll):
  - Proxied UI `http://127.0.0.1:3300/admin/ui/?instance=default`: SSE open → header `1 đang kết nối`, row `1f14dead… ĐANG KẾT NỐI`; SSE closed → header `0 đang kết nối`, row `1f14dead… REGISTERED`.
  - Direct UI `http://127.0.0.1:3001/ui/`: SSE open → header `1 đang kết nối`, row `db53f850… ĐANG KẾT NỐI`; SSE closed → header `0 đang kết nối`, row `db53f850… REGISTERED`.
  - Live flip at API level (`/health` `connected_sessions`, `/api/sessions` `connected`) observed without any refresh.

### Remaining
- Commit working tree (no commit yet; repo last commits pre-session: 44c29e5, ab37ee7, 37f994e).
