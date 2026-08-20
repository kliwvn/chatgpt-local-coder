import assert from "node:assert/strict";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("../manager/server.mjs", import.meta.url), "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

assert.match(source, /const instanceCommandChains = new Map\(\)/,
  "Server and Tunnel commands must share one per-instance arrival-order queue");
assert.match(source, /const instanceIntentState = new Map\(\)[\s\S]{0,900}?function beginInstanceIntent\(name, type\)/,
  "per-instance coalescing must have a shared intent generation/barrier");

for (const intent of [
  "server:start",
  "server:stop",
  "server:restart",
  "tunnel:start",
  "tunnel:stop",
  "tunnel:restart",
  "instance:delete",
  "instance:rename",
  "instance:config",
]) {
  assert.ok(source.includes(`beginInstanceIntent(name, "${intent}")`), `missing intent barrier: ${intent}`);
}

const serverCommand = section("function enqueueServerCommand(name, operation)", "function enqueueServerLifecycle");
assert.match(serverCommand, /enqueueInstanceCommand\(name, operation\)/,
  "Gateway public commands must participate in the shared instance queue");
const tunnelCommand = section("function enqueueTunnelCommand(name, operation)", "function enqueueTunnelLifecycle");
assert.match(tunnelCommand, /enqueueInstanceCommand\(name, operation\)/,
  "Tunnel public commands must participate in the shared instance queue");

const restartServer = section("async function restartServer(name)", "async function tunnelStatus");
assert.match(restartServer, /intent\.consecutiveSameType \? serverRestartInFlight\.get\(name\) : null/,
  "Gateway Restart may coalesce only consecutive duplicate restart intents");
assert.match(restartServer, /intent\.previousType === "server:start"[\s\S]{0,180}?serverStartInFlight\.get\(name\)/,
  "Gateway Restart may reuse only the immediately preceding Start generation");

const startTunnel = section("async function startTunnel(name)", "async function stopTunnel(name)");
assert.match(startTunnel, /intent\.consecutiveSameType \? tunnelStartInFlight\.get\(name\) : null/,
  "Tunnel Start may coalesce only consecutive duplicate Start intents");
const restartTunnel = section("async function restartTunnel(name)", "async function downloadCloudflared");
assert.match(restartTunnel, /intent\.consecutiveSameType \? tunnelRestartInFlight\.get\(name\) : null/,
  "Tunnel Restart may coalesce only consecutive duplicate restart intents");
assert.match(restartTunnel, /intent\.previousType === "tunnel:start"[\s\S]{0,180}?tunnelStartInFlight\.get\(name\)/,
  "Tunnel Restart may reuse only the immediately preceding Tunnel Start generation");

const catalogBarrier = section("function enqueueInstanceCatalogCommand(name, operation)", "async function createInstanceUnlocked");
const instanceTicket = catalogBarrier.indexOf("const instanceRun = enqueueInstanceCommand");
const catalogTicket = catalogBarrier.indexOf("return enqueueInstanceCatalogMutation");
assert.ok(instanceTicket >= 0 && catalogTicket > instanceTicket,
  "catalog commands must reserve their per-instance ticket before waiting for the global catalog turn");
assert.match(catalogBarrier, /markInstanceTurn\(\)[\s\S]{0,120}?await catalogTurnGranted/,
  "the per-instance ticket must rendezvous with the catalog ticket before mutation");
assert.match(catalogBarrier, /await instanceTurnReached[\s\S]{0,120}?grantCatalogTurn\(\)[\s\S]{0,120}?return instanceRun/,
  "the catalog ticket must release only the matching reserved per-instance command");

const deleteUnlocked = section("async function deleteInstanceUnlocked(name)", "async function deleteInstance(name)");
assert.match(deleteUnlocked, /enqueueTunnelLifecycle\(name, \(\) => stopTunnelUnlocked\(name\)\)/,
  "Delete must use the internal Tunnel primitive while already owning the public instance queue");
assert.match(deleteUnlocked, /enqueueRuntimeDeploy\([\s\S]{0,180}?stopServerUnlocked\(name\)/,
  "Delete must settle the internal Gateway stop under shared deployment ordering");
assert.doesNotMatch(deleteUnlocked, /await stop(?:Server|Tunnel)\(name\)/,
  "Delete must not recursively enqueue a public lifecycle command and deadlock itself");

const deleteWrapper = section("async function deleteInstance(name)", "async function proveInstanceInactiveWithoutConfig");
assert.match(deleteWrapper, /enqueueInstanceCatalogCommand\(name, \(\) => deleteInstanceUnlocked\(name\)\)/,
  "Delete must reserve both catalog and per-instance ordering before touching authority metadata");
assert.match(deleteWrapper, /serverStartInFlight\.delete\(name\)[\s\S]{0,220}?tunnelRestartInFlight\.delete\(name\)/,
  "Delete must invalidate stale lifecycle coalescing ledgers");

const renameWrapper = section("async function renameInstance(name, body)", "async function saveInstanceEnvUnlocked");
assert.match(renameWrapper, /enqueueInstanceCatalogCommand\(name, \(\) => renameInstanceUnlocked\(name, body\)\)/,
  "Rename must reserve both catalog and per-instance ordering");

const envWrapper = section("async function saveInstanceEnv(name, body)", "async function saveInstanceConfig(name, body)");
assert.match(envWrapper, /enqueueInstanceCommand\([\s\S]{0,180}?enqueueFileMutation/,
  ".env saves must serialize with lifecycle authority reads");
const configWrapper = section("async function saveInstanceConfig(name, body)", "\/\* ------------------------------------------------------------------ \*\/");
assert.match(configWrapper, /enqueueInstanceCommand\(name, \(\) => updateInstanceConfig/,
  "config.json saves must serialize with lifecycle/catalog commands");

assert.equal((source.match(/const config = await saveInstanceConfig\(/g) || []).length, 2,
  "both per-instance and legacy config PUT routes must use the ordered config wrapper");

console.log("manager command/catalog ordering static invariants: ok");