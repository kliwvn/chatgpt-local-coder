/**
 * Lock the ChatGPT public MCP contract.
 *
 * The slim profile is a frozen ABI for the ChatGPT host connector:
 * - exact tool inventory (names, order, count) — invariant across restart,
 *   workspace, upstream config, and whether an upstream manager is attached;
 * - exact canonical document hash — any drift fails this test;
 * - no `listChanged` advertisement in slim;
 * - bridge tools (mcp_servers/mcp_tools/mcp_call) always present and callable;
 * - upstream proxy refresh can never leak native tools into slim.
 *
 * Updating the contract is an explicit developer operation: bump
 * CHATGPT_PUBLIC_CONTRACT_VERSION and regenerate the fixture with
 * `node scripts/generate-contract-fixture.mjs`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";
import { refreshProxiedTools } from "../dist/lib/mcp-tool-proxy.js";
import { getDefaultCwd, getWorkspaceRoots, setDefaultCwd, setWorkspaceRoots } from "../dist/lib/path-security.js";
import {
  CHATGPT_PUBLIC_CONTRACT_VERSION,
  canonicalizeToolList,
  compareContract,
  computeContractHash,
  loadExpectedContract,
} from "../dist/lib/chatgpt-public-contract.js";

const fixturePath = path.join(import.meta.dirname, "fixtures", `chatgpt-public-contract-v${CHATGPT_PUBLIC_CONTRACT_VERSION}.json`);
const { version, document: expected } = await loadExpectedContract(fixturePath);
const fixtureRaw = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const oldProfile = process.env.CHATGPT_TOOL_PROFILE;
const oldRuntimeEnv = Object.fromEntries([
  "FULL_DISK_ACCESS",
  "LOCAL_CODER_INSTANCE_ID",
  "CLC_SANDBOX_PROFILE_NAME",
  "CLC_SANDBOX_STATE_DIR",
  "MCP_SHELL_STATE_DIR",
].map((key) => [key, process.env[key]]));
const oldCwd = getDefaultCwd();
const oldRoots = getWorkspaceRoots();

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }
function check(name, cond, detail) {
  if (cond) ok(name);
  else fail(name, detail ?? "condition false");
}

async function snapshot(server) {
  const client = new Client({ name: "contract-check", version: "1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const caps = await client.getServerCapabilities();
  const listed = await client.listTools();
  await client.close();
  return { caps, tools: listed.tools };
}

async function callTool(server, name, args) {
  const client = new Client({ name: "contract-check", version: "1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return result;
}

const servers = [];
let temp;
try {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-contract-"));
  process.env.FULL_DISK_ACCESS = "true";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(temp, ".sandbox-state");
  process.env.MCP_SHELL_STATE_DIR = path.join(temp, ".shell-state");
  setDefaultCwd(temp);
  setWorkspaceRoots([temp]);
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  const { createMcpServer } = await import("../dist/server-factory.js");

  // --- 1. exact fixture match, no manager ---------------------------------
  const noMgr = await createMcpServer(temp, 10, [temp], false);
  servers.push(noMgr);
  const a = await snapshot(noMgr);
  check("slim inventory size matches fixture", a.tools.length === expected.length, `${a.tools.length} != ${expected.length}`);
  const namesA = canonicalizeToolList(a.tools).map((t) => t.name);
  check("slim inventory names+order match fixture", JSON.stringify(namesA) === JSON.stringify(expected.map((t) => t.name)));
  const cmpA = compareContract(a.tools, expected, version);
  check("slim document matches fixture exactly (hash)", cmpA.ok, cmpA.firstDifference);
  const hashA = computeContractHash(a.tools);
  check("live hash equals fixture hash", hashA === fixtureRaw.hash, `${hashA} != ${fixtureRaw.hash}`);

  // --- 2. bridge/manager invariance ---------------------------------------
  const withMgr = await createMcpServer(temp, 10, [temp], false, getUpstreamManager());
  servers.push(withMgr);
  const b = await snapshot(withMgr);
  const hashB = computeContractHash(b.tools);
  check("manager-attached inventory identical (hash)", hashA === hashB, `${hashA} != ${hashB}`);
  check("manager-attached inventory identical (names)", JSON.stringify(namesA) === JSON.stringify(b.tools.map((t) => t.name)));

  // --- 3. no listChanged advertisement in slim -----------------------------
  check("slim does not advertise listChanged", !(a.caps?.tools?.listChanged ?? false), JSON.stringify(a.caps?.tools));
  check("manager-attached slim does not advertise listChanged", !(b.caps?.tools?.listChanged ?? false), JSON.stringify(b.caps?.tools));

  // --- 4. no proxy leak under refresh -------------------------------------
  const manager = getUpstreamManager();
  await manager.reloadConfig();
  await refreshProxiedTools(withMgr, manager);
  const after = await snapshot(withMgr);
  check("proxy refresh does not change slim inventory", computeContractHash(after.tools) === hashA);
  check("proxy refresh does not broadcast listChanged in slim", !(after.caps?.tools?.listChanged ?? false));

  // --- 5. bridge tools callable without a manager --------------------------
  const serversRes = await callTool(noMgr, "mcp_servers", {});
  const toolsRes = await callTool(noMgr, "mcp_tools", { server_id: "x" });
  const callRes = await callTool(noMgr, "mcp_call", { server_id: "x", tool: "y" });
  check(
    "mcp_servers works without manager (empty)",
    Array.isArray(serversRes.content) && serversRes.content.some((c) => typeof c.text === "string" && c.text.includes('"count":0'))
  );
  check("mcp_tools errors cleanly without manager", Boolean(toolsRes.isError));
  check("mcp_call errors cleanly without manager", Boolean(callRes.isError));

  // The public remember tool stays in the frozen ABI, but when the canonical
  // Global Harness bootstrap is active its legacy Local Coder memory write plane
  // must be inactive rather than competing with project/Harness Memory.
  const rememberRes = await callTool(noMgr, "remember", { note: "contract probe: must not persist under Global Harness" });
  const rememberText = JSON.stringify(rememberRes);
  check(
    "remember stays ABI-compatible but is no-write under canonical Global Harness",
    rememberText.includes('"saved":false') && rememberText.includes('"inactive":true') && rememberText.includes("global_harness_project_memory"),
    rememberText
  );

  // --- 6. full profile stays dynamic --------------------------------------
  process.env.CHATGPT_TOOL_PROFILE = "full";
  const full = await createMcpServer(temp, 10, [temp], false);
  servers.push(full);
  const f = await snapshot(full);
  const fullNames = f.tools.map((t) => t.name);
  check("full profile advertises listChanged", Boolean(f.caps?.tools?.listChanged), JSON.stringify(f.caps?.tools));
  check("full profile exposes every slim tool", namesA.every((n) => fullNames.includes(n)));
  check("full profile adds dynamic-profile tools", f.tools.length > expected.length, `${f.tools.length} <= ${expected.length}`);
  for (const n of ["read_file_base64", "git_branch", "git_push", "stop_process"]) {
    check(`full profile exposes ${n}`, fullNames.includes(n));
  }
} catch (e) {
  fail("setup", e.stack ?? e);
} finally {
  for (const s of servers) await s.close().catch(() => undefined);
  if (oldProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
  else process.env.CHATGPT_TOOL_PROFILE = oldProfile;
  for (const [key, value] of Object.entries(oldRuntimeEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setDefaultCwd(oldCwd);
  setWorkspaceRoots(oldRoots);
  // Temp dir is left for OS-managed cleanup in os.tmpdir(): direct recursive
  // removal is prohibited by the repo P0 safety policy.
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
