import { getFullDiskAccess } from "./path-security.js";

/** Commands are intentionally open; path-aware tools have a separate disk scope. */

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

export function shouldBlockCommand(_command: string): boolean {
  return false;
}

export function describePermissionProfile(): string {
  return getFullDiskAccess()
    ? "open commands; path-aware tools have full-disk access; native shell commands are not OS-sandboxed"
    : "open commands; path-aware tools are limited to workspace roots; native shell commands are not OS-sandboxed";
}

export function requireWriteAllowed(): void {}

export function requireCommandAllowed(_command: string): void {}