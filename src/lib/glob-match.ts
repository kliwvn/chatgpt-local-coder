function escapeRegexChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compile the small glob dialect used by Local Coder discovery tools.
 * A globstar followed by a slash means zero-or-more directories, so a globstar
 * TypeScript pattern matches both root-level and nested files; `*` and `?` never
 * cross path separators.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let regex = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      const isGlobStar = normalized[i + 1] === "*";
      if (isGlobStar) {
        i++;
        if (normalized[i + 1] === "/") {
          i++;
          regex += "(?:.*/)?";
        } else {
          regex += ".*";
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegexChar(ch);
  }
  regex += "$";
  return new RegExp(regex, "i");
}

export function matchesCompiledGlob(matcher: RegExp, relativePath: string, basename?: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return matcher.test(normalized) || (basename !== undefined && matcher.test(basename));
}

export function matchesGlob(pattern: string, relativePath: string, basename?: string): boolean {
  return matchesCompiledGlob(globToRegExp(pattern), relativePath, basename);
}
