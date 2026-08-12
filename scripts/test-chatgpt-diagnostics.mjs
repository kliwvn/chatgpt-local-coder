/**
 * Diagnostics contract: prove which layer gates a write, without claiming host
 * permission we cannot observe.
 *
 * Covers:
 * - agent_status exposes the public-contract fingerprint (version, hash,
 *   tool_count, dynamic flags) alongside boot identity;
 * - permission terminology separates the local executor profile from the
 *   unobservable ChatGPT host action gate;
 * - the startup drift guard fails closed with MCP_PUBLIC_CONTRACT_DRIFT on an
 *   intentionally corrupted registration, and only an explicit
 *   CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE=1 permits a dev-only boot.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";
import { setDefaultCwd, setWorkspaceRoots } from "../dist/lib/path-security.js";
import {
  initializeProcessSecurity,
  resetProcessSecurityForTests,
} from "../dist/lib/process-executor.js";
import {
  CHATGPT_PUBLIC_CONTRACT_VERSION,
  MCP_PUBLIC_CONTRACT_DRIFT,
} from "../dist/lib/chatgpt-public-contract.js";
import { assertNoContractDrift, getContractFingerprint } from "../dist/lib/contract-fingerprint.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", `chatgpt-public-contract-v${CHATGPT_PUBLIC_CONTRACT_VERSION}.json`);
const fixtureRaw = JSON.parse(await fs.readFile(fixturePath, "utf8"));

let passed = 0;
let failed = 0;
const oldEnv = Object.fromEntries([
  "FULL_DISK_ACCESS",
  "LOCAL_CODER_INSTANCE_ID",
  "CLC_SANDBOX_PROFILE_NAME",
  "CLC_SANDBOX_STATE_DIR",
  "SANDBOX_NETWORK_MODE",
].map((key) => [key, process.env[key]]));
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }
function check(name, cond, detail) {
  if (cond) ok(name);
  else fail(name, detail ?? "condition false");
}

async function callTool(server, name, args) {
  const client = new Client({ name: "diag-check", version: "1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  const payload = result.structuredContent;
  return payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
}

const servers = [];
let temp;
try {
  const testBase = path.resolve(process.env.WORKSPACE_PATH?.trim() || path.dirname(process.cwd()));
  temp = await fs.mkdtemp(path.join(testBase, "clc-diag-"));
  setDefaultCwd(temp);
  setWorkspaceRoots([temp]);
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  process.env.FULL_DISK_ACCESS = "false";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(temp, ".sandbox-state");
  process.env.SANDBOX_NETWORK_MODE = "none";
  resetProcessSecurityForTests();
  const sandbox = await initializeProcessSecurity();
  check("strict sandbox self-test passed", sandbox.sandbox_self_test === "passed", sandbox.sandbox_error || sandbox.sandbox_self_test);

  const server = await createMcpServer(temp, 10, [temp], false);
  servers.push(server);

  // --- 1. agent_status fingerprint + boot identity ------------------------
  const status = await callTool(server, "agent_status", {});
  check("agent_status returns data payload", status && typeof status === "object", JSON.stringify(status)?.slice(0, 120));

  const contract = status.mcp_contract;
  check("agent_status exposes mcp_contract", !!contract, "mcp_contract missing");
  check("mcp_contract.version is 1", contract?.version === CHATGPT_PUBLIC_CONTRACT_VERSION, `${contract?.version}`);
  check("mcp_contract.hash equals fixture hash", contract?.hash === fixtureRaw.hash, `${contract?.hash} != ${fixtureRaw.hash}`);
  check("mcp_contract.tool_count equals fixture tools", contract?.tool_count === fixtureRaw.tools.length, `${contract?.tool_count} != ${fixtureRaw.tools.length}`);
  check("mcp_contract.profile is slim", contract?.profile === "slim", `${contract?.profile}`);
  check("slim is not dynamic_tools", contract?.dynamic_tools === false, `${contract?.dynamic_tools}`);
  check("slim advertises no list_changed", contract?.list_changed === false, `${contract?.list_changed}`);

  check("boot.boot_id present", typeof status.boot?.boot_id === "string" && status.boot.boot_id.length > 0, String(status.boot?.boot_id));
  check("boot.pid matches process", status.boot?.pid === process.pid, `${status.boot?.pid} != ${process.pid}`);
  check("boot.node matches runtime", status.boot?.node === process.version, `${status.boot?.node} != ${process.version}`);
  check("boot.process_started_at parseable", !Number.isNaN(Date.parse(status.boot?.process_started_at ?? "")), String(status.boot?.process_started_at));

  // --- 2. permission terminology (local vs unobservable host) --------------
  check("backward-compat permission_profile kept", status.permission_profile === "open", `${status.permission_profile}`);
  check("local_executor_profile present", status.local_executor_profile === "open", `${status.local_executor_profile}`);
  check("local_write_allowed true", status.local_write_allowed === true, `${status.local_write_allowed}`);
  check("host_action_permission unobservable", status.host_action_permission === "unobservable", `${status.host_action_permission}`);
  check("host_write_gate unobservable", status.host_write_gate === "unobservable", `${status.host_write_gate}`);
  check("HOST_NOT_INVOKED is externally inferred only", status.host_not_invoked_semantics === "externally_inferred_only", `${status.host_not_invoked_semantics}`);
  check("agent_status process sandbox required", status.process_security?.process_sandbox_mode === "required", `${status.process_security?.process_sandbox_mode}`);
  check("agent_status AppContainer backend", status.process_security?.sandbox_backend === "windows_appcontainer", `${status.process_security?.sandbox_backend}`);
  check("agent_status sandbox self-test passed", status.process_security?.sandbox_self_test === "passed", `${status.process_security?.sandbox_self_test}`);
  check("shell_commands_os_sandboxed true", status.shell_commands_os_sandboxed === true, `${status.shell_commands_os_sandboxed}`);

  // --- 3. drift guard: fails closed on corruption --------------------------
  const internal = server._registeredTools;
  const originalDesc = internal["read_text_file"]?.description;
  internal["read_text_file"].description = "INTENTIONAL CORRUPTION";
  let driftError = null;
  try {
    await assertNoContractDrift(server);
  } catch (e) {
    driftError = e;
  }
  check(
    "corrupted registration throws MCP_PUBLIC_CONTRACT_DRIFT",
    driftError instanceof Error && driftError.message.startsWith(`${MCP_PUBLIC_CONTRACT_DRIFT}:`),
    driftError ? driftError.message.slice(0, 160) : "no throw"
  );
  internal["read_text_file"].description = originalDesc;

  // --- 4. explicit override permits dev-only boot --------------------------
  internal["read_text_file"].description = "INTENTIONAL CORRUPTION";
  process.env.CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE = "1";
  let overrideError = null;
  try {
    await assertNoContractDrift(server);
  } catch (e) {
    overrideError = e;
  }
  check("explicit override does not throw", overrideError === null, overrideError ? String(overrideError).slice(0, 160) : "ok");
  delete process.env.CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE;
  internal["read_text_file"].description = originalDesc;

  // --- 5. getContractFingerprint helper agrees -----------------------------
  const fp = await getContractFingerprint();
  check("getContractFingerprint version", fp.version === CHATGPT_PUBLIC_CONTRACT_VERSION, `${fp.version}`);
  check("getContractFingerprint hash", fp.hash === fixtureRaw.hash, `${fp.hash} != ${fixtureRaw.hash}`);
  check("getContractFingerprint tool_count", fp.tool_count === fixtureRaw.tools.length, `${fp.tool_count}`);
  check("getContractFingerprint profile reads env", fp.profile === "slim", `${fp.profile}`);
} catch (e) {
  fail("setup", e);
} finally {
  for (const s of servers) await s.close().catch(() => {});
  resetProcessSecurityForTests();
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
