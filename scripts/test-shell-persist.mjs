/**
 * Global shell cwd persists across bootstrap (simulates ChatGPT new MCP sessions).
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  bootstrapShellSession,
  ensureShellBootstrap,
  execInShellSession,
  getShellStatus,
  resetShellSessionQueued,
} from "../dist/lib/persistent-shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const stateDir = path.join(root, ".tool-test-tmp", "shell-persist");

process.env.MCP_SHELL_STATE_DIR = stateDir;

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  await fs.rm(stateDir, { recursive: true, force: true });
  await ensureShellBootstrap(root);
  await execInShellSession(process.platform === "win32" ? "cd src" : "cd src", root, 5000);

  const cwd1 = getShellStatus().cwd;
  if (!cwd1.replace(/\\/g, "/").endsWith("/src")) {
    throw new Error(`expected cwd in src, got ${cwd1}`);
  }
  ok(`cwd after cd: ${cwd1}`);

  // Transport churn must not re-read disk state and overwrite the global shell
  // cwd/history with an older snapshot. Force an intentionally stale disk state,
  // then call the once-per-process bootstrap many times.
  const stateFiles = await fs.readdir(stateDir);
  const stateFile = path.join(stateDir, stateFiles.find((name) => name.startsWith("shell-")));
  const stale = JSON.parse(await fs.readFile(stateFile, "utf8"));
  stale.cwd = root;
  stale.recent_commands = ["stale-command"];
  await fs.writeFile(stateFile, JSON.stringify(stale, null, 2), "utf8");
  await Promise.all(Array.from({ length: 50 }, () => ensureShellBootstrap(root)));
  const cwdAfterEnsure = getShellStatus().cwd;
  if (cwdAfterEnsure !== cwd1) throw new Error(`ensure bootstrap reloaded stale disk state: ${cwd1} -> ${cwdAfterEnsure}`);
  ok("transport churn reuses one shell bootstrap without stale cwd overwrite");

  // Explicit bootstrap remains available for deliberate reload/test semantics.
  await bootstrapShellSession(root);
  const cwd2 = getShellStatus().cwd;
  if (cwd2 !== root) throw new Error(`explicit re-bootstrap did not reload disk state: ${cwd2}`);
  ok("explicit re-bootstrap reloads durable state when requested");

  // Foreground commands share one persistent cwd. Concurrent MCP requests must
  // execute in invocation order, not let the slower command overwrite the cwd
  // after a newer command has already completed.
  const srcDir = path.join(root, "src");
  const slowCommand = process.platform === "win32"
    ? "Start-Sleep -Milliseconds 300; Write-Output first"
    : "sleep 0.3; printf first";
  const first = execInShellSession(slowCommand, root, 5000, srcDir);
  const second = execInShellSession(process.platform === "win32" ? "Write-Output second" : "printf second", root, 5000, root);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  if (path.resolve(firstResult.cwd) !== path.resolve(srcDir)) throw new Error(`first concurrent cwd wrong: ${firstResult.cwd}`);
  if (path.resolve(secondResult.cwd) !== path.resolve(root)) throw new Error(`second concurrent cwd wrong: ${secondResult.cwd}`);
  if (path.resolve(getShellStatus().cwd) !== path.resolve(root)) {
    throw new Error(`foreground shell concurrency left stale cwd: ${getShellStatus().cwd}`);
  }
  ok("foreground shell commands serialize persistent cwd updates");

  const slowBeforeReset = execInShellSession(slowCommand, root, 5000, srcDir);
  const queuedReset = resetShellSessionQueued(root);
  await Promise.all([slowBeforeReset, queuedReset]);
  if (path.resolve(getShellStatus().cwd) !== path.resolve(root)) {
    throw new Error(`queued shell reset was overwritten by an earlier command: ${getShellStatus().cwd}`);
  }
  ok("shell reset shares foreground execution queue");
} catch (e) {
  fail("shell persist", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);