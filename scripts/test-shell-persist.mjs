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

  const srcDir = path.join(root, "src");
  resetShellSession(root);
  const oneOff = await execInShellSession(
    process.platform === "win32" ? "Write-Output oneoff" : "printf oneoff",
    root,
    5000,
    srcDir
  );
  if (path.resolve(oneOff.cwd) !== path.resolve(srcDir)) throw new Error(`one-off cwd not used: ${oneOff.cwd}`);
  if (path.resolve(getShellStatus().cwd) !== path.resolve(root)) {
    throw new Error(`one-off workingDirectory contaminated persistent cwd: ${getShellStatus().cwd}`);
  }
  ok("workingDirectory is one-off and does not contaminate persistent cwd");

  // Explicit cwd directives DO mutate the shared persistent cwd, but child
  // execution remains parallel. A newer cwd mutation wins even if the older
  // process completes later.
  const firstCommand = process.platform === "win32"
    ? `cd "${srcDir}"; Start-Sleep -Milliseconds 700; Write-Output first`
    : `cd "${srcDir}"; sleep 0.7; printf first`;
  const secondCommand = process.platform === "win32"
    ? `cd "${root}"; Write-Output second`
    : `cd "${root}"; printf second`;
  const first = execInShellSession(firstCommand, root, 5000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = execInShellSession(secondCommand, root, 5000);
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
  ok("explicit cwd mutations stay parallel while latest invocation owns cwd");

  const slowBeforeReset = execInShellSession(firstCommand, root, 5000);
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