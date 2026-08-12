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

const mcpUrlAuthExportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('bearer'),
    token: z.string(),
  }),
  z.object({
    type: z.literal('client_credentials'),
    clientId: z.string(),
    clientSecret: z.string(),
    scope: z.string().optional(),
    expectedIssuer: z.string(),
  }),
]);

const mcpUrlConfigExportSchema = z.object({
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  allowInsecureHttp: z.boolean().optional(),
  auth: mcpUrlAuthExportSchema.optional(),
});

const mcpLocalConfigExportSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  // Execution approval is deliberately absent: it is machine-bound and must
  // always be renewed after import on the destination host.
});

/**
 * Describes whether an exported MCP configuration can be used as-is on the
 * destination host. This is deliberately separate from `config`: a masked
 * sentinel is presentation data, never a credential that import may persist.
 *
 * Older v1 exports did not carry this field. They remain accepted as `ready`;
 * if they contain a secret sentinel, normal MCP validation rejects them rather
 * than silently turning the sentinel into a credential.
 */
const mcpPortabilitySchema = z.object({
  state: z.enum(['ready', 'redacted', 'local_approval_required']),
  redacted_fields: z.array(z.string().max(512)).max(1024).optional().default([]),
}).optional().default({ state: 'ready', redacted_fields: [] });

const mcpServerExportSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  transport: z.enum(['url', 'stdio', 'relay']),
  config: z.union([
    mcpUrlConfigExportSchema,
    mcpLocalConfigExportSchema,
  ]).nullable().optional(),
  portability: mcpPortabilitySchema,
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
