import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(repoRoot, "native", "windows-sandbox-runner");
const outDir = path.join(nativeRoot, "bin");
const targets = [
  {
    source: path.join(nativeRoot, "SandboxRunner.cs"),
    output: path.join(outDir, "SandboxRunner.exe"),
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
  const args = [
    "/nologo",
    "/target:exe",
    "/platform:anycpu",
    "/optimize+",
    "/checked+",
    ...target.references.map((reference) => `/r:${reference}`),
    `/out:${target.output}`,
    target.source,
  ];
  const result = spawnSync(csc, args, {
    cwd: nativeRoot,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);

  const bytes = await fs.readFile(target.output);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const hashFile = `${target.output}.sha256`;
  await fs.writeFile(hashFile, `${sha256}\n`, "utf8");
  console.log(`windows sandbox helper: ${target.output}`);
  console.log(`windows sandbox helper sha256: ${sha256}`);
}
