import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
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

    res.json((conversations as Record<string, unknown>[]).map(withParsedProviderRouting));
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

    res.status(201).json(withParsedProviderRouting(conversation as Record<string, unknown>));
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
    res.json(withParsedProviderRouting(conversation as Record<string, unknown>));
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
    res.json(withParsedProviderRouting(conversation as Record<string, unknown>));
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
    res.json(withParsedProviderRouting(conversation as Record<string, unknown>));
  } catch (err) {
    console.error('Error updating conversation provider routing:', err);
    res.status(500).json({ error: 'Failed to update conversation provider routing' });
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

export default router;
