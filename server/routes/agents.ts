import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
import {
  assertProviderRoutingCompatible,
  normalizeProviderRoutingConfig,
  parseProviderRoutingConfig,
  serializeProviderRoutingConfig,
  type ProviderRoutingConfig,
} from '../providerRouting.js';

const router = Router();

function normalizeProviderRoutingBody(value: unknown): { config: ProviderRoutingConfig | null; error?: string } {
  if (value === undefined || value === null) return { config: null };
  const config = normalizeProviderRoutingConfig(value);
  if (!config) return { config: null, error: 'provider_routing is invalid' };
  return { config };
}

function withParsedProviderRouting<T extends Record<string, unknown>>(row: T): T & { provider_routing: ProviderRoutingConfig | null } {
  return {
    ...row,
    provider_routing: parseProviderRoutingConfig(row.provider_routing),
  };
}

const INVALID_SKILL_IDS_ERROR = 'One or more skill_ids do not exist or are not owned by this user';

function skillIdsAreOwnedByUser(skillIds: unknown, userId: string): boolean {
  if (!Array.isArray(skillIds)) return true;
  const skillLookup = db.prepare('SELECT id FROM skills WHERE id = ? AND user_id = ?');
  return skillIds.every((skillId) => (
    typeof skillId === 'string'
    && skillId.length > 0
    && Boolean(skillLookup.get(skillId, userId))
  ));
}

// GET /api/agents - List all agents (with tool_ids, mcp_server_ids, and skill_ids)
router.get('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const agents = db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Record<string, unknown>[];
    const agentIds = agents.map((a) => a.id as string);
    const toolLinks = agentIds.length
      ? (db.prepare('SELECT agent_id, tool_id FROM agent_tools WHERE agent_id IN (?' + ',?'.repeat(agentIds.length - 1) + ')').all(...agentIds) as { agent_id: string; tool_id: string }[])
      : [];
    const mcpLinks = agentIds.length
      ? (db.prepare('SELECT agent_id, mcp_server_id FROM agent_mcp_servers WHERE agent_id IN (?' + ',?'.repeat(agentIds.length - 1) + ')').all(...agentIds) as { agent_id: string; mcp_server_id: string }[])
      : [];
    const skillLinks = agentIds.length
      ? (db.prepare('SELECT agent_id, skill_id FROM agent_skills WHERE agent_id IN (?' + ',?'.repeat(agentIds.length - 1) + ')').all(...agentIds) as { agent_id: string; skill_id: string }[])
      : [];
    const toolByAgent = new Map<string, string[]>();
    const mcpByAgent = new Map<string, string[]>();
    const skillByAgent = new Map<string, string[]>();
    for (const l of toolLinks) {
      if (!toolByAgent.has(l.agent_id)) toolByAgent.set(l.agent_id, []);
      toolByAgent.get(l.agent_id)!.push(l.tool_id);
    }
    for (const l of mcpLinks) {
      if (!mcpByAgent.has(l.agent_id)) mcpByAgent.set(l.agent_id, []);
      mcpByAgent.get(l.agent_id)!.push(l.mcp_server_id);
    }
    for (const l of skillLinks) {
      if (!skillByAgent.has(l.agent_id)) skillByAgent.set(l.agent_id, []);
      skillByAgent.get(l.agent_id)!.push(l.skill_id);
    }
    const result = agents.map((a) => ({
      ...withParsedProviderRouting(a),
      tool_ids: toolByAgent.get(a.id as string) || [],
      mcp_server_ids: mcpByAgent.get(a.id as string) || [],
      skill_ids: skillByAgent.get(a.id as string) || [],
    }));
    res.json(result);
  } catch (err) {
    console.error('Error listing agents:', err);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// GET /api/agents/search?q=query - Search agents by name (for @mention autocomplete)
router.get('/search', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { q } = req.query;
    const query = typeof q === 'string' ? q.trim() : '';

    if (!query) {
      // Return all agents with limited fields for dropdown
      const agents = db.prepare(`
        SELECT id, name, emoji, description
        FROM agents
        WHERE user_id = ?
        ORDER BY name ASC
      `).all(userId);
      return res.json({ agents });
    }

    // Search by name (case-insensitive)
    const searchPattern = `%${query}%`;
    const agents = db.prepare(`
      SELECT id, name, emoji, description
      FROM agents
      WHERE user_id = ? AND (name LIKE ? OR description LIKE ?)
      ORDER BY name ASC
    `).all(userId, searchPattern, searchPattern);

    res.json({ agents });
  } catch (err) {
    console.error('Error searching agents:', err);
    res.status(500).json({ error: 'Failed to search agents' });
  }
});

// GET /api/agents/:id - Get single agent (with tool_ids, mcp_server_ids, skill_ids, and full resources)
router.get('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown> | undefined;
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const toolLinks = db.prepare('SELECT tool_id FROM agent_tools WHERE agent_id = ?').all(req.params.id) as { tool_id: string }[];
    const toolIds = toolLinks.map((l) => l.tool_id);
    const tools = toolIds.length
      ? (db.prepare('SELECT * FROM tools WHERE id IN (?' + ',?'.repeat(toolIds.length - 1) + ')').all(...toolIds) as Record<string, unknown>[])
      : [];
    const toolsParsed = tools.map((t) => ({
      ...t,
      parameters_schema: t.parameters_schema ? JSON.parse(t.parameters_schema as string) : {},
      config: t.config ? JSON.parse(t.config as string) : null,
    }));
    const mcpLinks = db.prepare('SELECT mcp_server_id FROM agent_mcp_servers WHERE agent_id = ?').all(req.params.id) as { mcp_server_id: string }[];
    const mcpServerIds = mcpLinks.map((l) => l.mcp_server_id);
    let mcpServers: Record<string, unknown>[] = [];
    if (mcpServerIds.length > 0) {
      const rows = db.prepare('SELECT * FROM mcp_servers WHERE id IN (?' + ',?'.repeat(mcpServerIds.length - 1) + ')').all(...mcpServerIds) as Record<string, unknown>[];
      mcpServers = rows.map((r) => ({
        ...r,
        config: r.config ? (() => { try { return JSON.parse(r.config as string); } catch { return null; } })() : null,
      }));
    }
    const skillLinks = db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ?').all(req.params.id) as { skill_id: string }[];
    const skillIds = skillLinks.map((l) => l.skill_id);
    const skills = skillIds.length
      ? (db.prepare('SELECT * FROM skills WHERE id IN (?' + ',?'.repeat(skillIds.length - 1) + ') AND user_id = ?').all(...skillIds, userId) as Record<string, unknown>[])
      : [];
    const skillsParsed = skills.map((s) => ({
      ...s,
      metadata: s.metadata ? (() => { try { return JSON.parse(s.metadata as string); } catch { return null; } })() : null,
    }));
    res.json({
      ...withParsedProviderRouting(agent),
      tool_ids: toolIds,
      tools: toolsParsed,
      mcp_server_ids: mcpServerIds,
      mcp_servers: mcpServers,
      skill_ids: skillIds,
      skills: skillsParsed,
    });
  } catch (err) {
    console.error('Error getting agent:', err);
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

// POST /api/agents - Create agent (optional tool_ids, mcp_server_ids, skill_ids; web_search_enabled syncs with web_search tool)
router.post('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { name, description, emoji, system_prompt, base_url, model, provider_routing, temperature, max_tokens, web_search_enabled, reasoning_enabled, reasoning_effort, reasoning_max_tokens, tool_ids, mcp_server_ids, skill_ids, tool_choice, parallel_tool_calls, structured_output_enabled, structured_output_schema, response_healing_enabled } = req.body;

    if (!name || !system_prompt) {
      return res.status(400).json({ error: 'Name and system_prompt are required' });
    }

    const defaultBaseUrl = 'https://openrouter.ai/api/v1';
    const defaultModel = 'openrouter/auto';
    const finalModel = model || defaultModel;
    const routingInput = normalizeProviderRoutingBody(provider_routing);
    if (routingInput.error) {
      return res.status(400).json({ error: routingInput.error });
    }
    try {
      assertProviderRoutingCompatible(finalModel, routingInput.config);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid provider routing' });
    }
    if (!skillIdsAreOwnedByUser(skill_ids, userId)) {
      return res.status(400).json({ error: INVALID_SKILL_IDS_ERROR });
    }

    let finalToolIds: string[] = Array.isArray(tool_ids) ? [...tool_ids] : [];
    const webSearchTool = db.prepare("SELECT id FROM tools WHERE name = 'web_search' AND user_id = ?").get(userId) as { id: string } | undefined;
    if (web_search_enabled && webSearchTool && !finalToolIds.includes(webSearchTool.id)) {
      finalToolIds.push(webSearchTool.id);
    }
    if (!web_search_enabled && webSearchTool) {
      finalToolIds = finalToolIds.filter((tid) => tid !== webSearchTool.id);
    }

    const id = nanoid();
    const toolChoiceVal = tool_choice === 'none' ? 'none' : 'auto';
    const parallelVal = parallel_tool_calls === false ? 0 : 1;
    const structuredOutputVal = structured_output_enabled ? 1 : 0;
    const responseHealingVal = response_healing_enabled ? 1 : 0;
    const schemaVal = typeof structured_output_schema === 'string' && structured_output_schema.trim() ? structured_output_schema.trim() : null;
    db.prepare(`
      INSERT INTO agents (id, user_id, name, description, emoji, system_prompt, provider, provider_routing, base_url, model, temperature, max_tokens, web_search_enabled, reasoning_enabled, reasoning_effort, reasoning_max_tokens, tool_choice, parallel_tool_calls, structured_output_enabled, structured_output_schema, response_healing_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      name,
      description || '',
      emoji || '🤖',
      system_prompt,
      'openrouter',
      serializeProviderRoutingConfig(routingInput.config),
      base_url || defaultBaseUrl,
      finalModel,
      temperature ?? 0.6,
      max_tokens ?? 8192,
      web_search_enabled ? 1 : 0,
      reasoning_enabled ? 1 : 0,
      reasoning_effort || null,
      reasoning_max_tokens ?? null,
      toolChoiceVal,
      parallelVal,
      structuredOutputVal,
      schemaVal,
      responseHealingVal
    );

    for (const toolId of finalToolIds) {
      db.prepare('INSERT OR IGNORE INTO agent_tools (agent_id, tool_id) VALUES (?, ?)').run(id, toolId);
    }

    const mcpIds: string[] = Array.isArray(mcp_server_ids) ? mcp_server_ids : [];
    for (const mcpId of mcpIds) {
      if (typeof mcpId === 'string' && mcpId) {
        db.prepare('INSERT OR IGNORE INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)').run(id, mcpId);
      }
    }
    const skillIds: string[] = Array.isArray(skill_ids) ? skill_ids : [];
    for (const skillId of skillIds) {
      if (typeof skillId === 'string' && skillId) {
        db.prepare('INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)').run(id, skillId);
      }
    }

    const agent = withParsedProviderRouting(db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>);
    const toolLinks = db.prepare('SELECT tool_id FROM agent_tools WHERE agent_id = ?').all(id) as { tool_id: string }[];
    const mcpLinks = db.prepare('SELECT mcp_server_id FROM agent_mcp_servers WHERE agent_id = ?').all(id) as { mcp_server_id: string }[];
    const skillLinks = db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ?').all(id) as { skill_id: string }[];
    (agent as Record<string, unknown>).tool_ids = toolLinks.map((l) => l.tool_id);
    (agent as Record<string, unknown>).mcp_server_ids = mcpLinks.map((l) => l.mcp_server_id);
    (agent as Record<string, unknown>).skill_ids = skillLinks.map((l) => l.skill_id);
    res.status(201).json(agent);
  } catch (err) {
    console.error('Error creating agent:', err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// PUT /api/agents/:id - Update agent (optional tool_ids, mcp_server_ids, skill_ids; web_search_enabled syncs with web_search tool)
router.put('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const existing = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown> | undefined;
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { name, description, emoji, system_prompt, base_url, model, provider_routing, temperature, max_tokens, web_search_enabled, reasoning_enabled, reasoning_effort, reasoning_max_tokens, tool_ids, mcp_server_ids, skill_ids, tool_choice, parallel_tool_calls, structured_output_enabled, structured_output_schema, response_healing_enabled } = req.body;

    if (!skillIdsAreOwnedByUser(skill_ids, userId)) {
      return res.status(400).json({ error: INVALID_SKILL_IDS_ERROR });
    }

    let finalToolIds: string[] | null = null;
    if (Array.isArray(tool_ids)) {
      finalToolIds = [...tool_ids];
      const webSearchTool = db.prepare("SELECT id FROM tools WHERE name = 'web_search' AND user_id = ?").get(userId) as { id: string } | undefined;
      if (web_search_enabled && webSearchTool && !finalToolIds.includes(webSearchTool.id)) {
        finalToolIds.push(webSearchTool.id);
      }
      if (web_search_enabled === false && webSearchTool) {
        finalToolIds = finalToolIds.filter((tid) => tid !== webSearchTool.id);
      }
    }

    const toolChoiceVal = tool_choice !== undefined ? (tool_choice === 'none' ? 'none' : 'auto') : null;
    const parallelVal = parallel_tool_calls !== undefined ? (parallel_tool_calls === false ? 0 : 1) : null;
    const structuredOutputVal = structured_output_enabled !== undefined ? (structured_output_enabled ? 1 : 0) : null;
    const responseHealingVal = response_healing_enabled !== undefined ? (response_healing_enabled ? 1 : 0) : null;
    const schemaVal = structured_output_schema !== undefined ? (typeof structured_output_schema === 'string' && structured_output_schema.trim() ? structured_output_schema.trim() : null) : null;
    const routingInput = provider_routing !== undefined
      ? normalizeProviderRoutingBody(provider_routing)
      : { config: parseProviderRoutingConfig(existing.provider_routing) };
    if (routingInput.error) {
      return res.status(400).json({ error: routingInput.error });
    }
    const nextModel = model ?? existing.model as string;
    const nextProviderRouting = provider_routing === undefined && model !== undefined && model !== existing.model
      ? null
      : routingInput.config;
    try {
      assertProviderRoutingCompatible(nextModel, nextProviderRouting);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid provider routing' });
    }
    db.prepare(`
      UPDATE agents SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        emoji = COALESCE(?, emoji),
        system_prompt = COALESCE(?, system_prompt),
        provider = COALESCE(?, provider),
        provider_routing = ?,
        base_url = COALESCE(?, base_url),
        model = COALESCE(?, model),
        temperature = COALESCE(?, temperature),
        max_tokens = COALESCE(?, max_tokens),
        web_search_enabled = ?,
        reasoning_enabled = ?,
        reasoning_effort = ?,
        reasoning_max_tokens = ?,
        tool_choice = COALESCE(?, tool_choice),
        parallel_tool_calls = COALESCE(?, parallel_tool_calls),
        structured_output_enabled = COALESCE(?, structured_output_enabled),
        structured_output_schema = COALESCE(?, structured_output_schema),
        response_healing_enabled = COALESCE(?, response_healing_enabled),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? null,
      description ?? null,
      emoji ?? null,
      system_prompt ?? null,
      'openrouter',
      serializeProviderRoutingConfig(nextProviderRouting),
      base_url ?? null,
      model ?? null,
      temperature ?? null,
      max_tokens ?? null,
      web_search_enabled !== undefined ? (web_search_enabled ? 1 : 0) : null,
      reasoning_enabled !== undefined ? (reasoning_enabled ? 1 : 0) : null,
      reasoning_effort !== undefined ? (reasoning_effort || null) : null,
      reasoning_max_tokens !== undefined ? (reasoning_max_tokens ?? null) : null,
      toolChoiceVal,
      parallelVal,
      structuredOutputVal,
      schemaVal,
      responseHealingVal,
      req.params.id
    );

    if (finalToolIds !== null) {
      db.prepare('DELETE FROM agent_tools WHERE agent_id = ?').run(req.params.id);
      for (const toolId of finalToolIds) {
        db.prepare('INSERT OR IGNORE INTO agent_tools (agent_id, tool_id) VALUES (?, ?)').run(req.params.id, toolId);
      }
    }

    if (Array.isArray(mcp_server_ids)) {
      db.prepare('DELETE FROM agent_mcp_servers WHERE agent_id = ?').run(req.params.id);
      for (const mcpId of mcp_server_ids) {
        if (typeof mcpId === 'string' && mcpId) {
          db.prepare('INSERT OR IGNORE INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)').run(req.params.id, mcpId);
        }
      }
    }
    if (Array.isArray(skill_ids)) {
      db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(req.params.id);
      for (const skillId of skill_ids) {
        if (typeof skillId === 'string' && skillId) {
          db.prepare('INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)').run(req.params.id, skillId);
        }
      }
    }

    const agent = withParsedProviderRouting(db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id) as Record<string, unknown>);
    const toolLinks = db.prepare('SELECT tool_id FROM agent_tools WHERE agent_id = ?').all(req.params.id) as { tool_id: string }[];
    const mcpLinks = db.prepare('SELECT mcp_server_id FROM agent_mcp_servers WHERE agent_id = ?').all(req.params.id) as { mcp_server_id: string }[];
    const skillLinks = db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ?').all(req.params.id) as { skill_id: string }[];
    (agent as Record<string, unknown>).tool_ids = toolLinks.map((l) => l.tool_id);
    (agent as Record<string, unknown>).mcp_server_ids = mcpLinks.map((l) => l.mcp_server_id);
    (agent as Record<string, unknown>).skill_ids = skillLinks.map((l) => l.skill_id);
    res.json(agent);
  } catch (err) {
    console.error('Error updating agent:', err);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// DELETE /api/agents/:id - Delete agent and cascaded conversations/messages
router.delete('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const existing = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting agent:', err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

export default router;
