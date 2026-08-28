import { createHash } from "node:crypto";

const OPENAI_TUNNEL_LAUNCH_FINGERPRINT_VERSION = 2;

function normalizedPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
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
