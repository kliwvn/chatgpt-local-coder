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
  "MCP_SHELL_STATE_DIR",
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
  const configuredWorkspace = String(process.env.WORKSPACE_PATH || "").trim();
  let testBase = path.resolve(configuredWorkspace || path.dirname(process.cwd()));
  try {
    if (!(await fs.stat(testBase)).isDirectory()) testBase = os.tmpdir();
  } catch {
    testBase = os.tmpdir();
  }
  temp = await fs.mkdtemp(path.join(testBase, "clc-diag-"));
  setDefaultCwd(temp);
  setWorkspaceRoots([temp]);
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  process.env.FULL_DISK_ACCESS = "false";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(temp, ".sandbox-state");
  process.env.MCP_SHELL_STATE_DIR = path.join(temp, ".shell-state");
  process.env.SANDBOX_NETWORK_MODE = "none";
  resetProcessSecurityForTests();
  const sandbox = await initializeProcessSecurity();
  check("strict sandbox self-test passed", sandbox.sandbox_self_test === "passed", sandbox.sandbox_error || sandbox.sandbox_self_test);

  // server-factory imports persistent-shell/state-path, so load it only after
  // this suite has installed test-owned state roots.
  const { createMcpServer } = await import("../dist/server-factory.js");
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
  check("dispatch diagnostics expose correlated process-global scope", status.mcp_dispatch?.scope === "process_global_with_recent_correlated_dispatches", `${status.mcp_dispatch?.scope}`);
  check(
    "dispatch diagnostics forbid cross-chat counter attribution",
    /every MCP session\/chat/i.test(String(status.mcp_dispatch?.attribution_warning || "")) &&
      /counter delta alone does not prove/i.test(String(status.mcp_dispatch?.attribution_warning || "")) &&
      /current agent_status request/i.test(String(status.mcp_dispatch?.attribution_warning || "")),
    String(status.mcp_dispatch?.attribution_warning || "")
  );
  check("dispatch diagnostics describe secret-safe correlation", /basename only/i.test(String(status.mcp_dispatch?.correlation?.secret_safety || "")), JSON.stringify(status.mcp_dispatch?.correlation));
  check("host-gate protocol version 2 present", status.mcp_dispatch?.protocol?.version === 2, JSON.stringify(status.mcp_dispatch?.protocol)?.slice(0, 240));
  check("host-gate protocol standardizes canary prefix", status.mcp_dispatch?.protocol?.canary?.basename_prefix === ".clc-host-gate-canary-", JSON.stringify(status.mcp_dispatch?.protocol?.canary));
  check("host-gate protocol requires canonical canary shape+content", /8-64 character nonce/i.test(String(status.mcp_dispatch?.protocol?.canary?.recognition_rule || "")) && /content exactly matches/i.test(String(status.mcp_dispatch?.protocol?.canary?.recognition_rule || "")), JSON.stringify(status.mcp_dispatch?.protocol?.canary));
  check("host-gate protocol keeps a dedicated canary ledger", status.mcp_dispatch?.correlation?.canary_limit === status.mcp_dispatch?.protocol?.canary?.retained_records, JSON.stringify(status.mcp_dispatch?.correlation));
  check("host-gate diagnostics expose coverage start", !Number.isNaN(Date.parse(status.mcp_dispatch?.coverage?.canary?.complete_since || "")), JSON.stringify(status.mcp_dispatch?.coverage));
  check("host-gate absence requires same-process coverage", /same live Local Coder process/i.test(String(status.mcp_dispatch?.coverage?.absence_rule || "")) && /evicted attempt makes absence indeterminate/i.test(String(status.mcp_dispatch?.coverage?.absence_rule || "")), String(status.mcp_dispatch?.coverage?.absence_rule || ""));
  check("host-gate protocol has indeterminate no-coverage state", /evicted\/reset record/i.test(String(status.mcp_dispatch?.protocol?.classification?.INDETERMINATE_NO_COVERAGE?.evidence || "")), JSON.stringify(status.mcp_dispatch?.protocol?.classification));
  check("host-gate protocol distinguishes reached-unsettled", /state=reached/i.test(String(status.mcp_dispatch?.protocol?.classification?.MCP_REACHED_UNSETTLED?.evidence || "")), JSON.stringify(status.mcp_dispatch?.protocol?.classification));
  check("handler rejection warns about unknown side effects", /HANDLER_ERROR.*side-effect status is unknown/i.test(String(status.mcp_dispatch?.protocol?.classification?.MCP_REJECTED?.next_action || "")), String(status.mcp_dispatch?.protocol?.classification?.MCP_REJECTED?.next_action || ""));
  check("host-gate protocol says host surface is unobservable", status.mcp_dispatch?.protocol?.host_surface_checklist?.observable_by_server === false, JSON.stringify(status.mcp_dispatch?.protocol?.host_surface_checklist));
  check("host-gate support bundle is secret-safe", /Do not include file contents.*raw MCP session IDs.*API keys.*command text/i.test(String(status.mcp_dispatch?.protocol?.support_bundle?.privacy || "")), String(status.mcp_dispatch?.protocol?.support_bundle?.privacy || ""));
  check("host-gate protocol forbids annotation falsification", Array.isArray(status.mcp_dispatch?.protocol?.prohibitions) && status.mcp_dispatch.protocol.prohibitions.some((item) => /Do not weaken or falsify MCP annotations/i.test(String(item))), JSON.stringify(status.mcp_dispatch?.protocol?.prohibitions));
  check("host-gate protocol includes context bisect", Array.isArray(status.mcp_dispatch?.protocol?.context_bisect?.steps) && status.mcp_dispatch.protocol.context_bisect.steps.some((item) => /PASS->HOST_NOT_INVOKED/i.test(String(item))), JSON.stringify(status.mcp_dispatch?.protocol?.context_bisect));
  check("agent_status says host app identity is unobservable", status.identity_semantics?.chatgpt_app_install_identity === "unobservable", JSON.stringify(status.identity_semantics));
  check(
    "agent_status forbids using transport ids as app permission identity",
    /Do not use tunnel_id.*ChatGPT app\/install\/developer-connector permission identity/i.test(String(status.identity_semantics?.permission_lookup_guidance || "")),
    String(status.identity_semantics?.permission_lookup_guidance || "")
  );
  check(
    "quickstart forbids shell fallback for host-blocked typed writes",
    /do not retry a host-blocked typed write through run_command\/start_process/i.test(String(status.quickstart || "")),
    String(status.quickstart || "").slice(0, 500)
  );
  check(
    "quickstart says upstream refresh cannot refresh ChatGPT connector",
    /mcp_servers\(refresh=true\).*does not refresh\/rebind the ChatGPT/i.test(String(status.quickstart || "")),
    String(status.quickstart || "").slice(0, 700)
  );
  check(
    "quickstart separates transport ids from ChatGPT app identity",
    /tunnel_id\/client_instance_id\/boot_id\/PID\/MCP session ids are transport\/runtime identities, not ChatGPT app\/install permission identities/i.test(String(status.quickstart || "")),
    String(status.quickstart || "").slice(0, 1000)
  );
  check(
    "quickstart uses standardized host-gate protocol",
    /follow mcp_dispatch\.protocol v2.*\.clc-host-gate-canary-<UTC>-<nonce>\.tmp.*MCP_REACHED_UNSETTLED.*MCP_REJECTED.*MCP_EXECUTED.*HOST_NOT_INVOKED.*coverage\.canary\.complete_since.*INDETERMINATE_NO_COVERAGE/i.test(String(status.quickstart || "")),
    String(status.quickstart || "").slice(0, 2600)
  );
  check("agent_status process sandbox required", status.process_security?.process_sandbox_mode === "required", `${status.process_security?.process_sandbox_mode}`);
  check("agent_status AppContainer backend", status.process_security?.sandbox_backend === "windows_appcontainer", `${status.process_security?.sandbox_backend}`);
  check("agent_status sandbox self-test passed", status.process_security?.sandbox_self_test === "passed", `${status.process_security?.sandbox_self_test}`);
  check("shell_commands_os_sandboxed true", status.shell_commands_os_sandboxed === true, `${status.shell_commands_os_sandboxed}`);
  check("permission description names required AppContainer", /Windows AppContainer workspace sandbox/.test(String(status.permission_description || "")), String(status.permission_description));
  check("permission description says sandbox failure is fail-closed", /fail closed/i.test(String(status.permission_description || "")), String(status.permission_description));
  check("strict quickstart does not claim native unsandboxed execution", !/not OS-sandboxed|execute native shell commands/i.test(String(status.quickstart || "")), String(status.quickstart || "").slice(-220));

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
