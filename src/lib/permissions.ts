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
  "mv",
  "move",
  "ren",
  "rename",
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
  "set-content",
  "out-file",
  "move-item",
  "rename-item",
]);
const DYNAMIC_EXECUTION_COMMANDS = new Set([
  "invoke-expression",
  "iex",
  "start-process",
  "invoke-command",
  "start",
]);
const CMD_CONTROL_COMMANDS = new Set(["if", "for", "forfiles", "xargs", "parallel"]);
const COMMAND_PREFIXES = new Set(["sudo", "command", "call", "do", "then", "else"]);
const PYTHON_BINARIES = /^(?:python(?:3(?:\.\d+)*)?|py)$/i;
const NODE_BINARIES = /^node$/i;
const POWERSHELL_BINARIES = /^(?:powershell|pwsh)$/i;
const CMD_BINARIES = /^cmd$/i;
const POSIX_SHELL_BINARIES = /^(?:ba|z|da)?sh$/i;

function executableName(token: string): string {
  // Shell commands may invoke a dangerous executable through an absolute or
  // quoted path (for example C:\\Windows\\System32\\cmd.exe or /bin/rm).
  // Classify the executable by its basename so path spelling cannot bypass the
  // destructive-command guard. Strip the Windows executable suffix as well.
  const normalized = token.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return base.replace(/\.(?:exe|com|cmd|bat)$/i, "");
}

function splitShellSegments(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
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
    if (ch === "'" || ch === '"' || ch === "`") {
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
  let quote: "'" | '"' | "`" | null = null;
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
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) push();
    else current += ch;
  }
  push();
  return tokens;
}

function stripQuotedLiterals(input: string): string {
  let out = "";
  let quote: "'" | '"' | "`" | null = null;
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
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function firstCommandIndex(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    if (COMMAND_PREFIXES.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) index++;
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
    return (
      /\bshutil\s*\.\s*rmtree\s*\(|\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(|\.\s*(?:unlink|rmdir)\s*\(/i.test(visible) ||
      /__import__\s*\(\s*['"](?:shutil|os)['"]\s*\)\s*\.\s*(?:rmtree|remove|unlink|rmdir|removedirs)\s*\(/i.test(code)
    );
  }
  if (NODE_BINARIES.test(executable)) {
    return (
      /\.\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*\(/i.test(visible) ||
      /(?:require\s*\([^)]*\)|\bfs)\s*\[\s*['"](?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)['"]\s*\]\s*\(/i.test(code)
    );
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
  if (CMD_CONTROL_COMMANDS.has(executable)) {
    // cmd.exe IF/FOR/FORFILES place the command later in the same segment.
    // Scan every suffix so a nested rmdir/del/git clean cannot hide behind control syntax.
    for (let index = commandIndex + 1; index < tokens.length; index++) {
      if (classifyCommand(tokens.slice(index).join(" "), depth + 1)) return true;
    }
  }
  if (executable === "find" && tokens.slice(commandIndex + 1).some((token) => token === "-delete")) return true;
  if (executable === "cipher" && tokens.slice(commandIndex + 1).some((token) => /^\/w(?::|$)/i.test(token))) return true;
  if (executable === "robocopy" && tokens.slice(commandIndex + 1).some((token) => /^\/(?:mir|purge)$/i.test(token))) return true;
  if (executable === "rsync" && tokens.slice(commandIndex + 1).some((token) => /^--delete(?:-|=|$)/i.test(token))) return true;
  if (executable === "git") return destructiveGit(tokens, commandIndex);

  if (CMD_BINARIES.test(executable)) {
    const wrapperIndex = tokens.findIndex((token, index) => index > commandIndex && /^\/[ck]$/i.test(token));
    return wrapperIndex >= 0 && tokens.length > wrapperIndex + 1
      ? classifyCommand(tokens.slice(wrapperIndex + 1).join(" "), depth + 1)
      : false;
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
    return wrapperIndex >= 0 && tokens.length > wrapperIndex + 1
      ? classifyCommand(tokens.slice(wrapperIndex + 1).join(" "), depth + 1)
      : false;
  }

  if (PYTHON_BINARIES.test(executable) || NODE_BINARIES.test(executable)) {
    const inlineFlag = PYTHON_BINARIES.test(executable) ? /^-c$/i : /^-(?:e|p|eval|print)$/i;
    const codeIndex = tokens.findIndex((token, index) => index > commandIndex && inlineFlag.test(token));
    if (codeIndex >= 0 && tokens.length > codeIndex + 1) {
      return destructiveInlineCode(executable, tokens.slice(codeIndex + 1).join(" "));
    }
  }

  const visible = stripQuotedLiterals(segment);
  return (
    /\[(?:system\.)?io\.(?:file|directory)\]::delete\s*\(/i.test(visible) ||
    /\.\s*delete\s*\(/i.test(visible) ||
    // Single redirection overwrites/truncates a file. Append redirection (>>)
    // remains allowed for ordinary logs/output capture.
    /(?:^|[^>])(?:\d*)>(?!>)/.test(visible)
  );
}

function classifyCommand(command: string, depth = 0): boolean {
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
