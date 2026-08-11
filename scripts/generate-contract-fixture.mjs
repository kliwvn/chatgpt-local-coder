/**
 * Dev-only fixture generator: dumps the live slim profile tools/list into
 * scripts/fixtures/chatgpt-public-contract-v1.json.
 *
 * This is an EXPLICIT developer operation. Running it regenerates the
 * authoritative contract fixture; the change must ship as an ABI bump commit.
 *
 * Usage: npm run build && node scripts/generate-contract-fixture.mjs
 * (build first — the generator imports dist/, not src/).
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";
import { getUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";
import { setDefaultCwd, setWorkspaceRoots } from "../dist/lib/path-security.js";
import {
  CHATGPT_PUBLIC_CONTRACT_VERSION,
  canonicalizeToolList,
  computeContractHash,
} from "../dist/lib/chatgpt-public-contract.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-fixture-"));
const oldProfile = process.env.CHATGPT_TOOL_PROFILE;
const oldCwd = process.env.CODEX_WORKSPACE_ROOT;
const oldDriftOverride = process.env.CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE;
try {
  // The generator's whole purpose is to capture an intentionally changed ABI;
  // the slim startup self-check would fail-closed against the previous
  // fixture before we can list tools. Override is explicit, dev-only, and
  // scoped to this process — production boots never set it.
  process.env.CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE = "1";
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  setDefaultCwd(temp);
  setWorkspaceRoots([temp]);

  const server = await createMcpServer(temp, 10, [temp], false, getUpstreamManager());
  const client = new Client({ name: "fixture-gen", version: "1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const listed = await client.listTools();
  await client.close();

  const document = canonicalizeToolList(listed.tools);
  const hash = computeContractHash(listed.tools);
  const fixturePath = path.join(process.cwd(), "scripts", "fixtures", `chatgpt-public-contract-v${CHATGPT_PUBLIC_CONTRACT_VERSION}.json`);
  await fs.mkdir(path.dirname(fixturePath), { recursive: true });
  const payload = { version: CHATGPT_PUBLIC_CONTRACT_VERSION, hash, tools: document };
  await fs.writeFile(fixturePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`fixture: ${fixturePath}`);
  console.log(`version=${CHATGPT_PUBLIC_CONTRACT_VERSION} tools=${document.length} hash=${hash}`);
} finally {
  if (oldProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
  else process.env.CHATGPT_TOOL_PROFILE = oldProfile;
  if (oldCwd === undefined) delete process.env.CODEX_WORKSPACE_ROOT;
  else process.env.CODEX_WORKSPACE_ROOT = oldCwd;
  if (oldDriftOverride === undefined) delete process.env.CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE;
  else process.env.CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE = oldDriftOverride;
  setDefaultCwd(os.homedir());
  setWorkspaceRoots([]);
  // Temp dir is left for OS-managed cleanup in os.tmpdir(): direct recursive
  // removal is prohibited by the repo P0 safety policy.
}
