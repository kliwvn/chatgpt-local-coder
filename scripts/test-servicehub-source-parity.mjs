/**
 * ServiceHub deployment parity guard for ChatGPT Local Coder.
 *
 * Standalone upstream clones skip when no ServiceHub module definition exists.
 * Integrated canonical/runtime checkouts compare the canonical Git-tracked source
 * package plus every test referenced by run-all-tests.mjs.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootFiles = new Set([
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "chatgpt-local-coder.bat",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
]);
const sourcePrefixes = ["src/", "manager/", "scripts/", "native/", "profiles/"];
const excludedPrefixes = [
  "manager/instances/",
  "manager/state/",
  "manager/logs/",
];

const slash = (value) => String(value).replaceAll("\\", "/");
const samePath = (a, b) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readDefinition(serviceHubRoot) {
  const definition = path.join(serviceHubRoot, "modules", "definitions", "chatgpt-local-coder.yaml");
  if (!(await exists(definition))) return null;
  const text = await fs.readFile(definition, "utf8");
  const source = text.match(/^\s*source:\s*(.+?)\s*$/m)?.[1]?.trim();
  const cwd = text.match(/^\s*cwd:\s*(.+?)\s*$/m)?.[1]?.trim();
  if (!source || !cwd) return null;
  return { definition, canonicalRoot: path.resolve(source), runtimeRoot: path.resolve(cwd) };
}

async function resolveIntegration() {
  if (process.env.CLC_CANONICAL_SOURCE && process.env.CLC_SERVICEHUB_RUNTIME_SOURCE) {
    return {
      definition: "environment",
      canonicalRoot: path.resolve(process.env.CLC_CANONICAL_SOURCE),
      runtimeRoot: path.resolve(process.env.CLC_SERVICEHUB_RUNTIME_SOURCE),
    };
  }

  // Canonical layout: <home>/chatgpt-local-coder + <home>/ServiceHub.
  const siblingServiceHub = path.resolve(repoRoot, "..", "ServiceHub");
  const fromCanonical = await readDefinition(siblingServiceHub);
  if (fromCanonical) return fromCanonical;

  // Runtime layout: <ServiceHub>/modules/runtime/chatgpt-local-coder/source.
  let cursor = repoRoot;
  for (let depth = 0; depth < 7; depth += 1) {
    const candidate = await readDefinition(cursor);
    if (candidate) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function trackedCanonicalFiles(canonicalRoot) {
  const output = execFileSync(
    "git",
    ["-C", canonicalRoot, "ls-files", "-z"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map(slash)
    .filter((rel) =>
      (rootFiles.has(rel) || sourcePrefixes.some((prefix) => rel.startsWith(prefix))) &&
      !excludedPrefixes.some((prefix) => rel.startsWith(prefix))
    );
}

async function canonicalRuntimeSourceFiles(canonicalRoot) {
  const sourceRoot = path.join(canonicalRoot, "src");
  const out = [];
  const queue = [sourceRoot];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile()) {
        out.push(slash(path.relative(canonicalRoot, absolute)));
      }
    }
  }
  return out;
}

async function referencedTests(canonicalRoot) {
  const runner = await fs.readFile(path.join(canonicalRoot, "scripts", "run-all-tests.mjs"), "utf8");
  return [...runner.matchAll(/["'](scripts\/test-[^"']+\.mjs)["']/g)].map((match) => slash(match[1]));
}

async function digest(file) {
  const bytes = await fs.readFile(file);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const integration = await resolveIntegration();
if (!integration) {
  console.log("servicehub-source-parity: skip (no ServiceHub integration definition)");
  process.exit(0);
}

const { canonicalRoot, runtimeRoot, definition } = integration;
if (!(await exists(canonicalRoot)) || !(await exists(runtimeRoot))) {
  console.log(
    `servicehub-source-parity: skip (integration paths unavailable; canonical=${canonicalRoot}, runtime=${runtimeRoot})`
  );
  process.exit(0);
}

const currentIsCanonical = samePath(repoRoot, canonicalRoot);
const currentIsRuntime = samePath(repoRoot, runtimeRoot);
assert.ok(
  currentIsCanonical || currentIsRuntime,
  `parity guard must run from canonical or ServiceHub runtime source; repo=${repoRoot}`
);

const files = new Set(trackedCanonicalFiles(canonicalRoot));
for (const rel of await canonicalRuntimeSourceFiles(canonicalRoot)) files.add(rel);
for (const rel of await referencedTests(canonicalRoot)) {
  if (await exists(path.join(canonicalRoot, rel))) files.add(rel);
}

const missing = [];
const different = [];
for (const rel of [...files].sort()) {
  const canonicalFile = path.join(canonicalRoot, rel);
  const runtimeFile = path.join(runtimeRoot, rel);
  if (!(await exists(runtimeFile))) {
    missing.push(rel);
    continue;
  }
  if ((await digest(canonicalFile)) !== (await digest(runtimeFile))) different.push(rel);
}

assert.deepEqual(
  { missing, different },
  { missing: [], different: [] },
  `ServiceHub Local Coder source drift detected from ${definition}\ncanonical=${canonicalRoot}\nruntime=${runtimeRoot}`
);
console.log(`servicehub-source-parity: ok (${files.size} canonical source/test files identical)`);
