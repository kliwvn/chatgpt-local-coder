import assert from "node:assert/strict";
import { autoStartInstance, autoStartInstances } from "../manager/autostart-policy.mjs";

// A transient cold-start miss must be retried, then the tunnel may start only
// after a fresh successful server gate.
{
  let serverCalls = 0;
  let tunnelCalls = 0;
  const result = await autoStartInstance("default", {
    readConfig: async () => ({ autoStart: true }),
    startServer: async () => {
      serverCalls += 1;
      return serverCalls === 1
        ? { ok: false, error: "cold-start health timeout" }
        : { ok: true, pid: 1234, port: 3000 };
    },
    startTunnel: async () => {
      tunnelCalls += 1;
      return { ok: true, mode: "openai" };
    },
    retryDelaysMs: [0, 0],
    sleep: async () => undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(serverCalls, 2);
  assert.equal(tunnelCalls, 1);
}

// Tunnel retry must re-check the server each time instead of trusting stale
// state from the previous attempt.
{
  let serverCalls = 0;
  let tunnelCalls = 0;
  const result = await autoStartInstance("default", {
    readConfig: async () => ({ autoStart: true }),
    startServer: async () => {
      serverCalls += 1;
      return { ok: true, alreadyRunning: serverCalls > 1, pid: 55, port: 3000 };
    },
    startTunnel: async () => {
      tunnelCalls += 1;
      return tunnelCalls === 1
        ? { ok: false, error: "control plane not ready" }
        : { ok: true, mode: "openai" };
    },
    retryDelaysMs: [0, 0],
    sleep: async () => undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(serverCalls, 2);
  assert.equal(tunnelCalls, 2);
}

// A transient config re-read failure after Server health is established must
// remain a retryable config failure. It must never be false-greened as
// autoStart-disabled merely because tunnelConfig is temporarily unavailable.
{
  let configReads = 0;
  let serverCalls = 0;
  let tunnelCalls = 0;
  const result = await autoStartInstance("default", {
    readConfig: async () => {
      configReads += 1;
      if (configReads === 2) throw new Error("transient config read failure");
      return { autoStart: true };
    },
    startServer: async () => {
      serverCalls += 1;
      return { ok: true, alreadyRunning: serverCalls > 1, pid: 56, port: 3000 };
    },
    startTunnel: async () => {
      tunnelCalls += 1;
      return { ok: true, mode: "openai" };
    },
    retryDelaysMs: [0, 0],
    sleep: async () => undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  assert.equal(result.attempts, 2);
  assert.equal(serverCalls, 2);
  assert.equal(tunnelCalls, 1);
}

// An explicit lifecycle action during bootstrap must cancel later retry/tunnel
// work so the user's Stop remains authoritative for this manager lifetime.
{
  let serverCalls = 0;
  let tunnelCalls = 0;
  let cancelled = false;
  const result = await autoStartInstance("default", {
    readConfig: async () => ({ autoStart: true }),
    startServer: async () => {
      serverCalls += 1;
      cancelled = true;
      return { ok: false, error: "still warming" };
    },
    startTunnel: async () => {
      tunnelCalls += 1;
      return { ok: true, mode: "openai" };
    },
    shouldContinue: async () => !cancelled,
    retryDelaysMs: [0, 0],
    sleep: async () => undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "cancelled");
  assert.equal(serverCalls, 1);
  assert.equal(tunnelCalls, 0);
}

// autoStart=false is a true opt-out and must perform no lifecycle mutation.
{
  let lifecycleCalls = 0;
  const result = await autoStartInstance("disabled", {
    readConfig: async () => ({ autoStart: false }),
    startServer: async () => { lifecycleCalls += 1; return { ok: true }; },
    startTunnel: async () => { lifecycleCalls += 1; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "disabled");
  assert.equal(lifecycleCalls, 0);
}

// Missing/legacy autoStart authority is not consent. Only explicit true may
// trigger boot lifecycle work; this prevents a partially written or older
// config object from silently reverting to autostart-on semantics.
{
  let lifecycleCalls = 0;
  for (const config of [{}, { lastTunnelUrl: "" }, null]) {
    const result = await autoStartInstance("missing-authority", {
      readConfig: async () => config,
      startServer: async () => { lifecycleCalls += 1; return { ok: true }; },
      startTunnel: async () => { lifecycleCalls += 1; return { ok: true }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "disabled");
  }
  assert.equal(lifecycleCalls, 0, "missing autoStart authority must never start Server or Tunnel");
}

// autoStart can be switched off while a slow Server start is in flight. The
// completed Server start is not rolled back implicitly, but no later Tunnel
// bootstrap may occur from the stale pre-start config snapshot.
{
  let configReads = 0;
  let tunnelCalls = 0;
  const result = await autoStartInstance("toggle-off", {
    readConfig: async () => {
      configReads += 1;
      return { autoStart: configReads < 2 };
    },
    startServer: async () => ({ ok: true, pid: 88, port: 3000 }),
    startTunnel: async () => {
      tunnelCalls += 1;
      return { ok: true, mode: "openai" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "disabled");
  assert.equal(result.server, true);
  assert.equal(result.tunnel, false);
  assert.equal(tunnelCalls, 0);
}

// Losing the field entirely while Server start is in flight is also an opt-out:
// undefined must never inherit the historical `not false => true` behavior.
{
  let configReads = 0;
  let tunnelCalls = 0;
  const result = await autoStartInstance("field-lost", {
    readConfig: async () => {
      configReads += 1;
      return configReads === 1 ? { autoStart: true } : {};
    },
    startServer: async () => ({ ok: true, pid: 89, port: 3000 }),
    startTunnel: async () => { tunnelCalls += 1; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "disabled");
  assert.equal(result.server, true);
  assert.equal(result.tunnel, false);
  assert.equal(tunnelCalls, 0);
}

// Retry is bounded: a persistent failure must not create an infinite watchdog.
{
  let serverCalls = 0;
  const result = await autoStartInstance("broken", {
    readConfig: async () => ({ autoStart: true }),
    startServer: async () => {
      serverCalls += 1;
      return { ok: false, error: "persistent failure" };
    },
    startTunnel: async () => ({ ok: true }),
    maxAttempts: 3,
    retryDelaysMs: [0, 0],
    sleep: async () => undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "server");
  assert.equal(result.attempts, 3);
  assert.equal(serverCalls, 3);
}

// Independent instances must bootstrap concurrently with a hard cap, avoiding
// head-of-line blocking while preventing an unbounded process-start burst.
{
  let active = 0;
  let maxActive = 0;
  const names = ["a", "b", "c", "d", "e"];
  const results = await autoStartInstances(names, {
    concurrency: 2,
    readConfig: async () => ({ autoStart: true }),
    startServer: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { ok: true, pid: 1, port: 3000 };
    },
    startTunnel: async () => ({ ok: true, mode: "openai" }),
  });
  assert.equal(results.length, names.length);
  assert.ok(results.every((result) => result.ok));
  assert.equal(maxActive, 2);
}

// One corrupt instance must not abort the supervisor for its peers.
{
  const results = await autoStartInstances(["bad", "good"], {
    concurrency: 2,
    readConfig: async (name) => {
      if (name === "bad") throw new Error("config unreadable");
      return { autoStart: true };
    },
    startServer: async () => ({ ok: true, pid: 7, port: 3000 }),
    startTunnel: async () => ({ ok: true, mode: "openai" }),
    maxAttempts: 1,
  });
  assert.equal(results.find((result) => result.name === "bad")?.ok, false);
  assert.equal(results.find((result) => result.name === "good")?.ok, true);
}

console.log("manager autostart policy tests passed");