import assert from "node:assert/strict";
import {
  evaluateOpenAiTunnelLaunchState,
  evaluateOpenAiTunnelControlPlaneFreshness,
  evaluateOpenAiTunnelRecoveryCandidate,
  legacyOpenAiTunnelLaunchFingerprintV1,
  legacyPidFileMatchesProcessStart,
  openAiTunnelLaunchFingerprint,
  waitForTunnelPortRelease,
} from "../manager/tunnel-state.mjs";

const base = {
  tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
  apiKey: "sk-test-secret-not-persisted",
  healthPort: 4411,
  serverPort: 3000,
  runtimeIdentity: "sha256:runtime-a",
};
const fingerprint = openAiTunnelLaunchFingerprint(base);
const legacyFingerprint = legacyOpenAiTunnelLaunchFingerprintV1(base);
const processStartedAt = "2026-08-14T12:00:00.0000000Z";
assert.match(fingerprint, /^[0-9a-f]{64}$/);
assert.ok(!fingerprint.includes(base.apiKey), "fingerprint must never contain plaintext secret");
assert.notEqual(legacyFingerprint, fingerprint, "runtime-bound launch contract must differ from legacy v1 fingerprint");

for (const [field, value] of [
  ["tunnelId", "tunnel_fedcba9876543210fedcba9876543210"],
  ["apiKey", "sk-different-secret"],
  ["healthPort", 4412],
  ["serverPort", 3002],
  ["runtimeIdentity", "sha256:runtime-b"],
]) {
  const changed = openAiTunnelLaunchFingerprint({ ...base, [field]: value });
  assert.notEqual(changed, fingerprint, `${field} drift must change launch fingerprint`);
}

const exact = evaluateOpenAiTunnelLaunchState({
  mode: "openai",
  healthy: true,
  processPids: [1234],
  processStartedAt,
  savedPid: 1234,
  savedProcessStartedAt: processStartedAt,
  savedFingerprint: fingerprint,
  desiredFingerprint: fingerprint,
  runtimePathMatches: true,
});
assert.equal(exact.desired, true);
assert.equal(exact.launchIdentityMatches, true);
assert.equal(exact.configDrift, false);
assert.equal(exact.healthDrift, false);
assert.equal(exact.ambiguous, false);
assert.equal(exact.pidMatch, true);
assert.equal(exact.processStartedAtMatch, true);
assert.equal(exact.fingerprintMatch, true);
assert.equal(exact.runtimePathMatches, true);

for (const [label, override] of [
  ["legacy missing fingerprint", { savedFingerprint: undefined }],
  ["legacy missing pid", { savedPid: null }],
  ["pid replacement", { processPids: [4321] }],
  ["missing current process start", { processStartedAt: undefined }],
  ["missing saved process start", { savedProcessStartedAt: undefined }],
  ["pid reuse/process-start mismatch", { savedProcessStartedAt: "2026-08-14T11:59:59.0000000Z" }],
  ["fingerprint/config drift", { desiredFingerprint: openAiTunnelLaunchFingerprint({ ...base, apiKey: "sk-new" }) }],
  ["runtime path drift", { runtimePathMatches: false }],
  ["wrong mode", { mode: "cloudflare" }],
]) {
  const state = evaluateOpenAiTunnelLaunchState({
    mode: "openai",
    healthy: true,
    processPids: [1234],
    processStartedAt,
    savedPid: 1234,
    savedProcessStartedAt: processStartedAt,
    savedFingerprint: fingerprint,
    desiredFingerprint: fingerprint,
    runtimePathMatches: true,
    ...override,
  });
  assert.equal(state.desired, false, `${label} must not be accepted as desired`);
  assert.equal(state.configDrift, true, `${label} must fail closed as config drift`);
  assert.equal(state.healthDrift, false, `${label} is launch/config drift, not operational health drift`);
}

const unhealthy = evaluateOpenAiTunnelLaunchState({
  mode: "openai",
  healthy: false,
  processPids: [1234],
  processStartedAt,
  savedPid: 1234,
  savedProcessStartedAt: processStartedAt,
  savedFingerprint: fingerprint,
  desiredFingerprint: fingerprint,
  runtimePathMatches: true,
});
assert.equal(unhealthy.desired, false, "unhealthy transport must never be accepted as desired");
assert.equal(unhealthy.launchIdentityMatches, true, "health failure must preserve a matching launch identity");
assert.equal(unhealthy.configDrift, false, "health failure must not be mislabeled as stale configuration");
assert.equal(unhealthy.healthDrift, true, "health failure must be reported separately as operational drift");

const duplicate = evaluateOpenAiTunnelLaunchState({
  mode: "openai",
  healthy: true,
  processPids: [1234, 5678],
  processStartedAt,
  savedPid: 1234,
  savedProcessStartedAt: processStartedAt,
  savedFingerprint: fingerprint,
  desiredFingerprint: fingerprint,
  runtimePathMatches: true,
});
assert.equal(duplicate.desired, false);
assert.equal(duplicate.configDrift, true);
assert.equal(duplicate.healthDrift, false);
assert.equal(duplicate.ambiguous, true);
assert.equal(duplicate.duplicateProcesses, true);
assert.deepEqual(duplicate.pids, [1234, 5678]);

const freshnessNowMs = 1_790_738_900_000;
const freshMetrics = [
  'commands_poll_cycles_total{otel_scope_name="controlplane"} 42',
  'commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} 1.79073889e+09',
].join("\n");
const freshControlPlane = evaluateOpenAiTunnelControlPlaneFreshness(freshMetrics, {
  nowMs: freshnessNowMs,
  staleAfterMs: 36000,
});
assert.equal(freshControlPlane.supported, true);
assert.equal(freshControlPlane.fresh, true);
assert.equal(freshControlPlane.ageMs, 10000);
assert.equal(freshControlPlane.lastSuccessfulAt, "2026-09-30T03:28:10.000Z");

const staleControlPlane = evaluateOpenAiTunnelControlPlaneFreshness(
  'commands_poll_last_successful_timestamp_seconds 1.7907388e+09',
  { nowMs: freshnessNowMs, staleAfterMs: 36000 }
);
assert.equal(staleControlPlane.supported, true);
assert.equal(staleControlPlane.fresh, false);
assert.equal(staleControlPlane.ageMs, 100000);
assert.equal(staleControlPlane.reason, "stale");

const missingControlPlane = evaluateOpenAiTunnelControlPlaneFreshness(
  'commands_poll_cycles_total 42',
  { nowMs: freshnessNowMs, staleAfterMs: 36000 }
);
assert.equal(missingControlPlane.supported, false, "older tunnel-client metrics without freshness gauge must remain compatibility-unknown");
assert.equal(missingControlPlane.fresh, null);
assert.equal(missingControlPlane.reason, "metric-missing");

const malformedControlPlane = evaluateOpenAiTunnelControlPlaneFreshness(
  'commands_poll_last_successful_timestamp_seconds not-a-number',
  { nowMs: freshnessNowMs, staleAfterMs: 36000 }
);
assert.equal(malformedControlPlane.supported, true);
assert.equal(malformedControlPlane.fresh, false, "present-but-malformed freshness evidence must fail closed");
assert.equal(malformedControlPlane.reason, "metric-invalid");

const toleratedFutureSkew = evaluateOpenAiTunnelControlPlaneFreshness(
  `commands_poll_last_successful_timestamp_seconds ${(freshnessNowMs + 3000) / 1000}`,
  { nowMs: freshnessNowMs, staleAfterMs: 36000 }
);
assert.equal(toleratedFutureSkew.supported, true);
assert.equal(toleratedFutureSkew.fresh, true, "small same-host clock skew must not flap freshness");
assert.equal(toleratedFutureSkew.ageMs, 0);

const invalidFutureControlPlane = evaluateOpenAiTunnelControlPlaneFreshness(
  `commands_poll_last_successful_timestamp_seconds ${(freshnessNowMs + 60000) / 1000}`,
  { nowMs: freshnessNowMs, staleAfterMs: 36000 }
);
assert.equal(invalidFutureControlPlane.supported, true);
assert.equal(invalidFutureControlPlane.fresh, false, "far-future timestamps must not be clamped to fresh age=0");
assert.equal(invalidFutureControlPlane.ageMs, null);
assert.equal(invalidFutureControlPlane.reason, "metric-future");

const recoverableTunnel = {
  running: true,
  owned: true,
  kind: "openai",
  configDrift: false,
  healthDrift: true,
  ambiguous: false,
  duplicateProcesses: false,
  launchPidMatch: true,
  launchProcessStartedAtMatch: true,
  launchFingerprintMatch: true,
  runtimePathMatches: true,
  localHealthy: true,
  controlPlaneFreshnessSupported: true,
  controlPlaneFresh: false,
  controlPlaneFreshnessReason: "stale",
};
assert.deepEqual(
  evaluateOpenAiTunnelRecoveryCandidate(recoverableTunnel),
  { recover: true, reason: "control-plane-stale" }
);
assert.equal(
  evaluateOpenAiTunnelRecoveryCandidate({ ...recoverableTunnel, owned: false }).recover,
  false,
  "unowned transport must never be auto-restarted"
);
assert.equal(
  evaluateOpenAiTunnelRecoveryCandidate({ ...recoverableTunnel, ambiguous: true }).recover,
  false,
  "ambiguous transport must never be auto-restarted"
);
assert.deepEqual(
  evaluateOpenAiTunnelRecoveryCandidate({
    ...recoverableTunnel,
    controlPlaneFreshnessSupported: false,
    controlPlaneFresh: null,
    controlPlaneFreshnessReason: "metric-missing",
  }),
  { recover: false, reason: "freshness-unsupported" },
  "unknown/legacy freshness evidence must preserve the serving tunnel"
);
assert.deepEqual(
  evaluateOpenAiTunnelRecoveryCandidate({
    ...recoverableTunnel,
    controlPlaneFreshnessReason: "metric-invalid",
  }),
  { recover: false, reason: "freshness-not-stale" },
  "malformed telemetry must not authorize automatic disruption"
);
assert.deepEqual(
  evaluateOpenAiTunnelRecoveryCandidate({
    ...recoverableTunnel,
    controlPlaneFreshnessReason: "metric-future",
  }),
  { recover: false, reason: "freshness-not-stale" },
  "future-skewed telemetry must fail closed without authorizing an automatic restart"
);

const processStartedAtMs = Date.parse(processStartedAt);
assert.equal(legacyPidFileMatchesProcessStart({
  processStartedAt,
  pidFileMtimeMs: processStartedAtMs - 7,
}), true, "previous-contract PID evidence within the spawn/write window must remain stoppable for migration");
assert.equal(legacyPidFileMatchesProcessStart({
  processStartedAt,
  pidFileMtimeMs: processStartedAtMs + 9999,
}), true, "legacy migration window must tolerate bounded filesystem/process timestamp skew");
assert.equal(legacyPidFileMatchesProcessStart({
  processStartedAt,
  pidFileMtimeMs: processStartedAtMs + 10001,
}), false, "PID reuse outside the bounded launch window must not inherit legacy ownership");
assert.equal(legacyPidFileMatchesProcessStart({
  processStartedAt: "not-a-date",
  pidFileMtimeMs: processStartedAtMs,
}), false, "invalid process CreationDate must fail closed");
assert.equal(legacyPidFileMatchesProcessStart({
  processStartedAt,
  pidFileMtimeMs: Number.NaN,
}), false, "missing PID-file mtime must fail closed");

let releaseProbes = 0;
const released = await waitForTunnelPortRelease({
  port: 4411,
  isPortOpen: async () => ++releaseProbes < 3,
  timeoutMs: 100,
  intervalMs: 1,
  sleep: async () => {},
});
assert.equal(released, true, "stop settlement must wait through transient listener retention");
assert.equal(releaseProbes, 3, "port-release probe must retry until listener closes");

const notReleased = await waitForTunnelPortRelease({
  port: 4411,
  isPortOpen: async () => true,
  timeoutMs: 0,
  intervalMs: 1,
  sleep: async () => {},
});
assert.equal(notReleased, false, "stop settlement must fail closed when health listener does not release");

assert.equal(await waitForTunnelPortRelease({ port: 0, isPortOpen: async () => false }), false, "invalid health ports must not false-pass settlement");

console.log("manager-tunnel-state: ok (secret-safe PID+CreationDate+runtime launch identity + bounded process/listener stop settlement)");
