import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
import { getAllBuiltinNames } from '../tools/registry.js';
import {
  EXPORT_VERSION,
  parseImportPayload,
  type AgentExport,
  type ToolExport,
  type McpServerExport,
  type ExportPayload,
} from '../schemas/exportImport.js';
import { parseProviderRoutingConfig, serializeProviderRoutingConfig } from '../providerRouting.js';
import {
  MCP_SECRET_PLACEHOLDER,
  isEncryptedMcpConfig,
  maskMcpConfig,
  normalizeMcpConfig,
  parseStoredMcpConfig,
  serializeMcpConfig,
} from '../mcp/index.js';
import type { McpServerConfig, McpTransport } from '../mcp/types.js';

const exportRouter = Router();
const importRouter = Router();
const SECRET_EXPORT_QUERY = 'include_secrets';
const SECRET_EXPORT_CONFIRM_HEADER = 'x-confirm-secret-export';
const SECRET_EXPORT_CONFIRM_VALUE = 'include-secrets';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setPrivateNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function wantsSecretExport(req: AuthRequest): boolean {
  return req.query[SECRET_EXPORT_QUERY] === 'true';
}

function confirmSecretExport(req: AuthRequest, res: Response): boolean | null {
  if (!wantsSecretExport(req)) return false;
  if (req.get(SECRET_EXPORT_CONFIRM_HEADER) !== SECRET_EXPORT_CONFIRM_VALUE) {
    res.status(400).json({
      error: `Secret export requires ${SECRET_EXPORT_QUERY}=true and header ${SECRET_EXPORT_CONFIRM_HEADER}: ${SECRET_EXPORT_CONFIRM_VALUE}`,
    });
    return null;
  }
  return true;
}

function stripUserId<T extends Record<string, unknown>>(row: T): Omit<T, 'user_id'> {
  const { user_id: _, ...rest } = row;
  return rest as Omit<T, 'user_id'>;
}

function getAgentsForExport(userId: string, agentIds?: string[]): AgentExport[] {
  let agents: Record<string, unknown>[];
  if (agentIds && agentIds.length > 0) {
    const placeholders = agentIds.map(() => '?').join(',');
    agents = db.prepare(
      `SELECT * FROM agents WHERE user_id = ? AND id IN (${placeholders}) ORDER BY created_at DESC`
    ).all(userId, ...agentIds) as Record<string, unknown>[];
  } else {
    agents = db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Record<string, unknown>[];
  }
  if (agents.length === 0) return [];
  const ids = agents.map((a) => a.id as string);
  const toolLinks = db.prepare(
    'SELECT agent_id, tool_id FROM agent_tools WHERE agent_id IN (?' + ',?'.repeat(ids.length - 1) + ')'
  ).all(...ids) as { agent_id: string; tool_id: string }[];
  const mcpLinks = db.prepare(
    'SELECT agent_id, mcp_server_id FROM agent_mcp_servers WHERE agent_id IN (?' + ',?'.repeat(ids.length - 1) + ')'
  ).all(...ids) as { agent_id: string; mcp_server_id: string }[];
  const toolByAgent = new Map<string, string[]>();
  const mcpByAgent = new Map<string, string[]>();
  for (const l of toolLinks) {
    if (!toolByAgent.has(l.agent_id)) toolByAgent.set(l.agent_id, []);
    toolByAgent.get(l.agent_id)!.push(l.tool_id);
  }
  for (const l of mcpLinks) {
    if (!mcpByAgent.has(l.agent_id)) mcpByAgent.set(l.agent_id, []);
    mcpByAgent.get(l.agent_id)!.push(l.mcp_server_id);
  }
  return agents.map((a) => {
    const out = stripUserId(a) as Record<string, unknown>;
    out.tool_ids = toolByAgent.get(a.id as string) || [];
    out.mcp_server_ids = mcpByAgent.get(a.id as string) || [];
    out.web_search_enabled = (a.web_search_enabled as number) ? 1 : 0;
    out.reasoning_enabled = (a.reasoning_enabled as number) ? 1 : 0;
    out.parallel_tool_calls = (a.parallel_tool_calls as number) ?? 1;
    out.structured_output_enabled = (a.structured_output_enabled as number) ? 1 : 0;
    out.response_healing_enabled = (a.response_healing_enabled as number) ? 1 : 0;
    out.provider_routing = parseProviderRoutingConfig(a.provider_routing);
    return out as AgentExport;
  });
}

function getToolsForExport(userId: string): ToolExport[] {
  const rows = db.prepare('SELECT * FROM tools WHERE user_id = ? ORDER BY type ASC, name ASC').all(userId) as Record<string, unknown>[];
  return rows.map((r) => {
    const out = stripUserId(r) as Record<string, unknown>;
    out.parameters_schema = r.parameters_schema ? JSON.parse(r.parameters_schema as string) : { type: 'object', properties: {}, required: [] };
    out.config = r.config ? JSON.parse(r.config as string) : null;
    return out as ToolExport;
  });
}

type McpPortability = McpServerExport['portability'];

interface PortableMcpConfig {
  config: McpServerConfig;
  portability: McpPortability;
}

const REDACTED_IMPORT_URL = 'https://127.0.0.1/__agent_studio_mcp_import_requires_setup__';
const IMPORT_DRAFT_PREFIX = '[Setup required] ';
const MAX_MCP_SERVER_NAME_LENGTH = 200;

function maskUrlSecrets(config: McpServerConfig): McpServerConfig {
  const masked = maskMcpConfig(config);
  if (!('url' in masked)) {
    // Local execution approval is deliberately machine-bound and never part of
    // a portable export, even when secret export is explicitly confirmed.
    const { executionApproval: _approval, ...portable } = masked;
    return portable;
  }
  try {
    const url = new URL(masked.url);
    if (url.search) url.search = `?${MCP_SECRET_PLACEHOLDER}`;
    if (url.hash) url.hash = `#${MCP_SECRET_PLACEHOLDER}`;
    return { ...masked, url: url.href };
  } catch {
    return { ...masked, url: '[invalid MCP URL]' };
  }
}

function urlRedactedFields(config: Extract<McpServerConfig, { url: string }>): string[] {
  const fields: string[] = [];
  try {
    const url = new URL(config.url);
    if (url.search) fields.push('config.url.query');
    if (url.hash) fields.push('config.url.fragment');
  } catch {
    fields.push('config.url');
  }
  for (const name of Object.keys(config.headers ?? {})) fields.push(`config.headers.${name}`);
  if (config.auth?.type === 'bearer') fields.push('config.auth.token');
  if (config.auth?.type === 'client_credentials') fields.push('config.auth.clientSecret');
  return fields;
}

function localRedactedFields(config: Extract<McpServerConfig, { command: string }>): string[] {
  const fields = ['config.executionApproval'];
  for (let index = 0; index < (config.args?.length ?? 0); index += 1) {
    fields.push(`config.args.${index}`);
  }
  for (const name of Object.keys(config.env ?? {})) fields.push(`config.env.${name}`);
  if (config.cwd) fields.push('config.cwd');
  return fields;
}

function portableConfig(config: McpServerConfig, includeSecrets: boolean): PortableMcpConfig {
  if ('url' in config) {
    // Preserve the draft state across repeated export/import cycles. A secret
    // export cannot manufacture credentials that this draft never contained.
    if (config.url === REDACTED_IMPORT_URL) {
      return {
        config: { ...config },
        portability: { state: 'redacted', redacted_fields: ['config'] },
      };
    }
    if (includeSecrets) {
      return {
        config: { ...config },
        portability: { state: 'ready', redacted_fields: [] },
      };
    }
    const redactedFields = urlRedactedFields(config);
    return {
      config: maskUrlSecrets(config),
      portability: {
        state: redactedFields.length > 0 ? 'redacted' : 'ready',
        redacted_fields: redactedFields,
      },
    };
  }

  const { executionApproval: _approval, ...withoutApproval } = config;
  if (includeSecrets) {
    return {
      config: withoutApproval,
      portability: {
        state: 'local_approval_required',
        redacted_fields: ['config.executionApproval'],
      },
    };
  }

  const redactedFields = localRedactedFields(config);
  const portable: McpServerConfig = {
    command: config.command,
    ...(config.args && config.args.length > 0
      ? { args: config.args.map(() => MCP_SECRET_PLACEHOLDER) }
      : {}),
    ...(config.env && Object.keys(config.env).length > 0
      ? { env: Object.fromEntries(Object.keys(config.env).map((key) => [key, MCP_SECRET_PLACEHOLDER])) }
      : {}),
    ...(config.cwd ? { cwd: MCP_SECRET_PLACEHOLDER } : {}),
  };
  const hasPortableSecrets = Boolean(config.args?.length || Object.keys(config.env ?? {}).length || config.cwd);
  return {
    config: portable,
    portability: {
      state: hasPortableSecrets ? 'redacted' : 'local_approval_required',
      redacted_fields: redactedFields,
    },
  };
}

function parseAndMigrateExportConfig(row: Record<string, unknown>, userId: string): McpServerConfig | null {
  const stored = typeof row.config === 'string' ? row.config : null;
  const config = parseStoredMcpConfig(stored);
  if (!config || isEncryptedMcpConfig(stored)) return config;
  try {
    const encrypted = serializeMcpConfig(config);
    db.prepare('UPDATE mcp_servers SET config = ? WHERE id = ? AND user_id = ? AND config = ?')
      .run(encrypted, row.id, userId, stored);
  } catch {
    // An installation without an encryption key may read legacy rows, but new
    // writes and imports remain disabled rather than silently storing secrets.
  }
  return config;
}

function getMcpServersForExport(userId: string, includeSecrets = false): McpServerExport[] {
  const rows = db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY name ASC').all(userId) as Record<string, unknown>[];
  return rows.map((row) => {
    const out = stripUserId(row) as Record<string, unknown>;
    const config = parseAndMigrateExportConfig(row, userId);
    if (config) {
      const portable = portableConfig(config, includeSecrets);
      out.config = portable.config;
      out.portability = portable.portability;
    } else {
      out.config = null;
      out.portability = {
        state: 'redacted',
        redacted_fields: ['config'],
      } satisfies McpPortability;
    }
    return out as unknown as McpServerExport;
  });
}

function draftServerName(name: string): string {
  if (name.startsWith(IMPORT_DRAFT_PREFIX)) return name.slice(0, MAX_MCP_SERVER_NAME_LENGTH);
  return `${IMPORT_DRAFT_PREFIX}${name}`.slice(0, MAX_MCP_SERVER_NAME_LENGTH);
}

/**
 * A redacted export is a setup draft, not an executable configuration. URL
 * drafts point at loopback without the private-network opt-in, so the MCP
 * connection guard rejects them before any socket opens. Local drafts retain
 * only the executable hint and never receive an execution approval.
 */
function disabledDraftConfig(transport: McpTransport, incoming: unknown): McpServerConfig {
  if (transport === 'url') {
    return normalizeMcpConfig('url', { url: REDACTED_IMPORT_URL }, {
      requireExecutionApproval: false,
      localExecutionApproved: false,
    });
  }
  const command = isRecord(incoming) && typeof incoming.command === 'string' && incoming.command.trim()
    ? incoming.command
    : '__agent_studio_mcp_import_requires_setup__';
  return normalizeMcpConfig(transport, { command }, {
    requireExecutionApproval: false,
    localExecutionApproved: false,
  });
}

function rawMcpConfigs(payload: unknown): Map<string, unknown> {
  const configs = new Map<string, unknown>();
  if (!isRecord(payload) || (payload.kind !== 'mcp_servers' && payload.kind !== 'all')) return configs;
  if (!Array.isArray(payload.mcp_servers)) return configs;
  for (const server of payload.mcp_servers) {
    if (isRecord(server) && typeof server.id === 'string' && 'config' in server) {
      configs.set(server.id, server.config);
    }
  }
  return configs;
}

function containsSecretPlaceholder(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return value.includes(MCP_SECRET_PLACEHOLDER);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSecretPlaceholder(item, seen));
  return Object.values(value as Record<string, unknown>)
    .some((item) => containsSecretPlaceholder(item, seen));
}

function importConfigErrorStatus(error: unknown): number {
  return error instanceof Error && error.message.includes('ENCRYPTION_KEY') ? 503 : 400;
}

function importConfigErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes('ENCRYPTION_KEY')) {
    return 'Secure MCP configuration storage is unavailable until ENCRYPTION_KEY is configured';
  }
  return error instanceof Error ? `Invalid MCP server configuration: ${error.message}` : 'Invalid MCP server configuration';
}

// GET /api/export/agents — optional query: ids=id1,id2
exportRouter.get('/agents', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const idsParam = typeof req.query.ids === 'string' ? req.query.ids : undefined;
    const agentIds = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const agents = getAgentsForExport(userId, agentIds);
    const payload: ExportPayload = {
      version: EXPORT_VERSION,
      kind: 'agents',
      exported_at: new Date().toISOString(),
      agents,
    };
    res.json(payload);
  } catch (err) {
    console.error('Export agents error:', err);
    res.status(500).json({ error: 'Failed to export agents' });
  }
});

// GET /api/export/tools
exportRouter.get('/tools', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const tools = getToolsForExport(userId);
    const payload: ExportPayload = {
      version: EXPORT_VERSION,
      kind: 'tools',
      exported_at: new Date().toISOString(),
      tools,
    };
    res.json(payload);
  } catch (err) {
    console.error('Export tools error:', err);
    res.status(500).json({ error: 'Failed to export tools' });
  }
});

// GET /api/export/mcp-servers
exportRouter.get('/mcp-servers', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const includeSecrets = confirmSecretExport(req, res);
    if (includeSecrets === null) return;
    const mcp_servers = getMcpServersForExport(userId, includeSecrets);
    const payload: ExportPayload = {
      version: EXPORT_VERSION,
      kind: 'mcp_servers',
      exported_at: new Date().toISOString(),
      mcp_servers,
    };
    res.json(payload);
  } catch (err) {
    console.error('Export MCP servers error:', err);
    res.status(500).json({ error: 'Failed to export MCP servers' });
  }
});

// GET /api/export/all
exportRouter.get('/all', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const includeSecrets = confirmSecretExport(req, res);
    if (includeSecrets === null) return;
    const agents = getAgentsForExport(userId);
    const tools = getToolsForExport(userId);
    const mcp_servers = getMcpServersForExport(userId, includeSecrets);
    const payload: ExportPayload = {
      version: EXPORT_VERSION,
      kind: 'all',
      exported_at: new Date().toISOString(),
      agents,
      tools,
      mcp_servers,
    };
    res.json(payload);
  } catch (err) {
    console.error('Export all error:', err);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// POST /api/import — body: export JSON
importRouter.post('/', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    let payload: ExportPayload;
    try {
      payload = parseImportPayload(req.body);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : 'Invalid export format';
      return res.status(400).json({ error: msg });
    }

    const builtinNames = getAllBuiltinNames();
    const result = { agents: 0, tools: 0, mcp_servers: 0 };
    const toolIdMap = new Map<string, string>();
    const mcpIdMap = new Map<string, string>();

    const preparedMcpServers: Array<{
      newId: string;
      sourceId: string;
      name: string;
      transport: McpTransport;
      serializedConfig: string;
      portability: McpPortability;
    }> = [];
    if (payload.kind === 'mcp_servers' || payload.kind === 'all') {
      const servers = payload.kind === 'all' ? payload.mcp_servers! : payload.mcp_servers;
      const rawConfigs = rawMcpConfigs(req.body);
      try {
        for (const server of servers) {
          const transport = server.transport as McpTransport;
          const incomingConfig = rawConfigs.has(server.id) ? rawConfigs.get(server.id) : server.config;
          if (server.portability.state === 'local_approval_required' && transport === 'url') {
            throw new Error('URL transport cannot use local_approval_required portability state');
          }
          if (server.portability.state !== 'redacted' && containsSecretPlaceholder(incomingConfig)) {
            throw new Error('Secret placeholders require an explicitly redacted portability state');
          }
          const normalized = server.portability.state === 'redacted'
            ? disabledDraftConfig(transport, incomingConfig)
            : normalizeMcpConfig(transport, incomingConfig, {
                // Portable files can never authorize executable code on this host.
                requireExecutionApproval: false,
                localExecutionApproved: false,
              });
          const newId = nanoid();
          mcpIdMap.set(server.id, newId);
          preparedMcpServers.push({
            newId,
            sourceId: server.id,
            name: server.portability.state === 'redacted' ? draftServerName(server.name) : server.name,
            transport,
            serializedConfig: serializeMcpConfig(normalized),
            portability: server.portability,
          });
        }
      } catch (error) {
        return res.status(importConfigErrorStatus(error)).json({ error: importConfigErrorMessage(error) });
      }
    }

    const run = db.transaction(() => {
      if (payload.kind === 'tools' || payload.kind === 'all') {
        const tools = payload.kind === 'all' ? payload.tools! : payload.tools;
        for (const t of tools) {
          const existingBuiltin = builtinNames.includes(t.name)
            ? (db.prepare('SELECT id FROM tools WHERE name = ? AND user_id = ?').get(t.name, userId) as { id: string } | undefined)
            : undefined;
          if (existingBuiltin) {
            toolIdMap.set(t.id, existingBuiltin.id);
            continue;
          }
          const newId = nanoid();
          toolIdMap.set(t.id, newId);
          const schema = t.parameters_schema && typeof t.parameters_schema === 'object'
            ? t.parameters_schema
            : { type: 'object' as const, properties: {} as Record<string, unknown>, required: [] as string[] };
          const configStr = t.config ? JSON.stringify(t.config) : null;
          db.prepare(`
            INSERT INTO tools (id, user_id, name, description, parameters_schema, type, config)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(newId, userId, t.name, t.description, JSON.stringify(schema), t.type, configStr);
          result.tools += 1;
        }
      }

      if (preparedMcpServers.length > 0) {
        for (const server of preparedMcpServers) {
          db.prepare(`
            INSERT INTO mcp_servers (id, user_id, name, transport, config)
            VALUES (?, ?, ?, ?, ?)
          `).run(server.newId, userId, server.name, server.transport, server.serializedConfig);
          result.mcp_servers += 1;
        }
      }

      if (payload.kind === 'agents' || payload.kind === 'all') {
        const agents = payload.kind === 'all' ? payload.agents! : payload.agents;
        for (const a of agents) {
          const newId = nanoid();
          const toolIds = (a.tool_ids || []).map((oldId) => toolIdMap.get(oldId)).filter(Boolean) as string[];
          const mcpIds = (a.mcp_server_ids || []).map((oldId) => mcpIdMap.get(oldId)).filter(Boolean) as string[];
          const toolChoiceVal = a.tool_choice === 'none' ? 'none' : 'auto';
          const parallelVal = a.parallel_tool_calls === false || a.parallel_tool_calls === 0 ? 0 : 1;
          const structuredVal = a.structured_output_enabled ? 1 : 0;
          const responseHealingVal = a.response_healing_enabled ? 1 : 0;
          db.prepare(`
            INSERT INTO agents (id, user_id, name, description, emoji, system_prompt, provider, provider_routing, base_url, model, temperature, max_tokens, web_search_enabled, reasoning_enabled, reasoning_effort, reasoning_max_tokens, tool_choice, parallel_tool_calls, structured_output_enabled, structured_output_schema, response_healing_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            newId,
            userId,
            a.name,
            a.description ?? '',
            a.emoji ?? '🤖',
            a.system_prompt,
            a.provider ?? 'openrouter',
            serializeProviderRoutingConfig(a.provider_routing),
            a.base_url ?? 'https://openrouter.ai/api/v1',
            a.model ?? 'openrouter/auto',
            a.temperature ?? 0.6,
            a.max_tokens ?? 8192,
            a.web_search_enabled ? 1 : 0,
            a.reasoning_enabled ? 1 : 0,
            a.reasoning_effort ?? null,
            a.reasoning_max_tokens ?? null,
            toolChoiceVal,
            parallelVal,
            structuredVal,
            a.structured_output_schema ?? null,
            responseHealingVal
          );
          for (const tid of toolIds) {
            db.prepare('INSERT OR IGNORE INTO agent_tools (agent_id, tool_id) VALUES (?, ?)').run(newId, tid);
          }
          for (const mid of mcpIds) {
            db.prepare('INSERT OR IGNORE INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)').run(newId, mid);
          }
          result.agents += 1;
        }
      }
    });

    run();
    const requiresConfiguration = preparedMcpServers
      .filter((server) => server.portability.state !== 'ready')
      .map((server) => ({
        id: server.newId,
        source_id: server.sourceId,
        name: server.name,
        transport: server.transport,
        reason: server.portability.state,
        redacted_fields: server.portability.redacted_fields,
      }));
    res.json({
      success: true,
      created: result,
      requires_configuration: requiresConfiguration,
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
  }
});

export { exportRouter, importRouter };
