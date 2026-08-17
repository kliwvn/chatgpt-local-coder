const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const DEFAULT_AUTO_START_MAX_ATTEMPTS = 3;
export const DEFAULT_AUTO_START_RETRY_DELAYS_MS = Object.freeze([3000, 10000]);
export const DEFAULT_AUTO_START_CONCURRENCY = 2;

function errorText(result) {
  return String(result?.error || "unknown error").replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Reconcile one instance during manager bootstrap only.
 *
 * This is deliberately bounded rather than a perpetual watchdog: autoStart means
 * "bring this instance up when the manager boots", while an explicit Stop in the
 * UI must remain authoritative for the rest of the current manager lifetime.
 */
export async function autoStartInstance(name, {
  readConfig,
  startServer,
  startTunnel,
  recoverTunnel = null,
  shouldContinue = async () => true,
  sleep = DEFAULT_SLEEP,
  log = () => undefined,
  maxAttempts = DEFAULT_AUTO_START_MAX_ATTEMPTS,
  retryDelaysMs = DEFAULT_AUTO_START_RETRY_DELAYS_MS,
} = {}) {
  if (typeof readConfig !== "function" || typeof startServer !== "function" || typeof startTunnel !== "function") {
    throw new TypeError("autoStartInstance requires readConfig, startServer, and startTunnel functions");
  }
  if (recoverTunnel !== null && typeof recoverTunnel !== "function") {
    throw new TypeError("recoverTunnel must be a function when provided");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let config;
    try {
      config = await readConfig(name);
    } catch (err) {
      lastFailure = { stage: "config", result: { ok: false, error: String((err && err.message) || err) } };
      log(`[Auto] ${name}: config read failed on attempt ${attempt}/${maxAttempts}: ${errorText(lastFailure.result)}`);
      if (attempt >= maxAttempts) break;
      const delay = Number(retryDelaysMs[Math.min(attempt - 1, Math.max(0, retryDelaysMs.length - 1))] || 0);
      if (delay > 0) await sleep(delay);
      continue;
    }
    if (config?.autoStart !== true) {
      log(`[Auto] ${name}: skipped because autoStart is not explicitly enabled.`);
      return { ok: true, skipped: true, reason: "disabled", attempts: attempt - 1 };
    }
    if (!(await shouldContinue(name))) {
      log(`[Auto] ${name}: bootstrap reconciliation cancelled by an explicit lifecycle action.`);
      return { ok: true, skipped: true, reason: "cancelled", attempts: attempt - 1 };
    }

    log(`[Auto] ${name}: attempt ${attempt}/${maxAttempts}.`);

    // Re-run the idempotent server start/status gate on every retry. This is
    // cheap when healthy and prevents a tunnel retry from assuming a server that
    // died between attempts is still established.
    let server;
    try {
      server = await startServer(name);
    } catch (err) {
      server = { ok: false, error: String((err && err.message) || err) };
    }
    if (!server?.ok) {
      lastFailure = { stage: "server", result: server };
      log(`[Auto] ${name}: Server failed on attempt ${attempt}/${maxAttempts}: ${errorText(server)}`);
    } else {
      log(
        server.alreadyRunning
          ? `[Auto] ${name}: Server already running (port ${server.port}).`
          : `[Auto] ${name}: Server started${server.pid ? ` (pid ${server.pid})` : ""}.`
      );
    }

    if (server?.ok) {
      // The config can change while a slow server start is in flight. Re-read
      // autoStart before exposing that server through a tunnel so toggling
      // autoStart off during bootstrap is authoritative for all later boot work.
      let tunnelConfig;
      let tunnelConfigReadFailed = false;
      try {
        tunnelConfig = await readConfig(name);
      } catch (err) {
        tunnelConfigReadFailed = true;
        lastFailure = { stage: "config", result: { ok: false, error: String((err && err.message) || err) } };
        log(`[Auto] ${name}: config re-read failed before Tunnel on attempt ${attempt}/${maxAttempts}: ${errorText(lastFailure.result)}`);
      }
      if (!tunnelConfigReadFailed && tunnelConfig?.autoStart !== true) {
        log(`[Auto] ${name}: autoStart is no longer explicitly enabled; Tunnel bootstrap is skipped.`);
        return { ok: true, skipped: true, reason: "disabled", attempts: attempt, server: true, tunnel: false };
      }
      if (!tunnelConfigReadFailed && !(await shouldContinue(name))) {
        log(`[Auto] ${name}: bootstrap reconciliation cancelled before Tunnel start.`);
        return { ok: true, skipped: true, reason: "cancelled", attempts: attempt };
      }
      if (!tunnelConfigReadFailed && tunnelConfig?.autoStart === true) {
        let tunnel;
        try {
          tunnel = await startTunnel(name);
        } catch (err) {
          tunnel = { ok: false, error: String((err && err.message) || err) };
        }
        if (tunnel?.ok) {
          log(
            tunnel.alreadyRunning
              ? `[Auto] ${name}: Tunnel already running (${tunnel.mode || tunnel.kind || "unknown"}).`
              : `[Auto] ${name}: Tunnel started (${tunnel.mode || tunnel.kind || "unknown"}${tunnel.url ? ` — ${tunnel.url}` : ""}).`
          );
          return { ok: true, attempts: attempt, server: true, tunnel: true };
        }

        // A matching Manager-owned OpenAI tunnel can survive a Manager restart
        // while its local health listener is wedged. Repeating startTunnel()
        // cannot heal that state because start is intentionally fail-closed for
        // an already-running unhealthy process. During bootstrap only, allow a
        // typed recovery hook to restart that exact-owned unhealthy transport.
        // Never recover config drift or unowned processes, and re-check explicit
        // lifecycle cancellation before scheduling destructive recovery.
        let recoveryHandledFailure = false;
        if (
          recoverTunnel &&
          tunnel?.running === true &&
          tunnel?.owned === true &&
          tunnel?.healthDrift === true &&
          tunnel?.configDrift !== true
        ) {
          if (!(await shouldContinue(name))) {
            log(`[Auto] ${name}: bootstrap reconciliation cancelled before unhealthy Tunnel recovery.`);
            return { ok: true, skipped: true, reason: "cancelled", attempts: attempt };
          }
          log(`[Auto] ${name}: exact-owned Tunnel is unhealthy; attempting bounded bootstrap recovery.`);
          let recovery;
          try {
            recovery = await recoverTunnel(name);
          } catch (err) {
            recovery = { ok: false, error: String((err && err.message) || err) };
          }
          if (recovery?.cancelled === true) {
            log(`[Auto] ${name}: unhealthy Tunnel recovery cancelled by an explicit lifecycle action.`);
            return { ok: true, skipped: true, reason: "cancelled", attempts: attempt };
          }
          if (recovery?.ok) {
            log(`[Auto] ${name}: unhealthy Tunnel recovered (${recovery.mode || recovery.kind || "unknown"}).`);
            return { ok: true, attempts: attempt, server: true, tunnel: true, recoveredTunnel: true };
          }
          lastFailure = { stage: "tunnel-recovery", result: recovery };
          log(`[Auto] ${name}: Tunnel recovery failed on attempt ${attempt}/${maxAttempts}: ${errorText(recovery)}`);
          recoveryHandledFailure = true;
        }
        if (!recoveryHandledFailure) {
          lastFailure = { stage: "tunnel", result: tunnel };
          log(`[Auto] ${name}: Tunnel failed on attempt ${attempt}/${maxAttempts}: ${errorText(tunnel)}`);
        }
      }
    }

    if (attempt >= maxAttempts) break;
    if (!(await shouldContinue(name))) {
      log(`[Auto] ${name}: bootstrap reconciliation cancelled before retry.`);
      return { ok: true, skipped: true, reason: "cancelled", attempts: attempt };
    }
    const delay = Number(retryDelaysMs[Math.min(attempt - 1, Math.max(0, retryDelaysMs.length - 1))] || 0);
    log(`[Auto] ${name}: retrying ${lastFailure?.stage || "startup"} in ${Math.max(0, delay)}ms.`);
    if (delay > 0) await sleep(delay);
  }

  log(`[Auto] ${name}: bootstrap retries exhausted at ${lastFailure?.stage || "startup"}: ${errorText(lastFailure?.result)}`);
  return {
    ok: false,
    attempts: maxAttempts,
    stage: lastFailure?.stage || "startup",
    error: errorText(lastFailure?.result),
  };
}

/** Run independent instance bootstraps with bounded concurrency. */
export async function autoStartInstances(names, options = {}) {
  const uniqueNames = [...new Set((names || []).map((name) => String(name)))];
  if (uniqueNames.length === 0) return [];

  const concurrency = Math.max(
    1,
    Math.min(
      uniqueNames.length,
      Number.isInteger(options.concurrency) && options.concurrency > 0
        ? options.concurrency
        : DEFAULT_AUTO_START_CONCURRENCY
    )
  );
  let cursor = 0;
  const results = new Array(uniqueNames.length);

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= uniqueNames.length) return;
      const name = uniqueNames[index];
      try {
        results[index] = await autoStartInstance(name, options);
      } catch (err) {
        const error = String((err && err.message) || err).replace(/\s+/g, " ").trim().slice(0, 240);
        options.log?.(`[Auto] ${name}: unexpected bootstrap supervisor error: ${error}`);
        results[index] = { ok: false, attempts: 0, stage: "supervisor", error };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results.map((result, index) => ({ name: uniqueNames[index], ...result }));
}