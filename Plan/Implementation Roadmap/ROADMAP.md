# ROADMAP — chatgpt-local-coder

## Current production invariants
- MCP transport sessions are isolated; never coalesce them by IP/User-Agent/client name.
- Idle retention defaults to **2 minutes**, cleanup **15 seconds**, hard cap **64**; connected SSE and in-flight operations are never evicted, and later stale POSTs are recoverable.
- Stale session IDs remain recoverable when `MCP_SESSION_RECOVERY=true`.
- Initialize sends exactly one complete server-instruction document; do not double-wrap project memory/instructions.
- Proxy tools must be registered before a newly initialized session becomes usable (`createMcpServer` awaits proxy refresh).
- One global `McpUpstreamManager` owns upstream connections/cache across transport sessions.
- Full session IDs stay internal; admin session/activity APIs, SSE and server logs expose only short IDs.
- Successful `/health` polling must not spam `server.log`.
- Session dashboard auto-refresh is visible-only, 5s, single-flight and displays retention policy.
- Manager `:3300` and direct admin settings both expose recovery/TTL/cleanup/delete-grace/max-session policy; these are not hidden code-only knobs.
- Existing TX-01 op-chain invariant remains: SSE GET bypasses the chain; POST/DELETE serialize; second concurrent GET fails fast 409.
  - Manager and admin APIs never ship plaintext secrets to the browser: env endpoints mask via `SECRET_KEY_RE` + sentinel; upstream config masks header/env secrets; write paths restore sentinels from stored config. Audit file stays raw (local disk).
  - Activity feed at the API boundary ships metadata-only `details` + sanitized `summary` for tool entries (never raw tool arguments).
  - `buildSession` failure/shutdown paths close the server+transport AND unregister from the upstream manager (no leaked registrations).
  - `npm test` and `run-all-tests.mjs` run the same 12 unit scripts (test-runner parity).

## Next
- Commit/push only when explicitly requested.
- For quality-critical repo work, prefer a per-project instance or call `project_context(<repo>)`; the broad live default `E:\` is intentionally not treated as one repo context.
- Continue observing client-side initialize frequency, but optimize with caching/retention rather than unsafe cross-session reuse.
- **Security follow-up:** `OPENAI_TUNNEL_API_KEY` value exists in the gitignored instance `.env`; `git log --all -S <value fragment>` found no committed value (full history sweep pending). Rotation recommended as defense-in-depth; consider `git filter-repo`/history scrub if a sweep ever finds it.
- Manager `:3300` restarts are required to pick up `manager/server.mjs` changes (module cached in memory) — document for future audits.

## Done
- TX-02 session churn/performance hardening: TTL/cap cleanup, single instruction payload, proxy readiness, log/admin redaction, quiet health polling, dashboard live policy telemetry, harness fix, live performance verification.
- GET-only `bypassQueue` on the session op chain (`src/lib/mcp-session-manager.ts`, `src/index.ts`).
- DELETE/POST stay serialized; SDK `close()` runs after any in-flight POST.
- Admin `connected` / `connected_sessions` live tracking + UI proxy wiring and auto-refresh (`public/ui/app.js`).
- TX-02 Fix 1: manager env-injection staleness resolved (manager restart + explicit stop/start); per-instance audit isolation live (`agent_status.audit_log` = instance path); fresh PID 55452; session integration 13/13 + unit suite green; records synced.
- TX-02 round 2 (SHIPPED `8bb68e2`): cap admission counts published + in-flight (hard reject when in-flight fills cap); over-cap → deliberate HTTP 429 (`SessionCapacityError`); recovery leak closed via `disposePendingSession`; manager `startServer` validates session policy before spawn; `.env.example`/README gain `MCP_SESSION_DELETE_GRACE_MS`; deterministic 429 test + parallel-init cap test with `MCP_MAX_SESSIONS=8`; suite 15/15; records synced (`b8f8f18`).
- TX-02 round 3 (SHIPPED `5521ceb` + `4a4537f`): manager env plaintext leak closed (mask + sentinel round-trip); upstream config secrets masked on every response + restored on write; activity feed redacted at API boundary; DELETE-grace re-init fixed; clientInfo sanitized; `buildSession` leak fixed (close + unregister on failure/shutdown); `test-session-leak` regression (real `createNew` path, failing connect); runner parity (`npm test` = `run-all-tests` = 12 unit scripts); `.env.example`/README drift fixed; suite ALL PASSED; live verified (instance 2640, manager 31400).
