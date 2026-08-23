import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
import {
  createShare,
  getShareStatus,
  revokeShare,
} from '../shares/service.js';
import { validateOwnedIds } from '../mcp/ownership.js';
import { getSettingValue } from './settings.js';
import {
  assertProviderRoutingCompatible,
  normalizeProviderRoutingConfig,
  parseProviderRoutingConfig,
  serializeProviderRoutingConfig,
  type ProviderRoutingConfig,
} from '../providerRouting.js';

const router = Router();

function withParsedProviderRouting<T extends Record<string, unknown>>(row: T): T & { provider_routing: ProviderRoutingConfig | null } {
  return {
    ...row,
    provider_routing: parseProviderRoutingConfig(row.provider_routing),
  };
}

function normalizeProviderRoutingBody(value: unknown): { config: ProviderRoutingConfig | null; error?: string } {
  if (value === undefined || value === null) return { config: null };
  const config = normalizeProviderRoutingConfig(value);
  if (!config) return { config: null, error: 'provider_routing is invalid' };
  return { config };
}

function attachToolConfig(row: Record<string, unknown>, userId: string): Record<string, unknown> {
  return attachToolConfigBatch([row], userId)[0];
}
function attachToolConfigBatch(rows: Record<string, unknown>[], userId: string): Record<string, unknown>[] {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id as string);
  const placeholders = ids.map(() => '?').join(',');
  const toolLinks = db.prepare(`SELECT ct.conversation_id, ct.tool_id FROM conversation_tools ct JOIN tools t ON t.id = ct.tool_id WHERE ct.conversation_id IN (${placeholders}) AND t.user_id = ?`).all(...ids, userId) as { conversation_id: string; tool_id: string }[];
  const mcpLinks = db.prepare(`SELECT cm.conversation_id, cm.mcp_server_id FROM conversation_mcp_servers cm JOIN mcp_servers ms ON ms.id = cm.mcp_server_id WHERE cm.conversation_id IN (${placeholders}) AND ms.user_id = ?`).all(...ids, userId) as { conversation_id: string; mcp_server_id: string }[];
  const toolMap = new Map<string, string[]>();
  const mcpMap = new Map<string, string[]>();
  for (const l of toolLinks) { if (!toolMap.has(l.conversation_id)) toolMap.set(l.conversation_id, []); toolMap.get(l.conversation_id)!.push(l.tool_id); }
  for (const l of mcpLinks) { if (!mcpMap.has(l.conversation_id)) mcpMap.set(l.conversation_id, []); mcpMap.get(l.conversation_id)!.push(l.mcp_server_id); }
  return rows.map((r) => ({
    ...r,
    tools_overridden: !!r.tools_overridden,
    tool_ids: toolMap.get(r.id as string) || [],
    mcp_server_ids: mcpMap.get(r.id as string) || [],
  }));
}

function attachSkillConfig(row: Record<string, unknown>): Record<string, unknown> {
  return attachSkillConfigBatch([row])[0];
}
function attachSkillConfigBatch(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id as string);
  const placeholders = ids.map(() => '?').join(',');
  const skillLinks = db.prepare(`SELECT conversation_id, skill_id FROM conversation_skills WHERE conversation_id IN (${placeholders})`).all(...ids) as { conversation_id: string; skill_id: string }[];
  const skillMap = new Map<string, string[]>();
  for (const l of skillLinks) { if (!skillMap.has(l.conversation_id)) skillMap.set(l.conversation_id, []); skillMap.get(l.conversation_id)!.push(l.skill_id); }
  return rows.map((r) => ({
    ...r,
    skills_overridden: !!r.skills_overridden,
    skill_ids: skillMap.get(r.id as string) || [],
  }));
}

// GET /api/conversations - List conversations, optionally filtered by agent_id
router.get('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { agent_id } = req.query;
    let conversations;

    if (agent_id) {
      conversations = db.prepare(`
        SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
        FROM conversations c
        LEFT JOIN agents a ON c.agent_id = a.id
        WHERE c.user_id = ? AND c.agent_id = ?
        ORDER BY c.updated_at DESC
      `).all(userId, agent_id);
    } else {
      conversations = db.prepare(`
        SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
        FROM conversations c
        LEFT JOIN agents a ON c.agent_id = a.id
        WHERE c.user_id = ?
        ORDER BY c.updated_at DESC
      `).all(userId);
    }

    res.json(attachSkillConfigBatch(attachToolConfigBatch(conversations as Record<string, unknown>[], userId)).map(withParsedProviderRouting));
  } catch (err) {
    console.error('Error listing conversations:', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// POST /api/conversations - Create conversation
router.post('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { agent_id, title } = req.body;

    // If agent_id is provided, validate it exists
    if (agent_id) {
      const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(agent_id, userId);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
    }

    const id = nanoid();
    const conversationTitle = title || (agent_id ? 'New conversation' : 'General Chat');
    // For general chat, set initial model from user's general_chat_model setting so the conversation keeps that model
    const initialModel = !agent_id ? (getSettingValue(userId, 'general_chat_model') || null) : null;
    const initialProviderRouting = !agent_id
      ? serializeProviderRoutingConfig(parseProviderRoutingConfig(getSettingValue(userId, 'general_chat_provider_routing')))
      : null;
    db.prepare(`
      INSERT INTO conversations (id, user_id, agent_id, title, model, provider_routing)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, agent_id || null, conversationTitle, initialModel, initialProviderRouting);

    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ?
    `).get(id);

    res.status(201).json(withParsedProviderRouting(attachSkillConfig(attachToolConfig(conversation as Record<string, unknown>, userId))));
  } catch (err) {
    console.error('Error creating conversation:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// PUT /api/conversations/:id - Update conversation title
router.put('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { title } = req.body;
    db.prepare(`
      UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?
    `).run(title, req.params.id, userId);

    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(withParsedProviderRouting(attachSkillConfig(attachToolConfig(conversation as Record<string, unknown>, userId))));
  } catch (err) {
    console.error('Error updating conversation:', err);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

// PUT /api/conversations/:id/model - Update conversation model override
router.put('/:id/model', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { model } = req.body;

    // Validate model is a string or null
    if (model !== undefined && model !== null && typeof model !== 'string') {
      return res.status(400).json({ error: 'model must be a string or null' });
    }

    const existing = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });

    db.prepare(`
      UPDATE conversations SET model = ?, provider_routing = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?
    `).run(model || null, null, req.params.id, userId);

    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ? AND c.user_id = ?
    `).get(req.params.id, userId);

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(withParsedProviderRouting(attachSkillConfig(attachToolConfig(conversation as Record<string, unknown>, userId))));
  } catch (err) {
    console.error('Error updating conversation model:', err);
    res.status(500).json({ error: 'Failed to update conversation model' });
  }
});

// PUT /api/conversations/:id/provider-routing - Update conversation provider routing override
router.put('/:id/provider-routing', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { provider_routing } = req.body;
    const existing = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });

    const routingInput = normalizeProviderRoutingBody(provider_routing);
    if (routingInput.error) {
      return res.status(400).json({ error: routingInput.error });
    }

    let effectiveModel = typeof existing.model === 'string' && existing.model
      ? existing.model
      : '';
    if (!effectiveModel && typeof existing.agent_id === 'string' && existing.agent_id) {
      const agent = db.prepare('SELECT model FROM agents WHERE id = ? AND user_id = ?').get(existing.agent_id, userId) as { model?: string } | undefined;
      effectiveModel = agent?.model || '';
    }
    if (!effectiveModel) {
      effectiveModel = getSettingValue(userId, 'general_chat_model') || 'openrouter/auto';
    }
    try {
      assertProviderRoutingCompatible(effectiveModel, routingInput.config);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid provider routing' });
    }

    db.prepare(`
      UPDATE conversations SET provider_routing = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?
    `).run(serializeProviderRoutingConfig(routingInput.config), req.params.id, userId);

    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ? AND c.user_id = ?
    `).get(req.params.id, userId);

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(withParsedProviderRouting(attachSkillConfig(attachToolConfig(conversation as Record<string, unknown>, userId))));
  } catch (err) {
    console.error('Error updating conversation provider routing:', err);
    res.status(500).json({ error: 'Failed to update conversation provider routing' });
  }
});

// PUT /api/conversations/:id/tool-config - Set conversation-level tool/MCP override (full replace)
router.put('/:id/tool-config', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { tool_ids, mcp_server_ids } = req.body;

    const ownedToolIds = validateOwnedIds(tool_ids, 'tool_ids', userId);
    if (!ownedToolIds.ok) {
      return res.status(400).json({ error: ownedToolIds.error });
    }
    const ownedMcpServerIds = validateOwnedIds(mcp_server_ids, 'mcp_server_ids', userId);
    if (!ownedMcpServerIds.ok) {
      return res.status(400).json({ error: ownedMcpServerIds.error });
    }

    const existing = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });

    const dedupedToolIds = ownedToolIds.ids;
    const dedupedMcpServerIds = ownedMcpServerIds.ids;

    const run = db.transaction(() => {
      db.prepare(`UPDATE conversations SET tools_overridden = 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(req.params.id, userId);
      db.prepare('DELETE FROM conversation_tools WHERE conversation_id = ?').run(req.params.id);
      for (const toolId of dedupedToolIds) {
        db.prepare('INSERT OR IGNORE INTO conversation_tools (conversation_id, tool_id) VALUES (?, ?)').run(req.params.id, toolId);
      }
      db.prepare('DELETE FROM conversation_mcp_servers WHERE conversation_id = ?').run(req.params.id);
      for (const mcpId of dedupedMcpServerIds) {
        db.prepare('INSERT OR IGNORE INTO conversation_mcp_servers (conversation_id, mcp_server_id) VALUES (?, ?)').run(req.params.id, mcpId);
      }
    });
    run();

    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ? AND c.user_id = ?
    `).get(req.params.id, userId);

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(withParsedProviderRouting(attachSkillConfig(attachToolConfig(conversation as Record<string, unknown>, userId))));
  } catch (err) {
    console.error('Error updating conversation tool config:', err);
    res.status(500).json({ error: 'Failed to update conversation tool config' });
  }
});

// DELETE /api/conversations/:id/tool-config - Clear conversation-level tool/MCP override
router.delete('/:id/tool-config', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const existing = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });

    const run = db.transaction(() => {
      db.prepare(`UPDATE conversations SET tools_overridden = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(req.params.id, userId);
      db.prepare('DELETE FROM conversation_tools WHERE conversation_id = ?').run(req.params.id);
      db.prepare('DELETE FROM conversation_mcp_servers WHERE conversation_id = ?').run(req.params.id);
    });
    run();

    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ? AND c.user_id = ?
    `).get(req.params.id, userId);

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(withParsedProviderRouting(attachSkillConfig(attachToolConfig(conversation as Record<string, unknown>, userId))));
  } catch (err) {
    console.error('Error clearing conversation tool config:', err);
    res.status(500).json({ error: 'Failed to clear conversation tool config' });
  }
});

// PUT /api/conversations/:id/skill-config - Set conversation-level skill override (full replace)
router.put('/:id/skill-config', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { skill_ids } = req.body;

    if (!Array.isArray(skill_ids) || !skill_ids.every((id: unknown) => typeof id === 'string')) {
      return res.status(400).json({ error: 'skill_ids must be an array of strings' });
    }

    const existing = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });

    const dedupedSkillIds = [...new Set(skill_ids as string[])];
    const run = db.transaction(() => {
      db.prepare(`UPDATE conversations SET skills_overridden = 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(req.params.id, userId);
      db.prepare('DELETE FROM conversation_skills WHERE conversation_id = ?').run(req.params.id);
      for (const skillId of dedupedSkillIds) {
        db.prepare('INSERT OR IGNORE INTO conversation_skills (conversation_id, skill_id) VALUES (?, ?)').run(req.params.id, skillId);
      }
    });
    run();

    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ? AND c.user_id = ?
    `).get(req.params.id, userId);

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(withParsedProviderRouting(attachSkillConfig(attachToolConfig(conversation as Record<string, unknown>, userId))));
  } catch (err) {
    console.error('Error updating conversation skill config:', err);
    res.status(500).json({ error: 'Failed to update conversation skill config' });
  }
});

// DELETE /api/conversations/:id/skill-config - Clear conversation-level skill override
router.delete('/:id/skill-config', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const existing = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });

    const run = db.transaction(() => {
      db.prepare(`UPDATE conversations SET skills_overridden = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(req.params.id, userId);
      db.prepare('DELETE FROM conversation_skills WHERE conversation_id = ?').run(req.params.id);
    });
    run();

    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ? AND c.user_id = ?
    `).get(req.params.id, userId);

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(withParsedProviderRouting(attachSkillConfig(attachToolConfig(conversation as Record<string, unknown>, userId))));
  } catch (err) {
    console.error('Error clearing conversation skill config:', err);
    res.status(500).json({ error: 'Failed to clear conversation skill config' });
  }
});

// PUT /api/conversations/:id/active-leaf - Move the active thread cursor
// (message-tree navigation: switch visible variant / continue from any branch)
router.put('/:id/active-leaf', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { message_id } = req.body;

    if (typeof message_id !== 'string' || !message_id.trim()) {
      return res.status(400).json({ error: 'message_id is required' });
    }

    const conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const message = db.prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ?').get(message_id, req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    db.prepare("UPDATE conversations SET active_leaf_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(message_id, req.params.id, userId);
    res.json({ success: true, active_leaf_id: message_id });
  } catch (err) {
    console.error('Error updating active leaf:', err);
    res.status(500).json({ error: 'Failed to update active leaf' });
  }
});

// DELETE /api/conversations/:id - Delete conversation and messages
router.delete('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const existing = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!existing) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting conversation:', err);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

// POST /api/conversations/:id/share - Create (or rotate) a read-only share link
router.post('/:id/share', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const result = createShare(req.params.id, userId);
    switch (result.kind) {
      case 'created':
        // Raw token is returned exactly once (GC6); only its hash is stored.
        return res.status(201).json({ id: result.shareId, token: result.token, created_at: result.createdAt });
      case 'conversation-not-found':
        return res.status(404).json({ error: 'Conversation not found' });
      case 'sharing-disabled-local-mode':
        return res.status(403).json({ error: 'Sharing is disabled in local mode. Sharing requires an account-based deployment.' });
    }
  } catch (err) {
    console.error('Error creating conversation share:', err);
    res.status(500).json({ error: 'Failed to create conversation share' });
  }
});

// GET /api/conversations/:id/share - Share status for the owner (never the raw token)
router.get('/:id/share', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const result = getShareStatus(req.params.id, userId);
    switch (result.kind) {
      case 'active':
        return res.json({ status: 'active', share: { id: result.shareId, created_at: result.createdAt } });
      case 'none':
        return res.json({ status: 'none' });
      case 'conversation-not-found':
        return res.status(404).json({ error: 'Conversation not found' });
    }
  } catch (err) {
    console.error('Error getting conversation share status:', err);
    res.status(500).json({ error: 'Failed to get conversation share status' });
  }
});

// DELETE /api/conversations/:id/share - Revoke the active share link (idempotent)
router.delete('/:id/share', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const result = revokeShare(req.params.id, userId);
    switch (result.kind) {
      case 'revoked':
      case 'none-active': // nothing to revoke is still a success for the caller
        return res.json({ success: true });
      case 'conversation-not-found':
        return res.status(404).json({ error: 'Conversation not found' });
    }
  } catch (err) {
    console.error('Error revoking conversation share:', err);
    res.status(500).json({ error: 'Failed to revoke conversation share' });
  }
});

export default router;
