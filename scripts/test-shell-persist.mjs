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
  flushShellPersistence,
  getShellStatus,
  resetShellSession,
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
  await flushShellPersistence();

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

  // Foreground commands share one persistent cwd, but they must not serialize
  // child execution: a long command in one MCP transport must not block another
  // transport (or a command that calls back into this MCP server). Persistent cwd
  // follows invocation order, so the newest invocation wins even if it completes
  // first.
  const srcDir = path.join(root, "src");
  const slowCommand = process.platform === "win32"
    ? "Start-Sleep -Milliseconds 700; Write-Output first"
    : "sleep 0.7; printf first";
  const first = execInShellSession(slowCommand, root, 5000, srcDir);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = execInShellSession(
    process.platform === "win32" ? "Write-Output second" : "printf second",
    root,
    5000,
    root
  );
  const winner = await Promise.race([
    first.then(() => "first"),
    second.then(() => "second"),
  ]);
  if (winner !== "second") throw new Error("foreground command was serialized behind earlier slow command");
  const secondResult = await second;
  const firstResult = await first;
  if (path.resolve(firstResult.cwd) !== path.resolve(srcDir)) throw new Error(`first concurrent cwd wrong: ${firstResult.cwd}`);
  if (path.resolve(secondResult.cwd) !== path.resolve(root)) throw new Error(`second concurrent cwd wrong: ${secondResult.cwd}`);
  if (path.resolve(getShellStatus().cwd) !== path.resolve(root)) {
    throw new Error(`foreground shell concurrency left stale cwd: ${getShellStatus().cwd}`);
  }
  ok("foreground shell commands stay parallel while latest invocation owns cwd");

  const slowBeforeReset = execInShellSession(slowCommand, root, 5000, srcDir);
  resetShellSession(root);
  await slowBeforeReset;
  if (path.resolve(getShellStatus().cwd) !== path.resolve(root)) {
    throw new Error(`shell reset was overwritten by an earlier command completion: ${getShellStatus().cwd}`);
  }
  await flushShellPersistence();
  ok("shell reset remains authoritative over earlier in-flight command");
} catch (e) {
  fail("shell persist", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);