import { Router, Response } from 'express';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';

const router = Router();

// GET /api/usage/stats - Aggregate usage statistics (user's conversations only)
router.get('/stats', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const stats = db.prepare(`
      SELECT
        COALESCE(SUM(m.cost), 0) as total_cost,
        COALESCE(SUM(m.prompt_tokens), 0) as total_prompt_tokens,
        COALESCE(SUM(m.completion_tokens), 0) as total_completion_tokens,
        COALESCE(SUM(m.cached_tokens), 0) as total_cached_tokens,
        COUNT(*) as total_messages
      FROM messages m
      INNER JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role = 'assistant' AND c.user_id = ?
    `).get(userId) as {
      total_cost: number;
      total_prompt_tokens: number;
      total_completion_tokens: number;
      total_cached_tokens: number;
      total_messages: number;
    };

    res.json(stats);
  } catch (err) {
    console.error('Usage stats error:', err);
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

export default router;
