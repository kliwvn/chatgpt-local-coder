import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "../dist/lib/atomic-write.js";
import { withFileMutation, withFileMutations } from "../dist/lib/file-mutation.js";
import { loadProjectMemory } from "../dist/lib/project-memory.js";
import {
  setDefaultCwd,
  setWorkspaceRoots,
  validatePath,
} from "../dist/lib/path-security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getTwoFreePorts() {
  const first = net.createServer();
  const second = net.createServer();
  await new Promise((resolve, reject) => first.listen(0, "127.0.0.1", resolve).once("error", reject));
  await new Promise((resolve, reject) => second.listen(0, "127.0.0.1", resolve).once("error", reject));
  const ports = [first.address().port, second.address().port];
  await Promise.all([
    new Promise((resolve) => first.close(resolve)),
    new Promise((resolve) => second.close(resolve)),
  ]);
  return ports;
}

async function waitForHealth(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error("isolated MCP server did not become healthy");
}

async function initialize(port, id) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "filesystem-safety-test", version: "1" },
      },
    }),
  });
  assert(response.ok, `initialize failed: HTTP ${response.status}`);
  const sessionId = response.headers.get("mcp-session-id");
  assert(sessionId, "initialize did not return mcp-session-id");
  return sessionId;
}

async function callTool(port, sessionId, id, name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: response.status, text: await response.text() };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-filesystem-safety-"));
const oldFullDisk = process.env.FULL_DISK_ACCESS;

try {
  // Path boundary: an in-workspace junction/symlink must not escape the sandbox.
  const workspace = path.join(root, "workspace");
  const outsideDir = path.join(root, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outsideDir);
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "TOP_SECRET\n");
  const escapeLink = path.join(workspace, "escape");
  await fs.symlink(outsideDir, escapeLink, process.platform === "win32" ? "junction" : "dir");

  process.env.FULL_DISK_ACCESS = "false";
  setDefaultCwd(workspace);
  setWorkspaceRoots([workspace]);

  let existingEscapeBlocked = false;
  try {
    await validatePath(path.join(escapeLink, "secret.txt"));
  } catch {
    existingEscapeBlocked = true;
  }
  assert(existingEscapeBlocked, "validatePath allowed existing symlink/junction escape");

  let createEscapeBlocked = false;
  try {
    await validatePath(path.join(escapeLink, "new.txt"));
  } catch {
    createEscapeBlocked = true;
  }
  assert(createEscapeBlocked, "validatePath allowed create path through symlink/junction escape");

  // Project-controlled memory cannot use @import or a .claude junction to read
  // outside the configured workspace while the path sandbox is enabled.
  const memorySecret = "MEMORY_ESCAPE_SECRET_7f31";
  await fs.writeFile(path.join(outsideDir, "memory-secret.md"), `${memorySecret}\n`);
  await fs.writeFile(path.join(workspace, "CLAUDE.md"), `project-memory\n@../outside/memory-secret.md\n`);
  const outsideClaude = path.join(outsideDir, "claude-dir");
  await fs.mkdir(path.join(outsideClaude, "rules"), { recursive: true });
  await fs.writeFile(path.join(outsideClaude, "CLAUDE.md"), `${memorySecret}-claude\n`);
  await fs.writeFile(path.join(outsideClaude, "rules", "escape.md"), `${memorySecret}-rule\n`);
  await fs.symlink(outsideClaude, path.join(workspace, ".claude"), process.platform === "win32" ? "junction" : "dir");
  const memory = await loadProjectMemory(workspace, {
    maxBytes: 100000,
    maxLines: 1000,
    workspaceRoots: [workspace],
  });
  const projectMemoryText = memory.sections
    .filter((section) => section.kind !== "user")
    .map((section) => section.content)
    .join("\n");
  assert(!projectMemoryText.includes(memorySecret), "project memory imported content outside workspace");
  assert(projectMemoryText.includes("import blocked"), "blocked project-memory import was not surfaced safely");

  // A workspace root that is itself a symlink/junction remains usable because
  // both the configured root and requested path are canonicalized consistently.
  const realWorkspace = path.join(root, "real-workspace");
  const linkedWorkspace = path.join(root, "linked-workspace");
  await fs.mkdir(realWorkspace);
  await fs.writeFile(path.join(realWorkspace, "inside.txt"), "inside\n");
  await fs.symlink(realWorkspace, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");
  setDefaultCwd(linkedWorkspace);
  setWorkspaceRoots([linkedWorkspace]);
  const canonicalInside = await validatePath(path.join(linkedWorkspace, "inside.txt"));
  assert(
    path.normalize(canonicalInside) === path.normalize(path.join(realWorkspace, "inside.txt")),
    "symlinked workspace root did not canonicalize consistently"
  );

  // Scheduler: same-file writes serialize, unrelated siblings stay parallel,
  // and directory operations conflict with descendants.
  const shared = path.join(realWorkspace, "shared.txt");
  await fs.writeFile(shared, "");
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      withFileMutation(shared, async () => {
        const current = await fs.readFile(shared, "utf8");
        await delay(2);
        await atomicWriteFile(shared, `${current}${i}\n`, "utf8");
      })
    )
  );
  const sharedLines = (await fs.readFile(shared, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  assert(sharedLines.length === 30 && new Set(sharedLines).size === 30, "same-file mutation lost updates");

  let activeSiblings = 0;
  let maxSiblingConcurrency = 0;
  const siblingJob = (file) =>
    withFileMutation(file, async () => {
      activeSiblings++;
      maxSiblingConcurrency = Math.max(maxSiblingConcurrency, activeSiblings);
      await delay(30);
      activeSiblings--;
    });
  await Promise.all([
    siblingJob(path.join(realWorkspace, "a.txt")),
    siblingJob(path.join(realWorkspace, "b.txt")),
  ]);
  assert(maxSiblingConcurrency === 2, "unrelated sibling files were unnecessarily serialized");

  const parent = path.join(realWorkspace, "tree");
  const child = path.join(parent, "child.txt");
  const order = [];
  await Promise.all([
    withFileMutation(parent, async () => {
      order.push("parent-start");
      await delay(30);
      order.push("parent-end");
    }),
    withFileMutation(child, async () => {
      order.push("child-start");
      order.push("child-end");
    }),
  ]);
  assert(order.join(",") === "parent-start,parent-end,child-start,child-end", "directory/child mutations overlapped");

  // A later single-path job must not overtake an earlier multi-path waiter that
  // conflicts with it, otherwise continuous traffic can starve the multi-path job.
  const fairA = path.join(realWorkspace, "fair-a.txt");
  const fairB = path.join(realWorkspace, "fair-b.txt");
  const fairOrder = [];
  let releaseFairActive;
  const fairGate = new Promise((resolve) => {
    releaseFairActive = resolve;
  });
  const fairActive = withFileMutation(fairA, async () => {
    fairOrder.push("active-start");
    await fairGate;
    fairOrder.push("active-end");
  });
  await delay(5);
  const fairMiddle = withFileMutations([fairA, fairB], async () => {
    fairOrder.push("middle");
  });
  const fairLater = withFileMutation(fairB, async () => {
    fairOrder.push("later");
  });
  await delay(15);
  assert(!fairOrder.includes("later"), "later conflicting job overtook an earlier multi-path waiter");
  releaseFairActive();
  await Promise.all([fairActive, fairMiddle, fairLater]);
  assert(fairOrder.join(",") === "active-start,active-end,middle,later", `mutation fairness order was ${fairOrder.join(",")}`);

  // End-to-end MCP regression: two transport sessions editing the same file must
  // merge non-overlapping edits instead of last-write-wins, and multi-file patch
  // paths must not escape the workspace with ../.
  const mcpWorkspace = path.join(root, "mcp-workspace");
  const outsideFile = path.join(root, "outside-patch.txt");
  await fs.mkdir(mcpWorkspace);
  await fs.writeFile(outsideFile, "OLD\n");
  const raceFile = path.join(mcpWorkspace, "race.txt");
  await fs.writeFile(raceFile, "A B\n");
  const mcpEscape = path.join(mcpWorkspace, "escape");
  await fs.symlink(outsideDir, mcpEscape, process.platform === "win32" ? "junction" : "dir");
  const mcpFileEscape = path.join(mcpWorkspace, "secret-link.txt");
  let fileSymlinkCreated = true;
  try {
    await fs.symlink(path.join(outsideDir, "secret.txt"), mcpFileEscape, "file");
  } catch (err) {
    if (process.platform === "win32" && err?.code === "EPERM") fileSymlinkCreated = false;
    else throw err;
  }

  const [port, adminPort] = await getTwoFreePorts();
  const server = spawn(process.execPath, ["dist/index.js"], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PORT: String(adminPort),
      WORKSPACE_PATH: mcpWorkspace,
      EXTRA_WORKSPACE_PATHS: repo,
      FULL_DISK_ACCESS: "false",
      CHATGPT_TOOL_PROFILE: "full",
      CHECKPOINT_PATH: path.join(mcpWorkspace, ".checkpoints"),
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth(port);
    const [sessionA, sessionB] = await Promise.all([initialize(port, 1), initialize(port, 2)]);
    await Promise.all([
      callTool(port, sessionA, 11, "edit_file", { path: raceFile, old_text: "A", new_text: "AA" }),
      callTool(port, sessionB, 12, "edit_file", { path: raceFile, old_text: "B", new_text: "BB" }),
    ]);
    assert((await fs.readFile(raceFile, "utf8")) === "AA BB\n", "concurrent MCP edit_file lost an update");

    const escapePatch = [
      "*** Begin Patch",
      "*** Update File: ../outside-patch.txt",
      "@@",
      "-OLD",
      "+PWNED",
      "*** End Patch",
    ].join("\n");
    const patchResult = await callTool(port, sessionA, 13, "apply_patch", { path: mcpWorkspace, patch: escapePatch });
    assert((await fs.readFile(outsideFile, "utf8")) === "OLD\n", "multi-file apply_patch escaped workspace");
    assert(/isError|ngoài workspace|outside workspace/i.test(patchResult.text), "escape patch was not reported as an error");

    const readEscape = await callTool(port, sessionA, 14, "read_text_file", {
      path: path.join(mcpEscape, "secret.txt"),
    });
    assert(!readEscape.text.includes("TOP_SECRET"), "read_text_file leaked data through workspace symlink/junction");
    assert(/isError|ngoài workspace|outside workspace/i.test(readEscape.text), "symlink/junction escape was not reported as an error");

    if (fileSymlinkCreated) {
      const grepEscape = await callTool(port, sessionA, 15, "grep", {
        path: mcpWorkspace,
        pattern: "TOP_SECRET",
        glob: "*.txt",
        output_mode: "content",
      });
      assert(!grepEscape.text.includes("TOP_SECRET"), "grep followed an unvalidated symlink file outside workspace");

      const globEscape = await callTool(port, sessionA, 16, "glob", {
        path: mcpWorkspace,
        pattern: "**/*.txt",
        max_results: 100,
      });
      assert(!globEscape.text.includes("secret-link.txt"), "glob exposed an unvalidated symlink-file target");
    }

    // Exercise the real EXDEV path when the test workspace and repository live
    // on different volumes (common on the Windows deployment this project uses).
    // On single-volume CI this still verifies normal move semantics.
    const moveSource = path.join(mcpWorkspace, "cross-volume-source.txt");
    const moveDestination = path.join(repo, `.cross-volume-move-test-${process.pid}-${Date.now()}.txt`);
    await fs.writeFile(moveSource, "cross-volume-payload\n");
    try {
      const moveResult = await callTool(port, sessionA, 17, "move_file", {
        source: moveSource,
        destination: moveDestination,
      });
      assert(!/isError["\\]*:\s*true/i.test(moveResult.text), `move_file returned error: ${moveResult.text.slice(0, 800)}`);
      assert((await fs.readFile(moveDestination, "utf8")) === "cross-volume-payload\n", "move_file destination content mismatch");
      let sourceStillExists = true;
      try {
        await fs.access(moveSource);
      } catch {
        sourceStillExists = false;
      }
      assert(!sourceStillExists, "move_file left source behind after successful move");
      const differentVolumes = path.parse(mcpWorkspace).root.toLowerCase() !== path.parse(repo).root.toLowerCase();
      if (differentVolumes) {
        assert(/cross_volume["\\]*:\s*true/i.test(moveResult.text), "cross-volume move did not report EXDEV fallback");
      }
    } finally {
      await fs.rm(moveDestination, { force: true });
    }

    const moveDirSource = path.join(mcpWorkspace, "cross-volume-dir-source");
    const moveDirDestination = path.join(repo, `.cross-volume-move-dir-test-${process.pid}-${Date.now()}`);
    await fs.mkdir(path.join(moveDirSource, "nested"), { recursive: true });
    await fs.writeFile(path.join(moveDirSource, "nested", "payload.txt"), "directory-payload\n");
    try {
      const moveDirResult = await callTool(port, sessionA, 18, "move_file", {
        source: moveDirSource,
        destination: moveDirDestination,
      });
      assert(!/isError["\\]*:\s*true/i.test(moveDirResult.text), `directory move_file returned error: ${moveDirResult.text.slice(0, 800)}`);
      assert(
        (await fs.readFile(path.join(moveDirDestination, "nested", "payload.txt"), "utf8")) === "directory-payload\n",
        "cross-volume directory move content mismatch"
      );
      let dirSourceStillExists = true;
      try {
        await fs.access(moveDirSource);
      } catch {
        dirSourceStillExists = false;
      }
      assert(!dirSourceStillExists, "cross-volume directory move left source behind");
      const differentVolumes = path.parse(mcpWorkspace).root.toLowerCase() !== path.parse(repo).root.toLowerCase();
      if (differentVolumes) {
        assert(/cross_volume["\\]*:\s*true/i.test(moveDirResult.text), "cross-volume directory move did not report EXDEV fallback");
      }
    } finally {
      await fs.rm(moveDirDestination, { recursive: true, force: true });
    }
  } finally {
    server.kill("SIGTERM");
    await delay(400);
    if (server.exitCode == null && process.platform === "win32" && server.pid) {
      spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
  }

  console.log("filesystem-safety: ok (junction/patch escapes blocked, concurrent edits serialized, prefix fairness safe, cross-volume move safe)");
} finally {
  if (oldFullDisk === undefined) delete process.env.FULL_DISK_ACCESS;
  else process.env.FULL_DISK_ACCESS = oldFullDisk;
  await fs.rm(root, { recursive: true, force: true });
}