/**
 * Legacy input compatibility: the ChatGPT host connector caches a frozen
 * snapshot of tools/list, so clients may keep sending historical argument
 * shapes long after internal changes. These cases lock the invariant that
 * every slim-profile tool still accepts its historical arguments and returns
 * the same structured result keys.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDefaultCwd, getWorkspaceRoots, setDefaultCwd, setWorkspaceRoots } from "../dist/lib/path-security.js";

const oldProfile = process.env.CHATGPT_TOOL_PROFILE;
const oldRuntimeEnv = Object.fromEntries([
  "FULL_DISK_ACCESS",
  "LOCAL_CODER_INSTANCE_ID",
  "CLC_SANDBOX_PROFILE_NAME",
  "CLC_SANDBOX_STATE_DIR",
  "MCP_SHELL_STATE_DIR",
].map((key) => [key, process.env[key]]));
const oldCwd = getDefaultCwd();
const oldRoots = getWorkspaceRoots();
// Strict-mode workspace must not live under os.tmpdir() (C:\Users is not
// traversable by the sandbox; git_status would fail with "Invalid path
// 'C:/Users'"). Derive from the repo parent like the other sandbox tests.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(path.resolve(repoRoot, ".."), "clc-legacy-compat-"));

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

let server;
let client;
let dynamicProject;
let escapeProject;
let escapeOutside;
try {
  process.env.CHATGPT_TOOL_PROFILE = "slim";
  process.env.FULL_DISK_ACCESS = "false";
  process.env.LOCAL_CODER_INSTANCE_ID = "tests";
  process.env.CLC_SANDBOX_PROFILE_NAME = "ChatGPTLocalCoder.tests";
  process.env.CLC_SANDBOX_STATE_DIR = path.join(temp, ".sandbox-state");
  process.env.MCP_SHELL_STATE_DIR = path.join(temp, ".shell-state");
  setDefaultCwd(temp);
  setWorkspaceRoots([temp]);

  // server-factory imports persistent-shell/state-path. Import it only after the
  // test-owned state roots above are installed; a static import would bind the
  // production parent's MCP_SHELL_STATE_DIR before fixture setup.
  const { createMcpServer } = await import("../dist/server-factory.js");
  server = await createMcpServer(temp, 10, [temp], false);
  client = new Client({ name: "legacy-compat", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  async function call(name, args) {
    const res = await client.callTool({ name, arguments: args });
    return { text: JSON.stringify(res), isError: Boolean(res.isError), structuredContent: res.structuredContent };
  }


  const legacyFile = path.join(temp, "legacy.txt");
  let r = await call("write_file", { path: legacyFile, content: "line1\nline2\n" });
  assert.equal(r.isError, false, `write_file legacy: ${r.text}`);
  assert.equal(await fs.readFile(legacyFile, "utf8"), "line1\nline2\n");
  ok("write_file accepts {path, content}");

  // --- edit_file: with and without replace_all -----------------------------
  r = await call("edit_file", { path: legacyFile, old_text: "line2", new_text: "line2-edited" });
  assert.equal(r.isError, false, `edit_file legacy: ${r.text}`);
  assert.match(await fs.readFile(legacyFile, "utf8"), /line2-edited/);
  ok("edit_file accepts {path, old_text, new_text}");
  r = await call("edit_file", { path: legacyFile, old_text: "line1", new_text: "line1-replaced", replace_all: true });
  assert.equal(r.isError, false, `edit_file replace_all: ${r.text}`);
  assert.match(await fs.readFile(legacyFile, "utf8"), /line1-replaced/);
  ok("edit_file accepts historical replace_all");

  // --- multi_edit: {path, edits[]} -----------------------------------------
  r = await call("multi_edit", { path: legacyFile, edits: [{ old_text: "line1-replaced", new_text: "m1" }, { old_text: "line2-edited", new_text: "m2" }] });
  assert.equal(r.isError, false, `multi_edit legacy: ${r.text}`);
  const afterMulti = await fs.readFile(legacyFile, "utf8");
  assert.match(afterMulti, /m1/);
  assert.match(afterMulti, /m2/);
  ok("multi_edit accepts {path, edits[]}");

  // --- apply_patch: Codex @@ hunks -----------------------------------------
  const patchFile = path.join(temp, "patched.txt");
  await fs.writeFile(patchFile, "alpha\nbeta\n", "utf8");
  const patch = "@@\n-beta\n+beta2\n";
  r = await call("apply_patch", { patch, path: patchFile });
  assert.equal(r.isError, false, `apply_patch legacy: ${r.text}`);
  assert.match(await fs.readFile(patchFile, "utf8"), /beta2/);
  ok("apply_patch accepts {patch, path}");

  // --- grep: {pattern, path, output_mode} ----------------------------------
  r = await call("grep", { pattern: "beta2", path: temp, output_mode: "files_with_matches" });
  assert.equal(r.isError, false, `grep legacy: ${r.text}`);
  assert.match(r.text, /patched\.txt/);
  ok("grep accepts {pattern, path, output_mode}");

  // --- glob: {pattern, path} -----------------------------------------------
  r = await call("glob", { pattern: "*.txt", path: temp });
  assert.equal(r.isError, false, `glob legacy: ${r.text}`);
  assert.match(r.text, /legacy\.txt/);
  ok("glob accepts {pattern, path}");

  // --- run_command: {command} (cwd defaults to workspace) ------------------
  // This suite owns historical MCP input/output compatibility, not the Windows
  // AppContainer boundary. Use trusted execution for shell-shape assertions so
  // host AV/PowerShell cold-start latency cannot turn this ABI test flaky;
  // strict process behavior is covered by the dedicated sandbox suites.
  process.env.FULL_DISK_ACCESS = "true";
  r = await call("run_command", { command: "node --version" });
  assert.equal(r.isError, false, `run_command legacy: ${r.text}`);
  assert.match(r.text, /v\d+\.\d+/);
  ok("run_command accepts {command}");

  // --- start_process + process_output: {command} / {id} --------------------
  r = await call("start_process", { command: "node --version" });
  assert.equal(r.isError, false, `start_process legacy: ${r.text}`);
  const procId = r.structuredContent?.data?.id ?? JSON.parse(r.text).id;
  assert.ok(procId, `start_process returned no id: ${r.text}`);
  // Poll: on slow hosts the child is still spawning when the first
  // process_output call returns (running:true, empty stdout).
  let outputText = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    const out = await call("process_output", { id: procId });
    assert.equal(out.isError, false, `process_output legacy: ${out.text}`);
    outputText = out.text;
    if (/v\d+\.\d+/.test(outputText)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.match(outputText, /v\d+\.\d+/, "process_output never saw child output");
  ok("start_process/process_output accept historical shapes");
  process.env.FULL_DISK_ACCESS = "false";

  // --- git: add/commit/restore with legacy args ----------------------------
  const repo = path.join(temp, "legacy-repo");
  await fs.mkdir(repo);
  const gitFile = path.join(repo, "tracked.txt");
  await fs.writeFile(gitFile, "v1\n", "utf8");
  const { spawnSync } = await import("node:child_process");
  const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  // This suite owns cached MCP argument/result compatibility, not strict Git
  // sandbox health. Use trusted execution for the historical git_status shape;
  // AppContainer Git behavior is covered by dedicated process/Git boundary tests.
  process.env.FULL_DISK_ACCESS = "true";
  r = await call("git_status", { path: repo });
  assert.equal(r.isError, false, `git_status legacy: ${r.text}`);
  // git_status runs in a non-repo dir: it must still return a structured
  // result (possibly an error status), not throw a transport error.
  ok("git_status returns structured result on any path");
  process.env.FULL_DISK_ACCESS = "false";

  // --- rewind: {action:"status"} -------------------------------------------
  r = await call("rewind", { action: "status" });
  assert.equal(r.isError, false, `rewind legacy: ${r.text}`);
  assert.match(r.text, /checkpoint/i);
  ok("rewind accepts {action:status}");

  // --- project_context: {} (defaults) --------------------------------------
  r = await call("project_context", {});
  assert.equal(r.isError, false, `project_context legacy: ${r.text}`);
  ok("project_context accepts {}");

  // --- project_context: explicit dynamic repo in trusted full-disk mode -----
  dynamicProject = `${temp}-dynamic-project`;
  const dynamicSkillDir = path.join(dynamicProject, ".claude", "skills", "dynamic-context-fixture");
  const dynamicRulesDir = path.join(dynamicProject, ".claude", "rules");
  const dynamicSourceDir = path.join(dynamicProject, "src");
  await fs.mkdir(dynamicSkillDir, { recursive: true });
  await fs.mkdir(dynamicRulesDir, { recursive: true });
  await fs.mkdir(dynamicSourceDir, { recursive: true });
  await fs.writeFile(
    path.join(dynamicProject, "AGENTS.md"),
    "# Dynamic project instructions\n@PROJECT_GUIDANCE.md\n",
    "utf8"
  );
  await fs.writeFile(path.join(dynamicProject, "PROJECT_GUIDANCE.md"), "DYNAMIC_IMPORT_EXPANDED\n", "utf8");
  await fs.writeFile(path.join(dynamicRulesDir, "always.md"), "DYNAMIC_UNCONDITIONAL_RULE\n", "utf8");
  await fs.writeFile(
    path.join(dynamicRulesDir, "typescript.md"),
    "---\npaths:\n  - \"src/**/*.ts\"\n---\nDYNAMIC_PATH_RULE\n",
    "utf8"
  );
  const dynamicSourceFile = path.join(dynamicSourceDir, "feature.ts");
  await fs.writeFile(dynamicSourceFile, "export const feature = true;\n", "utf8");
  await fs.writeFile(
    path.join(dynamicSkillDir, "SKILL.md"),
    "---\nname: dynamic-context-fixture\ndescription: Dynamic project context fixture\n---\n\nBODY_NOT_AUTO_INJECTED\n",
    "utf8"
  );
  process.env.FULL_DISK_ACCESS = "true";
  r = await call("project_context", { path: dynamicProject, max_depth: 0 });
  assert.equal(r.isError, false, `project_context full-disk dynamic repo: ${r.text}`);
  assert.equal(path.normalize(r.structuredContent?.data?.root || ""), path.normalize(await fs.realpath(dynamicProject)));
  assert.ok(
    r.structuredContent?.data?.files?.some((entry) => entry.path.endsWith("AGENTS.md") && /Dynamic project instructions/.test(entry.content)),
    `dynamic project AGENTS.md missing: ${r.text}`
  );
  assert.ok(
    r.structuredContent?.data?.project_skills?.some((skill) => skill.name === "dynamic-context-fixture"),
    `dynamic project skill metadata missing: ${r.text}`
  );
  const dynamicInstructionText = JSON.stringify(r.structuredContent?.data?.project_instructions || {});
  assert.match(dynamicInstructionText, /DYNAMIC_IMPORT_EXPANDED/, "dynamic AGENTS @import was not expanded");
  assert.match(dynamicInstructionText, /DYNAMIC_UNCONDITIONAL_RULE/, "dynamic unconditional .claude rule was not loaded");
  assert.doesNotMatch(r.text, /BODY_NOT_AUTO_INJECTED/, "project_context injected a selected skill body instead of metadata only");
  r = await call("load_path_rules", { path: dynamicSourceFile });
  assert.equal(r.isError, false, `load_path_rules dynamic repo: ${r.text}`);
  assert.equal(path.normalize(r.structuredContent?.data?.project_root || ""), path.normalize(await fs.realpath(dynamicProject)));
  assert.match(r.text, /DYNAMIC_PATH_RULE/, "dynamic repo path-specific rule was not loaded");

  // Trusted full-disk mode widens deliberate agent authority, not automatic
  // project-controlled context discovery. A project must not escape its own
  // context boundary by replacing context/skill/rule surfaces with aliases to
  // sibling directories or files outside the explicitly selected repo.
  escapeProject = `${temp}-escape-project`;
  escapeOutside = `${temp}-escape-outside`;
  const escapeClaudeDir = path.join(escapeProject, ".claude");
  const escapeSourceDir = path.join(escapeProject, "src");
  const outsideSkillsDir = path.join(escapeOutside, "skills");
  const outsideRulesDir = path.join(escapeOutside, "rules");
  await fs.mkdir(escapeClaudeDir, { recursive: true });
  await fs.mkdir(escapeSourceDir, { recursive: true });
  await fs.mkdir(path.join(outsideSkillsDir, "outside-skill"), { recursive: true });
  await fs.mkdir(outsideRulesDir, { recursive: true });
  await fs.writeFile(path.join(escapeProject, "AGENTS.md"), "ESCAPE_PROJECT_OWNED\n", "utf8");
  const escapeSourceFile = path.join(escapeSourceDir, "escape.ts");
  await fs.writeFile(escapeSourceFile, "export const escape = false;\n", "utf8");
  await fs.writeFile(
    path.join(outsideSkillsDir, "outside-skill", "SKILL.md"),
    "---\nname: outside-project-skill\ndescription: MUST_NOT_AUTO_DISCOVER\n---\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(outsideRulesDir, "outside.md"),
    "---\npaths:\n  - \"src/**/*.ts\"\n---\nOUTSIDE_PATH_RULE_MUST_NOT_LOAD\n",
    "utf8"
  );
  await fs.symlink(outsideSkillsDir, path.join(escapeClaudeDir, "skills"), process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(outsideRulesDir, path.join(escapeClaudeDir, "rules"), process.platform === "win32" ? "junction" : "dir");

  let contextFileAliasCreated = true;
  const outsideReadme = path.join(escapeOutside, "outside-readme.md");
  await fs.writeFile(outsideReadme, "OUTSIDE_CONTEXT_FILE_MUST_NOT_LOAD\n", "utf8");
  try {
    await fs.symlink(outsideReadme, path.join(escapeProject, "README.md"), "file");
  } catch (err) {
    if (process.platform === "win32" && err?.code === "EPERM") contextFileAliasCreated = false;
    else throw err;
  }

  r = await call("project_context", { path: escapeProject, max_depth: 0 });
  assert.equal(r.isError, false, `project_context escape fixture: ${r.text}`);
  assert.ok(
    !r.structuredContent?.data?.project_skills?.some((skill) => skill.name === "outside-project-skill"),
    `project_context auto-discovered project skill outside selected repo: ${r.text}`
  );
  if (contextFileAliasCreated) {
    assert.doesNotMatch(r.text, /OUTSIDE_CONTEXT_FILE_MUST_NOT_LOAD/, "project_context auto-read context file outside selected repo");
  }
  const escapeRulesResult = await call("load_path_rules", { path: escapeSourceFile });
  assert.equal(escapeRulesResult.isError, false, `load_path_rules escape fixture: ${escapeRulesResult.text}`);
  assert.doesNotMatch(
    escapeRulesResult.text,
    /OUTSIDE_PATH_RULE_MUST_NOT_LOAD/,
    "load_path_rules auto-loaded a project rule outside the inferred project root"
  );
  ok("trusted full-disk project auto-discovery remains request-root scoped");

  process.env.FULL_DISK_ACCESS = "false";

  // A broad configured collection root is authority, not semantic ownership.
  // Path-rule inference must still bind a file to the nearest nested project
  // marker/rules root instead of forcing every child repo to inherit collection
  // rules merely because strict mode is enabled.
  const strictNestedProject = path.join(temp, "strict-nested-project");
  const strictNestedRules = path.join(strictNestedProject, ".claude", "rules");
  const strictNestedSource = path.join(strictNestedProject, "src", "nested.ts");
  await fs.mkdir(strictNestedRules, { recursive: true });
  await fs.mkdir(path.dirname(strictNestedSource), { recursive: true });
  await fs.writeFile(
    path.join(strictNestedRules, "nested.md"),
    "---\npaths:\n  - \"src/**/*.ts\"\n---\nSTRICT_NESTED_RULE\n",
    "utf8"
  );
  await fs.writeFile(strictNestedSource, "export const nested = true;\n", "utf8");
  const strictNestedRulesResult = await call("load_path_rules", { path: strictNestedSource });
  assert.equal(strictNestedRulesResult.isError, false, `strict nested load_path_rules: ${strictNestedRulesResult.text}`);
  assert.equal(
    path.normalize(strictNestedRulesResult.structuredContent?.data?.project_root || ""),
    path.normalize(await fs.realpath(strictNestedProject)),
    `strict nested project root drifted to collection root: ${strictNestedRulesResult.text}`
  );
  assert.match(strictNestedRulesResult.text, /STRICT_NESTED_RULE/, "strict nested project rule was not loaded");
  ok("strict collection authority preserves nested project rule ownership");

  r = await call("project_context", { path: dynamicProject, max_depth: 0 });
  assert.equal(r.isError, true, `strict project_context unexpectedly accepted dynamic repo: ${r.text}`);
  assert.match(r.text, /PROJECT_CONTEXT_SCOPE_DENIED|ngoài workspace|outside workspace/i);
  ok("project_context dynamically binds explicit repos only in trusted full-disk mode");

  // --- mcp_servers: {} -----------------------------------------------------
  r = await call("mcp_servers", {});
  assert.equal(r.isError, false, `mcp_servers legacy: ${r.text}`);
  assert.match(r.text, /"count":0/);
  ok("mcp_servers accepts {}");
} catch (e) {
  fail("legacy compat", e.stack ?? e);
} finally {
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  setDefaultCwd(oldCwd);
  setWorkspaceRoots(oldRoots);
  if (oldProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
  else process.env.CHATGPT_TOOL_PROFILE = oldProfile;
  for (const [key, value] of Object.entries(oldRuntimeEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The fixture dir is owned by this test and created just above; remove it on
  // exit like the sibling git/sandbox tests so runs leave no residue under the
  // repo parent. The dir never holds user content, so exact-target removal is
  // safe and matches the established test convention.
  await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  if (dynamicProject) await fs.rm(dynamicProject, { recursive: true, force: true }).catch(() => undefined);
  if (escapeProject) await fs.rm(escapeProject, { recursive: true, force: true }).catch(() => undefined);
  if (escapeOutside) await fs.rm(escapeOutside, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
