/**
 * Test instruction context builder (Phase 1+2).
 * Run: node scripts/test-project-memory.mjs
 */
import {
  appendAutoMemory,
  buildInstructionContext,
  summarizeInstructionContext,
} from "../dist/lib/instruction-context.js";
import { loadProjectMemory } from "../dist/lib/project-memory.js";
import { validateContextReadPath, validatePath } from "../dist/lib/path-security.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workspaceRoot = process.env.WORKSPACE_PATH || process.cwd();
let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}
function fail(name, err) {
  console.error(`FAIL ${name}: ${err}`);
  failed++;
}

try {
  const ctx = await buildInstructionContext({
    workspaceRoot,
    workspaceRoots: [workspaceRoot],
    pid: process.pid,
    adminPort: 3001,
  });

  if (!ctx.instructionsText.includes("Agent workflow")) {
    throw new Error("missing agent prompt");
  }
  ok("agent prompt in instructions");

  if (!/use the narrow typed mutation tool/i.test(ctx.instructionsText) || !/Reserve run_command\/start_process for build, test, verification/i.test(ctx.instructionsText)) {
    throw new Error("agent prompt does not prefer typed mutations over generic shell");
  }
  ok("typed mutation routing in instructions");

  if (!/mcp_servers\(refresh=true\).*cannot refresh, reconnect, or rebind the ChatGPT/i.test(ctx.instructionsText)) {
    throw new Error("agent prompt does not distinguish upstream MCP refresh from ChatGPT connector refresh");
  }
  ok("upstream refresh boundary in instructions");

  if (!/mcp_dispatch counters are process-global/i.test(ctx.instructionsText)) {
    if (!/mcp_dispatch aggregate counters are process-global/i.test(ctx.instructionsText)) {
      throw new Error("agent prompt does not warn that dispatch counters are process-global");
    }
  }
  ok("dispatch attribution warning in instructions");

  if (!/\.clc-host-gate-canary-<UTC>-<nonce>\.tmp/i.test(ctx.instructionsText)
      || !/PASS->HOST_NOT_INVOKED/i.test(ctx.instructionsText)
      || !/MCP_REACHED_UNSETTLED/i.test(ctx.instructionsText)
      || !/coverage\.canary\.complete_since/i.test(ctx.instructionsText)
      || !/INDETERMINATE_NO_COVERAGE/i.test(ctx.instructionsText)) {
    throw new Error("agent prompt does not include the standardized host-gate canary/context-bisect protocol");
  }
  ok("host-gate canary/context-bisect protocol in instructions");

  if (!/tunnel_id, client_instance_id, boot_id, PID, and MCP session ids are transport\/runtime identities, not ChatGPT app\/install permission identities/i.test(ctx.instructionsText)) {
    throw new Error("agent prompt does not distinguish transport ids from ChatGPT app permission identity");
  }
  ok("transport identity boundary in instructions");

  if (!ctx.instructionsText.includes("## Environment")) {
    throw new Error("missing environment block");
  }
  ok("environment block");

  if (!ctx.instructionsText.includes("## Git")) {
    throw new Error("missing git block");
  }
  ok("git block");

  if (!ctx.instructionsText.includes("agent_status")) {
    throw new Error("missing footer quick pointers");
  }
  ok("footer pointers (agent_status not duplicated in body)");

  if (ctx.instructionBytes < 500) {
    throw new Error(`instructions too small: ${ctx.instructionBytes}`);
  }
  ok(`instruction size ${Math.round(ctx.instructionBytes / 1024)}KB`);

  const summary = summarizeInstructionContext(ctx);
  if (!summary.root) throw new Error("summary missing root");
  ok("summarizeInstructionContext");
  if (!/^[0-9a-f]{64}$/.test(String(summary.instruction_sha256 || ""))) {
    throw new Error("instruction summary missing SHA-256 identity");
  }
  const harnessFreshness = summary.global_harness;
  if (harnessFreshness && typeof harnessFreshness === "object") {
    if (harnessFreshness.active_in_snapshot && harnessFreshness.restart_required) {
      throw new Error(`freshly built canonical Global Harness snapshot is unexpectedly stale: ${JSON.stringify(harnessFreshness)}`);
    }
  }
  ok("instruction/global-harness identity and freshness diagnostics");

  console.log("\nGit:", ctx.git.is_repo ? ctx.git.branch : "not a repo");
  console.log("Memory files:", ctx.projectMemory.sections.map((s) => s.path).join(", ") || "(none)");
} catch (err) {
  fail("buildInstructionContext", err.message || err);
}

try {
  const tempCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), "clc-auto-memory-shadow-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempCodexHome;
  try {
    const sentinel = "__LOCAL_AUTO_MEMORY_MUST_NOT_SHADOW_GLOBAL_HARNESS__";
    await appendAutoMemory(workspaceRoot, sentinel);
    const ctx = await buildInstructionContext({
      workspaceRoot,
      workspaceRoots: [workspaceRoot],
      pid: process.pid,
      adminPort: 3001,
    });
    const hasHarnessBootstrap = ctx.projectMemory.sections.some(
      (section) => section.kind === "user" && /[\\/]\.agents[\\/]AGENTS\.md$/i.test(section.path)
    );
    if (hasHarnessBootstrap) {
      if (ctx.instructionsText.includes(sentinel) || ctx.instructionsText.includes("## Auto memory (learned across sessions)")) {
        throw new Error("legacy Local Coder auto memory was injected beside canonical Global Harness memory");
      }
      ok("canonical Global Harness suppresses competing Local Coder auto-memory injection");
    }
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await fs.rm(tempCodexHome, { recursive: true, force: true });
  }
} catch (err) {
  fail("Global Harness auto-memory ownership", err.message || err);
}

try {
  const previousFullDiskAccess = process.env.FULL_DISK_ACCESS;
  process.env.FULL_DISK_ACCESS = "false";
  try {
    const harnessModule = path.join(os.homedir(), ".agents", "skills", "cross-project-delivery", "SKILL.md");
    const contextPath = await validateContextReadPath(harnessModule);
    if (path.normalize(contextPath).toLowerCase() !== path.normalize(harnessModule).toLowerCase()) {
      throw new Error(`Global Harness context path mismatch: ${contextPath}`);
    }

    const tildeContextPath = await validateContextReadPath("~/.agents/skills/cross-project-delivery/SKILL.md");
    if (path.normalize(tildeContextPath).toLowerCase() !== path.normalize(harnessModule).toLowerCase()) {
      throw new Error(`Global Harness ~/ context path mismatch: ${tildeContextPath}`);
    }

    let normalPathRejected = false;
    try {
      await validatePath(harnessModule);
    } catch {
      normalPathRejected = true;
    }
    if (!normalPathRejected) throw new Error("Global Harness context exception widened ordinary path authority");

    const continuityFile = path.join(os.homedir(), ".codex", "GLOBAL_IMPLEMENTATION_NOTES.md");
    try {
      const continuityInfo = await fs.lstat(continuityFile);
      if (!continuityInfo.isFile() || continuityInfo.isSymbolicLink()) {
        throw new Error("Global Harness continuity file exists but is not a canonical regular file");
      }
      const continuityPath = await validateContextReadPath(continuityFile);
      if (path.normalize(continuityPath).toLowerCase() !== path.normalize(continuityFile).toLowerCase()) {
        throw new Error(`Global Harness continuity path mismatch: ${continuityPath}`);
      }
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      let missingContinuityRejected = false;
      try {
        await validateContextReadPath(continuityFile);
      } catch {
        missingContinuityRejected = true;
      }
      if (!missingContinuityRejected) {
        throw new Error("missing Global Harness continuity file was trusted before a canonical file existed");
      }
    }

    let unrelatedOutsideReadRejected = false;
    try {
      await validateContextReadPath(path.join(os.homedir(), "__clc-unrelated-context-probe__.txt"));
    } catch {
      unrelatedOutsideReadRejected = true;
    }
    if (!unrelatedOutsideReadRejected) throw new Error("Global Harness context exception widened arbitrary outside-workspace reads");
    ok("Global Harness canonical ~/ selective reads work without widening mutation/outside-read authority");
  } finally {
    if (previousFullDiskAccess === undefined) delete process.env.FULL_DISK_ACCESS;
    else process.env.FULL_DISK_ACCESS = previousFullDiskAccess;
  }
} catch (err) {
  fail("Global Harness selective read context", err.message || err);
}

try {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-project-memory-"));
  try {
    await fs.writeFile(path.join(temp, "large-import.md"), "ữ".repeat(600_000), "utf8");
    await fs.writeFile(path.join(temp, "CLAUDE.md"), "@large-import.md\nroot-tail\n", "utf8");
    const bundle = await loadProjectMemory(temp, {
      maxBytes: 4096,
      maxLines: 1000,
      workspaceRoots: [temp],
      includeUserMemory: false,
    });
    if (bundle.total_bytes > 4096) throw new Error(`memory budget exceeded: ${bundle.total_bytes}`);
    const section = bundle.sections.find((item) => item.path.endsWith("CLAUDE.md"));
    if (!section) throw new Error("bounded project CLAUDE.md missing");
    if (!section.truncated) throw new Error("oversized imported memory was not marked truncated");
    if (section.content.includes("\uFFFD")) throw new Error("UTF-8 prefix truncation emitted replacement character");
    ok("project memory import I/O and expansion stay within byte budget");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
} catch (err) {
  fail("bounded project memory", err.message || err);
}

try {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-project-memory-unlimited-"));
  try {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}-${"x".repeat(100)}`);
    const expected = lines.join("\n");
    await fs.writeFile(path.join(temp, "AGENTS.md"), expected, "utf8");
    if (!process.env.PROJECT_MEMORY_MAX_BYTES?.trim() && !process.env.PROJECT_MEMORY_MAX_LINES?.trim()) {
      const defaultBundle = await loadProjectMemory(temp, {
        workspaceRoots: [temp],
        includeUserMemory: false,
      });
      const defaultSection = defaultBundle.sections.find((item) => item.path.endsWith("AGENTS.md"));
      if (!defaultSection || defaultSection.truncated || defaultSection.content !== expected) {
        throw new Error("unset PROJECT_MEMORY_MAX_BYTES/LINES did not default to unlimited");
      }
      ok("unset PROJECT_MEMORY_MAX_BYTES/LINES defaults to unlimited");
    }
    const bundle = await loadProjectMemory(temp, {
      maxBytes: 0,
      maxLines: 0,
      workspaceRoots: [temp],
      includeUserMemory: false,
    });
    const section = bundle.sections.find((item) => item.path.endsWith("AGENTS.md"));
    if (!section) throw new Error("unlimited AGENTS.md missing");
    if (section.truncated) throw new Error("0-limit AGENTS.md was incorrectly marked truncated");
    if (section.content !== expected) throw new Error("0-limit AGENTS.md was not loaded in full");
    if (bundle.total_bytes !== Buffer.byteLength(expected, "utf8")) {
      throw new Error(`unlimited memory byte count mismatch: ${bundle.total_bytes}`);
    }
    ok("PROJECT_MEMORY_MAX_BYTES/LINES=0 means unlimited");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
} catch (err) {
  fail("unlimited project memory", err.message || err);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);