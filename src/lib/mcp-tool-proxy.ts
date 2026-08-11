import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpUpstreamManager } from "./mcp-upstream-manager.js";
import type { UpstreamServerConfig } from "./mcp-upstream-config.js";
import { MCP_TOOL_RESULT_MAX_BYTES } from "./output-budget.js";
import { proxiedToolAnnotations } from "./tool-annotations.js";
import { toolResult } from "./tool-result.js";
import { getChatGptToolProfile } from "./tool-profile.js";

interface ProxyRegistration {
  registered: RegisteredTool;
  signature: string;
}

function zodUnion(items: z.ZodTypeAny[]): z.ZodTypeAny {
  if (items.length === 0) return z.any();
  if (items.length === 1) return items[0];
  const [first, second, ...rest] = items;
  return z.union([first, second, ...rest]);
}

const proxyRegistry = new WeakMap<McpServer, Map<string, ProxyRegistration>>();

function getRegistry(server: McpServer): Map<string, ProxyRegistration> {
  let map = proxyRegistry.get(server);
  if (!map) {
    map = new Map();
    proxyRegistry.set(server, map);
  }
  return map;
}

function jsonSchemaValueToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const literals = s.enum.map((value) => z.literal(value as string | number | boolean | null));
    return zodUnion(literals);
  }
  if (Object.prototype.hasOwnProperty.call(s, "const")) {
    return z.literal(s.const as string | number | boolean | null);
  }
  const variants = (Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null) as unknown[] | null;
  if (variants?.length) {
    const converted = variants.map(jsonSchemaValueToZod);
    return zodUnion(converted);
  }

  const rawType = s.type;
  if (Array.isArray(rawType)) {
    const converted = rawType.map((type) => jsonSchemaValueToZod({ ...s, type }));
    return zodUnion(converted);
  }

  if (rawType === "string") {
    let out = z.string();
    if (typeof s.minLength === "number") out = out.min(s.minLength);
    if (typeof s.maxLength === "number") out = out.max(s.maxLength);
    return out;
  }
  if (rawType === "integer") {
    let out = z.number().int();
    if (typeof s.minimum === "number") out = out.min(s.minimum);
    if (typeof s.maximum === "number") out = out.max(s.maximum);
    return out;
  }
  if (rawType === "number") {
    let out = z.number();
    if (typeof s.minimum === "number") out = out.min(s.minimum);
    if (typeof s.maximum === "number") out = out.max(s.maximum);
    return out;
  }
  if (rawType === "boolean") return z.boolean();
  if (rawType === "null") return z.null();
  if (rawType === "array") return z.array(jsonSchemaValueToZod(s.items));
  if (rawType === "object" || s.properties) {
    const shape = jsonSchemaToZodShape(s as Tool["inputSchema"]);
    const object = z.object(shape);
    if (s.additionalProperties === false) return object.strict();
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      return object.catchall(jsonSchemaValueToZod(s.additionalProperties));
    }
    // JSON Schema defaults additionalProperties to true. passthrough() is
    // therefore required here; Zod's default object mode would silently strip
    // arbitrary upstream arguments before the proxy call reaches its server.
    return object.passthrough();
  }
  return z.any();
}

export function jsonSchemaToZodShape(schema: Tool["inputSchema"]): Record<string, z.ZodTypeAny> {
  if (!schema || typeof schema !== "object") return {};
  const schemaObj = schema as { properties?: Record<string, unknown>; required?: string[] };
  const props = schemaObj.properties;
  if (!props || typeof props !== "object") return {};

  const required = new Set(Array.isArray(schemaObj.required) ? schemaObj.required : []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const p = prop as { description?: string };
    let field: z.ZodTypeAny = jsonSchemaValueToZod(prop);
    if (p.description) field = field.describe(p.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function shouldExposeTool(config: UpstreamServerConfig, toolName: string): boolean {
  if (!config.enabled) return false;
  if (config.expose === "none" || config.expose === "meta_only") return false;
  if (config.expose === "all") return true;
  return (config.tools ?? []).includes(toolName);
}

function proxiedCallResult(proxyName: string, upstreamServer: string, upstreamTool: string, raw: unknown): CallToolResult {
  const obj = raw && typeof raw === "object"
    ? raw as { content?: unknown; structuredContent?: unknown; isError?: unknown; _meta?: Record<string, unknown> }
    : {};
  const isError = Boolean(obj.isError);
  const formatted = formatUpstreamResult(raw);

  if (Array.isArray(obj.content)) {
    // A direct MCP proxy should preserve protocol-level content blocks (image,
    // resource, resource_link, audio, etc.), not bury them inside JSON text.
    // Keep the local envelope in structuredContent without duplicating those
    // blocks unless the upstream already supplied structuredContent.
    const envelopeResult = obj.structuredContent !== undefined
      ? obj.structuredContent
      : { content_blocks_preserved: true, count: obj.content.length };
    const envelope = toolResult(
      proxyName,
      { upstream_server: upstreamServer, upstream_tool: upstreamTool, result: envelopeResult },
      { ok: !isError, summary: isError ? `${upstreamTool} failed upstream` : undefined },
    );
    const candidate: CallToolResult = {
      ...envelope,
      // Keep the local-coder JSON envelope as content[0] for backward
      // compatibility, then append upstream blocks verbatim so rich MCP content
      // remains usable by clients instead of being flattened into JSON.
      content: [...envelope.content, ...(obj.content as CallToolResult["content"])],
      ...(isError ? { isError: true } : {}),
      ...(obj._meta ? { _meta: obj._meta } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MCP_TOOL_RESULT_MAX_BYTES) {
      return candidate;
    }
  }

  // Oversized or non-content upstream results use the standard bounded JSON
  // envelope. Preserve isError so clients can self-correct from tool failures.
  const fallback: CallToolResult = {
    ...toolResult(
      proxyName,
      { upstream_server: upstreamServer, upstream_tool: upstreamTool, result: formatted },
      { ok: !isError, summary: isError ? `${upstreamTool} failed upstream` : undefined },
    ),
    ...(isError ? { isError: true } : {}),
  };
  if (obj._meta) {
    const withMeta: CallToolResult = { ...fallback, _meta: obj._meta };
    if (Buffer.byteLength(JSON.stringify(withMeta), "utf8") <= MCP_TOOL_RESULT_MAX_BYTES) return withMeta;
  }
  return fallback;
}

export async function refreshProxiedTools(server: McpServer, manager: McpUpstreamManager): Promise<string[]> {
  // The slim profile is a frozen ChatGPT ABI: native upstream proxies must
  // never appear in (or disappear from) the stable inventory. Proxy refresh is
  // a full-profile-only activity; the mcp_call bridge still reaches upstream.
  if (getChatGptToolProfile() !== "full") return [];

  const registry = getRegistry(server);
  const activeNames = new Set<string>();
  for (const config of manager.listServerConfigs()) {
    if (!config.enabled) continue;
    if (config.expose !== "all" && config.expose !== "allowlist") continue;

    let tools: Tool[] = [];
    try {
      tools = await manager.listTools(config.id);
    } catch {
      continue;
    }

    const prefix = `${config.tool_prefix ?? config.id}__`;
    for (const tool of tools) {
      if (!shouldExposeTool(config, tool.name)) continue;
      const proxyName = `${prefix}${tool.name}`;
      activeNames.add(proxyName);

      const signature = JSON.stringify({
        upstreamId: config.id,
        upstreamName: config.name,
        title: tool.title ?? tool.name,
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema ?? {},
        annotations: tool.annotations ?? null,
        meta: tool._meta ?? null,
      });
      const existing = registry.get(proxyName);
      if (existing?.signature === signature) continue;
      if (existing) {
        existing.registered.remove();
        registry.delete(proxyName);
      }

      const inputSchema = jsonSchemaValueToZod(tool.inputSchema);

      const registered = server.registerTool(
        proxyName,
        {
          title: tool.title ?? tool.name,
          description: `[${config.name}] ${tool.description ?? tool.name}`,
          inputSchema,
          annotations: proxiedToolAnnotations(tool.annotations),
          _meta: tool._meta,
        },
        async (args: Record<string, unknown>) => {
          const raw = await manager.callTool(config.id, tool.name, args ?? {});
          return proxiedCallResult(proxyName, config.id, tool.name, raw);
        }
      );
      registry.set(proxyName, { registered, signature });
    }
  }

  for (const [name, entry] of registry.entries()) {
    if (!activeNames.has(name)) {
      entry.registered.remove();
      registry.delete(name);
    }
  }

  return [...activeNames];
}

export function formatUpstreamResult(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  if (obj.structuredContent !== undefined) return obj.structuredContent;
  if (Array.isArray(obj.content)) {
    const allText = obj.content.every(
      (c) => c && typeof c === "object" && "text" in c && typeof (c as { text?: unknown }).text === "string"
    );
    if (allText) return obj.content.map((c) => (c as { text: string }).text).join("\n");
    // Preserve image/resource/resource_link/audio blocks instead of coercing them
    // through Array.join(), which turns objects into the lossy "[object Object]".
    return obj.content;
  }
  return raw;
}

export function clearProxiedTools(server: McpServer): void {
  const registry = getRegistry(server);
  for (const entry of registry.values()) {
    entry.registered.remove();
  }
  registry.clear();
}