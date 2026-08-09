import fs from "fs/promises";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "url";
import { globFiles } from "../dist/lib/glob-search.js";
import { globToRegExp } from "../dist/lib/glob-match.js";
import { grepSearch } from "../dist/lib/grep-search.js";
import { regexLineMatches } from "../dist/lib/regex-guard.js";
import { applyMultiFilePatch, applyUnifiedPatchToText, isMultiFilePatch } from "../dist/lib/patch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clc-tools-"));

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

await fs.mkdir(tmpDir, { recursive: true });

await run("glob finds typescript files", async () => {
  const matches = await globFiles(root, "src/**/*.ts", 50);
  if (!matches.some((m) => m.path.endsWith("filesystem.ts"))) throw new Error("filesystem.ts not found");
});

await run("globstar matches root, immediate child, nested, and dotfiles", async () => {
  const dir = path.join(tmpDir, "globstar");
  await fs.mkdir(path.join(dir, "src", "deep"), { recursive: true });
  await fs.mkdir(path.join(dir, ".github"), { recursive: true });
  await fs.writeFile(path.join(dir, "root.ts"), "root\n");
  await fs.writeFile(path.join(dir, "src", "App.tsx"), "app\n");
  await fs.writeFile(path.join(dir, "src", "deep", "Nested.tsx"), "nested\n");
  await fs.writeFile(path.join(dir, ".env"), "SECRET=nope\n");
  await fs.writeFile(path.join(dir, ".github", "workflow.yml"), "name: ci\n");

  const rootTs = await globFiles(dir, "**/*.ts", 50);
  if (!rootTs.some((m) => m.path.endsWith("root.ts"))) throw new Error("globstar missed root-level root.ts");
  const tsx = await globFiles(dir, "src/**/*.tsx", 50);
  if (!tsx.some((m) => m.path.endsWith("App.tsx"))) throw new Error("globstar missed immediate App.tsx");
  if (!tsx.some((m) => m.path.endsWith("Nested.tsx"))) throw new Error("globstar missed nested Nested.tsx");
  const env = await globFiles(dir, ".env", 10);
  if (!env.some((m) => m.path.endsWith(".env"))) throw new Error("glob skipped dotfile");
  const github = await globFiles(dir, ".github/**/*.yml", 10);
  if (!github.some((m) => m.path.endsWith("workflow.yml"))) throw new Error("glob skipped dot-directory");
});

await run("glob compiler treats regex metacharacters literally", async () => {
  const literal = globToRegExp("[draft](1)+.txt");
  if (!literal.test("[draft](1)+.txt")) throw new Error("literal regex metacharacters did not match themselves");
  if (literal.test("d1.txt")) throw new Error("regex metacharacters leaked into glob semantics");
  const wildcard = globToRegExp("*.log");
  if (!wildcard.test("server.log") || wildcard.test("server.log.tmp")) throw new Error("glob wildcard semantics regressed");
});

await run("grep content mode", async () => {
  const out = await grepSearch({ pattern: "registerFilesystemTools", path: path.join(root, "src"), glob: "*.ts", headLimit: 10 });
  if (!out.includes("filesystem.ts")) throw new Error("pattern not found");
});

await run("grep files_with_matches mode", async () => {
  const out = await grepSearch({
    pattern: "createMcpServer",
    path: path.join(root, "src"),
    glob: "*.ts",
    outputMode: "files_with_matches",
    headLimit: 10,
  });
  if (!out.includes("server-factory")) throw new Error("file not listed");
});

await run("grep accepts a direct file path", async () => {
  const file = path.join(tmpDir, "direct-grep.txt");
  await fs.writeFile(file, "alpha\nneedle direct\nomega\n");
  const out = await grepSearch({
    pattern: "needle direct",
    path: file,
    glob: "*",
    outputMode: "content",
    headLimit: 10,
  });
  if (!out.includes("direct-grep.txt:2: needle direct")) throw new Error(`direct file grep failed: ${out}`);
});

await run("grep path glob and multiline count", async () => {
  const dir = path.join(tmpDir, "grep-glob");
  await fs.mkdir(path.join(dir, "src", "deep"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "App.tsx"), "needle\nneedle\n");
  await fs.writeFile(path.join(dir, "src", "deep", "Nested.tsx"), "needle\n");
  await fs.writeFile(path.join(dir, "outside.tsx"), "needle\n");
  await fs.writeFile(path.join(dir, ".hidden.tsx"), "needle\n");

  const pathFiltered = await grepSearch({
    pattern: "needle",
    path: dir,
    glob: "src/**/*.tsx",
    outputMode: "files_with_matches",
    headLimit: 20,
  });
  if (!pathFiltered.includes("App.tsx") || !pathFiltered.includes("Nested.tsx")) {
    throw new Error(`path glob missed expected files: ${pathFiltered}`);
  }
  if (pathFiltered.includes("outside.tsx")) throw new Error(`path glob leaked outside match: ${pathFiltered}`);

  const counted = await grepSearch({
    pattern: "needle",
    path: dir,
    glob: "src/App.tsx",
    outputMode: "count",
    multiline: true,
    headLimit: 20,
  });
  if (!counted.endsWith("App.tsx:2")) throw new Error(`multiline count incorrect: ${counted}`);

  const hidden = await grepSearch({
    pattern: "needle",
    path: dir,
    glob: ".hidden.tsx",
    outputMode: "files_with_matches",
    headLimit: 20,
  });
  if (!hidden.includes(".hidden.tsx")) throw new Error("grep skipped dotfile");
});

await run("regex timeout is isolated and queued work recovers", async () => {
  const pathological = regexLineMatches("(a+)+$", "", `${"a".repeat(30000)}!`, 1);
  const queuedNormal = regexLineMatches("needle", "", "alpha\nneedle\nomega", 2);
  let timedOut = false;
  try {
    await pathological;
  } catch (err) {
    timedOut = /timed out/i.test(String(err));
  }
  if (!timedOut) throw new Error("pathological regex did not hit the worker timeout");
  const normal = await queuedNormal;
  if (normal.count !== 1 || normal.indexes[0] !== 1) {
    throw new Error(`queued regex did not recover after timeout: ${JSON.stringify(normal)}`);
  }
});

await run("grep propagates regex timeout instead of returning false no-match", async () => {
  const file = path.join(tmpDir, "regex-timeout.txt");
  await fs.writeFile(file, `${"a".repeat(30000)}!\n`);
  let timedOut = false;
  try {
    await grepSearch({ pattern: "(a+)+$", path: file, glob: "*", headLimit: 10 });
  } catch (err) {
    timedOut = /timed out/i.test(String(err));
  }
  if (!timedOut) throw new Error("grep swallowed a regex timeout as No matches found");
});

await run("apply_patch codex style", async () => {
  const file = path.join(tmpDir, "sample.txt");
  await fs.writeFile(file, "hello\nworld\n");
  const next = applyUnifiedPatchToText("hello\nworld\n", "@@\n-hello\n+hi\n world\n");
  if (!next.includes("hi")) throw new Error("patch failed");
});

await run("read offset/limit simulation", async () => {
  const file = path.join(tmpDir, "lines.txt");
  await fs.writeFile(file, "a\nb\nc\nd\n");
  const lines = (await fs.readFile(file, "utf-8")).split("\n");
  const slice = lines.slice(1, 3);
  if (slice.join(",") !== "b,c") throw new Error(`unexpected ${slice}`);
});

await run("edit replace_all simulation", async () => {
  const file = path.join(tmpDir, "repeat.txt");
  await fs.writeFile(file, "foo bar foo");
  const content = await fs.readFile(file, "utf-8");
  const next = content.split("foo").join("baz");
  await fs.writeFile(file, next);
  const result = await fs.readFile(file, "utf-8");
  if (result !== "baz bar baz") throw new Error(result);
});

await run("multi-file patch detection", async () => {
  const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-hello
+hi
*** End Patch`;
  if (!isMultiFilePatch(patch)) throw new Error("should detect multi-file patch");
});

await run("multi-file patch apply", async () => {
  const file = path.join(tmpDir, "multi.txt");
  await fs.writeFile(file, "alpha\nbeta\n");
  const patch = `*** Begin Patch
*** Update File: multi.txt
@@
-alpha
+gamma
 beta
*** End Patch`;
  const results = await applyMultiFilePatch(patch, { base_dir: tmpDir });
  if (results.length !== 1 || !results[0].ok) throw new Error(JSON.stringify(results));
  const text = await fs.readFile(file, "utf-8");
  if (!text.includes("gamma")) throw new Error(text);
});

await run("multi-file patch preflight prevents partial writes", async () => {
  const first = path.join(tmpDir, "transaction-a.txt");
  const second = path.join(tmpDir, "transaction-b.txt");
  await fs.writeFile(first, "alpha\n");
  await fs.writeFile(second, "beta\n");
  const patch = `*** Begin Patch
*** Update File: transaction-a.txt
@@
-alpha
+changed
*** Update File: transaction-b.txt
@@
-missing
+never
*** End Patch`;
  const results = await applyMultiFilePatch(patch, { base_dir: tmpDir });
  if (results.some((result) => result.ok)) throw new Error(`expected all operations rejected: ${JSON.stringify(results)}`);
  if ((await fs.readFile(first, "utf-8")) !== "alpha\n") throw new Error("first file changed despite later preflight failure");
  if ((await fs.readFile(second, "utf-8")) !== "beta\n") throw new Error("second file changed despite preflight failure");
});

await run("delete and move file", async () => {
  const src = path.join(tmpDir, "move-me.txt");
  const dest = path.join(tmpDir, "moved.txt");
  await fs.writeFile(src, "payload");
  await fs.rename(src, dest);
  const text = await fs.readFile(dest, "utf-8");
  if (text !== "payload") throw new Error("move failed");
  await fs.unlink(dest);
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);