/**
 * Behavioral coverage for Local Coder bootstrap skill discovery.
 *
 * Breaks caught:
 * - global/project skill catalogs stop surfacing real SKILL.md metadata;
 * - nested skills disappear when a collection directory also has SKILL.md;
 * - strict-mode catalog traversal follows a directory alias outside its trusted root;
 * - formatted bootstrap instructions inject skill bodies instead of metadata only.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getDefaultCwd,
  getWorkspaceRoots,
  setDefaultCwd,
  setWorkspaceRoots,
} from "../dist/lib/path-security.js";
import {
  formatSkillsForInstructions,
  loadSkillDiscovery,
} from "../dist/lib/skills-loader.js";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "condition false") {
  if (condition) {
    console.log(`OK  ${name}`);
    passed++;
  } else {
    console.error(`FAIL ${name}: ${detail}`);
    failed++;
  }
}

const previousEnv = Object.fromEntries(
  ["HOME", "USERPROFILE", "FULL_DISK_ACCESS"].map((key) => [key, process.env[key]])
);
const previousCwd = getDefaultCwd();
const previousRoots = getWorkspaceRoots();

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-skill-discovery-"));
const home = path.join(temp, "home");
const workspace = path.join(temp, "workspace");
const outside = path.join(temp, "outside");
const globalSkillsRoot = path.join(home, ".agents", "skills");
const globalCollection = path.join(globalSkillsRoot, "collection");
const nestedSkill = path.join(globalCollection, "skills", "nested");
const projectSkill = path.join(workspace, ".claude", "skills", "project-fixture");
const outsideGlobal = path.join(outside, "global-escape");
const outsideProject = path.join(outside, "project-escape");

try {
  await Promise.all([
    fs.mkdir(path.join(home, ".agents", "global-harness"), { recursive: true }),
    fs.mkdir(nestedSkill, { recursive: true }),
    fs.mkdir(projectSkill, { recursive: true }),
    fs.mkdir(outsideGlobal, { recursive: true }),
    fs.mkdir(outsideProject, { recursive: true }),
  ]);

  await Promise.all([
    fs.writeFile(path.join(home, ".agents", "AGENTS.md"), "# Fixture AGENTS\n", "utf8"),
    fs.writeFile(
      path.join(globalCollection, "SKILL.md"),
      "---\nname: collection-fixture\ndescription: Collection entry\n---\n\n# Collection Fixture\nBODY_SENTINEL_COLLECTION\n",
      "utf8"
    ),
    fs.writeFile(
      path.join(nestedSkill, "SKILL.md"),
      "---\nname: nested-fixture\ndescription: >-\n  Nested folded\n  description\n---\n\n# Nested Fixture\nBODY_SENTINEL_NESTED\n",
      "utf8"
    ),
    fs.writeFile(
      path.join(projectSkill, "SKILL.md"),
      "---\nname: project-fixture\ndescription: Project entry\n---\n\n# Project Fixture\nBODY_SENTINEL_PROJECT\n",
      "utf8"
    ),
    fs.writeFile(
      path.join(outsideGlobal, "SKILL.md"),
      "---\nname: global-escape\ndescription: Must stay hidden\n---\n",
      "utf8"
    ),
    fs.writeFile(
      path.join(outsideProject, "SKILL.md"),
      "---\nname: project-escape\ndescription: Must stay hidden\n---\n",
      "utf8"
    ),
  ]);

  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outsideGlobal, path.join(globalSkillsRoot, "escape-link"), linkType);
  await fs.symlink(outsideProject, path.join(workspace, ".claude", "skills", "escape-link"), linkType);

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.FULL_DISK_ACCESS = "false";
  setDefaultCwd(workspace);
  setWorkspaceRoots([workspace]);

  const discovery = await loadSkillDiscovery(workspace);
  const globalNames = discovery.global_skills.map((skill) => skill.name);
  const projectNames = discovery.project_skills.map((skill) => skill.name);
  const nested = discovery.global_skills.find((skill) => skill.name === "nested-fixture");

  check(
    "canonical bootstrap roots are exposed",
    discovery.agents_md === path.join(home, ".agents", "AGENTS.md") &&
      discovery.global_harness_root === path.join(home, ".agents", "global-harness") &&
      discovery.global_skills_root === globalSkillsRoot,
    JSON.stringify(discovery)
  );
  check(
    "collection and nested global skills are both discovered",
    globalNames.includes("collection-fixture") && globalNames.includes("nested-fixture"),
    JSON.stringify(globalNames)
  );
  check(
    "folded frontmatter description is normalized",
    nested?.description === "Nested folded description",
    JSON.stringify(nested)
  );
  check(
    "project skill metadata is discovered",
    projectNames.length === 1 &&
      projectNames[0] === "project-fixture" &&
      discovery.project_skills[0]?.scope === "project",
    JSON.stringify(discovery.project_skills)
  );
  check(
    "strict catalog traversal rejects directory aliases escaping trusted roots",
    !globalNames.includes("global-escape") && !projectNames.includes("project-escape"),
    JSON.stringify({ globalNames, projectNames })
  );
  check(
    "discovery total reflects accepted skills only",
    discovery.total_skills === 3,
    String(discovery.total_skills)
  );

  const instructions = formatSkillsForInstructions(discovery);
  check(
    "bootstrap instructions expose metadata needed for on-demand selection",
    instructions.includes("collection-fixture") &&
      instructions.includes("nested-fixture") &&
      instructions.includes("project-fixture") &&
      instructions.includes("Nested folded description"),
    instructions
  );
  check(
    "bootstrap instructions never inject SKILL.md bodies",
    !instructions.includes("BODY_SENTINEL_COLLECTION") &&
      !instructions.includes("BODY_SENTINEL_NESTED") &&
      !instructions.includes("BODY_SENTINEL_PROJECT"),
    instructions
  );
} catch (error) {
  console.error(error?.stack || error);
  failed++;
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setDefaultCwd(previousCwd);
  setWorkspaceRoots(previousRoots);
  // P0 safety policy: leave the isolated temp tree for OS-managed cleanup.
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
