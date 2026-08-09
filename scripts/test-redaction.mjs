import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-redaction-"));
process.env.AUDIT_LOG_PATH = path.join(dir, "audit.log");
process.env.AUDIT_LOG_MAX_BYTES = "1048576";

const secret = "super-secret-value-12345";
const bearer = "bearer-token-value-67890";
const flagSecret = "flag-token-value-24680";
const openAiSecret = "sk-proj-abcdefghijk123456789";
const command = `$env:OPENAI_TUNNEL_API_KEY='${secret}'; curl -H 'Authorization: Bearer ${bearer}' --token ${flagSecret} ${openAiSecret}`;

try {
  const redaction = await import("../dist/lib/redaction.js");
  const text = redaction.redactSensitiveText(command);
  for (const value of [secret, bearer, flagSecret, openAiSecret]) assert.equal(text.includes(value), false);

  const deep = redaction.redactSensitiveValue({ api_key: secret, headers: { Authorization: `Bearer ${bearer}` }, command, nested: [{ password: flagSecret, plain: "ok" }] });
  const deepJson = JSON.stringify(deep);
  for (const value of [secret, bearer, flagSecret, openAiSecret]) assert.equal(deepJson.includes(value), false);
  assert.equal(deep.nested[0].plain, "ok");

  const activity = await import("../dist/lib/activity-log.js");
  const summary = activity.summarizeToolArgs("run_command", { command });
  for (const value of [secret, bearer, flagSecret, openAiSecret]) assert.equal(summary.includes(value), false);
  activity.logMcpRequest({ method: "tools/call", params: { name: "run_command", arguments: { command, API_KEY: secret } } }, "session-redaction-test", 3, 200);
  const entry = activity.getRecentActivity(1)[0];
  const entryJson = JSON.stringify(entry);
  for (const value of [secret, bearer, flagSecret, openAiSecret]) assert.equal(entryJson.includes(value), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry.details || {}, "arguments"), false, "raw MCP arguments must not be stored in activity");

  const audit = await import("../dist/lib/audit.js");
  await audit.audit({ tool: "run_command", action: "command", status: "error", details: { command, API_KEY: secret } });
  const newest = (await fs.readFile(process.env.AUDIT_LOG_PATH, "utf8")).trim().split(/\r?\n/).at(-1) || "";
  for (const value of [secret, bearer, flagSecret, openAiSecret]) assert.equal(newest.includes(value), false, "audit record leaked secret");
  JSON.parse(newest);

  console.log("redaction: ok");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
