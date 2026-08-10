import { envBoundedInteger } from "./env-utils.js";

/**
 * Keep synchronous MCP work comfortably below the OpenAI tunnel/control-plane
 * request lifetime. Long jobs belong in start_process so the initial MCP
 * response returns quickly and later polling uses fresh requests.
 */
export function getSyncResponseBudgetMs(): number {
  return envBoundedInteger("MCP_SYNC_RESPONSE_BUDGET_MS", 100_000, 1_000, 115_000);
}

export function clampSyncTimeoutMs(configuredMs: number): number {
  const normalized = Number.isFinite(configuredMs) && configuredMs > 0 ? Math.floor(configuredMs) : 1;
  return Math.min(normalized, getSyncResponseBudgetMs());
}