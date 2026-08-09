import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpUpstreamManager } from "./mcp-upstream-manager.js";
import type { UpstreamServerConfig } from "./mcp-upstream-config.js";
import { toolAnnotations } from "./tool-annotations.js";
import { toolResult } from "./tool-result.js";

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
    return s.additionalProperties === false ? object.strict() : object.passthrough();
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

export async function refreshProxiedTools(server: McpServer, manager: McpUpstreamManager): Promise<string[]> {
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
      });
      const existing = registry.get(proxyName);
      if (existing?.signature === signature) continue;
      if (existing) {
        existing.registered.remove();
        registry.delete(proxyName);
      }

      const inputShape = jsonSchemaToZodShape(tool.inputSchema);
      const hasSchema = Object.keys(inputShape).length > 0;

      const registered = server.registerTool(
        proxyName,
        {
          title: tool.title ?? tool.name,
          description: `[${config.name}] ${tool.description ?? tool.name}`,
          inputSchema: hasSchema ? inputShape : {},
          annotations: toolAnnotations("edit"),
        },
        async (args: Record<string, unknown>) => {
          const raw = await manager.callTool(config.id, tool.name, args ?? {});
          const content = formatUpstreamResult(raw);
          const isErr =
            typeof raw === "object" &&
            raw !== null &&
            "isError" in raw &&
            Boolean(raw.isError);
          return toolResult(proxyName, {
            upstream_server: config.id,
            upstream_tool: tool.name,
            result: content,
          }, { ok: !isErr, summary: isErr ? `${tool.name} failed upstream` : undefined });
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

function formatUpstreamResult(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  if (obj.structuredContent) return obj.structuredContent;
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((c) => {
        if (c && typeof c === "object" && "text" in c) return (c as { text: string }).text;
        return c;
      })
      .join("\n");
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