import { getFullDiskAccess } from "./path-security.js";

/**
 * Agent-supplied shell text is classified before any shell spawn. Known destructive
 * filesystem/disk/Git primitives and nested-shell equivalents fail closed here.
 * This is still an application guard rather than an OS sandbox: once a permitted
 * arbitrary binary/script starts, the OS does not confine that child filesystem-wise.
 */

export type PermissionProfile = "open";

export function getPermissionProfile(): PermissionProfile {
  return "open";
}

export function isReadOnly(): boolean {
  return false;
}

export function canWriteFiles(): boolean {
  return true;
}

export function canRunCommands(): boolean {
  return true;
}

export function canUseAnyAbsolutePath(): boolean {
  return getFullDiskAccess();
}

const DELETE_COMMANDS = new Set([
  "rm",
  "srm",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "rmdir",
  "unlink",
  "truncate",
]);
const CRITICAL_DISK_COMMANDS = new Set([
  "diskpart",
  "format",
  "mkfs",
  "fdisk",
  "sfdisk",
  "parted",
  "wipefs",
  "shred",
  "dd",
]);
const POWERSHELL_DESTRUCTIVE_COMMANDS = new Set([
  "clear-content",
  "clear-disk",
  "initialize-disk",
  "remove-partition",
  "format-volume",
]);
const DYNAMIC_EXECUTION_COMMANDS = new Set([
  "invoke-expression",
  "iex",
]);
const CMD_CONTROL_COMMANDS = new Set(["if", "for", "forfiles", "xargs", "parallel"]);
const COMMAND_PREFIXES = new Set(["sudo", "command", "call", "do", "then", "else"]);
const PYTHON_BINARIES = /^(?:python(?:3(?:\.\d+)*)?|py)$/i;
const NODE_BINARIES = /^node$/i;
const PERL_BINARIES = /^perl(?:\d+(?:\.\d+)*)?$/i;
const RUBY_BINARIES = /^ruby(?:\d+(?:\.\d+)*)?$/i;
const PHP_BINARIES = /^php(?:\d+(?:\.\d+)*)?$/i;
const POWERSHELL_BINARIES = /^(?:powershell|pwsh)$/i;
const CMD_BINARIES = /^(?:cmd|%comspec%)$/i;
const POSIX_SHELL_BINARIES = /^(?:ba|z|da)?sh$/i;

function executableName(token: string): string {
  // Shell commands may invoke a dangerous executable through an absolute or
  // quoted path (for example C:\\Windows\\System32\\cmd.exe or /bin/rm).
  // Classify the executable by its basename so path spelling cannot bypass the
  // destructive-command guard. Strip the Windows executable suffix as well.
  const normalized = token
    .replace(/\^([^\r\n])/g, "$1")
    .replace(/`([^\r\n])/g, "$1")
    .replace(/^@+/, "")
    .replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return base.replace(/\.(?:exe|com|cmd|bat)$/i, "");
}

function splitShellSegments(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote && ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\r" || ch === "\n" || ch === "{" || ch === "}") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (const ch of input.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote && ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ch === ",") push();
    else current += ch;
  }
  push();
  return tokens;
}

function stripQuotedLiterals(input: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      out += " ";
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function stripSingleQuotedLiterals(input: string): string {
  let out = "";
  let inSingle = false;
  for (let index = 0; index < input.length; index++) {
    const ch = input[index];
    if (inSingle) {
      // PowerShell escapes a literal single quote inside a single-quoted string
      // by doubling it. Keep the whole literal opaque to command-substitution
      // scanning; POSIX single quotes are opaque as well.
      if (ch === "'" && input[index + 1] === "'") {
        out += "  ";
        index++;
        continue;
      }
      if (ch === "'") inSingle = false;
      out += " ";
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function foldSimpleStringConcatenations(input: string): string {
  let current = input;
  const pair = /(['"])([A-Za-z0-9_.:-]*)\1\s*\.\s*(['"])([A-Za-z0-9_.:-]*)\3/g;
  for (let pass = 0; pass < 8; pass++) {
    const next = current.replace(pair, (_match, _q1, left: string, _q2, right: string) => `'${left}${right}'`);
    if (next === current) break;
    current = next;
  }
  return current;
}

function foldSimplePlusStringConcatenations(input: string): string {
  let current = input;
  const pair = /(['"])([A-Za-z0-9_.:-]*)\1\s*\+\s*(['"])([A-Za-z0-9_.:-]*)\3/g;
  for (let pass = 0; pass < 8; pass++) {
    const next = current.replace(pair, (_match, _q1, left: string, _q2, right: string) => `'${left}${right}'`);
    if (next === current) break;
    current = next;
  }
  return current;
}

function propagateBareAliases(input: string, bindings: Set<string>): void {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const match of input.matchAll(/\b(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;?/g)) {
      if (!bindings.has(match[2]) || bindings.has(match[1])) continue;
      bindings.add(match[1]);
      changed = true;
    }
    if (!changed) break;
  }
}

function propagateSigilAliases(input: string, bindings: Set<string>): void {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const match of input.matchAll(/\$([A-Za-z_]\w*)\s*=\s*\$([A-Za-z_]\w*)\s*;?/g)) {
      if (!bindings.has(match[2]) || bindings.has(match[1])) continue;
      bindings.add(match[1]);
      changed = true;
    }
    if (!changed) break;
  }
}

function firstCommandIndex(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    if (
      COMMAND_PREFIXES.has(token) ||
      /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index]) ||
      /^\$(?:(?:env|global|script|local|private):)?[A-Za-z_][A-Za-z0-9_]*=.*/i.test(tokens[index])
    ) index++;
    else if (token === "env") index++;
    else break;
  }
  return index;
}

function gitSubcommandIndex(tokens: string[], gitIndex: number): number {
  let index = gitIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token.startsWith("-")) return index;
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(token)) index += 2;
    else index++;
  }
  return -1;
}

function destructiveGit(tokens: string[], gitIndex: number): boolean {
  const subIndex = gitSubcommandIndex(tokens, gitIndex);
  if (subIndex < 0) return false;
  const sub = tokens[subIndex].toLowerCase();
  const args = tokens.slice(subIndex + 1);
  if (sub === "clean") return !args.some((arg) => arg === "-n" || arg === "--dry-run");
  if (sub === "reset") return args.some((arg) => arg === "--hard" || /^-[^-]*h[^-]*$/.test(arg));
  if (sub === "restore") return true;
  if (sub === "rm" || sub === "prune") return true;
  if (sub === "stash") return args.some((arg) => arg === "drop" || arg === "clear");
  if (sub === "reflog") return args.some((arg) => arg === "expire" || arg === "delete");
  if (sub === "gc") return args.some((arg) => /^--prune(?:=|$)/.test(arg));
  if (sub === "branch") return args.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete");
  if (sub === "push") {
    return args.some((arg) =>
      arg === "-f" ||
      arg === "--force" ||
      arg.startsWith("--force-with-lease") ||
      arg === "--mirror" ||
      arg === "--delete" ||
      arg === "--prune" ||
      arg.startsWith(":") ||
      (arg.startsWith("+") && arg.includes(":"))
    );
  }
  if (sub === "tag") return args.some((arg) => arg === "-d" || arg === "--delete");
  if (sub === "remote") return args.some((arg) => arg === "remove" || arg === "rm" || arg === "prune");
  if (sub === "worktree") return args.some((arg) => arg === "remove" || arg === "prune");
  if (sub === "notes") return args.some((arg) => arg === "remove" || arg === "prune");
  if (sub === "submodule") return args.some((arg) => arg === "deinit");
  if (sub === "checkout") return args.includes("--") || args.some((arg) => arg === "-f" || arg === "--force" || arg === "." || arg === "..");
  if (sub === "switch") return args.some((arg) => arg === "-f" || arg === "--force" || arg === "--discard-changes");
  return false;
}

function destructiveInlineCode(executable: string, code: string): boolean {
  const visible = stripQuotedLiterals(code);
  if (PYTHON_BINARIES.test(executable)) {
    const importsFilesystemModule =
      /\bimport\s+(?:os|shutil|pathlib)\b|\bfrom\s+(?:os|shutil|pathlib)\s+import\b|__import__\s*\(\s*['"](?:os|shutil|pathlib)['"]\s*\)/i.test(code);
    const filesystemBindings = new Set<string>();
    const pathBindings = new Set<string>();
    const destructiveFunctionBindings = new Set<string>();
    const opaqueFilesystemFunctionBindings = new Set<string>();
    for (const match of code.matchAll(/\bimport\s+(os|shutil|pathlib)\b(?:\s+as\s+([A-Za-z_]\w*))?/gi)) {
      filesystemBindings.add(match[2] || match[1]);
    }
    for (const match of code.matchAll(/\bfrom\s+(os|shutil)\s+import\s+(rmtree|remove|unlink|rmdir|removedirs)\b(?:\s+as\s+([A-Za-z_]\w*))?/gi)) {
      destructiveFunctionBindings.add(match[3] || match[2]);
    }
    for (const match of code.matchAll(/\bfrom\s+pathlib\s+import\s+Path\b(?:\s+as\s+([A-Za-z_]\w*))?/gi)) {
      pathBindings.add(match[1] || "Path");
    }
    if (/\b(?:eval|exec)\s*\(/i.test(visible)) return true;
    for (const binding of filesystemBindings) {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const match of code.matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\s*=\\s*${escaped}\\s*\\.\\s*(?:rmtree|remove|unlink|rmdir|removedirs)\\b`, "gi"))) {
        destructiveFunctionBindings.add(match[1]);
      }
    }
    for (const match of code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*getattr\s*\([^,]+,\s*['"](?:rmtree|remove|unlink|rmdir|removedirs)['"]\s*\)/gi)) {
      destructiveFunctionBindings.add(match[1]);
    }
    for (const binding of filesystemBindings) {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const match of code.matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\s*=\\s*getattr\\s*\\(\\s*${escaped}\\s*,\\s*([^)]*)\\)`, "gi"))) {
        const selector = match[2].trim();
        const literal = /^['"]([A-Za-z_]\w*)['"]$/.exec(selector);
        if (!literal) opaqueFilesystemFunctionBindings.add(match[1]);
      }
      for (const match of code.matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\s*=\\s*(?:vars\\s*\\(\\s*${escaped}\\s*\\)|${escaped}\\s*\\.__dict__)\\s*\\[\\s*([^\\]]+)\\s*\\]`, "gi"))) {
        const selector = match[2].trim();
        const literal = /^['"]([A-Za-z_]\w*)['"]$/.exec(selector);
        if (!literal) opaqueFilesystemFunctionBindings.add(match[1]);
        else if (/^(?:rmtree|remove|unlink|rmdir|removedirs)$/i.test(literal[1])) destructiveFunctionBindings.add(match[1]);
      }
    }
    propagateBareAliases(code, destructiveFunctionBindings);
    propagateBareAliases(code, opaqueFilesystemFunctionBindings);
    const boundFilesystemDelete = [...filesystemBindings].some((binding) => {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\s*\\.\\s*(?:rmtree|remove|unlink|rmdir|removedirs)\\s*\\(`, "i").test(visible)) return true;
      for (const match of code.matchAll(new RegExp(`\\bgetattr\\s*\\(\\s*${escaped}\\s*,\\s*([^)]*)\\)\\s*\\(`, "gi"))) {
        const literal = /^['"]([A-Za-z_]\w*)['"]$/.exec(match[1].trim());
        if (!literal || /^(?:rmtree|remove|unlink|rmdir|removedirs)$/i.test(literal[1])) return true;
      }
      for (const match of code.matchAll(new RegExp(`\\b(?:vars\\s*\\(\\s*${escaped}\\s*\\)|${escaped}\\s*\\.__dict__)\\s*\\[\\s*([^\\]]+)\\s*\\]\\s*\\(`, "gi"))) {
        const literal = /^['"]([A-Za-z_]\w*)['"]$/.exec(match[1].trim());
        if (!literal || /^(?:rmtree|remove|unlink|rmdir|removedirs)$/i.test(literal[1])) return true;
      }
      return false;
    });
    const importedDeleteCall = [...destructiveFunctionBindings].some((binding) => {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\s*\\(`).test(visible);
    });
    const opaqueFilesystemCall = [...opaqueFilesystemFunctionBindings].some((binding) => {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\s*\\(`).test(visible);
    });
    const pathlibDelete = [...pathBindings].some((binding) => {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*\\.\\s*(?:unlink|rmdir)\\s*\\(`, "i").test(visible);
    });
    return (
      /\bshutil\s*\.\s*rmtree\s*\(|\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(/i.test(visible) ||
      /\b(?:pathlib\s*\.\s*)?Path\s*\([^)]*\)\s*\.\s*(?:unlink|rmdir)\s*\(/i.test(visible) ||
      /__import__\s*\(\s*['"](?:shutil|os)['"]\s*\)\s*\.\s*(?:rmtree|remove|unlink|rmdir|removedirs)\s*\(/i.test(code) ||
      /\bgetattr\s*\([^,]+,\s*['"](?:rmtree|remove|unlink|rmdir|removedirs)['"]\s*\)\s*\(/i.test(code) ||
      /\boperator\s*\.\s*methodcaller\s*\(\s*['"](?:rmtree|remove|unlink|rmdir|removedirs)['"]/i.test(code) ||
      boundFilesystemDelete ||
      importedDeleteCall ||
      opaqueFilesystemCall ||
      pathlibDelete ||
      (importsFilesystemModule && /\b(?:rmtree|remove|unlink|rmdir|removedirs)\s*\(/i.test(visible))
    );
  }
  if (NODE_BINARIES.test(executable)) {
    const requireBindings = new Set<string>(["require"]);
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*;?/gi)) {
      requireBindings.add(match[1]);
    }
    const requireCall = [...requireBindings]
      .map((binding) => binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const importsFilesystemModule =
      new RegExp(`\\b(?:${requireCall})\\s*\\(\\s*['"](?:node:)?fs(?:\\/promises)?['"]\\s*\\)`, "i").test(code) ||
      /\bfrom\s*['"](?:node:)?fs(?:\/promises)?['"]|\bimport\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/i.test(code);
    const filesystemBindings = new Set<string>();
    const filesystemNameBindings = new Set<string>();
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"](?:node:)?fs(?:\/promises)?['"]\s*;?/gi)) {
      filesystemNameBindings.add(match[1]);
    }
    for (const binding of requireBindings) {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const bindingPattern = new RegExp(
        `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escaped}\\s*\\(\\s*['"](?:node:)?fs(?:\\/promises)?['"]\\s*\\)`,
        "gi",
      );
      for (const match of code.matchAll(bindingPattern)) filesystemBindings.add(match[1]);
      for (const moduleName of filesystemNameBindings) {
        const escapedModule = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const dynamicBindingPattern = new RegExp(
          `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escaped}\\s*\\(\\s*${escapedModule}\\s*\\)`,
          "gi",
        );
        for (const match of code.matchAll(dynamicBindingPattern)) filesystemBindings.add(match[1]);
      }
    }
    for (const match of code.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"](?:node:)?fs(?:\/promises)?['"]/gi)) {
      filesystemBindings.add(match[1]);
    }
    if (/\b(?:eval|Function)\s*\(/.test(visible)) return true;
    const destructiveFunctionBindings = new Set<string>();
    for (const binding of filesystemBindings) {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const match of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escaped}\\s*\\.\\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\\b`, "gi"))) {
        destructiveFunctionBindings.add(match[1]);
      }
    }
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)\s*\.\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\b/gi)) {
      destructiveFunctionBindings.add(match[1]);
    }
    for (const match of code.matchAll(/\{([^}]*)\}\s*=\s*require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/gi)) {
      for (const part of match[1].split(",")) {
        const named = /^\s*(rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*$/i.exec(part);
        if (named) destructiveFunctionBindings.add(named[2] || named[1]);
      }
    }
    for (const match of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/gi)) {
      for (const part of match[1].split(",")) {
        const named = /^\s*(rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*(?:as\s+([A-Za-z_$][\w$]*))?\s*$/i.exec(part);
        if (named) destructiveFunctionBindings.add(named[2] || named[1]);
      }
    }
    propagateBareAliases(code, destructiveFunctionBindings);
    const aliasedDeleteCall = [...destructiveFunctionBindings].some((binding) => {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\s*\\(`).test(visible);
    });
    const dynamicFilesystemMember = [...filesystemBindings].some((binding) => {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\s*\\.\\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\\s*\\(`, "i").test(visible)) return true;
      if (new RegExp(`\\b${escaped}\\s*\\.\\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\\s*\\.\\s*bind\\s*\\([^)]*\\)\\s*\\(`, "i").test(code)) return true;
      if (new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escaped}\\s*\\.\\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\\s*;?[\\s\\S]*\\b\\1\\s*\\(`, "i").test(code)) return true;
      for (const match of code.matchAll(new RegExp(`\\b${escaped}\\s*\\[\\s*([^\\]]+)\\s*\\]\\s*\\(`, "gi"))) {
        const literal = /^['"]([A-Za-z_$][\w$]*)['"]$/.exec(match[1].trim());
        if (!literal || /^(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)$/i.test(literal[1])) return true;
      }
      for (const match of code.matchAll(new RegExp(`\\bReflect\\s*\\.\\s*get\\s*\\(\\s*${escaped}\\s*,\\s*([^)]*)\\)\\s*\\(`, "gi"))) {
        const literal = /^['"]([A-Za-z_$][\w$]*)['"]$/.exec(match[1].trim());
        if (!literal || /^(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)$/i.test(literal[1])) return true;
      }
      return false;
    });
    let directRequireMember = false;
    for (const match of code.matchAll(/\brequire\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)\s*\[\s*([^\]]+)\s*\]\s*\(/gi)) {
      const literal = /^['"]([A-Za-z_$][\w$]*)['"]$/.exec(match[1].trim());
      if (!literal || /^(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)$/i.test(literal[1])) {
        directRequireMember = true;
        break;
      }
    }
    return (
      /\bfs(?:\s*\.\s*promises)?\s*\.\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*\(/i.test(visible) ||
      /require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)(?:\s*\.\s*promises)?\s*(?:\.\s*|\[\s*['"])(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)(?:['"]\s*\])?\s*\(/i.test(code) ||
      directRequireMember ||
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)\s*\.\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*;?[\s\S]*\b\1\s*\(/i.test(code) ||
      /\{[^}]*\b(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*:\s*([A-Za-z_$][\w$]*)[^}]*\}\s*=\s*require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)[\s\S]*\b\1\s*\(/i.test(code) ||
      (importsFilesystemModule && /\[\s*['"](?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)['"]\s*\]\s*\(/i.test(code)) ||
      (importsFilesystemModule && /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"](?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)['"][^;]*;[\s\S]*\[\s*\1\s*\]\s*\(/i.test(code)) ||
      aliasedDeleteCall ||
      dynamicFilesystemMember ||
      (importsFilesystemModule && /\b(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*\(/i.test(visible))
    );
  }
  if (PERL_BINARIES.test(executable)) {
    if (/\beval\b/i.test(visible)) return true;
    const folded = foldSimpleStringConcatenations(code);
    const destructiveFunctionBindings = new Set<string>();
    const literalFunctionBindings = new Map<string, string>();
    for (const match of folded.matchAll(/\$([A-Za-z_]\w*)\s*=\s*['"]([A-Za-z_]\w*)['"]\s*;?/gi)) literalFunctionBindings.set(match[1], match[2]);
    for (const match of folded.matchAll(/\$([A-Za-z_]\w*)\s*=\s*['"](?:unlink|rmdir)['"]\s*;?/gi)) destructiveFunctionBindings.add(match[1]);
    propagateSigilAliases(folded, destructiveFunctionBindings);
    const aliasedDeleteCall = [...destructiveFunctionBindings].some((binding) => {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`&\\s*\\$${escaped}\\s*\\(`, "i").test(folded);
    });
    for (const match of folded.matchAll(/&\s*\$([A-Za-z_]\w*)\s*\(/g)) {
      if (!literalFunctionBindings.has(match[1])) return true;
    }
    return (
      /\b(?:unlink|rmdir)\b/i.test(visible) ||
      aliasedDeleteCall
    );
  }
  if (RUBY_BINARIES.test(executable)) {
    if (/\b(?:eval|class_eval|instance_eval)\b/i.test(visible)) return true;
    const folded = foldSimplePlusStringConcatenations(code);
    const destructiveMethodBindings = new Set<string>();
    const destructiveSymbolBindings = new Set<string>();
    const literalSelectorBindings = new Map<string, string>();
    for (const match of folded.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?::([A-Za-z_]\w*)|['"]([A-Za-z_]\w*)['"](?:\s*\.\s*to_sym)?)\s*;?/gi)) {
      literalSelectorBindings.set(match[1], match[2] || match[3]);
    }
    for (const match of folded.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:File|Dir|FileUtils)\s*\.\s*method\s*\(\s*:(?:delete|unlink|rmdir|rm|rm_f|rm_r|rm_rf|remove|remove_dir|remove_entry|remove_entry_secure)\s*\)/gi)) {
      destructiveMethodBindings.add(match[1]);
    }
    for (const match of folded.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?::|['"])(?:delete|unlink|rmdir|rm|rm_f|rm_r|rm_rf|remove|remove_dir|remove_entry|remove_entry_secure)(?:['"](?:\s*\.\s*to_sym)?)?\b/gi)) {
      destructiveSymbolBindings.add(match[1]);
    }
    propagateBareAliases(folded, destructiveMethodBindings);
    propagateBareAliases(folded, destructiveSymbolBindings);
    const aliasedMethodCall = [...destructiveMethodBindings].some((binding) => new RegExp(`\\b${binding}\\s*\\.\\s*call\\s*\\(`).test(folded));
    const aliasedSymbolSend = [...destructiveSymbolBindings].some((binding) => new RegExp(`\\b(?:File|Dir|FileUtils)\\s*\\.\\s*(?:send|public_send)\\s*\\(\\s*${binding}\\b`, "i").test(folded));
    for (const match of folded.matchAll(/\b(?:File|Dir|FileUtils)\s*\.\s*(?:send|public_send)\s*\(\s*([A-Za-z_]\w*)\b/gi)) {
      if (!literalSelectorBindings.has(match[1])) return true;
    }
    return (
      /\b(?:File\s*\.\s*(?:delete|unlink)|Dir\s*\.\s*rmdir|FileUtils\s*\.\s*(?:rm|rm_f|rm_r|rm_rf|remove|remove_dir|remove_entry|remove_entry_secure))\s*\(/i.test(visible) ||
      /\b(?:File|Dir|FileUtils)\s*\.\s*(?:send|public_send)\s*\(\s*:(?:delete|unlink|rmdir|rm|rm_f|rm_r|rm_rf|remove|remove_dir|remove_entry|remove_entry_secure)\b/i.test(code) ||
      /\b(?:File|Dir|FileUtils)\s*\.\s*method\s*\(\s*:(?:delete|unlink|rmdir|rm|rm_f|rm_r|rm_rf|remove|remove_dir|remove_entry|remove_entry_secure)\s*\)\s*\.\s*call\s*\(/i.test(code) ||
      aliasedMethodCall ||
      aliasedSymbolSend
    );
  }
  if (PHP_BINARIES.test(executable)) {
    if (/\beval\s*\(/i.test(visible)) return true;
    const folded = foldSimpleStringConcatenations(code);
    const destructiveFunctionBindings = new Set<string>();
    const literalFunctionBindings = new Map<string, string>();
    for (const match of folded.matchAll(/\$([A-Za-z_]\w*)\s*=\s*['"]([A-Za-z_]\w*)['"]\s*;?/gi)) literalFunctionBindings.set(match[1], match[2]);
    for (const match of folded.matchAll(/\$([A-Za-z_]\w*)\s*=\s*['"](?:unlink|rmdir)['"]\s*;?/gi)) destructiveFunctionBindings.add(match[1]);
    propagateSigilAliases(folded, destructiveFunctionBindings);
    const aliasedDeleteCall = [...destructiveFunctionBindings].some((binding) => {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\$${escaped}\\s*\\(`, "i").test(folded);
    });
    for (const match of folded.matchAll(/\$([A-Za-z_]\w*)\s*\(/g)) {
      if (!literalFunctionBindings.has(match[1])) return true;
    }
    return (
      /\b(?:unlink|rmdir)\s*\(/i.test(visible) ||
      /\bcall_user_func(?:_array)?\s*\(\s*['"](?:unlink|rmdir)['"]/i.test(code) ||
      aliasedDeleteCall
    );
  }
  return false;
}

function destructiveDynamicInvocation(command: string): boolean {
  const visible = stripQuotedLiterals(command);
  // PowerShell call operator with a variable/Get-Command target is opaque to a
  // text classifier. Fail closed rather than allowing an uninspectable command
  // name to resolve to Remove-Item/rm/etc. Quoted examples remain harmless.
  if (/&\s*(?:\$(?:\{|[A-Za-z_])|\()/i.test(visible)) return true;
  if (/\[(?:system\.)?io\.(?:file|directory)\][\s\S]*\.\s*getmethods?\s*\([\s\S]*\.\s*invoke\s*\(/i.test(command)) return true;
  if (/\[(?:system\.)?io\.(?:file|directory)\]\s*\.\s*invokemember\s*\(/i.test(command)) return true;
  if (/\b(?:get-item|get-childitem|gi|gci)\b[\s\S]*\|[\s\S]*(?:foreach-object\b|%)[\s\S]*\$_\s*\.\s*delete\s*\(/i.test(visible)) return true;
  if (/\b(?:get-item|get-childitem|gi|gci)\b[\s\S]*\|[\s\S]*(?:foreach-object\b|%)[\s\S]*\$_\s*\.\s*psobject\s*\.\s*methods\s*\[\s*['"]delete['"]\s*\]\s*\.\s*invoke\s*\(/i.test(command)) return true;
  for (const match of visible.matchAll(/\$([A-Za-z_]\w*)\s*=\s*(?:\(\s*)?(?:get-item|get-childitem|gi|gci)\b[^;\r\n]*;[\s\S]*?\$\1\s*\.\s*delete\s*\(/gi)) {
    if (match[0]) return true;
  }
  for (const match of visible.matchAll(/\$([A-Za-z_]\w*)\s*=\s*\[(?:system\.)?io\.(?:fileinfo|directoryinfo)\]\s*::\s*new\s*\([^;\r\n]*;[\s\S]*?\$\1\s*\.\s*delete\s*\(/gi)) {
    if (match[0]) return true;
  }

  for (const match of command.matchAll(/\bset\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^&|\r\n"]+)/gi)) {
    const name = match[1];
    const value = executableName(match[2].trim().split(/\s+/)[0] || "");
    if (!DELETE_COMMANDS.has(value) && !CRITICAL_DISK_COMMANDS.has(value)) continue;
    const expansion = new RegExp(`(?:!${name}!|%${name}%)`, "i");
    if (expansion.test(visible)) return true;
  }

  for (const match of visible.matchAll(/(?:^|[;&|]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z0-9_.-]+)/g)) {
    const name = match[1];
    const value = executableName(match[2]);
    if (!DELETE_COMMANDS.has(value) && !CRITICAL_DISK_COMMANDS.has(value)) continue;
    const expansion = new RegExp(`(?:^|[;&|]\\s*)(?:command|env|sudo)\\s+\\$(?:\\{${name}\\}|${name})(?:\\s+([^;&|\\r\\n]*))?(?:$|[;&|])`, "i");
    const invocation = expansion.exec(visible);
    if (invocation && classifyCommand(`${match[2]} ${invocation[1] || ""}`.trim())) return true;
  }
  const knownPosixAssignments = new Set<string>();
  for (const match of visible.matchAll(/(?:^|[;&|]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[A-Za-z0-9_.-]+/g)) knownPosixAssignments.add(match[1]);
  for (const match of visible.matchAll(/(?:^|[;&|]\s*)(?:command|env|sudo)\s+\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(?:\s|$)/g)) {
    const name = match[1] || match[2];
    if (!knownPosixAssignments.has(name)) return true;
  }
  return false;
}

function destructiveCommandSubstitution(command: string, depth: number): boolean {
  if (depth > 8) return true;
  const visible = stripSingleQuotedLiterals(command);
  for (const match of visible.matchAll(/`([^`\r\n]+)`/g)) {
    if (classifyCommand(match[1], depth + 1)) return true;
  }
  for (const match of visible.matchAll(/\$\(([^()]*)\)/g)) {
    if (classifyCommand(match[1], depth + 1)) return true;
  }
  return false;
}

function opaqueExecutableToken(token: string): boolean {
  return (
    /^\$\{[^}]+\}/.test(token) ||
    /^\$[A-Za-z_][A-Za-z0-9_:]*/.test(token) ||
    /^![-A-Za-z0-9_:.]+!/.test(token) ||
    /^%[-A-Za-z0-9_:.]+%/.test(token) ||
    /^\$\(/.test(token)
  );
}

function opaquePosixCommandTarget(command: string): boolean {
  const visible = stripSingleQuotedLiterals(command);
  return /(?:^|[;&|]\s*)(?:\$\{[^}\r\n]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\([^\r\n]*\)|`[^`\r\n]+`)(?:\s|$)/m.test(visible);
}

function opaqueCmdCommandTarget(command: string): boolean {
  return /(?:^|[&|]\s*)(?:![A-Za-z_][A-Za-z0-9_:]*!|%[A-Za-z_][A-Za-z0-9_:]*%)(?:\s|$)/mi.test(command);
}

function classifyStartProcess(tokens: string[], commandIndex: number, depth: number): boolean {
  const args = tokens.slice(commandIndex + 1);
  let target: string | undefined;
  let targetIndex = -1;
  const filePathIndex = args.findIndex((token) => /^-(?:filepath|file)$/i.test(token));
  if (filePathIndex >= 0 && args[filePathIndex + 1]) {
    target = args[filePathIndex + 1];
    targetIndex = filePathIndex + 1;
  }
  if (!target) {
    targetIndex = args.findIndex((token) => !token.startsWith("-"));
    if (targetIndex >= 0) target = args[targetIndex];
  }
  if (!target) return false;
  if (opaqueExecutableToken(target)) return true;

  const argumentListIndex = args.findIndex((token) => /^-(?:argumentlist|args)$/i.test(token));
  const nestedArgs = argumentListIndex >= 0 ? args.slice(argumentListIndex + 1) : args.slice(targetIndex + 1);
  return classifyCommand([target, ...nestedArgs].join(" "), depth + 1);
}

function classifyInvokeCommand(tokens: string[], commandIndex: number, depth: number): boolean {
  const args = tokens.slice(commandIndex + 1);
  const scriptBlockIndex = args.findIndex((token) => /^-(?:scriptblock|command)$/i.test(token));
  if (scriptBlockIndex < 0 || !args[scriptBlockIndex + 1]) return false;
  if (opaqueExecutableToken(args[scriptBlockIndex + 1])) return true;
  return classifyCommand(args.slice(scriptBlockIndex + 1).join(" "), depth + 1);
}

function classifyCmdStart(tokens: string[], commandIndex: number, depth: number): boolean {
  const args = tokens.slice(commandIndex + 1);
  for (let index = 0; index < args.length; index++) {
    const candidate = executableName(args[index]);
    if (
      DELETE_COMMANDS.has(candidate) ||
      CRITICAL_DISK_COMMANDS.has(candidate) ||
      POWERSHELL_DESTRUCTIVE_COMMANDS.has(candidate) ||
      DYNAMIC_EXECUTION_COMMANDS.has(candidate) ||
      candidate === "git" ||
      CMD_BINARIES.test(candidate) ||
      POWERSHELL_BINARIES.test(candidate) ||
      POSIX_SHELL_BINARIES.test(candidate)
    ) {
      return classifyCommand(args.slice(index).join(" "), depth + 1);
    }
  }
  return false;
}

function classifySegment(segment: string, depth: number): boolean {
  if (depth > 8) return true;
  const tokens = tokenizeShell(segment);
  const commandIndex = firstCommandIndex(tokens);
  if (commandIndex >= tokens.length) return false;
  const executable = executableName(tokens[commandIndex]);

  if (DELETE_COMMANDS.has(executable)) return true;
  if (CRITICAL_DISK_COMMANDS.has(executable) || executable.startsWith("mkfs.")) return true;
  if (POWERSHELL_DESTRUCTIVE_COMMANDS.has(executable)) return true;
  if (DYNAMIC_EXECUTION_COMMANDS.has(executable)) return true;
  if (executable === "eval" || executable === "exec") {
    if (tokens.length > commandIndex + 1 && opaqueExecutableToken(tokens[commandIndex + 1])) return true;
    return tokens.length > commandIndex + 1
      ? classifyCommand(tokens.slice(commandIndex + 1).join(" "), depth + 1)
      : false;
  }
  if (executable === "start-process") return classifyStartProcess(tokens, commandIndex, depth);
  if (executable === "invoke-command") return classifyInvokeCommand(tokens, commandIndex, depth);
  if (executable === "start") return classifyCmdStart(tokens, commandIndex, depth);
  if (CMD_CONTROL_COMMANDS.has(executable)) {
    // cmd.exe IF/FOR/FORFILES place the command later in the same segment.
    // Scan every suffix so a nested rmdir/del/git clean cannot hide behind control syntax.
    for (let index = commandIndex + 1; index < tokens.length; index++) {
      if (opaqueExecutableToken(tokens[index])) return true;
      if (classifyCommand(tokens.slice(index).join(" "), depth + 1)) return true;
    }
  }
  if (executable === "find") {
    const args = tokens.slice(commandIndex + 1);
    if (args.some((token) => token === "-delete")) return true;
    const execIndex = args.findIndex((token) => /^-(?:exec|execdir|ok|okdir)$/i.test(token));
    if (execIndex >= 0 && args[execIndex + 1]) {
      return classifyCommand(args.slice(execIndex + 1).join(" "), depth + 1);
    }
  }
  if (executable === "busybox" || executable === "toybox") {
    return tokens.length > commandIndex + 1
      ? classifyCommand(tokens.slice(commandIndex + 1).join(" "), depth + 1)
      : false;
  }
  if (executable === "cipher" && tokens.slice(commandIndex + 1).some((token) => /^\/w(?::|$)/i.test(token))) return true;
  if (executable === "robocopy" && tokens.slice(commandIndex + 1).some((token) => /^\/(?:mir|purge)$/i.test(token))) return true;
  if (executable === "rsync" && tokens.slice(commandIndex + 1).some((token) => /^--delete(?:-|=|$)/i.test(token))) return true;
  if (executable === "git") return destructiveGit(tokens, commandIndex);

  if (CMD_BINARIES.test(executable)) {
    const wrapperIndex = tokens.findIndex((token, index) => index > commandIndex && /^\/[ck]$/i.test(token));
    if (wrapperIndex < 0 || tokens.length <= wrapperIndex + 1) return false;
    const nested = tokens.slice(wrapperIndex + 1).join(" ");
    if (opaqueCmdCommandTarget(nested)) return true;
    return classifyCommand(nested, depth + 1);
  }
  if (POWERSHELL_BINARIES.test(executable)) {
    if (tokens.some((token) => /^-(?:encodedcommand|enc)$/i.test(token))) return true;
    const wrapperIndex = tokens.findIndex((token, index) => index > commandIndex && /^-(?:command|c)$/i.test(token));
    return wrapperIndex >= 0 && tokens.length > wrapperIndex + 1
      ? classifyCommand(tokens.slice(wrapperIndex + 1).join(" "), depth + 1)
      : false;
  }
  if (POSIX_SHELL_BINARIES.test(executable)) {
    const wrapperIndex = tokens.findIndex((token, index) => index > commandIndex && token === "-c");
    if (wrapperIndex < 0 || tokens.length <= wrapperIndex + 1) return false;
    const nested = tokens.slice(wrapperIndex + 1).join(" ");
    if (opaquePosixCommandTarget(nested)) return true;
    return classifyCommand(nested, depth + 1);
  }

  if (PYTHON_BINARIES.test(executable) || NODE_BINARIES.test(executable) || PERL_BINARIES.test(executable) || RUBY_BINARIES.test(executable) || PHP_BINARIES.test(executable)) {
    const inlineFlag = PYTHON_BINARIES.test(executable)
      ? /^-c$/i
      : NODE_BINARIES.test(executable)
        ? /^-(?:e|p|eval|print)$/i
        : PERL_BINARIES.test(executable) || RUBY_BINARIES.test(executable)
          ? /^-e$/i
          : /^-r$/i;
    const codeIndex = tokens.findIndex((token, index) => index > commandIndex && inlineFlag.test(token));
    if (codeIndex >= 0 && tokens.length > codeIndex + 1) {
      return destructiveInlineCode(executable, tokens.slice(codeIndex + 1).join(" "));
    }
  }

  const visible = stripQuotedLiterals(segment);
  return (
    /\[(?:system\.)?io\.(?:file|directory)\]::delete\s*\(/i.test(visible) ||
    /(?:\(\s*get-item\b[^)]*\)|\[(?:system\.)?io\.(?:fileinfo|directoryinfo)\][^;\r\n]*)\s*\.\s*delete\s*\(/i.test(visible) ||
    /\[(?:system\.management\.automation\.)?scriptblock\]\s*::\s*create\s*\(/i.test(visible)
  );
}

function classifyCommand(command: string, depth = 0): boolean {
  if (destructiveDynamicInvocation(command)) return true;
  if (destructiveCommandSubstitution(command, depth)) return true;
  return splitShellSegments(command).some((segment) => classifySegment(segment, depth));
}

export function shouldBlockCommand(command: string): boolean {
  return classifyCommand(String(command || ""));
}

export function describePermissionProfile(): string {
  const diskScope = getFullDiskAccess()
    ? "path-aware tools have full-disk access"
    : "path-aware tools are limited to workspace roots";
  return `open commands with a fail-closed known-destructive-command guard; ${diskScope}; permitted child processes are not OS-sandboxed`;
}

export function requireWriteAllowed(): void {}

export function requireCommandAllowed(command: string): void {
  if (!shouldBlockCommand(command)) return;
  throw new Error(
    "BLOCKED_DESTRUCTIVE_COMMAND: permanent/destructive filesystem or Git mutation is disabled in shell. " +
      "Use delete_file/delete_directory for recoverable Trash/Recycle Bin removal, " +
      "or a checkpointed Git tool for tracked-file restoration. Native shell is not an OS sandbox, so do not bypass this guard through scripts."
  );
}
