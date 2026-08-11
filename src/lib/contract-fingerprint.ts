import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { getChatGptToolProfile } from "./tool-profile.js";
import {
  CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE,
  CHATGPT_PUBLIC_CONTRACT_VERSION,
  MCP_PUBLIC_CONTRACT_DRIFT,
  compareContract,
  loadExpectedContract,
  type ContractComparison,
} from "./chatgpt-public-contract.js";

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/fixtures",
  `chatgpt-public-contract-v${CHATGPT_PUBLIC_CONTRACT_VERSION}.json`
);

export interface ContractFingerprint {
  profile: string;
  version: number;
  hash: string;
  tool_count: number;
  dynamic_tools: boolean;
  list_changed: boolean;
}

let bootId: string | undefined;
/** Stable per-process identity so diagnostics can distinguish restarts. */
export function getBootId(): string {
  if (!bootId) bootId = randomUUID();
  return bootId;
}

function toolInputSchema(schema: RegisteredTool["inputSchema"]): Tool["inputSchema"] {
  const obj = normalizeObjectSchema(schema);
  const jsonSchema = obj
    ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: "input" })
    : { type: "object", properties: {} };
  // toJsonSchemaCompat returns a looser JsonSchema type than Tool["inputSchema"];
  // the runtime value is identical to what the SDK's list handler emits.
  return jsonSchema as Tool["inputSchema"];
}

/**
 * Snapshot the registered tools exactly as the SDK's ListToolsRequestHandler
 * serializes them (same schema normalization + JSON Schema conversion), so the
 * startup self-check compares against what a host client would actually see.
 */
export function snapshotRegisteredTools(server: McpServer): Tool[] {
  // The SDK exposes no public accessor for the registered tool registry; this
  // internal shape is stable in the pinned SDK version (1.30.0) and is exactly
  // what the SDK's ListToolsRequestHandler serializes.
  const serverInternal = server as unknown as {
    _registeredTools?: Record<string, RegisteredTool & { enabled?: boolean }>;
  };
  const registry = serverInternal._registeredTools;
  if (!registry) {
    throw new Error(`${MCP_PUBLIC_CONTRACT_DRIFT}: SDK tool registry is not inspectable`);
  }
  return Object.entries(registry)
    .filter(([, tool]) => tool.enabled !== false)
    .map(([name, tool]) => ({
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: toolInputSchema(tool.inputSchema),
      annotations: tool.annotations,
    }));
}

async function loadFixtureHash(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const parsed = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("hash" in parsed)) {
    throw new Error(`${MCP_PUBLIC_CONTRACT_DRIFT}: fixture ${FIXTURE_PATH} has no canonical hash`);
  }
  const hash = parsed.hash;
  if (typeof hash !== "string" || !hash) {
    throw new Error(`${MCP_PUBLIC_CONTRACT_DRIFT}: fixture ${FIXTURE_PATH} has no canonical hash`);
  }
  return hash;
}

/** Runtime contract fingerprint for /health and agent_status. */
export async function getContractFingerprint(): Promise<ContractFingerprint> {
  const { document } = await loadExpectedContract(FIXTURE_PATH);
  const profile = getChatGptToolProfile();
  const dynamic = profile === "full";
  return {
    profile,
    version: CHATGPT_PUBLIC_CONTRACT_VERSION,
    hash: await loadFixtureHash(),
    tool_count: document.length,
    dynamic_tools: dynamic,
    list_changed: dynamic,
  };
}

/**
 * Compare the live registered tool list against the authoritative fixture.
 * Never auto-accepts drift: an explicit CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE
 * is required to boot with a mismatched contract (developer-only).
 */
export async function verifyLiveContract(server: McpServer): Promise<ContractComparison> {
  const { version, document } = await loadExpectedContract(FIXTURE_PATH);
  return compareContract(snapshotRegisteredTools(server), document, version);
}

export async function assertNoContractDrift(server: McpServer): Promise<void> {
  const comparison = await verifyLiveContract(server);
  if (comparison.ok) return;
  if (process.env[CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE] === "1") {
    // Developer override: log a high-signal warning and continue. Never set in
    // production; exists so a mid-refactor boot can run before the fixture has
    // been intentionally regenerated.
    console.warn(
      `${MCP_PUBLIC_CONTRACT_DRIFT} (override): expected v${comparison.expectedVersion} ${comparison.expectedHash}, got ${comparison.actualHash}; ${comparison.firstDifference ?? "unknown difference"}`
    );
    return;
  }
  throw new Error(
    `${MCP_PUBLIC_CONTRACT_DRIFT}: expected v${comparison.expectedVersion} hash ${comparison.expectedHash}, got ${comparison.actualHash}; ${comparison.firstDifference ?? "unknown difference"}. Regenerate the fixture intentionally (node scripts/generate-contract-fixture.mjs) or set ${CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE}=1 for a dev-only boot.`
  );
}
