import { createHash } from "node:crypto";

const OPENAI_TUNNEL_LAUNCH_FINGERPRINT_VERSION = 1;

function normalizedPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}

/**
 * Persistable, secret-safe evidence for the exact OpenAI tunnel launch config.
 * The API key participates in the digest but is never stored in plaintext.
 */
export function openAiTunnelLaunchFingerprint({ tunnelId, apiKey, healthPort, serverPort }) {
  const payload = JSON.stringify({
    version: OPENAI_TUNNEL_LAUNCH_FINGERPRINT_VERSION,
    tunnelId: String(tunnelId || ""),
    apiKey: String(apiKey || ""),
    healthPort: normalizedPort(healthPort),
    serverPort: normalizedPort(serverPort),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Decide whether a currently running tunnel-client process is exactly the one
 * launched for the current desired configuration. Missing legacy evidence,
 * PID replacement, duplicates, unhealthy transport, or config changes
 * all fail closed as config drift.
 */
export function evaluateOpenAiTunnelLaunchState({
  mode,
  healthy,
  processPids,
  savedPid,
  savedFingerprint,
  desiredFingerprint,
}) {
  const pids = [...new Set((Array.isArray(processPids) ? processPids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b);
  const duplicateProcesses = pids.length > 1;
  const pidMatch = pids.length === 1 && Number(savedPid) === pids[0];
  const fingerprintMatch = typeof savedFingerprint === "string"
    && /^[0-9a-f]{64}$/.test(savedFingerprint)
    && typeof desiredFingerprint === "string"
    && savedFingerprint === desiredFingerprint;
  const desired = mode === "openai"
    && healthy === true
    && !duplicateProcesses
    && pidMatch
    && fingerprintMatch;

  return {
    desired,
    configDrift: !desired,
    ambiguous: duplicateProcesses,
    duplicateProcesses,
    pids,
    pidMatch,
    fingerprintMatch,
  };
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
