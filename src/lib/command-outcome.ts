export type CommandOutcome = "ok" | "no_match" | "failed";

const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

function firstPipelineTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;

  const push = () => {
    if (token) tokens.push(token);
    token = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\r" || ch === "\n") {
      push();
      break;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    token += ch;
  }
  push();
  return tokens;
}

/**
 * Git documents `git grep` exit 1 as "no matches" rather than an execution
 * failure. Recognize only a leading git-grep pipeline; all other non-zero exits
 * remain failures so test/build/script errors are never hidden.
 */
export function isGitGrepCommand(command: string): boolean {
  const tokens = firstPipelineTokens(command);
  let i = tokens[0] === "&" ? 1 : 0;
  if (!/^git(?:\.exe)?$/i.test(tokens[i] || "")) return false;
  i++;

  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "grep") return true;
    if (GIT_OPTIONS_WITH_VALUE.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("--") || /^-[A-Za-z]/.test(token)) {
      i++;
      continue;
    }
    return false;
  }
  return false;
}

export function classifyCommandOutcome(
  command: string,
  exitCode: number | null,
  stderr = "",
  timedOut = false
): CommandOutcome {
  if (timedOut) return "failed";
  if (exitCode === 0) return "ok";
  if (exitCode === 1 && stderr.trim() === "" && isGitGrepCommand(command)) return "no_match";
  return "failed";
}