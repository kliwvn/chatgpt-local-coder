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
const basicSecret = "dXNlcjpwYXNzd29yZA==";
const proxySecret = "proxy-token-value-13579";
const awsSecret = "aws-signature-value-97531";
const hyphenSecret = "hyphen-key-value-86420";
const command = `$env:OPENAI_TUNNEL_API_KEY='${secret}'; curl -H 'Authorization: Bearer ${bearer}' --token ${flagSecret} ${openAiSecret}`;

try {
  const redaction = await import("../dist/lib/redaction.js");
  assert.equal(redaction.isSecretKeyName("AUTHORIZATION"), true);
  assert.equal(redaction.isSecretKeyName("api-key"), true);
  assert.equal(redaction.isSecretKeyName("x.api.key"), true);
  const urlSecret = "url-token-secret-314159";
  const userSecret = "url-user-secret-271828";
  const passwordSecret = "url-password-secret-161803";
  const rawUrl = `https://${userSecret}:${passwordSecret}@example.invalid/mcp?access_token=${urlSecret}&mode=safe`;
  const maskedUrl = redaction.redactSensitiveUrl(rawUrl);
  for (const value of [urlSecret, userSecret, passwordSecret]) {
    assert.equal(maskedUrl.includes(value), false, "upstream URL redaction leaked credential material");
  }
  assert.match(maskedUrl, /mode=safe/, "URL redaction changed non-secret query configuration");
  const restoredUrl = redaction.restoreSensitiveUrl(maskedUrl, rawUrl);
  const restored = new URL(restoredUrl);
  assert.equal(decodeURIComponent(restored.username), userSecret);
  assert.equal(decodeURIComponent(restored.password), passwordSecret);
  assert.equal(restored.searchParams.get("access_token"), urlSecret);
  assert.equal(restored.searchParams.get("mode"), "safe");
  const changedHost = redaction.restoreSensitiveUrl(
    `https://${redaction.REDACTED_MASK}:${redaction.REDACTED_MASK}@other.invalid/mcp?access_token=${redaction.REDACTED_MASK}`,
    rawUrl,
  );
  assert.equal(changedHost.includes(urlSecret), false, "URL secret restoration crossed an endpoint identity change");
  const urlText = redaction.redactSensitiveText(`connect failed: ${rawUrl}`);
  for (const value of [urlSecret, userSecret, passwordSecret]) {
    assert.equal(urlText.includes(value), false, "free-text URL error redaction leaked credential material");
  }
  const text = redaction.redactSensitiveText(command);
  for (const value of [secret, bearer, flagSecret, openAiSecret]) assert.equal(text.includes(value), false);

  const variants = [
    `Authorization: Basic ${basicSecret}`,
    `Proxy-Authorization: Token ${proxySecret}`,
    `'Authorization: AWS4-HMAC-SHA256 Credential=user, Signature=${awsSecret}'`,
    `api-key=${hyphenSecret}`,
  ];
  for (const variant of variants) {
    const safe = redaction.redactSensitiveText(variant);
    for (const value of [basicSecret, proxySecret, awsSecret, hyphenSecret]) assert.equal(safe.includes(value), false, `redaction leaked variant: ${variant.split(":")[0]}`);
  }
  const jsonPayload = JSON.stringify({
    API_KEY: secret,
    "api-key": hyphenSecret,
    headers: { Authorization: `Bearer ${bearer}` },
    plain: "ok",
  });
  const redactedJson = redaction.redactSensitiveText(jsonPayload);
  const parsedRedactedJson = JSON.parse(redactedJson);
  assert.equal(parsedRedactedJson.API_KEY, redaction.REDACTED_MASK);
  assert.equal(parsedRedactedJson["api-key"], redaction.REDACTED_MASK);
  assert.equal(parsedRedactedJson.headers.Authorization.includes(bearer), false);
  assert.equal(parsedRedactedJson.plain, "ok");

  const quotedAuthWithTail = redaction.redactSensitiveText(`curl -H 'Authorization: Bearer ${bearer}' --next keep-me`);
  assert.match(quotedAuthWithTail, /Authorization:\s*\*{8}/i);
  assert.match(quotedAuthWithTail, /'Authorization:\s*\*{8}'/, "quoted Authorization redaction must preserve both shell quotes");
  assert.match(quotedAuthWithTail, /--next keep-me$/, "redaction must preserve non-secret command suffix after a quoted Authorization header");
  const basicWithTail = redaction.redactSensitiveText(`Authorization: Basic ${basicSecret} --next keep-me`);
  assert.match(basicWithTail, /--next keep-me$/, "Basic auth redaction must not consume following shell flags");

  const deep = redaction.redactSensitiveValue({ api_key: secret, "api-key": hyphenSecret, headers: { Authorization: `Bearer ${bearer}` }, command, nested: [{ password: flagSecret, plain: "ok" }] });
  const deepJson = JSON.stringify(deep);
  for (const value of [secret, bearer, flagSecret, openAiSecret, hyphenSecret]) assert.equal(deepJson.includes(value), false);
  assert.equal(deep.nested[0].plain, "ok");

  const activity = await import("../dist/lib/activity-log.js");
  const summary = activity.summarizeToolArgs("run_command", { command });
  for (const value of [secret, bearer, flagSecret, openAiSecret]) assert.equal(summary.includes(value), false);
  activity.logMcpRequest({ method: "tools/call", params: { name: "run_command", arguments: { command, API_KEY: secret } } }, "session-redaction-test", 3, 200);
  const entry = activity.getRecentActivity(1)[0];
  const entryJson = JSON.stringify(entry);
  for (const value of [secret, bearer, flagSecret, openAiSecret]) assert.equal(entryJson.includes(value), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry.details || {}, "arguments"), false, "raw MCP arguments must not be stored in activity");

  const legacyAuditSecret = "legacy-audit-secret-112233";
  const legacyAuditBackupSecret = "legacy-audit-backup-secret-445566";
  // Sparse oversized legacy history reproduces the OOM/CPU risk without writing
  // tens of MiB of physical data. Bounded migration should keep only the tail.
  const legacyLogicalBytes = 64 * 1024 * 1024;
  const legacyTail = Buffer.from(
    `\n${JSON.stringify({ time: new Date().toISOString(), details: { API_KEY: legacyAuditSecret } })}` +
      `\nAuthorization: Bearer ${legacyAuditSecret}\n`,
    "utf8"
  );
  const legacyHandle = await fs.open(process.env.AUDIT_LOG_PATH, "w");
  try {
    await legacyHandle.truncate(legacyLogicalBytes);
    await legacyHandle.write(legacyTail, 0, legacyTail.length, legacyLogicalBytes - legacyTail.length);
  } finally {
    await legacyHandle.close();
  }
  assert.equal((await fs.stat(process.env.AUDIT_LOG_PATH)).size, legacyLogicalBytes);
  await fs.mkdir(`${process.env.AUDIT_LOG_PATH}.1`);

  const audit = await import("../dist/lib/audit.js");
  await audit.audit({ tool: "run_command", action: "migration-first-attempt", status: "error", details: { command, API_KEY: secret } });
  const afterFailedMigration = await fs.readFile(process.env.AUDIT_LOG_PATH, "utf8");
  assert.ok((await fs.stat(process.env.AUDIT_LOG_PATH)).size <= 1024 * 1024, "historical audit migration must have a hard retention bound");
  assert.equal(afterFailedMigration.includes("\u0000"), false, "partial sparse audit prefix must be discarded");
  assert.equal(afterFailedMigration.includes(legacyAuditSecret), false, "active history should be scrubbed before a later generation failure");
  assert.equal(afterFailedMigration.includes("migration-first-attempt"), false, "audit append must fail closed when historical scrub cannot complete");

  await fs.rm(`${process.env.AUDIT_LOG_PATH}.1`, { recursive: true, force: true });
  await fs.writeFile(
    `${process.env.AUDIT_LOG_PATH}.1`,
    JSON.stringify({ time: new Date().toISOString(), details: { "x.api.key": legacyAuditBackupSecret } }) + "\n",
    "utf8"
  );
  await audit.audit({ tool: "run_command", action: "command", status: "error", details: { command, API_KEY: secret } });
  const auditDisk = await fs.readFile(process.env.AUDIT_LOG_PATH, "utf8");
  const auditBackupDisk = await fs.readFile(`${process.env.AUDIT_LOG_PATH}.1`, "utf8");
  assert.equal(auditDisk.includes(legacyAuditSecret), false, "historical active audit log retained plaintext secret");
  assert.equal(auditBackupDisk.includes(legacyAuditBackupSecret), false, "historical rotated audit log retained plaintext secret");
  const newest = auditDisk.trim().split(/\r?\n/).at(-1) || "";
  for (const value of [secret, bearer, flagSecret, openAiSecret]) assert.equal(newest.includes(value), false, "audit record leaked secret");
  JSON.parse(newest);

  console.log("redaction: ok");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
