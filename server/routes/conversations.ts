import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';

const router = Router();

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

    res.json(conversations);
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
    db.prepare(`
      INSERT INTO conversations (id, user_id, agent_id, title)
      VALUES (?, ?, ?, ?)
    `).run(id, userId, agent_id || null, conversationTitle);

    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ?
    `).get(id);

    res.status(201).json(conversation);
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
    res.json(conversation);
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

    db.prepare(`
      UPDATE conversations SET model = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?
    `).run(model || null, req.params.id, userId);

    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.emoji as agent_emoji
      FROM conversations c
      LEFT JOIN agents a ON c.agent_id = a.id
      WHERE c.id = ? AND c.user_id = ?
    `).get(req.params.id, userId);

    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conversation);
  } catch (err) {
    console.error('Error updating conversation model:', err);
    res.status(500).json({ error: 'Failed to update conversation model' });
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
