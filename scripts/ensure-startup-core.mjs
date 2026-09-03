import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, inspectRuntimeBuildFreshness } from "../manager/fs-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, "manager", "state");
const logDir = path.join(stateDir, "logs");
const dependencyStamp = path.join(stateDir, "startup-dependencies.sha256");
const coreStatusLog = path.join(logDir, "startup-core.log");
const coreLockDir = path.join(stateDir, "startup-core.lock");
const coreLockOwner = path.join(coreLockDir, "owner.json");
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const CORE_LOCK_WAIT_MS = STEP_TIMEOUT_MS * 2 + 60_000;
const CORE_LOCK_STALE_MS = CORE_LOCK_WAIT_MS + 60_000;
const OUTPUT_TAIL_CHARS = 8000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readCoreLockOwner() {
  try {
    const parsed = JSON.parse(await fsp.readFile(coreLockOwner, "utf8"));
    return {
      pid: Number(parsed?.pid),
      token: typeof parsed?.token === "string" ? parsed.token : "",
      started_at: Number(parsed?.started_at),
    };
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) return null;
    throw err;
  }
}

async function acquireCoreLock() {
  await fsp.mkdir(stateDir, { recursive: true });
  const deadline = Date.now() + CORE_LOCK_WAIT_MS;
  while (true) {
    try {
      await fsp.mkdir(coreLockDir);
      const owner = { pid: process.pid, token: randomUUID(), started_at: Date.now() };
      await atomicWriteFile(coreLockOwner, `${JSON.stringify(owner)}\n`, "utf8");
      return owner;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }

    let stat;
    try {
      stat = await fsp.stat(coreLockDir);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
    const ageMs = Math.max(0, Date.now() - Number(stat.mtimeMs || 0));
    const owner = await readCoreLockOwner();
    const ownerDead = Boolean(owner?.pid) && !processIsAlive(owner.pid);
    const ownerMissingTooLong = !owner && ageMs >= 2000;
    if (ownerDead || ownerMissingTooLong || ageMs >= CORE_LOCK_STALE_MS) {
      try {
        await fsp.rm(coreLockDir, { recursive: true, force: true });
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`startup core single-flight timed out waiting for owner pid=${owner?.pid || "unknown"}`);
    }
    await sleep(200);
  }
}

async function releaseCoreLock(owner) {
  try {
    const current = await readCoreLockOwner();
    if (!current || current.token !== owner.token || current.pid !== owner.pid) return;
    await fsp.rm(coreLockDir, { recursive: true, force: true });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

async function writeCoreStatus(text) {
  await fsp.mkdir(logDir, { recursive: true });
  await atomicWriteFile(coreStatusLog, `${new Date().toISOString()} ${text.trim()}\n`, "utf8");
}

function outputTail(value) {
  const text = String(value || "");
  return text.length <= OUTPUT_TAIL_CHARS ? text : text.slice(-OUTPUT_TAIL_CHARS);
}

function runNpm(args, timeoutMs = STEP_TIMEOUT_MS) {
  if (!fs.existsSync(npmCli)) {
    return { code: -1, output: `npm CLI not found beside Node runtime: ${npmCli}` };
  }
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = outputTail(`${result.stdout || ""}${result.stderr || ""}`);
  if (result.error) {
    const code = result.error.code === "ETIMEDOUT" ? 124 : -1;
    return { code, output: `${output}\n${result.error.message}`.trim() };
  }
  return { code: Number.isInteger(result.status) ? result.status : -1, output };
}

function dependencyFingerprint() {
  const hash = createHash("sha256");
  hash.update(`platform=${process.platform}\0arch=${process.arch}\0node_abi=${process.versions.modules || ""}\0`);
  for (const rel of ["package.json", "package-lock.json"]) {
    const file = path.join(root, rel);
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readStamp() {
  try {
    return (await fsp.readFile(dependencyStamp, "utf8")).trim();
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

async function ensureDependencies() {
  await fsp.mkdir(stateDir, { recursive: true });
  const fingerprint = dependencyFingerprint();
  const installedTreeExists = fs.existsSync(path.join(root, "node_modules"));
  const stamp = await readStamp();

  if (installedTreeExists && stamp === fingerprint) {
    console.log("[OK] Dependencies match current package authority.");
    return { installed: false, fingerprint };
  }

  if (installedTreeExists && !stamp) {
    const localProof = runNpm(["ls", "--all", "--json"], 60_000);
    if (localProof.code === 0) {
      await atomicWriteFile(dependencyStamp, `${fingerprint}\n`, "utf8");
      console.log("[OK] Existing node_modules validated locally; dependency stamp bootstrapped.");
      return { installed: false, fingerprint };
    }
    console.log("[..] Existing node_modules failed local validation; reconciling with npm install.");
  } else if (!installedTreeExists) {
    console.log("[..] node_modules is missing; running npm install.");
  } else {
    console.log("[..] package authority changed; running npm install.");
  }

  const install = runNpm(["install"]);
  if (install.output) process.stdout.write(install.output.endsWith("\n") ? install.output : `${install.output}\n`);
  if (install.code !== 0) throw new Error(`npm install failed (exit ${install.code})`);

  const after = dependencyFingerprint();
  await atomicWriteFile(dependencyStamp, `${after}\n`, "utf8");
  console.log("[OK] Dependencies reconciled.");
  return { installed: true, fingerprint: after };
}

async function buildState() {
  return inspectRuntimeBuildFreshness({
    sourceRoot: path.join(root, "src"),
    artifactRoot: path.join(root, "dist"),
    sourceFiles: ["package.json", "package-lock.json", "tsconfig.json"].map((rel) => path.join(root, rel)),
  });
}

async function ensureBuild(dependenciesInstalled) {
  let state = await buildState();
  const entry = path.join(root, "dist", "index.js");
  const buildNeeded = dependenciesInstalled || !fs.existsSync(entry) || state.sourceNewerThanBuild;
  if (!buildNeeded) {
    console.log("[OK] Build matches current source authority.");
    return { built: false, state };
  }

  console.log("[..] Runtime build is stale/missing; running npm run build.");
  const build = runNpm(["run", "build"]);
  if (build.output) process.stdout.write(build.output.endsWith("\n") ? build.output : `${build.output}\n`);
  if (build.code !== 0) throw new Error(`npm run build failed (exit ${build.code})`);

  state = await buildState();
  if (!fs.existsSync(entry) || state.sourceNewerThanBuild) {
    throw new Error("build completed but runtime freshness verification still reports drift");
  }
  console.log("[OK] Build reconciled and verified.");
  return { built: true, state };
}

async function main() {
  const major = Number(String(process.versions.node || "").split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node.js 22+ required; current runtime is ${process.version}`);
  }
  console.log(`[OK] Node ${process.version} ready.`);
  const owner = await acquireCoreLock();
  try {
    const deps = await ensureDependencies();
    const build = await ensureBuild(deps.installed);
    console.log(`[OK] Startup core ready (dependenciesInstalled=${deps.installed}, built=${build.built}).`);
    await writeCoreStatus(`OK node=${process.version} dependenciesInstalled=${deps.installed} built=${build.built}`);
  } finally {
    await releaseCoreLock(owner);
  }
}

main().catch(async (err) => {
  const detail = String(err?.stack || err?.message || err).slice(-8000);
  try {
    await writeCoreStatus(`FAIL ${detail}`);
  } catch {}
  console.error(`[LOI] Startup core preflight failed: ${detail}`);
  process.exitCode = 1;
});
