import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(repoRoot, "native", "windows-sandbox-runner");
const outDir = path.join(nativeRoot, "bin");
const runnerPointerPath = path.join(outDir, "SandboxRunner.current");
const targets = [
  {
    source: path.join(nativeRoot, "SandboxRunner.cs"),
    output: path.join(outDir, "SandboxRunner.exe"),
    versioned: true,
    references: ["System.dll", "System.Core.dll", "System.Web.Extensions.dll"],
  },
  {
    source: path.join(nativeRoot, "SandboxChildProbe.cs"),
    output: path.join(outDir, "SandboxChildProbe.exe"),
    references: ["System.dll"],
  },
  {
    source: path.join(nativeRoot, "SandboxGitHookProbe.cs"),
    output: path.join(outDir, "SandboxGitHookProbe.exe"),
    references: ["System.dll"],
  },
];

if (process.platform !== "win32") {
  console.log("windows sandbox helper: skipped (non-Windows host)");
  process.exit(0);
}

const candidates = [
  process.env.CLC_CSC_PATH,
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
].filter(Boolean);
const csc = candidates.find((candidate) => existsSync(candidate));
if (!csc) {
  console.error("OS_SANDBOX_UNAVAILABLE: .NET Framework csc.exe was not found; cannot build Windows AppContainer broker");
  process.exit(1);
}

await fs.mkdir(outDir, { recursive: true });
for (const target of targets) {
  const sourceBytes = await fs.readFile(target.source);
  const sourceFingerprint = createHash("sha256")
    .update(sourceBytes)
    .update("\0", "utf8")
    .update(target.references.join("\0"), "utf8")
    .digest("hex");
  const output = target.versioned
    ? path.join(outDir, `SandboxRunner.${sourceFingerprint.slice(0, 16)}.exe`)
    : target.output;
  const args = [
    "/nologo",
    "/target:exe",
    "/platform:anycpu",
    "/optimize+",
    "/checked+",
    ...target.references.map((reference) => `/r:${reference}`),
    `/out:${output}`,
    target.source,
  ];
  // Keep compiler stdio inherited. On Windows 10 AppContainer, Node/libuv
  // child-process pipe creation can hang before spawn() returns; inherited
  // handles avoid creating a second IPC pipe layer while the compiler remains
  // inside the same inherited AppContainer security boundary.
  const existingHashPath = `${output}.sha256`;
  const reusable = await Promise.all([
    fs.readFile(output).catch(() => null),
    fs.readFile(existingHashPath, "utf8").catch(() => null),
  ]).then(([bytes, expected]) => {
    if (!bytes || !expected) return false;
    const actual = createHash("sha256").update(bytes).digest("hex");
    return actual === expected.trim().toLowerCase();
  });
  if (!reusable) {
    const result = spawnSync(csc, args, {
      cwd: nativeRoot,
      windowsHide: true,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }

  const bytes = await fs.readFile(output);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const hashFile = `${output}.sha256`;
  await fs.writeFile(hashFile, `${sha256}\n`, "utf8");
  if (target.versioned) {
    const tempPointer = `${runnerPointerPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPointer, `${path.basename(output)}\n`, "utf8");
    await fs.rename(tempPointer, runnerPointerPath);
  }
  console.log(`windows sandbox helper: ${output}`);
  console.log(`windows sandbox helper sha256: ${sha256}`);
}
