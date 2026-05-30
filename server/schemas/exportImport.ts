import { z } from 'zod';

const EXPORT_VERSION = 1;
export type ExportKind = 'agents' | 'tools' | 'mcp_servers' | 'all';

// --- Export payload shapes (what we send) ---

const providerRoutingSchema = z.union([
  z.object({ mode: z.literal('auto') }),
  z.object({
    mode: z.literal('provider'),
    provider_slug: z.string(),
    allow_fallbacks: z.boolean(),
  }),
]).nullable();

const agentExportSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional().default(''),
  emoji: z.string().optional().default('🤖'),
  system_prompt: z.string(),
  provider: z.string().optional().default('openrouter'),
  provider_routing: providerRoutingSchema.optional(),
  base_url: z.string().optional().default('https://openrouter.ai/api/v1'),
  model: z.string().optional().default('openrouter/auto'),
  temperature: z.number().optional().default(0.6),
  max_tokens: z.number().optional().default(8192),
  web_search_enabled: z.union([z.number(), z.boolean()]).optional().default(0),
  reasoning_enabled: z.union([z.number(), z.boolean()]).optional().default(0),
  reasoning_effort: z.string().nullable().optional(),
  reasoning_max_tokens: z.number().nullable().optional(),
  tool_choice: z.enum(['auto', 'none']).optional().default('auto'),
  parallel_tool_calls: z.union([z.number(), z.boolean()]).optional().default(1),
  structured_output_enabled: z.union([z.number(), z.boolean()]).optional().default(0),
  structured_output_schema: z.string().nullable().optional(),
  response_healing_enabled: z.union([z.number(), z.boolean()]).optional().default(0),
  tool_ids: z.array(z.string()).optional().default([]),
  mcp_server_ids: z.array(z.string()).optional().default([]),
});

const toolExportSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  parameters_schema: z.record(z.string(), z.unknown()).or(z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  })),
  type: z.enum(['builtin', 'http']),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
});

const mcpServerExportSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(['url', 'stdio']),
  config: z.union([
    z.object({ url: z.string(), headers: z.record(z.string(), z.string()).optional() }),
    z.object({ command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }),
  ]).nullable().optional(),
});

export const exportPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(EXPORT_VERSION),
    kind: z.literal('agents'),
    exported_at: z.string(),
    agents: z.array(agentExportSchema),
  }),
  z.object({
    version: z.literal(EXPORT_VERSION),
    kind: z.literal('tools'),
    exported_at: z.string(),
    tools: z.array(toolExportSchema),
  }),
  z.object({
    version: z.literal(EXPORT_VERSION),
    kind: z.literal('mcp_servers'),
    exported_at: z.string(),
    mcp_servers: z.array(mcpServerExportSchema),
  }),
  z.object({
    version: z.literal(EXPORT_VERSION),
    kind: z.literal('all'),
    exported_at: z.string(),
    agents: z.array(agentExportSchema).optional().default([]),
    tools: z.array(toolExportSchema).optional().default([]),
    mcp_servers: z.array(mcpServerExportSchema).optional().default([]),
  }),
]);

export type AgentExport = z.infer<typeof agentExportSchema>;
export type ToolExport = z.infer<typeof toolExportSchema>;
export type McpServerExport = z.infer<typeof mcpServerExportSchema>;
export type ExportPayload = z.infer<typeof exportPayloadSchema>;

export function parseImportPayload(data: unknown): ExportPayload {
  return exportPayloadSchema.parse(data);
}

export { EXPORT_VERSION };
