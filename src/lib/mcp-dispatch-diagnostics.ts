import { createHash } from "node:crypto";
import path from "node:path";

const WRITE_LIKE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "delete_file",
  "delete_directory",
  "copy_file",
  "move_file",
  "create_directory",
  "write_file_base64",
  "replace_regex",
  "run_command",
  "start_process",
  "stop_process",
  "clear_processes",
  "shell_reset",
  "process_input",
  "git_add",
  "git_commit",
  "git_branch",
  "git_checkout",
  "git_restore",
  "git_push",
  "git_pull",
  "git_stash",
  "git_reset",
  "remember",
  "rewind",
  "mcp_call",
]);

interface DispatchStage {
  total: number;
  write_total: number;
  last_at: string | null;
  last_tool: string | null;
  last_write_at: string | null;
  last_write_tool: string | null;
}

export type McpRejectReason =
  | "INVALID_SESSION_ID"
  | "MISSING_SESSION_ID"
  | "STALE_SESSION_REBUILD_FAILED"
  | "HANDLER_ERROR";

interface RejectedDispatchStage extends DispatchStage {
  last_reason: McpRejectReason | null;
  last_write_reason: McpRejectReason | null;
  reasons: Record<McpRejectReason, number>;
}

export interface McpDispatchContext {
  dispatch_id: number;
  tool: string;
  write_like: boolean;
  host_gate_canary: boolean;
  session_fingerprint: string | null;
  correlation_hint: string | null;
  started_at: string;
}

interface RecentDispatch extends McpDispatchContext {
  state: "reached" | "executed" | "rejected";
  settled_at: string | null;
  reason: McpRejectReason | null;
}

const RECENT_DISPATCH_LIMIT = 128;
const HOST_GATE_CANARY_LIMIT = 64;
const HOST_GATE_CANARY_PREFIX = ".clc-host-gate-canary-";
const HOST_GATE_CANARY_CONTENT = "host-gate diagnostic canary\n";
const HOST_GATE_CANARY_BASENAME_RE = /^\.clc-host-gate-canary-\d{8}T\d{4}(?:\d{2})?Z-[A-Za-z0-9_-]{8,64}\.tmp$/;
const UNSETTLED_STALE_AFTER_MS = 120_000;
const CORRELATION_HINT_MAX_CHARS = 160;
const DIAGNOSTICS_STARTED_AT = new Date().toISOString();
const recentDispatches: RecentDispatch[] = [];
const hostGateCanaries: RecentDispatch[] = [];
const settledDispatches = new WeakSet<McpDispatchContext>();
let nextDispatchId = 1;
let recentDispatchEvictedTotal = 0;
let hostGateCanaryEvictedTotal = 0;

const reached: DispatchStage = {
  total: 0,
  write_total: 0,
  last_at: null,
  last_tool: null,
  last_write_at: null,
  last_write_tool: null,
};

const executed: DispatchStage = {
  total: 0,
  write_total: 0,
  last_at: null,
  last_tool: null,
  last_write_at: null,
  last_write_tool: null,
};

const rejected: RejectedDispatchStage = {
  total: 0,
  write_total: 0,
  last_at: null,
  last_tool: null,
  last_write_at: null,
  last_write_tool: null,
  last_reason: null,
  last_write_reason: null,
  reasons: {
    INVALID_SESSION_ID: 0,
    MISSING_SESSION_ID: 0,
    STALE_SESSION_REBUILD_FAILED: 0,
    HANDLER_ERROR: 0,
  },
};

function toolNameFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const rpc = body as { method?: unknown; params?: { name?: unknown } };
  if (rpc.method !== "tools/call" || !rpc.params || typeof rpc.params.name !== "string") return null;
  const name = rpc.params.name.trim();
  return name || null;
}

function toolArgumentsFromBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const rpc = body as { method?: unknown; params?: { arguments?: unknown } };
  if (rpc.method !== "tools/call" || !rpc.params || !rpc.params.arguments || typeof rpc.params.arguments !== "object") {
    return null;
  }
  return rpc.params.arguments as Record<string, unknown>;
}

function boundedLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, CORRELATION_HINT_MAX_CHARS);
}

function basenameHint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768) return null;
  const normalized = value.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  return base ? boundedLabel(base) : null;
}

function correlationHintFromBody(body: unknown, tool: string): string | null {
  const args = toolArgumentsFromBody(body);
  if (!args) return null;

  // Never echo generic command/process input: commands commonly contain secrets.
  if (tool === "run_command" || tool === "start_process" || tool === "process_input") return null;

  if (tool === "copy_file" || tool === "move_file") {
    const source = basenameHint(args.source ?? args.src ?? args.from);
    const destination = basenameHint(args.destination ?? args.dest ?? args.to);
    if (source || destination) return `file:${source ?? "?"}->${destination ?? "?"}`;
    return null;
  }

  const pathBase = basenameHint(args.path);
  if (pathBase) {
    if (tool.startsWith("git_")) return `repo:${pathBase}`;
    return `path:${pathBase}`;
  }

  if (tool === "mcp_call") {
    const serverId = typeof args.server_id === "string" ? boundedLabel(args.server_id) : null;
    const upstreamTool = typeof args.tool === "string" ? boundedLabel(args.tool) : null;
    if (serverId && upstreamTool) return `upstream:${serverId}:${upstreamTool}`;
  }
  return null;
}

function fingerprintSession(sessionId: string | undefined | null): string | null {
  if (!sessionId) return null;
  return createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 12);
}

function isHostGateCanaryRequest(body: unknown, tool: string, correlationHint: string | null): boolean {
  if (tool !== "write_file" || !correlationHint?.startsWith("path:")) return false;
  const basename = correlationHint.slice("path:".length);
  if (!HOST_GATE_CANARY_BASENAME_RE.test(basename)) return false;
  const args = toolArgumentsFromBody(body);
  return args?.content === HOST_GATE_CANARY_CONTENT;
}

function pushBounded<T>(items: T[], item: T, limit: number): number {
  items.push(item);
  if (items.length <= limit) return 0;
  const evicted = items.length - limit;
  items.splice(0, evicted);
  return evicted;
}

function ledgerCoverage(
  items: RecentDispatch[],
  limit: number,
  evictedTotal: number
): Record<string, unknown> {
  const oldest = items[0]?.started_at ?? null;
  const newest = items[items.length - 1]?.started_at ?? null;
  const oldestMs = oldest === null ? Number.NaN : Date.parse(oldest);
  // Once eviction has happened, timestamps at the exact millisecond of the
  // oldest retained record are ambiguous: an evicted predecessor may share
  // that same ISO millisecond. Move the absence-certainty boundary one
  // millisecond forward instead of claiming coverage we cannot prove.
  const completeSince = evictedTotal === 0
    ? DIAGNOSTICS_STARTED_AT
    : Number.isFinite(oldestMs)
      ? new Date(oldestMs + 1).toISOString()
      : null;
  return {
    limit,
    retained: items.length,
    evicted_total: evictedTotal,
    oldest_retained_started_at: oldest,
    newest_retained_started_at: newest,
    complete_since: completeSince,
    complete_since_semantics:
      "Absence is evidence only when complete_since is non-null and the attempt timestamp is at or after complete_since in this same live Local Coder process. After eviction the boundary is deliberately one millisecond later than the oldest retained record to avoid same-millisecond ambiguity. If the attempt predates complete_since, complete_since is null, or the server restarted after the attempt, absence is INDETERMINATE_NO_COVERAGE rather than HOST_NOT_INVOKED.",
  };
}

function exposeDispatch(record: RecentDispatch, nowMs: number): Record<string, unknown> {
  const startedMs = Date.parse(record.started_at);
  const ageMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null;
  return {
    ...record,
    age_ms: ageMs,
    stale_unsettled: record.state === "reached" && ageMs !== null && ageMs >= UNSETTLED_STALE_AFTER_MS,
  };
}

function getHostGateProtocol(): Record<string, unknown> {
  return {
    version: 2,
    purpose: "Diagnose whether ChatGPT blocked a write-like action before MCP dispatch without bypassing host safety or changing the public MCP ABI.",
    server_observation_boundary:
      "Local Coder can prove MCP_REACHED/MCP_EXECUTED/MCP_REJECTED after a tools/call reaches this handler. HOST_NOT_INVOKED is an external inference and requires both a host-side disabled/not-dispatched result and valid same-process ledger coverage for the absent unique canary.",
    canary: {
      tool: "write_file",
      basename_prefix: HOST_GATE_CANARY_PREFIX,
      basename_template: `${HOST_GATE_CANARY_PREFIX}<UTC>-<nonce>.tmp`,
      content: HOST_GATE_CANARY_CONTENT,
      recognition_rule: "A diagnostic canary is recognized only when tool=write_file, the basename matches the canonical timestamp+nonce .tmp shape with an 8-64 character nonce, and content exactly matches the canonical canary content. A prefix-only filename is not enough.",
      target_rule: "Create the canary only inside an already user-authorized writable project or scratch directory; never use a config/system file as the probe target. Use a fresh high-entropy nonce and do not overwrite an existing path.",
      observe: "Immediately after the host result, call agent_status and match the exact path:<basename> in mcp_dispatch.host_gate_canaries first. A fallback match in recent_dispatches is valid only when host_gate_canary=true. Also verify the attempt timestamp is inside mcp_dispatch.coverage.canary before using absence as evidence.",
      cleanup: "If the canary executed, remove only that canary with delete_file. Do not use shell/Git/process tools as cleanup or fallback.",
      retained_records: HOST_GATE_CANARY_LIMIT,
    },
    classification: {
      HOST_NOT_INVOKED: {
        evidence: "The host reports the action was disabled/not dispatched, the exact unique canonical canary is absent from both host_gate_canaries and recent_dispatches, and the attempt timestamp is at or after mcp_dispatch.coverage.canary.complete_since in the same live Local Coder process.",
        next_action: "Do not retry through a broader tool. Inspect host surface/action policy, try a clean normal conversation, and bisect conversation context if a clean canary succeeds.",
      },
      INDETERMINATE_NO_COVERAGE: {
        evidence: "The exact canary is absent, but the attempt predates mcp_dispatch.coverage.canary.complete_since, the Local Coder process restarted after the attempt, or the attempt timestamp is unknown. Ledger absence cannot distinguish host non-dispatch from an evicted/reset record.",
        next_action: "Run a new unique canary against the current live process and inspect agent_status immediately; do not label the earlier attempt HOST_NOT_INVOKED.",
      },
      MCP_REACHED_UNSETTLED: {
        evidence: "The exact canary exists with state=reached and no terminal state yet.",
        next_action: "Treat this as transport/session/response-loss or still-in-flight evidence, not HOST_NOT_INVOKED. Inspect session/tunnel logs and retry only after the state is understood.",
      },
      MCP_REJECTED: {
        evidence: "The exact canary exists with state=rejected and a local reject reason.",
        next_action: "Debug the reported Local Coder transport/session gate reason; the request did reach MCP. For HANDLER_ERROR, side-effect status is unknown because an error can occur after partial or completed tool work; inspect the target before retrying.",
      },
      MCP_EXECUTED: {
        evidence: "The exact canary exists with state=executed.",
        next_action: "The MCP handler completed. If the user-visible task still failed, inspect the tool result/business outcome rather than host dispatch.",
      },
    },
    context_bisect: {
      goal: "Find the smallest conversation/context transition after which a previously executing canary becomes HOST_NOT_INVOKED.",
      steps: [
        "Start a clean normal ChatGPT conversation with the connector selected and run one canary before loading project/harness context.",
        "If it executes, add one bounded context batch or one workflow step, then run a new unique canary.",
        "Stop at the first PASS->HOST_NOT_INVOKED transition; the last added context/surface/policy change is the trigger window, not proof of malicious content.",
        "Keep mutation work in the smallest context that still contains the user's explicit intent and exact verified evidence; do not omit required safety or authorization context.",
      ],
    },
    host_surface_checklist: {
      observable_by_server: false,
      checks: [
        "Confirm the current ChatGPT surface supports custom-app write actions rather than a read-only/research/knowledge mode.",
        "If an agent/workspace policy is in use, confirm its per-agent/action constraints permit the intended write action.",
        "Confirm no lockdown/read-only mode is active for the conversation.",
        "Confirm connector Action control/approval state is enabled; Refresh only updates action definitions and is not evidence that conversation safety state was reset.",
      ],
    },
    support_bundle: {
      capture: [
        "exact host error text",
        "attempt UTC timestamp",
        "unique canary basename",
        "agent_status.boot",
        "agent_status.mcp_contract",
        "agent_status.local_executor_profile/local_write_allowed",
        "agent_status.mcp_dispatch.coverage",
        "agent_status.mcp_dispatch.host_gate_canaries",
        "agent_status.mcp_dispatch.recent_dispatches around the attempt",
        "ChatGPT surface/conversation type and relevant action-policy state",
      ],
      privacy: "Do not include file contents, raw MCP session IDs, API keys, command text, or unrelated full paths. Correlation records intentionally keep only basenames and hashed session fingerprints.",
    },
    prohibitions: [
      "Do not weaken or falsify MCP annotations to make a blocked write look read-only.",
      "Do not retry a host-blocked typed mutation through run_command, start_process, Git, upstream MCP, or another broader action.",
      "Do not use process-global counter deltas as proof that one specific conversation attempt reached MCP.",
    ],
  };
}

export function isWriteLikeTool(name: string): boolean {
  if (WRITE_LIKE_TOOLS.has(name)) return true;
  // Full-profile native upstream proxies use <prefix>__<tool>. Their upstream
  // annotations are not available at the HTTP dispatch boundary, so classify
  // them conservatively as write-like rather than risk a false read-only label.
  return name.includes("__");
}

function advance(stage: DispatchStage, tool: string): void {
  const at = new Date().toISOString();
  stage.total++;
  stage.last_at = at;
  stage.last_tool = tool;
  if (isWriteLikeTool(tool)) {
    stage.write_total++;
    stage.last_write_at = at;
    stage.last_write_tool = tool;
  }
}

export function recordMcpReached(body: unknown, sessionId?: string | null): McpDispatchContext | null {
  const tool = toolNameFromBody(body);
  if (!tool) return null;
  advance(reached, tool);
  const correlationHint = correlationHintFromBody(body, tool);
  const context: McpDispatchContext = {
    dispatch_id: nextDispatchId++,
    tool,
    write_like: isWriteLikeTool(tool),
    host_gate_canary: isHostGateCanaryRequest(body, tool, correlationHint),
    session_fingerprint: fingerprintSession(sessionId),
    correlation_hint: correlationHint,
    started_at: new Date().toISOString(),
  };
  const record: RecentDispatch = { ...context, state: "reached", settled_at: null, reason: null };
  recentDispatchEvictedTotal += pushBounded(recentDispatches, record, RECENT_DISPATCH_LIMIT);
  if (context.host_gate_canary) {
    hostGateCanaryEvictedTotal += pushBounded(hostGateCanaries, record, HOST_GATE_CANARY_LIMIT);
  }
  return context;
}

function settleRecent(context: McpDispatchContext, state: "executed" | "rejected", reason: McpRejectReason | null): void {
  const record = recentDispatches.find((entry) => entry.dispatch_id === context.dispatch_id)
    ?? hostGateCanaries.find((entry) => entry.dispatch_id === context.dispatch_id);
  if (!record || record.state !== "reached") return;
  record.state = state;
  record.settled_at = new Date().toISOString();
  record.reason = reason;
}

export function recordMcpExecuted(context: McpDispatchContext | null): void {
  if (!context || settledDispatches.has(context)) return;
  settledDispatches.add(context);
  advance(executed, context.tool);
  settleRecent(context, "executed", null);
}

export function recordMcpRejected(context: McpDispatchContext | null, reason: McpRejectReason): void {
  if (!context || settledDispatches.has(context)) return;
  settledDispatches.add(context);
  advance(rejected, context.tool);
  rejected.last_reason = reason;
  rejected.reasons[reason]++;
  if (context.write_like) rejected.last_write_reason = reason;
  settleRecent(context, "rejected", reason);
}

export function getMcpDispatchDiagnostics(): Record<string, unknown> {
  const nowMs = Date.now();
  const inFlight = {
    total: Math.max(0, reached.total - executed.total - rejected.total),
    write_total: Math.max(0, reached.write_total - executed.write_total - rejected.write_total),
  };
  return {
    scope: "process_global_with_recent_correlated_dispatches",
    attribution_warning:
      "Counters aggregate every MCP session/chat connected to this Local Coder process. A counter delta alone does not prove that a specific ChatGPT attempt reached or executed. The current agent_status request also appears as state=reached until its own response completes. Diagnose a prior attempt with the exact canonical canary record plus timestamp/coverage, not aggregate deltas or the self-observation record.",
    interpretation:
      "For a canonical typed-write canary: a matching host_gate_canaries record, or a recent_dispatches record with host_gate_canary=true, proves the request reached this MCP handler. A same-basename recent record with host_gate_canary=false is not diagnostic evidence. state=rejected means the request hit a local transport/session/handler error; state=executed means the MCP handler path completed (not necessarily that every business-level operation succeeded). Absence supports HOST_NOT_INVOKED only when the host reports disabled/not-dispatched and mcp_dispatch.coverage.canary proves the attempt timestamp is covered by this same live process; otherwise use INDETERMINATE_NO_COVERAGE. Process-global deltas without correlation are not per-chat evidence.",
    correlation: {
      recommended_probe: `Use write_file with canonical basename ${HOST_GATE_CANARY_PREFIX}<UTC>-<nonce>.tmp and exact canonical canary content, then match the exact correlation hint and timestamp in host_gate_canaries/recent_dispatches and verify coverage.canary.`,
      session_fingerprint: "SHA-256 prefix of a valid MCP session id; raw session ids are never exposed.",
      secret_safety: "Generic command/process arguments are never copied into correlation hints; path hints contain basename only.",
      recent_limit: RECENT_DISPATCH_LIMIT,
      canary_limit: HOST_GATE_CANARY_LIMIT,
      unsettled_stale_after_ms: UNSETTLED_STALE_AFTER_MS,
    },
    coverage: {
      diagnostics_started_at: DIAGNOSTICS_STARTED_AT,
      recent: ledgerCoverage(recentDispatches, RECENT_DISPATCH_LIMIT, recentDispatchEvictedTotal),
      canary: ledgerCoverage(hostGateCanaries, HOST_GATE_CANARY_LIMIT, hostGateCanaryEvictedTotal),
      absence_rule:
        "Do not infer HOST_NOT_INVOKED from absence unless the host supplied a disabled/not-dispatched result and the attempt timestamp is covered by coverage.canary.complete_since in this same live Local Coder process. A restart or an evicted attempt makes absence indeterminate.",
    },
    protocol: getHostGateProtocol(),
    host_gate_canaries: hostGateCanaries.map((entry) => exposeDispatch(entry, nowMs)),
    recent_dispatches: recentDispatches.map((entry) => exposeDispatch(entry, nowMs)),
    stages: {
      HOST_NOT_INVOKED: {
        inferred: true,
        meaning: "ChatGPT/host rejected or did not dispatch the action before the MCP server.",
      },
      MCP_REACHED: { ...reached },
      MCP_EXECUTED: { ...executed },
      MCP_REJECTED: { ...rejected, reasons: { ...rejected.reasons } },
      MCP_IN_FLIGHT: {
        ...inFlight,
        inferred: true,
        meaning: "Requests that reached MCP and have not yet settled as executed or rejected. A reached record may remain visible after client disconnect/response loss; correlate the exact canary instead of treating aggregate in-flight totals as a host-gate signal.",
      },
    },
  };
}
