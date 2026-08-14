import assert from "node:assert/strict";
import {
  evaluateOpenAiTunnelLaunchState,
  openAiTunnelLaunchFingerprint,
  waitForTunnelPortRelease,
} from "../manager/tunnel-state.mjs";

const base = {
  tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
  apiKey: "sk-test-secret-not-persisted",
  healthPort: 4411,
  serverPort: 3000,
};
const fingerprint = openAiTunnelLaunchFingerprint(base);
assert.match(fingerprint, /^[0-9a-f]{64}$/);
assert.ok(!fingerprint.includes(base.apiKey), "fingerprint must never contain plaintext secret");

for (const [field, value] of [
  ["tunnelId", "tunnel_fedcba9876543210fedcba9876543210"],
  ["apiKey", "sk-different-secret"],
  ["healthPort", 4412],
  ["serverPort", 3002],
]) {
  const changed = openAiTunnelLaunchFingerprint({ ...base, [field]: value });
  assert.notEqual(changed, fingerprint, `${field} drift must change launch fingerprint`);
}

const exact = evaluateOpenAiTunnelLaunchState({
  mode: "openai",
  healthy: true,
  processPids: [1234],
  savedPid: 1234,
  savedFingerprint: fingerprint,
  desiredFingerprint: fingerprint,
});
assert.equal(exact.desired, true);
assert.equal(exact.configDrift, false);
assert.equal(exact.ambiguous, false);
assert.equal(exact.pidMatch, true);
assert.equal(exact.fingerprintMatch, true);

for (const [label, override] of [
  ["legacy missing fingerprint", { savedFingerprint: undefined }],
  ["legacy missing pid", { savedPid: null }],
  ["pid replacement", { processPids: [4321] }],
  ["fingerprint/config drift", { desiredFingerprint: openAiTunnelLaunchFingerprint({ ...base, apiKey: "sk-new" }) }],
  ["unhealthy transport", { healthy: false }],
  ["wrong mode", { mode: "cloudflare" }],
]) {
  const state = evaluateOpenAiTunnelLaunchState({
    mode: "openai",
    healthy: true,
    processPids: [1234],
    savedPid: 1234,
    savedFingerprint: fingerprint,
    desiredFingerprint: fingerprint,
    ...override,
  });
  assert.equal(state.desired, false, `${label} must not be accepted as desired`);
  assert.equal(state.configDrift, true, `${label} must fail closed as config drift`);
}

const duplicate = evaluateOpenAiTunnelLaunchState({
  mode: "openai",
  healthy: true,
  processPids: [1234, 5678],
  savedPid: 1234,
  savedFingerprint: fingerprint,
  desiredFingerprint: fingerprint,
});
assert.equal(duplicate.desired, false);
assert.equal(duplicate.configDrift, true);
assert.equal(duplicate.ambiguous, true);
assert.equal(duplicate.duplicateProcesses, true);
assert.deepEqual(duplicate.pids, [1234, 5678]);

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

console.log("manager-tunnel-state: ok (secret-safe launch identity + bounded process/listener stop settlement)");
