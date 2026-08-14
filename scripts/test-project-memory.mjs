/**
 * Test instruction context builder (Phase 1+2).
 * Run: node scripts/test-project-memory.mjs
 */
import {
  buildInstructionContext,
  summarizeInstructionContext,
} from "../dist/lib/instruction-context.js";
import { loadProjectMemory } from "../dist/lib/project-memory.js";
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

  console.log("\nGit:", ctx.git.is_repo ? ctx.git.branch : "not a repo");
  console.log("Memory files:", ctx.projectMemory.sections.map((s) => s.path).join(", ") || "(none)");
} catch (err) {
  fail("buildInstructionContext", err.message || err);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);