import { createHash } from "node:crypto";
import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * ChatGPT public MCP contract — source of truth for host-facing tool metadata.
 *
 * The ChatGPT connector caches a frozen snapshot of `tools/list`. Every field
 * below is part of that snapshot, so ANY change here is an ABI change:
 * - a connector Refresh becomes mandatory;
 * - the contract version MUST be bumped;
 * - the fixture `scripts/fixtures/chatgpt-public-contract-v1.json` MUST be
 *   regenerated intentionally (never by a normal test run).
 *
 * Internal executor changes (checkpoint backend, path validation, log format,
 * process cleanup, ...) must NEVER change the canonical hash.
 */
export const CHATGPT_PUBLIC_CONTRACT_VERSION = 1;

/** Env override that explicitly acknowledges a one-time contract drift.
 *  Never set in production; exists so a developer mid-refactor can boot the
 *  server before the fixture has been intentionally regenerated. */
export const CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE = "CHATGPT_PUBLIC_CONTRACT_DRIFT_OVERRIDE";

export const MCP_PUBLIC_CONTRACT_DRIFT = "MCP_PUBLIC_CONTRACT_DRIFT";

export interface PublicContractAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface PublicContractTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  annotations: PublicContractAnnotations;
}

export type PublicContractDocument = PublicContractTool[];

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalizeAnnotations(annotations?: ToolAnnotations): PublicContractAnnotations {
  return {
    readOnlyHint: Boolean(annotations?.readOnlyHint),
    destructiveHint: Boolean(annotations?.destructiveHint),
    idempotentHint: Boolean(annotations?.idempotentHint),
    openWorldHint: Boolean(annotations?.openWorldHint),
  };
}

/** Canonicalize one tool into the stable public-contract record shape.
 *  Order of the returned document is the registration order of `tools/list`,
 *  which is intentionally stable for the slim profile. */
export function canonicalizeTool(tool: Tool): PublicContractTool {
  return canonicalizeValue({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? {},
    annotations: canonicalizeAnnotations(tool.annotations),
  }) as PublicContractTool;
}

export function canonicalizeToolList(tools: Tool[]): PublicContractDocument {
  return tools.map(canonicalizeTool);
}

/** SHA-256 of the canonical JSON document (UTF-8, no timestamps, no paths). */
export function computeContractHash(tools: Tool[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeToolList(tools)), "utf8")
    .digest("hex");
}

export interface ContractComparison {
  ok: boolean;
  expectedVersion: number;
  expectedHash: string;
  actualHash: string;
  firstDifference?: string;
  actualCount: number;
  expectedCount: number;
}

function firstDifference(expected: PublicContractDocument, actual: PublicContractDocument): string | undefined {
  if (expected.length !== actual.length) {
    const expectedNames = expected.map((t) => t.name);
    const actualNames = actual.map((t) => t.name);
    const missing = expectedNames.filter((n) => !actualNames.includes(n));
    const extra = actualNames.filter((n) => !expectedNames.includes(n));
    return `tool count ${expected.length} != ${actual.length} (missing: ${missing.join(",") || "none"}, extra: ${extra.join(",") || "none"})`;
  }
  for (let i = 0; i < expected.length; i++) {
    if (JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) {
      return `tool[${i}] ${expected[i].name}: ${diffSummary(expected[i], actual[i])}`;
    }
  }
  return undefined;
}

function diffSummary(expected: PublicContractTool, actual: PublicContractTool): string {
  for (const key of ["title", "description", "inputSchema", "annotations"] as const) {
    const a = JSON.stringify(expected[key]);
    const b = JSON.stringify(actual[key]);
    if (a !== b) return `${key} differs`;
  }
  return "unknown field differs";
}

/** Compare live registered tools against an expected contract document. */
export function compareContract(
  tools: Tool[],
  expected: PublicContractDocument,
  expectedVersion = CHATGPT_PUBLIC_CONTRACT_VERSION
): ContractComparison {
  const actual = canonicalizeToolList(tools);
  const expectedHash = computeContractHash(
    expected.map((t) => ({
      name: t.name,
      title: t.title ?? undefined,
      description: t.description ?? undefined,
      inputSchema: t.inputSchema as Tool["inputSchema"],
      annotations: t.annotations as ToolAnnotations,
    }))
  );
  const actualHash = computeContractHash(tools);
  return {
    ok: actualHash === expectedHash,
    expectedVersion,
    expectedHash,
    actualHash,
    firstDifference: actualHash === expectedHash ? undefined : firstDifference(expected, actual),
    actualCount: actual.length,
    expectedCount: expected.length,
  };
}

/** Read the expected slim contract fixture from the repo (dev-time only). */
export async function loadExpectedContract(
  fixturePath: string
): Promise<{ version: number; document: PublicContractDocument }> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as { version: number; tools: PublicContractDocument };
  if (!Number.isInteger(parsed.version) || !Array.isArray(parsed.tools)) {
    throw new Error(`invalid contract fixture ${fixturePath}: expected {version, tools[]}`);
  }
  return { version: parsed.version, document: parsed.tools };
}

export { firstDifference };
