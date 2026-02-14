import { Router, Response } from 'express';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';

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
      SELECT * FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `).all(req.params.id) as Record<string, unknown>[];

    // Parse JSON columns (annotations, tool_calls, attachments)
    const parsed = messages.map((msg) => ({
      ...msg,
      annotations: msg.annotations ? JSON.parse(msg.annotations as string) : null,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls as string) : null,
      attachments: msg.attachments ? JSON.parse(msg.attachments as string) : null,
    }));

    res.json(parsed);
  } catch (err) {
    console.error('Error listing messages:', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

export default router;
