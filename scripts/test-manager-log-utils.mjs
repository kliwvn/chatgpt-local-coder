import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyTruncateLogFile, redactSensitiveLogText, rotateLogFile, scrubLogFile, tailFile } from "../manager/log-utils.mjs";
import { redactSensitiveText } from "../dist/lib/redaction.js";

const managerApp = await fs.readFile(new URL("../manager/app.js", import.meta.url), "utf8");
assert.match(managerApp, /COMMAND \(\?:FAILED\|NO MATCH\)/, "MCP-only filter must include command outcomes");
assert.match(managerApp, /TOOL FAILED\|COMMAND FAILED/, "error styling must include the new failure taxonomy");
assert.doesNotMatch(
  managerApp,
  /MCP ERROR\|TOOL ERROR\|\\\[err[^\n]+cls = "err"/,
  "error styling must not remain on the legacy-only taxonomy"
);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-local-coder-log-"));
try {
  const utf8 = path.join(dir, "utf8.log");
  await fs.writeFile(utf8, "xx🙂Z", "utf8");
  assert.equal(await tailFile(utf8, 4), "Z", "tail should skip leading UTF-8 continuation bytes");
  assert.equal((await tailFile(utf8, 64)).includes("\uFFFD"), false, "full tail must not inject replacement chars");
  assert.equal(await tailFile(utf8, 64), "xx🙂Z", "tail must preserve a complete trailing multibyte codepoint");

  const secret = "manager-log-secret-123456";
  const bearer = "managerBearerToken123456";
  const redacted = redactSensitiveLogText(
    `$env:OPENAI_TUNNEL_API_KEY=${secret}; Authorization: Bearer ${bearer}; --token ${secret}; sk-proj-abcdefghijk123456`
  );
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes(bearer), false);
  assert.match(redacted, /OPENAI_TUNNEL_API_KEY=\*{8}/);
  assert.match(redacted, /Authorization:\s*\*{8}/i);
  assert.match(redacted, /--token\s+\*{8}/i);
  assert.match(redacted, /sk-\*{8}/);

  const parityCorpus = [
    "$env:OPENAI_TUNNEL_API_KEY=fakeSecret123; --token fakeToken123",
    "curl -H 'Authorization: Bearer fakeBearer123' --next keep-me",
    "Authorization: Basic ZmFrZTpmYWtl --next keep-me",
    "Proxy-Authorization: Token fakeProxy123 --next keep-me",
    "api-key=fakeHyphen123 --next keep-me",
    "x.api.key=fakeDotted123 --next keep-me",
    JSON.stringify({ API_KEY: "fakeJsonSecret123", "api-key": "fakeHyphenJson123", plain: "ok" }),
    "plain=keep-me",
  ];
  for (const sample of parityCorpus) {
    assert.equal(
      redactSensitiveLogText(sample),
      redactSensitiveText(sample),
      "Manager/runtime redactors must stay in sync"
    );
  }
  const redactedJson = redactSensitiveLogText(JSON.stringify({ API_KEY: "fakeJsonSecret123", plain: "ok" }));
  assert.deepEqual(JSON.parse(redactedJson), { API_KEY: "********", plain: "ok" }, "Manager redaction must preserve valid JSON/JSONL");

  const historical = path.join(dir, "historical.log");
  await fs.writeFile(historical, `x.api.key=${secret}\nAuthorization: Bearer ${bearer}\nplain=keep-me\n`, "utf8");
  assert.equal(await scrubLogFile(historical), true, "historical managed log should be scrubbed on disk");
  const historicalDisk = await fs.readFile(historical, "utf8");
  assert.equal(historicalDisk.includes(secret), false);
  assert.equal(historicalDisk.includes(bearer), false);
  assert.match(historicalDisk, /plain=keep-me/);
  assert.equal(await scrubLogFile(historical), false, "already-scrubbed log should be a no-op");
  const unsrubbable = path.join(dir, "unsrubbable.log");
  await fs.mkdir(unsrubbable);
  await assert.rejects(scrubLogFile(unsrubbable), "non-ENOENT scrub failures must fail closed instead of pretending the log is clean");

  const log = path.join(dir, "server.log");
  await fs.writeFile(log, "first-generation", "utf8");
  assert.equal(await rotateLogFile(log, 4, 2), true);
  assert.equal(await fs.readFile(`${log}.1`, "utf8"), "first-generation");
  await fs.writeFile(log, "second-generation", "utf8");
  assert.equal(await rotateLogFile(log, 4, 2), true);
  assert.equal(await fs.readFile(`${log}.1`, "utf8"), "second-generation");
  assert.equal(await fs.readFile(`${log}.2`, "utf8"), "first-generation");
  assert.equal(await rotateLogFile(log, 4, 2), false, "missing active log is a no-op");

  // Live log maintenance: below-threshold files remain untouched.
  const below = path.join(dir, "below-threshold.log");
  await fs.writeFile(below, "small-log\n", "utf8");
  assert.equal(await copyTruncateLogFile(below, 64 * 1024, 2), false);
  assert.equal(await fs.readFile(below, "utf8"), "small-log\n");

  // Fail closed: if backup rotation cannot complete, never truncate the active log.
  const blocked = path.join(dir, "blocked-live.log");
  const blockedBody = "blocked-line\n".repeat(7000);
  await fs.writeFile(blocked, blockedBody, "utf8");
  await fs.mkdir(`${blocked}.2`);
  await assert.rejects(copyTruncateLogFile(blocked, 32 * 1024, 2));
  assert.equal(await fs.readFile(blocked, "utf8"), blockedBody);
  assert.equal((await fs.readdir(dir)).some((name) => name.startsWith("blocked-live.log.rotate-")), false);

  // Overlapping maintenance for one file is serialized; only one rotation wins.
  const concurrent = path.join(dir, "concurrent-live.log");
  await fs.writeFile(concurrent, "concurrent-line\n".repeat(7000), "utf8");
  const concurrentResults = await Promise.all([
    copyTruncateLogFile(concurrent, 32 * 1024, 2),
    copyTruncateLogFile(concurrent, 32 * 1024, 2),
  ]);
  assert.deepEqual(concurrentResults.slice().sort(), [false, true]);
  assert.equal((await fs.stat(concurrent)).size, 0);

  // Oversized legacy backup generations are dropped instead of retaining
  // plaintext or forcing an unbounded redaction pass during live maintenance.
  const legacyLarge = path.join(dir, "legacy-large.log");
  await fs.writeFile(legacyLarge, "active-line\n".repeat(7000), "utf8");
  await fs.writeFile(`${legacyLarge}.1`, "legacy-secret x.api.key=drop-me\n".repeat(4000), "utf8");
  assert.equal(await copyTruncateLogFile(legacyLarge, 32 * 1024, 2), true);
  assert.equal(await fs.stat(`${legacyLarge}.2`).then(() => true).catch(() => false), false);

  // A child holding an append-mode fd keeps writing after copy-truncate on Windows.
  const live = path.join(dir, "live.log");
  const writer = path.join(dir, "live-writer.mjs");
  const liveSecret = "live-copytruncate-secret-778899";
  await fs.writeFile(writer, [
    "const secret = process.argv[2];",
    "let i = 0;",
    "const timer = setInterval(() => {",
    "  console.log(`line-${String(i).padStart(3, '0')}-x.api.key=${secret}-${i}-${'x'.repeat(4096)}`);",
    "  i++;",
    "  if (i >= 120) { clearInterval(timer); setTimeout(() => process.exit(0), 20); }",
    "}, 5);",
    "",
  ].join("\n"), "utf8");
  const legacyBackupSecret = "legacy-live-backup-secret-445566";
  await fs.writeFile(`${live}.1`, `previous-1 x.api.key=${legacyBackupSecret}\nplain-old-backup\n`, "utf8");
  await fs.writeFile(`${live}.2`, "previous-2\n", "utf8");
  const liveFd = fsSync.openSync(live, "a");
  const child = spawn(process.execPath, [writer, liveSecret], {
    stdio: ["ignore", liveFd, liveFd],
    windowsHide: true,
  });
  fsSync.closeSync(liveFd);
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const st = await fs.stat(live).catch(() => null);
      if (st && st.size > 80 * 1024) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok((await fs.stat(live)).size > 80 * 1024, "live writer did not reach rotation threshold");
    assert.equal(await copyTruncateLogFile(live, 64 * 1024, 2), true);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("live writer timeout")), 5000);
      child.once("error", (err) => { clearTimeout(timeout); reject(err); });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve() : reject(new Error(`live writer exited ${code}`));
      });
    });

    const liveBackup = await fs.readFile(`${live}.1`, "utf8");
    const liveOldBackup = await fs.readFile(`${live}.2`, "utf8");
    const liveActive = await fs.readFile(live, "utf8");
    assert.equal(liveBackup.includes(liveSecret), false, "live backup retained plaintext secret");
    assert.match(liveBackup, /line-\d{3}-/);
    assert.equal(liveOldBackup.includes(legacyBackupSecret), false, "shifted legacy backup retained plaintext secret");
    assert.match(liveOldBackup, /previous-1 x\.api\.key=\*{8}/);
    assert.match(liveOldBackup, /plain-old-backup/);
    assert.match(liveActive, /line-119-/);
    assert.equal(liveActive.includes("\u0000"), false, "copy-truncate produced sparse/NUL corruption");
    assert.equal((await fs.readdir(dir)).some((name) => name.startsWith("live.log.rotate-")), false);
  } finally {
    if (child.exitCode == null) child.kill("SIGKILL");
  }

  // Wiring guard: Manager schedules both log kinds through lifecycle queues.
  const managerSource = await fs.readFile(new URL("../manager/server.mjs", import.meta.url), "utf8");
  assert.match(managerSource, /MANAGED_LOG_SWEEP_MS\s*=\s*60\s*\*\s*1000/);
  assert.match(managerSource, /\["server",\s*inst\.serverLog,\s*enqueueServerLifecycle\]/);
  assert.match(managerSource, /\["tunnel",\s*inst\.tunnelLog,\s*enqueueTunnelLifecycle\]/);
  assert.match(managerSource, /enqueueLifecycle\(name,\s*\(\)\s*=>\s*copyTruncateLogFile\(file\)\)/);
  assert.match(managerSource, /setInterval\(sweep,\s*MANAGED_LOG_SWEEP_MS\)/);
  assert.match(managerSource, /timer\.unref\?\.\(\)/);
  assert.match(managerSource, /startManagedLogMaintenance\(\);/);
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
console.log("manager-log-utils: ok");
