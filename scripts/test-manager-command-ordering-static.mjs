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
assert.match(source, /const instanceIntentState = new Map\(\)/,
  "per-instance coalescing must retain shared intent-generation state");
assert.match(source, /function beginInstanceIntent\(name, type\)[\s\S]{0,500}?instanceIntentState\.set\(name, current\)/,
  "per-instance coalescing must publish each shared intent generation/barrier");

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

const runtimeDeploy = section("async function ensureRuntimeAndServerUnlocked(name", "async function startServer(name)");
assert.doesNotMatch(runtimeDeploy, /if \(!names\.includes\(name\)\) names\.push\(name\)/,
  "runtime deploy must never resurrect a lifecycle target that disappeared from the managed catalog");
assert.match(runtimeDeploy, /if \(!names\.includes\(name\)\)[\s\S]{0,500}?retryable:\s*true[\s\S]{0,260}?staleInstanceAuthority:\s*true[\s\S]{0,500}?refusing to recreate stale lifecycle authority/,
  "runtime deploy must fail closed with explicit stale-authority semantics when its target leaves the catalog");

const startServer = section("async function startServer(name)", "async function stopServer(name)");
assert.match(startServer, /serverStartInFlight\.set\(name, pending\)[\s\S]{0,700}?\[manager-command\].*intent=server:start.*registered=true/,
  "Gateway Start must expose a pre-build registration marker after its shared command promise is published");

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
assert.match(deleteUnlocked, /enqueueTunnelLifecycle\(name, \(\) => stopTunnelWithTrafficDrainUnlocked\(name\)\)/,
  "Delete must use the internal drain-aware Tunnel primitive while already owning the public instance queue");
assert.doesNotMatch(deleteUnlocked, /enqueueTunnelLifecycle\(name, \(\) => stopTunnelUnlocked\(name\)\)/,
  "Delete must not bypass MCP traffic drain when stopping Tunnel");
assert.match(deleteUnlocked, /enqueueRuntimeDeploy\([\s\S]{0,180}?stopServerUnlocked\(name\)/,
  "Delete must settle the internal Gateway stop under shared deployment ordering");
assert.doesNotMatch(deleteUnlocked, /await stop(?:Server|Tunnel)\(name\)/,
  "Delete must not recursively enqueue a public lifecycle command and deadlock itself");

const deleteWrapper = section("async function deleteInstance(name)", "async function proveInstanceInactiveWithoutConfig");
assert.match(deleteWrapper, /enqueueInstanceCatalogCommand\(name, \(\) => deleteInstanceUnlocked\(name\)\)/,
  "Delete must reserve both catalog and per-instance ordering before touching authority metadata");
assert.match(deleteWrapper, /serverStartInFlight\.delete\(name\)[\s\S]{0,220}?tunnelRestartInFlight\.delete\(name\)/,
  "Delete must invalidate stale lifecycle coalescing ledgers");
assert.match(deleteWrapper, /const marker = \{ type: "delete", pending \}[\s\S]{0,180}?instanceCatalogMutationInFlight\.set\(name, marker\)[\s\S]{0,260}?return await pending[\s\S]{0,220}?instanceCatalogMutationInFlight\.delete\(name\)/,
  "Delete must publish a catalog tombstone before yielding and clear only its own marker after settlement");

const renameWrapper = section("async function renameInstance(name, body)", "async function saveInstanceEnvUnlocked");
assert.match(renameWrapper, /enqueueInstanceCatalogCommand\(name, \(\) => renameInstanceUnlocked\(name, body\)\)/,
  "Rename must reserve both catalog and per-instance ordering");
assert.match(renameWrapper, /const marker = \{ type: "rename", pending \}[\s\S]{0,180}?instanceCatalogMutationInFlight\.set\(name, marker\)[\s\S]{0,260}?return await pending[\s\S]{0,220}?instanceCatalogMutationInFlight\.delete\(name\)/,
  "Rename must publish a catalog tombstone before yielding and clear only its own marker after settlement");

const envWrapper = section("async function saveInstanceEnv(name, body)", "async function saveInstanceConfig(name, body)");
assert.match(envWrapper, /enqueueInstanceCommand\([\s\S]{0,180}?enqueueFileMutation/,
  ".env saves must serialize with lifecycle authority reads");
const configWrapper = section("async function saveInstanceConfig(name, body)", "\/\* ------------------------------------------------------------------ \*\/");
assert.match(configWrapper, /enqueueInstanceCommand\(name, \(\) => updateInstanceConfig/,
  "config.json saves must serialize with lifecycle/catalog commands");

assert.match(source, /const config = await dispatchInstanceMutation\(\(\) => saveInstanceConfig\(name, body\)\)/,
  "per-instance config PUT must dispatch through request-admission ordering before the ordered config wrapper");
assert.match(source, /const config = await dispatchDefaultMutation\(\(\) => saveInstanceConfig\(dname, body\)\)/,
  "legacy config PUT must dispatch through the same request-admission authority");
assert.match(source, /const LEGACY_DEFAULT_ADMISSION_MUTATIONS = new Set\(\[[\s\S]{0,800}?"PUT:\/api\/env"[\s\S]{0,800}?"PUT:\/api\/config"[\s\S]{0,800}?"POST:\/api\/server\/start"[\s\S]{0,800}?"POST:\/api\/server\/stop"[\s\S]{0,800}?"POST:\/api\/server\/restart"[\s\S]{0,800}?"POST:\/api\/tunnel\/start"[\s\S]{0,800}?"POST:\/api\/tunnel\/stop"[\s\S]{0,800}?"POST:\/api\/tunnel\/restart"/,
  "all legacy default config/lifecycle mutations must reserve the per-instance admission chain");
assert.match(source, /function reserveLegacyDefaultMutationAdmission\(req, url\)[\s\S]{0,900}?defaultInstanceNameForAdmission\(\)[\s\S]{0,500}?reserveInstanceRequestAdmission\(name\)[\s\S]{0,220}?legacyDefault:\s*true/,
  "legacy admission must freeze the target synchronously and share the direct per-instance admission chain");
assert.match(source, /function catalogMutationConflict\(name\)[\s\S]{0,500}?retryable:\s*true[\s\S]{0,220}?staleInstanceAuthority:\s*true/,
  "catalog changes must expose an explicit retryable stale-authority conflict");
assert.match(source, /async function handleApi\(req, res, url, body, instanceAdmission = null\)[\s\S]{0,900}?instanceAdmission\?\.name[\s\S]{0,300}?catalogMutationConflict\(instanceAdmission\.name\)[\s\S]{0,220}?return json\(res, 200, conflict\)[\s\S]{0,500}?await listInstances\(\)/,
  "admitted stale mutations must surface catalog authority conflicts before generic instance existence guards");
assert.match(source, /const dispatchInstanceMutation = \(operation\)[\s\S]{0,500}?instanceAdmission\.dispatch\(\(\) => catalogMutationConflict\(name\) \|\| operation\(\)\)/,
  "all later direct mutations must fail closed behind an in-flight Delete/Rename tombstone");
assert.match(source, /const dname = instanceAdmission\?\.legacyDefault === true[\s\S]{0,300}?instanceAdmission\.name[\s\S]{0,500}?const dispatchDefaultMutation = \(operation\)[\s\S]{0,500}?instanceAdmission\.dispatch\(\(\) => catalogMutationConflict\(dname\) \|\| operation\(\)\)/,
  "legacy handlers must keep the frozen admission target and reject stale authority before command registration");
for (const call of [
  "saveInstanceEnv(dname, body)",
  "startServer(dname)",
  "stopServer(dname)",
  "restartServer(dname)",
  "startTunnel(dname)",
  "stopTunnel(dname)",
  "restartTunnel(dname)",
]) {
  assert.ok(source.includes(`dispatchDefaultMutation(() => ${call})`), `legacy mutation must use shared admission dispatcher: ${call}`);
}

console.log("manager command/catalog ordering static invariants: ok");