import { createHash } from "node:crypto";

const OPENAI_TUNNEL_LAUNCH_FINGERPRINT_VERSION = 2;

function normalizedPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}

/**
 * Evaluate whether tunnel-client has successfully completed a control-plane
 * poll recently enough to be considered operationally connected. This is
 * deliberately independent from /healthz + /readyz: those endpoints prove
 * local liveness/readiness, not that the long-poll loop is still receiving
 * control-plane responses.
 *
 * Older tunnel-client builds may not expose the freshness gauge. Treat that
 * as compatibility-unknown instead of unhealthy so an upgrade cannot
 * accidentally authorize disruptive recovery without supported evidence.
 */
export function evaluateOpenAiTunnelControlPlaneFreshness(metricsText, {
  nowMs = Date.now(),
  staleAfterMs = 36000,
  maxFutureSkewMs = 5000,
} = {}) {
  const now = Number(nowMs);
  const staleAfter = Number(staleAfterMs);
  const maxFutureSkew = Number(maxFutureSkewMs);
  if (!Number.isFinite(now) || now < 0) throw new Error("nowMs must be a finite non-negative number");
  if (!Number.isFinite(staleAfter) || staleAfter <= 0) {
    throw new Error("staleAfterMs must be a finite positive number");
  }
  if (!Number.isFinite(maxFutureSkew) || maxFutureSkew < 0) {
    throw new Error("maxFutureSkewMs must be a finite non-negative number");
  }

  const text = String(metricsText || "");
  const lineMatch = text.match(
    /^commands_poll_last_successful_timestamp_seconds(?:\{[^}]*\})?\s+(\S+)\s*$/m
  );
  if (!lineMatch) {
    const metricMentioned = /(?:^|\n)commands_poll_last_successful_timestamp_seconds(?:\{|\s|$)/m.test(text);
    return {
      supported: metricMentioned,
      fresh: metricMentioned ? false : null,
      lastSuccessfulAt: null,
      ageMs: null,
      staleAfterMs: staleAfter,
      reason: metricMentioned ? "metric-invalid" : "metric-missing",
    };
  }

  const timestampSeconds = Number(lineMatch[1]);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    return {
      supported: true,
      fresh: false,
      lastSuccessfulAt: null,
      ageMs: null,
      staleAfterMs: staleAfter,
      reason: "metric-invalid",
    };
  }

  const timestampMs = timestampSeconds * 1000;
  if (!Number.isFinite(timestampMs)) {
    return {
      supported: true,
      fresh: false,
      lastSuccessfulAt: null,
      ageMs: null,
      staleAfterMs: staleAfter,
      reason: "metric-invalid",
    };
  }

  // The gauge and Date.now() originate on the same host. A small positive skew
  // can happen around clock adjustments, but a timestamp materially in the
  // future is not valid freshness evidence. Do not clamp a corrupted/future
  // sample to age=0 and accidentally keep a wedged control-plane loop green.
  if (timestampMs - now > maxFutureSkew) {
    return {
      supported: true,
      fresh: false,
      lastSuccessfulAt: new Date(timestampMs).toISOString(),
      ageMs: null,
      staleAfterMs: staleAfter,
      reason: "metric-future",
    };
  }

  const ageMs = Math.max(0, Math.round(now - timestampMs));
  const fresh = ageMs <= staleAfter;
  return {
    supported: true,
    fresh,
    lastSuccessfulAt: new Date(timestampMs).toISOString(),
    ageMs,
    staleAfterMs: staleAfter,
    reason: fresh ? "fresh" : "stale",
  };
}

/**
 * Decide whether an already-running OpenAI tunnel has enough exact authority
 * and telemetry evidence to permit an automatic recovery restart.
 *
 * This helper is intentionally narrower than healthDrift. Local health failure,
 * missing/legacy telemetry, malformed telemetry, launch drift, ambiguity, or
 * unowned processes are observation-only states. Automatic disruption is
 * authorized only for an exact-owned current OpenAI generation whose local
 * tunnel remains healthy while the supported control-plane freshness gauge is
 * explicitly stale.
 */
export function evaluateOpenAiTunnelRecoveryCandidate(status) {
  if (!status?.running) return { recover: false, reason: "not-running" };
  if (
    status.owned !== true
    || status.kind !== "openai"
    || status.configDrift === true
    || status.ambiguous === true
    || status.duplicateProcesses === true
    || status.launchPidMatch !== true
    || status.launchProcessStartedAtMatch !== true
    || status.launchFingerprintMatch !== true
    || status.runtimePathMatches !== true
  ) {
    return { recover: false, reason: "authority-not-exact" };
  }
  if (status.localHealthy !== true) {
    return { recover: false, reason: "local-unhealthy" };
  }
  if (status.controlPlaneFreshnessSupported !== true) {
    return { recover: false, reason: "freshness-unsupported" };
  }
  if (
    status.controlPlaneFreshnessReason !== "stale"
    || status.controlPlaneFresh !== false
  ) {
    return { recover: false, reason: "freshness-not-stale" };
  }
  if (status.healthDrift !== true) {
    return { recover: false, reason: "not-health-drift" };
  }
  return { recover: true, reason: "control-plane-stale" };
}

/**
 * Persistable, secret-safe evidence for the exact OpenAI tunnel launch config.
 * The API key participates in the digest but is never stored in plaintext.
 */
export function openAiTunnelLaunchFingerprint({ tunnelId, apiKey, healthPort, serverPort, runtimeIdentity }) {
  const payload = JSON.stringify({
    version: OPENAI_TUNNEL_LAUNCH_FINGERPRINT_VERSION,
    tunnelId: String(tunnelId || ""),
    apiKey: String(apiKey || ""),
    healthPort: normalizedPort(healthPort),
    serverPort: normalizedPort(serverPort),
    runtimeIdentity: String(runtimeIdentity || ""),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Previous launch-fingerprint contract. Keep this only for the bounded
 * PID-file-mtime ownership bridge so an immediately-previous tunnel can still
 * be stopped safely after upgrading. It must never authorize desired/green.
 */
export function legacyOpenAiTunnelLaunchFingerprintV1({ tunnelId, apiKey, healthPort, serverPort }) {
  const payload = JSON.stringify({
    version: 1,
    tunnelId: String(tunnelId || ""),
    apiKey: String(apiKey || ""),
    healthPort: normalizedPort(healthPort),
    serverPort: normalizedPort(serverPort),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Decide whether a currently running tunnel-client process is exactly the one
 * launched for the current desired configuration. Process/config identity drift
 * is reported separately from operational health so a transient health probe
 * cannot be misdiagnosed as stale launch configuration.
 */
export function evaluateOpenAiTunnelLaunchState({
  mode,
  healthy,
  processPids,
  processStartedAt,
  savedPid,
  savedProcessStartedAt,
  savedFingerprint,
  desiredFingerprint,
  runtimePathMatches = true,
}) {
  const pids = [...new Set((Array.isArray(processPids) ? processPids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b);
  const duplicateProcesses = pids.length > 1;
  const pidMatch = pids.length === 1 && Number(savedPid) === pids[0];
  const processStartedAtMatch = pidMatch
    && typeof processStartedAt === "string"
    && processStartedAt.length > 0
    && typeof savedProcessStartedAt === "string"
    && savedProcessStartedAt === processStartedAt;
  const fingerprintMatch = typeof savedFingerprint === "string"
    && /^[0-9a-f]{64}$/.test(savedFingerprint)
    && typeof desiredFingerprint === "string"
    && savedFingerprint === desiredFingerprint;
  const launchIdentityMatches = mode === "openai"
    && !duplicateProcesses
    && pidMatch
    && processStartedAtMatch
    && fingerprintMatch
    && runtimePathMatches === true;
  const desired = launchIdentityMatches && healthy === true;

  return {
    desired,
    launchIdentityMatches,
    configDrift: !launchIdentityMatches,
    healthDrift: launchIdentityMatches && healthy !== true,
    ambiguous: duplicateProcesses,
    duplicateProcesses,
    pids,
    pidMatch,
    processStartedAtMatch,
    fingerprintMatch,
    runtimePathMatches: runtimePathMatches === true,
  };
}

/**
 * One-release bridge for tunnels started by the immediately previous Manager
 * contract, which persisted the spawned PID but not Windows CreationDate.
 * The PID file is written immediately around spawn, so its mtime must be very
 * close to the process CreationDate. This is only ownership evidence for a
 * safe stop/restart; it is deliberately weaker than current PID+CreationDate
 * evidence and must never make the tunnel "desired"/green by itself.
 */
export function legacyPidFileMatchesProcessStart({
  processStartedAt,
  pidFileMtimeMs,
  maxSkewMs = 10000,
}) {
  const startedAtMs = Date.parse(String(processStartedAt || ""));
  const mtimeMs = Number(pidFileMtimeMs);
  const skewMs = Number(maxSkewMs);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(mtimeMs) || mtimeMs <= 0) return false;
  if (!Number.isFinite(skewMs) || skewMs < 0) return false;
  return Math.abs(mtimeMs - startedAtMs) <= skewMs;
}

/**
 * Windows can report the tunnel-client root PID gone a short time before its
 * TCP listener is fully released. A restart must settle both conditions or it
 * can race its own just-stopped health listener and false-report an unrelated
 * port conflict. Keep the probe injectable so the settlement contract can be
 * regression-tested without binding a real port.
 */
export async function waitForTunnelPortRelease({
  port,
  isPortOpen,
  timeoutMs = 5000,
  intervalMs = 100,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const normalized = normalizedPort(port);
  if (!normalized || typeof isPortOpen !== "function") return false;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    if (!(await isPortOpen(normalized))) return true;
    if (Date.now() >= deadline) break;
    await sleep(Math.max(1, Number(intervalMs) || 1));
  } while (Date.now() <= deadline);
  return false;
}
