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

const exportRouter = Router();
const importRouter = Router();

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

function getMcpServersForExport(userId: string): McpServerExport[] {
  const rows = db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY name ASC').all(userId) as Record<string, unknown>[];
  return rows.map((r) => {
    const out = stripUserId(r) as Record<string, unknown>;
    out.config = r.config ? (() => { try { return JSON.parse(r.config as string); } catch { return null; } })() : null;
    return out as McpServerExport;
  });
}

// GET /api/export/agents — optional query: ids=id1,id2
exportRouter.get('/agents', (req: AuthRequest, res: Response) => {
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
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const mcp_servers = getMcpServersForExport(userId);
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
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const agents = getAgentsForExport(userId);
    const tools = getToolsForExport(userId);
    const mcp_servers = getMcpServersForExport(userId);
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

      if (payload.kind === 'mcp_servers' || payload.kind === 'all') {
        const servers = payload.kind === 'all' ? payload.mcp_servers! : payload.mcp_servers;
        for (const m of servers) {
          const newId = nanoid();
          mcpIdMap.set(m.id, newId);
          const configStr = m.config ? JSON.stringify(m.config) : '{}';
          db.prepare(`
            INSERT INTO mcp_servers (id, user_id, name, transport, config)
            VALUES (?, ?, ?, ?, ?)
          `).run(newId, userId, m.name, m.transport, configStr);
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
    res.json({ success: true, created: result });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
  }
});

export { exportRouter, importRouter };
