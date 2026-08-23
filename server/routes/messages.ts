import { Router, Response } from 'express';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
import { parseProviderRoutingConfig } from '../providerRouting.js';

const router = Router();

// GET /api/conversations/:id/messages - Get all messages for a conversation
router.get('/:id/messages', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = db.prepare(`
      SELECT m.*, a.name as processed_by_agent_name
      FROM messages m
      LEFT JOIN agents a ON m.processed_by_agent_id = a.id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
    `).all(req.params.id) as Record<string, unknown>[];

    // Parse JSON columns (annotations, tool_calls, attachments)
    const parsed = messages.map((msg) => ({
      ...msg,
      annotations: msg.annotations ? JSON.parse(msg.annotations as string) : null,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls as string) : null,
      attachments: msg.attachments ? JSON.parse(msg.attachments as string) : null,
      provider_routing: parseProviderRoutingConfig(msg.provider_routing),
    }));

    // Deliberate contract change: the flat array becomes { messages, active_leaf_id }
    // so the client can render the thread tree (editing / variants / branches).
    // active_turn_id (plan.md S6) is additive and optional for poll-based reopen
    // reconciliation; null whenever no turn is live.
    res.json({
      messages: parsed,
      active_leaf_id: (conversation as { active_leaf_id?: string | null }).active_leaf_id ?? null,
      active_turn_id: (conversation as { active_turn_id?: string | null }).active_turn_id ?? null,
    });
  } catch (err) {
    console.error('Error listing messages:', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

export default router;
