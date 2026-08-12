/**
 * Regression test: manager env endpoints must never ship plaintext secrets.
 *
 * Spawns a throwaway manager (temp INSTANCES_DIR, no auto-start) and asserts:
 *   1. GET /api/instances/:name/env omits the plaintext OPENAI_TUNNEL_API_KEY
 *      and ADMIN_TOKEN, and returns the set/last4 shape for the tunnel key.
 *   2. Legacy GET /api/env does the same.
 *   3. Saving the masked raw editor after editing a non-secret line preserves
 *      the on-disk secrets (sentinel round-trip).
 *   4. Saving via `values` with sentinels also preserves them.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MASK = "********";

function jsonFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

async function waitForPort(port, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/status`);
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`manager did not start on port ${port}`);
}

const port = 4600 + Math.floor(Math.random() * 300);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-manager-redact-"));
let server;
try {
  await fs.mkdir(path.join(dir, "instances", "test"), { recursive: true });
  // Real test-owned workspace root: save-time validation rejects an empty or
  // missing WORKSPACE_PATH (WORKSPACE_SCOPE_MISSING), and redaction coverage
  // must not depend on an invalid fixture.
  const workspaceDir = path.join(dir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  // Minimal valid instance .env: no tunnel creds conflicts, unique ports.
  const envText = [
    `PORT=${port + 1}`,
    `ADMIN_PORT=${port + 2}`,
    `WORKSPACE_PATH=${workspaceDir.replaceAll("\\", "/")}`,
    "CHATGPT_TOOL_PROFILE=slim",
    "CHATGPT_AUTO_APPROVE=true",
    "SHELL_TIMEOUT=120",
    "OPENAI_TUNNEL_ID=test-id-123",
    "OPENAI_TUNNEL_API_KEY=sk-test-super-secret-9999",
    "ADMIN_TOKEN=admin-token-abc-12345",
    "AUTHORIZATION=manager-authorization-secret-24680",
    `OPENAI_TUNNEL_HEALTH_PORT=${port + 3}`,
  ].join("\n");
  await fs.writeFile(path.join(dir, "instances", "test", ".env"), envText, "utf-8");
  await fs.writeFile(
    path.join(dir, "instances", "test", "config.json"),
    JSON.stringify({ lastTunnelUrl: "", healthPort: port + 3, autoStart: false }),
    "utf-8"
  );

  server = spawn(process.execPath, ["manager/server.mjs", "--no-open"], {
    cwd: root,
    env: {
      ...process.env,
      MANAGER_PORT: String(port),
      MANAGER_INSTANCES_DIR: path.join(dir, "instances"),
      MANAGER_STATE_DIR: path.join(dir, "state"),
      // Ensure no legacy ROOT/.env migration surprises.
      MCP_ENV_FILE: path.join(dir, "env-legacy-do-not-use"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout?.on("data", (d) => (logs += d));
  server.stderr?.on("data", (d) => (logs += d));

  await waitForPort(port);

  const base = `http://127.0.0.1:${port}`;

  // 1. Instance env GET — masked.
  const instGet = await jsonFetch(`${base}/api/instances/test/env`);
  if (!instGet.body?.ok) throw new Error(`instance env GET failed: ${JSON.stringify(instGet.body)}`);
  const values = instGet.body.values;
  if (values.OPENAI_TUNNEL_API_KEY !== "sk-test-super-secret-9999") {
    if (!values.OPENAI_TUNNEL_API_KEY?.set || values.OPENAI_TUNNEL_API_KEY.last4 !== "9999") {
      throw new Error(`OPENAI_TUNNEL_API_KEY not masked: ${JSON.stringify(values.OPENAI_TUNNEL_API_KEY)}`);
    }
  } else {
    throw new Error("OPENAI_TUNNEL_API_KEY leaked plaintext on instance env GET");
  }
  if (values.ADMIN_TOKEN !== MASK) throw new Error(`ADMIN_TOKEN not masked: ${JSON.stringify(values.ADMIN_TOKEN)}`);
  if (values.AUTHORIZATION !== MASK) throw new Error(`AUTHORIZATION not masked: ${JSON.stringify(values.AUTHORIZATION)}`);
  if (values.PORT !== String(port + 1)) throw new Error("non-secret value changed on the wire");

  // 2. Legacy env GET — masked.
  const legacyGet = await jsonFetch(`${base}/api/env`);
  if (!legacyGet.body?.ok) throw new Error(`legacy env GET failed: ${JSON.stringify(legacyGet.body)}`);
  if (legacyGet.body.values.OPENAI_TUNNEL_API_KEY !== "sk-test-super-secret-9999") {
    if (!legacyGet.body.values.OPENAI_TUNNEL_API_KEY?.set) {
      throw new Error(`legacy env leaked: ${JSON.stringify(legacyGet.body.values.OPENAI_TUNNEL_API_KEY)}`);
    }
  } else {
    throw new Error("OPENAI_TUNNEL_API_KEY leaked plaintext on legacy env GET");
  }
  if (legacyGet.body.values.ADMIN_TOKEN !== MASK) {
    throw new Error("legacy env ADMIN_TOKEN not masked");
  }
  if (legacyGet.body.values.AUTHORIZATION !== MASK) {
    throw new Error("legacy env AUTHORIZATION not masked");
  }

  // 3. Raw editor round-trip: send the masked raw, changing one supported non-secret value.
  const raw = Object.entries(values)
    .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? MASK : v}`)
    .join("\n")
    .replace("SHELL_TIMEOUT=120", "SHELL_TIMEOUT=121");
  const rawSave = await jsonFetch(`${base}/api/instances/test/env`, {
    method: "PUT",
    body: JSON.stringify({ raw }),
  });
  if (!rawSave.body?.ok) throw new Error(`raw save failed: ${JSON.stringify(rawSave.body)}`);
  const afterRaw = await fs.readFile(path.join(dir, "instances", "test", ".env"), "utf-8");
  if (!afterRaw.includes("OPENAI_TUNNEL_API_KEY=sk-test-super-secret-9999")) {
    throw new Error("raw save erased OPENAI_TUNNEL_API_KEY");
  }
  if (!afterRaw.includes("ADMIN_TOKEN=admin-token-abc-12345")) {
    throw new Error("raw save erased ADMIN_TOKEN");
  }
  if (!afterRaw.includes("AUTHORIZATION=manager-authorization-secret-24680")) {
    throw new Error("raw save erased AUTHORIZATION");
  }
  if (!afterRaw.includes("SHELL_TIMEOUT=121")) throw new Error("raw save lost the non-secret edit");
  if (/^CHATGPT_AUTO_APPROVE=/m.test(afterRaw)) throw new Error("raw save preserved obsolete CHATGPT_AUTO_APPROVE");

  // 4. values-path sentinel round-trip.
  const valuesSave = await jsonFetch(`${base}/api/instances/test/env`, {
    method: "PUT",
    body: JSON.stringify({ values: { SHELL_TIMEOUT: "90", OPENAI_TUNNEL_API_KEY: MASK, ADMIN_TOKEN: MASK, AUTHORIZATION: MASK } }),
  });
  if (!valuesSave.body?.ok) throw new Error(`values save failed: ${JSON.stringify(valuesSave.body)}`);
  const afterValues = await fs.readFile(path.join(dir, "instances", "test", ".env"), "utf-8");
  if (!afterValues.includes("OPENAI_TUNNEL_API_KEY=sk-test-super-secret-9999")) {
    throw new Error("values save erased OPENAI_TUNNEL_API_KEY");
  }
  if (!afterValues.includes("ADMIN_TOKEN=admin-token-abc-12345")) {
    throw new Error("values save erased ADMIN_TOKEN");
  }
  if (!afterValues.includes("AUTHORIZATION=manager-authorization-secret-24680")) {
    throw new Error("values save erased AUTHORIZATION");
  }
  if (!afterValues.includes("SHELL_TIMEOUT=90")) throw new Error("values save lost the non-secret edit");

  // 5. Manager must reject invalid runtime limits instead of persisting values
  // that the server would later have to silently repair/fallback at startup.
  const invalidLimitSave = await jsonFetch(`${base}/api/instances/test/env`, {
    method: "PUT",
    body: JSON.stringify({ values: { ACTIVITY_LOG_MAX: "-1" } }),
  });
  if (invalidLimitSave.body?.ok !== false) {
    throw new Error(`invalid ACTIVITY_LOG_MAX was accepted: ${JSON.stringify(invalidLimitSave.body)}`);
  }
  const afterInvalid = await fs.readFile(path.join(dir, "instances", "test", ".env"), "utf-8");
  if (afterInvalid.includes("ACTIVITY_LOG_MAX=-1")) {
    throw new Error("invalid ACTIVITY_LOG_MAX was persisted despite validation failure");
  }

  const invalidEditLimitSave = await jsonFetch(`${base}/api/instances/test/env`, {
    method: "PUT",
    body: JSON.stringify({ values: { EDIT_TEXT_MAX_BYTES: "1" } }),
  });
  if (invalidEditLimitSave.body?.ok !== false) {
    throw new Error(`invalid EDIT_TEXT_MAX_BYTES was accepted: ${JSON.stringify(invalidEditLimitSave.body)}`);
  }
  const afterInvalidEditLimit = await fs.readFile(path.join(dir, "instances", "test", ".env"), "utf-8");
  if (afterInvalidEditLimit.includes("EDIT_TEXT_MAX_BYTES=1")) {
    throw new Error("invalid EDIT_TEXT_MAX_BYTES was persisted despite validation failure");
  }

  const invalidSyncBudgetSave = await jsonFetch(`${base}/api/instances/test/env`, {
    method: "PUT",
    body: JSON.stringify({ values: { MCP_SYNC_RESPONSE_BUDGET_MS: "115001" } }),
  });
  if (invalidSyncBudgetSave.body?.ok !== false) {
    throw new Error(`invalid MCP_SYNC_RESPONSE_BUDGET_MS was accepted: ${JSON.stringify(invalidSyncBudgetSave.body)}`);
  }
  const afterInvalidSyncBudget = await fs.readFile(path.join(dir, "instances", "test", ".env"), "utf-8");
  if (afterInvalidSyncBudget.includes("MCP_SYNC_RESPONSE_BUDGET_MS=115001")) {
    throw new Error("invalid MCP_SYNC_RESPONSE_BUDGET_MS was persisted despite validation failure");
  }

  // 6. Cross-field output-budget invariants must be validated at the Manager
  // boundary. A text-duplication threshold above the total wire budget would
  // re-enable oversized duplicate responses and must never reach disk.
  const invalidBudgetSave = await jsonFetch(`${base}/api/instances/test/env`, {
    method: "PUT",
    body: JSON.stringify({
      values: {
        MCP_TOOL_RESULT_MAX_BYTES: "262144",
        MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES: "524288",
      },
    }),
  });
  if (invalidBudgetSave.body?.ok !== false) {
    throw new Error(`invalid output budget relation was accepted: ${JSON.stringify(invalidBudgetSave.body)}`);
  }
  const afterInvalidBudget = await fs.readFile(path.join(dir, "instances", "test", ".env"), "utf-8");
  if (
    afterInvalidBudget.includes("MCP_TOOL_RESULT_MAX_BYTES=262144") ||
    afterInvalidBudget.includes("MCP_TOOL_RESULT_TEXT_DUPLICATE_MAX_BYTES=524288")
  ) {
    throw new Error("invalid output budget relation was persisted despite validation failure");
  }

  console.log("OK manager env redaction: secrets masked/preserved, runtime/output budget limits rejected safely");
} finally {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
}
