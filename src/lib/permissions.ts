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
    if (/\b(?:eval|exec)\s*\(/i.test(visible)) return true;
    const dynamicFilesystemLookup =
      importsFilesystemModule &&
      (/(?:\bvars\s*\([^)]*\)|\.__dict__)\s*\[[^\]]+\]\s*\(/i.test(code) ||
        /\bgetattr\s*\([^,]+,\s*(?!['"](?:rmtree|remove|unlink|rmdir|removedirs)['"]\s*\))[^)]+\)\s*\(/i.test(code));
    const destructiveAlias =
      /\b([A-Za-z_]\w*)\s*=\s*(?:shutil\s*\.\s*rmtree|os\s*\.\s*(?:remove|unlink|rmdir|removedirs)|getattr\s*\([^,]+,\s*['"](?:rmtree|remove|unlink|rmdir|removedirs)['"]\s*\))\s*;?[\s\S]*\b\1\s*\(/i.test(code);
    return (
      /\bshutil\s*\.\s*rmtree\s*\(|\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(/i.test(visible) ||
      /\b(?:pathlib\s*\.\s*)?Path\s*\([^)]*\)\s*\.\s*(?:unlink|rmdir)\s*\(/i.test(visible) ||
      /__import__\s*\(\s*['"](?:shutil|os)['"]\s*\)\s*\.\s*(?:rmtree|remove|unlink|rmdir|removedirs)\s*\(/i.test(code) ||
      /\bgetattr\s*\([^,]+,\s*['"](?:rmtree|remove|unlink|rmdir|removedirs)['"]\s*\)\s*\(/i.test(code) ||
      /\boperator\s*\.\s*methodcaller\s*\(\s*['"](?:rmtree|remove|unlink|rmdir|removedirs)['"]/i.test(code) ||
      destructiveAlias ||
      dynamicFilesystemLookup ||
      (importsFilesystemModule && /\b(?:rmtree|remove|unlink|rmdir|removedirs)\s*\(/i.test(visible))
    );
  }
  if (NODE_BINARIES.test(executable)) {
    const importsFilesystemModule =
      /\brequire\s*\(\s*['"]?(?:node:)?fs(?:\/promises)?['"]?\s*\)|\bfrom\s*['"](?:node:)?fs(?:\/promises)?['"]|\bimport\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/i.test(code);
    const filesystemBindings = new Set<string>();
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/gi)) {
      filesystemBindings.add(match[1]);
    }
    for (const match of code.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"](?:node:)?fs(?:\/promises)?['"]/gi)) {
      filesystemBindings.add(match[1]);
    }
    if (/\b(?:eval|Function)\s*\(/.test(visible)) return true;
    const dynamicFilesystemMember = [...filesystemBindings].some((binding) => {
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (
        new RegExp(`\\b${escaped}\\s*\\[[^\\]]+\\]\\s*\\(`).test(code) ||
        new RegExp(`\\bReflect\\s*\\.\\s*get\\s*\\(\\s*${escaped}\\s*,\\s*['"](?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)['"]\\s*\\)\\s*\\(`, "i").test(code) ||
        new RegExp(`\\b${escaped}\\s*\\.\\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\\s*\\.\\s*bind\\s*\\([^)]*\\)\\s*\\(`, "i").test(code) ||
        new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escaped}\\s*\\.\\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\\s*;?[\\s\\S]*\\b\\1\\s*\\(`, "i").test(code)
      );
    });
    return (
      /\bfs(?:\s*\.\s*promises)?\s*\.\s*(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*\(/i.test(visible) ||
      /require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)(?:\s*\.\s*promises)?\s*(?:\.\s*|\[\s*['"])(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)(?:['"]\s*\])?\s*\(/i.test(code) ||
      /require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)\s*\[[^\]]+\]\s*\(/i.test(code) ||
      /\{[^}]*\b(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*:\s*([A-Za-z_$][\w$]*)[^}]*\}\s*=\s*require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)[\s\S]*\b\1\s*\(/i.test(code) ||
      (importsFilesystemModule && /\[\s*['"](?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)['"]\s*\]\s*\(/i.test(code)) ||
      (importsFilesystemModule && /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"](?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)['"][^;]*;[\s\S]*\[\s*\1\s*\]\s*\(/i.test(code)) ||
      dynamicFilesystemMember ||
      (importsFilesystemModule && /\b(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync)\s*\(/i.test(visible))
    );
  }
  if (PERL_BINARIES.test(executable)) {
    if (/\beval\b/i.test(visible)) return true;
    return (
      /\b(?:unlink|rmdir)\b/i.test(visible) ||
      /\$([A-Za-z_]\w*)\s*=\s*['"](?:unlink|rmdir)['"]\s*;?[\s\S]*&\s*\$\1\s*\(/i.test(code)
    );
  }
  if (RUBY_BINARIES.test(executable)) {
    if (/\b(?:eval|class_eval|instance_eval)\b/i.test(visible)) return true;
    return (
      /\b(?:File\s*\.\s*(?:delete|unlink)|Dir\s*\.\s*rmdir|FileUtils\s*\.\s*(?:rm|rm_f|rm_r|rm_rf|remove|remove_dir|remove_entry|remove_entry_secure))\s*\(/i.test(visible) ||
      /\b(?:File|Dir|FileUtils)\s*\.\s*(?:send|public_send)\s*\(\s*:(?:delete|unlink|rmdir|rm|rm_f|rm_r|rm_rf|remove|remove_dir|remove_entry|remove_entry_secure)\b/i.test(code) ||
      /\b(?:File|Dir|FileUtils)\s*\.\s*method\s*\(\s*:(?:delete|unlink|rmdir|rm|rm_f|rm_r|rm_rf|remove|remove_dir|remove_entry|remove_entry_secure)\s*\)\s*\.\s*call\s*\(/i.test(code)
    );
  }
  if (PHP_BINARIES.test(executable)) {
    if (/\beval\s*\(/i.test(visible)) return true;
    return (
      /\b(?:unlink|rmdir)\s*\(/i.test(visible) ||
      /\bcall_user_func(?:_array)?\s*\(\s*['"](?:unlink|rmdir)['"]/i.test(code) ||
      /\$([A-Za-z_]\w*)\s*=\s*['"](?:unlink|rmdir)['"]\s*;?[\s\S]*\$\1\s*\(/i.test(code)
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
    const expansion = new RegExp(`(?:^|[;&|]\\s*)\\$(?:\\{${name}\\}|${name})(?:\\s|$)`, "i");
    if (expansion.test(visible)) return true;
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
