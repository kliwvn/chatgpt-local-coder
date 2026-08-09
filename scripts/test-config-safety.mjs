import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundedInteger, envIntegerOrThrow } from "../dist/lib/env-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

assert.equal(boundedInteger("42", 7, 1, 100), 42);
assert.equal(boundedInteger("42junk", 7, 1, 100), 7);
assert.equal(boundedInteger("-1", 7, 1, 100), 7);
assert.equal(boundedInteger("101", 7, 1, 100), 7);

const oldTestPort = process.env.TEST_STRICT_PORT;
try {
  process.env.TEST_STRICT_PORT = "4321";
  assert.equal(envIntegerOrThrow("TEST_STRICT_PORT", 3000, 1, 65_535), 4321);
  process.env.TEST_STRICT_PORT = "4321junk";
  assert.throws(() => envIntegerOrThrow("TEST_STRICT_PORT", 3000, 1, 65_535), /TEST_STRICT_PORT/);
} finally {
  if (oldTestPort === undefined) delete process.env.TEST_STRICT_PORT;
  else process.env.TEST_STRICT_PORT = oldTestPort;
}

// Regression: ACTIVITY_LOG_MAX=-1 previously made appendActivity() spin forever
// because entries.length > -1 can never become false. Run the existing activity
// suite in a child with a hard timeout so a regression fails deterministically.
const activity = spawnSync(process.execPath, [path.join(root, "scripts", "test-activity-log.mjs")], {
  cwd: root,
  env: { ...process.env, ACTIVITY_LOG_MAX: "-1" },
  encoding: "utf8",
  timeout: 5000,
});
if (activity.error) throw activity.error;
assert.equal(activity.status, 0, `activity invalid-config child failed: ${activity.stderr || activity.stdout}`);

console.log("config-safety: ok (strict integer fallback, invalid activity limit cannot hang)");