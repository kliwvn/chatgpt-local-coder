import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");

export const OPENAI_TUNNEL_VERSION = "v0.0.11";
export const OPENAI_TUNNEL_LAZY_CODEX_PATCH_REVISION = "lazy-codex-v2";
export const OPENAI_TUNNEL_LAZY_CODEX_SOURCE_SHA = "8d55683eeef80bc5e360d95abf4692454fafc615";
export const OPENAI_TUNNEL_LAZY_CODEX_MARKER_SCHEMA = 1;

const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BUILD_OUTPUT_CHARS = 12000;
const buildPromises = new Map();

export function lazyCodexRuntimePaths(root = DEFAULT_ROOT) {
  const dir = path.join(root, "bin", "lazy-codex-verified-v2");
  return {
    dir,
    exe: path.join(dir, "tunnel-client.exe"),
    marker: path.join(dir, "version.json"),
    builder: path.join(root, "scripts", "build-tunnel-client-lazy-codex.ps1"),
  };
}

export function lazyCodexRuntimeIdentity() {
  return {
    schema: OPENAI_TUNNEL_LAZY_CODEX_MARKER_SCHEMA,
    version: OPENAI_TUNNEL_VERSION,
    patch_revision: OPENAI_TUNNEL_LAZY_CODEX_PATCH_REVISION,
    source_commit: OPENAI_TUNNEL_LAZY_CODEX_SOURCE_SHA,
  };
}

export function lazyCodexRuntimeMarker(sha256) {
  return {
    ...lazyCodexRuntimeIdentity(),
    sha256: String(sha256 || "").toLowerCase(),
  };
}

function markerIdentityMatches(marker) {
  const expected = lazyCodexRuntimeIdentity();
  return Boolean(
    marker &&
    marker.schema === expected.schema &&
    marker.version === expected.version &&
    marker.patch_revision === expected.patch_revision &&
    marker.source_commit === expected.source_commit &&
    typeof marker.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(marker.sha256)
  );
}

async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function inspectLazyCodexTunnelRuntime({ root = DEFAULT_ROOT } = {}) {
  const paths = lazyCodexRuntimePaths(root);
  let marker;
  try {
    marker = JSON.parse(await fsp.readFile(paths.marker, "utf8"));
  } catch (err) {
    return {
      valid: false,
      reason: err?.code === "ENOENT" ? "marker-missing" : "marker-invalid",
      error: err?.code === "ENOENT" ? null : String(err?.message || err).slice(0, 500),
      ...paths,
    };
  }

  if (!markerIdentityMatches(marker)) {
    return { valid: false, reason: "identity-mismatch", marker, ...paths };
  }

  try {
    const stat = await fsp.stat(paths.exe);
    if (!stat.isFile() || stat.size <= 0) {
      return { valid: false, reason: "binary-empty", marker, ...paths };
    }
    const actualSha256 = await sha256File(paths.exe);
    if (actualSha256 !== marker.sha256) {
      return { valid: false, reason: "binary-hash-mismatch", marker, actualSha256, ...paths };
    }
    return { valid: true, reason: "exact-patched-runtime", marker, actualSha256, ...paths };
  } catch (err) {
    return {
      valid: false,
      reason: err?.code === "ENOENT" ? "binary-missing" : "binary-unreadable",
      marker,
      error: err?.code === "ENOENT" ? null : String(err?.message || err).slice(0, 500),
      ...paths,
    };
  }
}

function appendBounded(value, chunk, maxChars = MAX_BUILD_OUTPUT_CHARS) {
  const next = value + String(chunk ?? "");
  return next.length <= maxChars ? next : next.slice(-maxChars);
}

function powershellExe() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function killChildTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
      return;
    } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}

export async function buildLazyCodexTunnelRuntime({
  root = DEFAULT_ROOT,
  timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
} = {}) {
  const paths = lazyCodexRuntimePaths(root);
  if (!fs.existsSync(paths.builder)) {
    throw new Error(`Required lazy-Codex builder is missing: ${paths.builder}`);
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", paths.builder,
    "-Version", OPENAI_TUNNEL_VERSION,
    "-SourceCommit", OPENAI_TUNNEL_LAZY_CODEX_SOURCE_SHA,
    "-PatchRevision", OPENAI_TUNNEL_LAZY_CODEX_PATCH_REVISION,
    "-OutputDir", paths.dir,
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(powershellExe(), args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    let settled = false;
    let timer = null;

    const finish = (err, result = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    child.stdout.on("data", (chunk) => { output = appendBounded(output, chunk); });
    child.stderr.on("data", (chunk) => { output = appendBounded(output, chunk); });
    child.on("error", (err) => finish(new Error(`Cannot start lazy-Codex builder: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`lazy-Codex builder failed with exit ${code}: ${output.trim().slice(-6000)}`));
        return;
      }
      finish(null, { code, output: output.trim() });
    });

    timer = setTimeout(() => {
      killChildTree(child);
      finish(new Error(`lazy-Codex builder timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function ensureLazyCodexTunnelRuntime({
  root = DEFAULT_ROOT,
  platform = process.platform,
  arch = process.arch,
  buildRuntime = buildLazyCodexTunnelRuntime,
} = {}) {
  if (platform !== "win32") {
    return { ok: true, required: false, path: null, reason: "non-windows" };
  }
  if (arch !== "x64") {
    return {
      ok: false,
      required: true,
      path: null,
      reason: "unsupported-windows-architecture",
      error: `Patched OpenAI Tunnel runtime currently supports Windows x64 only; refusing official fallback on ${arch}.`,
    };
  }

  const before = await inspectLazyCodexTunnelRuntime({ root });
  if (before.valid) {
    return { ok: true, required: true, path: before.exe, rebuilt: false, inspection: before };
  }

  const key = path.resolve(root).toLowerCase();
  let pending = buildPromises.get(key);
  if (!pending) {
    pending = (async () => {
      await buildRuntime({ root });
      const after = await inspectLazyCodexTunnelRuntime({ root });
      if (!after.valid) {
        throw new Error(`Builder completed but patched runtime verification failed (${after.reason}).`);
      }
      return after;
    })();
    buildPromises.set(key, pending);
    pending.finally(() => {
      if (buildPromises.get(key) === pending) buildPromises.delete(key);
    }).catch(() => {});
  }

  try {
    const inspection = await pending;
    return {
      ok: true,
      required: true,
      path: inspection.exe,
      rebuilt: true,
      repairedFrom: before.reason,
      inspection,
    };
  } catch (err) {
    return {
      ok: false,
      required: true,
      path: null,
      reason: "patched-runtime-unavailable",
      error: `Patched OpenAI Tunnel runtime is required on Windows; refusing known-bad official fallback. ${String(err?.message || err).slice(0, 6000)}`,
      inspection: before,
    };
  }
}
