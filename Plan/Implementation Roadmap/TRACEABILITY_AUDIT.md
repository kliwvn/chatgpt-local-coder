# TRACEABILITY_AUDIT — chatgpt-local-coder

## TX-2026-08-09-02 — session churn / performance / context-quality audit

Claim scope: **MCP session retention, initialize payload, proxy-tool readiness, diagnostics/security, dashboard freshness, and live performance, committed as `8bb68e2` on `main` (pushed to `origin/main`)**.

| Requirement | Evidence | Status |
|---|---|---|
| Session churn must not retain thousands of full `McpServer` instances | 2m idle TTL + 15s sweep + 64 hard cap; live before 1013 sessions / ~529MB WS, final restart ~94MB WS | PASS |
| Active SSE / in-flight tool call must never be evicted | `isSessionBusy()` protects live connections + op chains; stress sandbox kept connected session through cap + TTL | PASS |
| Stale session continuity must remain available | existing recovery path retained; 13/13 integration includes stale auto-recovery + reinitialize | PASS |
| Initialize must not duplicate full server instructions | `server-factory` accepts complete instruction document directly; live initialize header count = 1 | PASS |
| Proxy tools must exist before first `tools/list` | async `createMcpServer()` awaits `refreshProxiedTools()` | PASS |
| Upstream MCP connection/cache must not rebuild per transport session | one shared `McpUpstreamManager`; only per-session tool registry is rebuilt | PASS |
| Health polling must not dominate log I/O | successful `/health` access logging suppressed; live post-restart count = 0 | PASS |
| Initialize telemetry must not print duplicate lines | canonical `Session initialized` remains; generic success `session initialize` console line suppressed; live generic count = 0 | PASS |
| Session identifiers exposed to admin/logs must be redacted | `/api/sessions`, activity JSON/history/SSE and server console/file log use `8 chars + …`; live raw-ID probes PASS | PASS |
| Dashboard session state must not remain stale until manual refresh | visible-only 5s poll + single-flight guard; policy displayed (`active/max`, TTL, cleanup) | PASS |
| Full test harness must target its own sandbox admin port | `ADMIN_PORT` passed to `test-mcp-session.mjs`; full session integration 13/13 | PASS |
| Build/readiness gates clean after all fixes | build + npm test + run-all + JS checks + diff check | PASS |

### Fix 1 — manager env-injection staleness (claim scope: audit isolation + fresh-spawn live verification)

### TX-2026-08-09-03 — cap-race / 429 / manager validation (claim scope: shipped `8bb68e2` on `main`)

| Requirement | Evidence | Status |
|---|---|---|
| Published + in-flight builds must never exceed `MCP_MAX_SESSIONS` | `reserveBuildSlot()` counts both; hard-rejects when in-flight fills the cap; integration `parallel init` 16 ok / retained 8/8 with `MCP_MAX_SESSIONS=8` | PASS |
| Over-cap must be a deliberate bounded status, not a generic 500 | `SessionCapacityError` → HTTP 429 (JSON-RPC `-32029`) in `handleMcpPost`; deterministic test: fill cap with connected sessions → next initialize exactly 429 | PASS |
| Recovery must not leak a built-but-unpublished session | `tryRecoverStale` hoists `pending` before `try`; catch disposes + releases via `disposePendingSession` (idempotent); single release point | PASS |
| Manager must not start a server with an invalid session policy | `startServer` validates via `validateSessionPolicy` and returns an error listing the bad keys | PASS |
| Session policy vars documented | `.env.example` + README now include `MCP_SESSION_DELETE_GRACE_MS` and `MCP_MAX_SESSIONS` | PASS |
| Full suite green after fixes | `set -o pipefail; node scripts/run-all-tests.mjs` → 15/15, `SUITE_EXIT=0` (integration spawns `MCP_MAX_SESSIONS=8`) | PASS |
| Manager restart actually loads new manager code | old manager 54744 stopped; current `server.mjs` started (new pid 57452 on :3300), auto-started instance 56536; health/policy/tunnel/audit verified | PASS |
| Changes committed and pushed | `8bb68e2` on `main`, pushed `44c29e5..8bb68e2` to `origin/main` | PASS |

| Requirement | Evidence | Status |
|---|---|---|
| Per-instance audit log isolation must take effect on the managed instance | `agent_status.audit_log` on fresh manager + fresh spawn = `manager/instances/default/.mcp-audit.log`; audit writes observed in instance file (pid 55452), root `.mcp-audit.log` frozen at old pid 31604 | PASS |
| Stale manager must not be mistaken for a code defect | on-disk `startServer → readInstanceEnv → spawnDetached({...env, MCP_ENV_FILE})` verified correct; root cause = manager PID 17072 started pre-edit (04:00), restart from current `server.mjs` fixed | PASS |
| Fresh instance must be a real fresh spawn (not `alreadyRunning`) | explicit stop (graceful, port free) then start via fresh manager; new pid 55452 | PASS |
| Full suite still green after manager restart + fresh spawn | `set -o pipefail; node scripts/run-all-tests.mjs` → session integration 13/13 PASS + unit suite PASS, `EXIT=0` | PASS |
| Health policy consistent on all surfaces | MCP :3000, admin :3001, manager :3300 all report `maxRetained=64/idleTtlMs=120000/cleanupIntervalMs=15000`, pid 55452 | PASS |
| Tunnel API key value not present in git history | `git log --all -S <value fragment>` → no hits; full sweep pending | **UNVERIFIED** |

### Context/quality conclusion
- MCP transport session IDs are **not** the model/chat conversation history. Re-initialize does not by itself reset the LLM dialogue context.
- Initialize does retransmit MCP server instructions, so excessive initialize definitely adds network/parse/server work and may cause redundant connector-side instruction processing. It is **not valid to claim** every ~8KB response is appended as another conversation turn; that connector-internal behavior is not observable here.
- The old retention leak could indirectly degrade agent quality through memory pressure, GC pauses, slower tool registration/refresh and timing-dependent missing proxy tools. Those server-side causes are now fixed/bounded.
- Remaining quality risk is workspace specificity: live default `E:\` is not a git repo and only user memory is auto-loaded. Use `project_context(repo)` or per-project instances for repo-specific context rather than merging transport sessions or globally injecting all repo memories.

## TX-2026-08-08-01 — claim scope

Claim scope: **MCP session op-chain deadlock fix + admin `connected` tracking + regression suite, as of working tree 2026-08-08 (pre-commit)**. No broader project-wide completion implied.

## Authority inputs (SOURCE_SET)
- User request: complete/fix MCP session-manager work — live `connected` tracking, passing integration suite, admin UI verification (direct + manager-proxied), and the op-chain refinement (GET bypass; POST/DELETE serialized) with regressions.
- Refinement advisory: GET only bypasses; DELETE stays on chain; regressions (a) SSE open → POST succeeds, (b) SSE open → DELETE 200 + stream closes; bounded DELETE-after-in-flight-POST.

## Requirement → evidence mapping

| Requirement | Evidence | Status |
|---|---|---|
| GET (SSE) must not hold the op chain | `handleExisting` `bypassQueue`; `handleMcpGet` passes `true` | PASS |
| POST succeeds while SSE open | suite test "POST tools/list succeeds while SSE open" | PASS |
| DELETE returns 200 + SSE closes | suite test "DELETE returns 200 and closes open SSE" (bounded read-to-completion) | PASS |
| DELETE-after-in-flight-POST not stranded | suite test "DELETE waits for in-flight POST then closes" | PASS |
| 2nd concurrent GET → 409 (no wedge) | suite test "concurrent GET: 2nd GET gets 409" | PASS |
| Admin `connected` live tracking | `/api/sessions` `connected`, `/health` `connected_sessions`; proxied admin API observed `connected_sessions: 1` | PASS |
| Proxied admin UI uses `?instance=` | `.workspace/probes/ui_check.mjs` 5/5 assertions | PASS |
| Admin UI renders `connected` state (proxied + direct) | TX-01 manual-refresh browser evidence remains valid; TX-02 supersedes refresh semantics with visible-only 5s single-flight auto-poll | PASS |
| Build + syntax clean | `npm run build`; `node --check` both JS files | PASS |

## Deviations / exclusions
- Full-suite duration now ≈8s (was 240s-hang); measured via suite run.
- Commit of the working tree is **pending** — no git commit exists for this transaction yet. Completion claim excludes "committed".
- Historical TX-01 had no auto-poll; **superseded by TX-2026-08-09-02**, which adds visible-only 5s single-flight dashboard refresh.
- Plan Pack / UI Outline: none exist; not fabricated (LIGHTWEIGHT mode per `cross-project-delivery`).

## Sync flags
- Records synchronized with working tree state (this audit is the synchronization record).
- No completion-critical `MUST` row degraded or silently dropped.
