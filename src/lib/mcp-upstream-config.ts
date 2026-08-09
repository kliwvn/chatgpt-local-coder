import fs from "fs/promises";
import path from "path";
import os from "os";
import { atomicWriteFile } from "./atomic-write.js";
import { readUtf8FileBounded } from "./bounded-file.js";

export type UpstreamTransport = "stdio" | "http";
export type UpstreamExposeMode = "none" | "meta_only" | "allowlist" | "all";

export interface UpstreamServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: UpstreamTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  tool_prefix?: string;
  expose: UpstreamExposeMode;
  tools?: string[];
  idle_timeout_sec?: number;
}

export interface UpstreamConfigFile {
  version: 1;
  servers: UpstreamServerConfig[];
}

const CONFIG_VERSION = 1 as const;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_SERVERS = 256;
const MAX_MAP_ENTRIES = 256;
const MAX_ARGS = 256;
const MAX_TOOLS = 1024;
const MAX_STRING_CHARS = 32_768;

export function defaultUpstreamConfig(): UpstreamConfigFile {
  return { version: CONFIG_VERSION, servers: [] };
}

export function resolveUpstreamConfigPath(): string {
  const configured = process.env.MCP_UPSTREAM_CONFIG?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "profiles", "mcp-upstream.json");
}

function normalizeServer(raw: UpstreamServerConfig): UpstreamServerConfig {
  if (!raw || typeof raw !== "object") throw new Error("Upstream server entry must be an object");
  if (typeof raw.id !== "string") throw new Error("Upstream server id must be a string");
  const id = raw.id.trim();
  if (!id) throw new Error("Upstream server id is required");
  if (id.length > 128) throw new Error("Upstream server id must be <= 128 characters");

  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid transport for ${id}: ${String(raw.transport)}`);
  }

  const expose = raw.expose ?? "meta_only";
  if (!["none", "meta_only", "allowlist", "all"].includes(expose)) {
    throw new Error(`Invalid expose mode for ${id}: ${String(raw.expose)}`);
  }

  const idleTimeout = raw.idle_timeout_sec ?? 600;
  if (!Number.isFinite(idleTimeout) || idleTimeout < 0 || idleTimeout > 86400) {
    throw new Error(`Invalid idle_timeout_sec for ${id}: ${String(raw.idle_timeout_sec)}`);
  }

  const normalizeStringMap = (value: Record<string, string> | undefined, label: string) => {
    if (!value) return {};
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} for ${id} must be an object`);
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_MAP_ENTRIES) throw new Error(`${label} for ${id} exceeds ${MAX_MAP_ENTRIES} entries`);
    const out: Record<string, string> = {};
    for (const [key, entry] of entries) {
      if (typeof entry !== "string") throw new Error(`${label}.${key} for ${id} must be a string`);
      if (key.length > 512 || entry.length > MAX_STRING_CHARS) {
        throw new Error(`${label}.${key.slice(0, 80)} for ${id} exceeds configured string limits`);
      }
      out[key] = entry;
    }
    return out;
  };

  const normalizeStringList = (value: string[] | undefined, label: string, maxItems: number): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${label} for ${id} must be an array`);
    if (value.length > maxItems) throw new Error(`${label} for ${id} exceeds ${maxItems} items`);
    return value.map((entry, index) => {
      if (typeof entry !== "string") throw new Error(`${label}[${index}] for ${id} must be a string`);
      if (entry.length > MAX_STRING_CHARS) throw new Error(`${label}[${index}] for ${id} exceeds ${MAX_STRING_CHARS} chars`);
      return entry;
    });
  };

  const optionalString = (value: unknown, label: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`${label} for ${id} must be a string`);
    if (value.length > MAX_STRING_CHARS) throw new Error(`${label} for ${id} exceeds ${MAX_STRING_CHARS} chars`);
    return value.trim();
  };

  const name = optionalString(raw.name, "name") || id;
  const command = optionalString(raw.command, "command");
  const cwd = optionalString(raw.cwd, "cwd");
  const url = optionalString(raw.url, "url");
  const toolPrefix = optionalString(raw.tool_prefix, "tool_prefix") || id;
  const args = normalizeStringList(raw.args, "args", MAX_ARGS);
  const tools = normalizeStringList(raw.tools, "tools", MAX_TOOLS);

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error(`enabled for ${id} must be a boolean`);
  }

  if (transport === "stdio" && !command) throw new Error(`stdio server ${id} requires command`);
  if (transport === "http" && !url) throw new Error(`http server ${id} requires url`);

  return {
    id,
    name,
    enabled: raw.enabled !== false,
    transport,
    command,
    args,
    env: normalizeStringMap(raw.env, "env"),
    cwd,
    url,
    headers: normalizeStringMap(raw.headers, "headers"),
    tool_prefix: toolPrefix.replace(/[^a-zA-Z0-9_-]/g, "_"),
    expose,
    tools,
    idle_timeout_sec: idleTimeout,
  };
}

export function normalizeUpstreamConfig(config: UpstreamConfigFile): UpstreamConfigFile {
  if (!config || !Array.isArray(config.servers)) throw new Error("servers must be an array");
  if (config.servers.length > MAX_SERVERS) throw new Error(`servers exceeds maximum ${MAX_SERVERS}`);
  const servers = config.servers.map(normalizeServer);
  const ids = new Set<string>();
  const exposedPrefixes = new Map<string, string>();
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`Duplicate upstream server id: ${server.id}`);
    ids.add(server.id);
    if (server.enabled && (server.expose === "all" || server.expose === "allowlist")) {
      const prefix = server.tool_prefix ?? server.id;
      const owner = exposedPrefixes.get(prefix);
      if (owner) {
        throw new Error(`Duplicate exposed tool_prefix '${prefix}' for ${owner} and ${server.id}`);
      }
      exposedPrefixes.set(prefix, server.id);
    }
  }
  return { version: CONFIG_VERSION, servers };
}

export async function loadUpstreamConfig(configPath = resolveUpstreamConfigPath()): Promise<UpstreamConfigFile> {
  try {
    const raw = await readUtf8FileBounded(configPath, MAX_CONFIG_BYTES, "MCP upstream config");
    const parsed = JSON.parse(raw) as UpstreamConfigFile;
    if (!Array.isArray(parsed.servers)) throw new Error("servers must be an array");
    return normalizeUpstreamConfig(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const defaults = defaultUpstreamConfig();
      await saveUpstreamConfig(defaults, configPath);
      return defaults;
    }
    throw err;
  }
}

export async function saveUpstreamConfig(
  config: UpstreamConfigFile,
  configPath = resolveUpstreamConfigPath()
): Promise<void> {
  const normalized = normalizeUpstreamConfig(config);
  const serialized = JSON.stringify(normalized, null, 2);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_CONFIG_BYTES) throw new Error(`MCP upstream config exceeds ${MAX_CONFIG_BYTES} bytes (${bytes})`);
  await atomicWriteFile(configPath, serialized, "utf8");
}

export type McpImportSource = "cursor" | "claude" | "opencode" | "file";

export interface McpServersEntry {
  command?: string;
  args?: string[] | string;
  env?: Record<string, string>;
  environment?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
  transport?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface DiscoveredMcpConfig {
  source: McpImportSource;
  path: string;
  label: string;
  server_count: number;
}

const HTTP_TYPES = new Set(["http", "streamable-http", "sse", "remote"]);
const STDIO_TYPES = new Set(["stdio", "local"]);

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

function commandToParts(command: string | string[] | undefined): { command?: string; args: string[] } {
  if (!command) return { args: [] };
  if (Array.isArray(command)) {
    if (command.some((part) => typeof part !== "string")) {
      throw new Error("command array must contain only strings");
    }
    return { command: command[0], args: command.slice(1) };
  }
  if (typeof command !== "string") throw new Error("command must be a string or string array");
  return { command, args: [] };
}

function resolveTransport(entry: McpServersEntry): UpstreamTransport | null {
  const rawType = entry.type ?? entry.transport ?? "";
  if (typeof rawType !== "string") throw new Error("MCP server type/transport must be a string");
  if (entry.url !== undefined && typeof entry.url !== "string") throw new Error("MCP server url must be a string");
  const type = rawType.toLowerCase();
  const hasUrl = Boolean(entry.url?.trim());
  const cmdParts = commandToParts(entry.command as string | string[] | undefined);
  const hasCommand = Boolean(cmdParts.command?.trim());

  if (HTTP_TYPES.has(type) || hasUrl) return "http";
  if (STDIO_TYPES.has(type) || hasCommand) return "stdio";
  if (type === "ws") return null;
  if (hasUrl) return "http";
  if (hasCommand) return "stdio";
  return null;
}

function entryToServer(id: string, entry: McpServersEntry, enabledDefault = false): UpstreamServerConfig | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`MCP server ${id} must be an object`);
  }
  const transport = resolveTransport(entry);
  if (!transport) return null;

  const cmdParts = commandToParts(entry.command as string | string[] | undefined);
  const args = Array.isArray(entry.args) ? entry.args : entry.args ? [entry.args] : cmdParts.args;
  for (const [label, value] of [["env", entry.env], ["environment", entry.environment]] as const) {
    if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
      throw new Error(`${label} for ${id} must be an object`);
    }
  }
  const env = { ...(entry.env ?? {}), ...(entry.environment ?? {}) };

  return normalizeServer({
    id,
    name: id,
    enabled: entry.enabled ?? enabledDefault,
    transport,
    command: cmdParts.command,
    args,
    env: Object.keys(env).length ? env : undefined,
    cwd: entry.cwd,
    url: entry.url,
    headers: entry.headers,
    expose: "meta_only",
    tools: [],
  });
}

export function parseMcpServersRecord(
  servers: Record<string, McpServersEntry>,
  enabledDefault = false
): UpstreamServerConfig[] {
  const imported: UpstreamServerConfig[] = [];
  for (const [id, entry] of Object.entries(servers)) {
    const server = entryToServer(id, entry, enabledDefault);
    if (server) imported.push(server);
  }
  return imported;
}

export interface McpServersFile {
  mcpServers?: Record<string, McpServersEntry>;
}

export function parseMcpServersFile(raw: McpServersFile, enabledDefault = false): UpstreamServerConfig[] {
  return parseMcpServersRecord(raw.mcpServers ?? {}, enabledDefault);
}

export interface ClaudeCodeConfigFile {
  mcpServers?: Record<string, McpServersEntry>;
  projects?: Record<string, { mcpServers?: Record<string, McpServersEntry> }>;
}

export function parseClaudeCodeConfig(raw: ClaudeCodeConfigFile, enabledDefault = false): UpstreamServerConfig[] {
  const merged: Record<string, McpServersEntry> = { ...(raw.mcpServers ?? {}) };
  for (const project of Object.values(raw.projects ?? {})) {
    if (project?.mcpServers) Object.assign(merged, project.mcpServers);
  }
  return parseMcpServersRecord(merged, enabledDefault);
}

export interface OpenCodeMcpEntry {
  type?: "local" | "remote" | string;
  command?: string | string[];
  url?: string;
  cwd?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface OpenCodeConfigFile {
  mcp?: Record<string, OpenCodeMcpEntry>;
}

export function parseOpenCodeConfig(raw: OpenCodeConfigFile, enabledDefault = false): UpstreamServerConfig[] {
  const imported: UpstreamServerConfig[] = [];
  for (const [id, entry] of Object.entries(raw.mcp ?? {})) {
    const cmdParts = commandToParts(entry.command);
    const mapped: McpServersEntry = {
      type: entry.type === "remote" ? "http" : entry.type === "local" ? "stdio" : entry.type,
      command: cmdParts.command,
      args: cmdParts.args,
      url: entry.url,
      cwd: entry.cwd,
      environment: entry.environment,
      headers: entry.headers,
      enabled: entry.enabled,
    };
    const server = entryToServer(id, mapped, enabledDefault);
    if (server) imported.push(server);
  }
  return imported;
}

async function mergeImportedServers(
  incoming: UpstreamServerConfig[],
  options?: { merge?: boolean; enableImported?: boolean }
): Promise<{ imported: string[]; config: UpstreamConfigFile }> {
  const configPath = resolveUpstreamConfigPath();
  const existing = await loadUpstreamConfig(configPath);
  const merge = options?.merge !== false;
  const byId = new Map(existing.servers.map((s) => [s.id, s]));
  const imported: string[] = [];

  for (const server of incoming) {
    if (options?.enableImported) server.enabled = true;
    if (merge && byId.has(server.id)) continue;
    byId.set(server.id, server);
    imported.push(server.id);
  }

  const merged: UpstreamConfigFile = { version: CONFIG_VERSION, servers: [...byId.values()] };
  await saveUpstreamConfig(merged, configPath);
  return { imported, config: merged };
}

export async function importMcpConfigFromFile(
  filePath: string,
  source: McpImportSource,
  options?: { merge?: boolean; enableImported?: boolean }
): Promise<{ imported: string[]; config: UpstreamConfigFile; source: McpImportSource; path: string }> {
  const rawText = await readUtf8FileBounded(filePath, MAX_CONFIG_BYTES, "MCP import config");
  const parsed = parseJsonc(rawText);
  let incoming: UpstreamServerConfig[] = [];

  if (source === "opencode") {
    incoming = parseOpenCodeConfig(parsed as OpenCodeConfigFile, false);
  } else if (source === "claude") {
    incoming = parseClaudeCodeConfig(parsed as ClaudeCodeConfigFile, false);
  } else {
    incoming = parseMcpServersFile(parsed as McpServersFile, false);
  }

  const result = await mergeImportedServers(incoming, options);
  return { ...result, source, path: filePath };
}

export async function importCursorMcpConfig(
  cursorConfigPath: string,
  options?: { merge?: boolean; enableImported?: boolean }
) {
  return importMcpConfigFromFile(cursorConfigPath, "cursor", options);
}

function homePaths(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

export function discoveryCandidates(): Array<{ source: McpImportSource; path: string; label: string }> {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const cwd = process.cwd();

  return [
    { source: "cursor", path: path.join(home, ".cursor", "mcp.json"), label: "Cursor (~/.cursor/mcp.json)" },
    { source: "cursor", path: path.join(appData, "Cursor", "User", "mcp.json"), label: "Cursor (AppData)" },
    { source: "claude", path: homePaths(".claude.json"), label: "Claude Code (~/.claude.json)" },
    { source: "claude", path: path.join(cwd, ".mcp.json"), label: "Claude Code (project .mcp.json)" },
    { source: "claude", path: path.join(appData, "Claude", "claude_desktop_config.json"), label: "Claude Desktop" },
    { source: "opencode", path: homePaths(".config", "opencode", "opencode.json"), label: "OpenCode (global)" },
    { source: "opencode", path: homePaths(".config", "opencode", "opencode.jsonc"), label: "OpenCode (global jsonc)" },
    { source: "opencode", path: path.join(cwd, "opencode.json"), label: "OpenCode (project)" },
    { source: "opencode", path: path.join(cwd, "opencode.jsonc"), label: "OpenCode (project jsonc)" },
    { source: "opencode", path: path.join(programData, "opencode", "opencode.json"), label: "OpenCode (managed)" },
  ];
}

export async function discoverMcpConfigs(): Promise<DiscoveredMcpConfig[]> {
  const found: DiscoveredMcpConfig[] = [];
  const seen = new Set<string>();

  for (const candidate of discoveryCandidates()) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try {
      await fs.access(candidate.path);
      const rawText = await readUtf8FileBounded(candidate.path, MAX_CONFIG_BYTES, "discovered MCP config");
      const parsed = parseJsonc(rawText);
      let count = 0;
      if (candidate.source === "opencode") count = Object.keys((parsed as OpenCodeConfigFile).mcp ?? {}).length;
      else if (candidate.source === "claude") count = parseClaudeCodeConfig(parsed as ClaudeCodeConfigFile).length;
      else count = Object.keys((parsed as McpServersFile).mcpServers ?? {}).length;
      if (count > 0) found.push({ source: candidate.source, path: candidate.path, label: candidate.label, server_count: count });
    } catch {}
  }
  return found;
}

export async function findMcpConfigForSource(source: McpImportSource): Promise<string | null> {
  const configs = await discoverMcpConfigs();
  return configs.find((c) => c.source === source)?.path ?? null;
}

export async function findCursorMcpConfig(): Promise<string | null> {
  return findMcpConfigForSource("cursor");
}