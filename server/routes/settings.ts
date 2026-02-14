import { Router, Response } from 'express';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
import { encrypt, isSensitive, maskValue, decryptSetting } from '../crypto.js';

const router = Router();

function paramKey(params: { key?: string | string[] }): string {
  const k = params.key;
  return Array.isArray(k) ? (k[0] ?? '') : (k ?? '');
}

// GET /api/settings/:key
router.get('/:key', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const key = paramKey(req.params);
    const row = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key) as
      | { value: string }
      | undefined;
    const raw = row?.value ?? null;
    if (raw != null && isSensitive(key)) {
      return res.json({ key, value: maskValue(raw), masked: true });
    }
    res.json({ key, value: raw });
  } catch (err) {
    console.error('Error getting setting:', err);
    res.status(500).json({ error: 'Failed to get setting' });
  }
});

// PUT /api/settings/:key
router.put('/:key', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { value } = req.body as { value?: string };
    const key = paramKey(req.params);
    const toStore = typeof value === 'string' && isSensitive(key) ? encrypt(value) : (value ?? '');
    db.prepare(`
      INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
    `).run(userId, key, toStore);
    if (isSensitive(key)) {
      return res.json({ key, value: maskValue(value), masked: true });
    }
    res.json({ key, value: value ?? '' });
  } catch (err) {
    console.error('Error updating setting:', err);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// GET /api/settings - Get all settings (sensitive keys masked)
router.get('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const rows = db.prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId) as {
      key: string;
      value: string;
    }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = isSensitive(row.key) ? maskValue(row.value) : row.value;
    }
    res.json(settings);
  } catch (err) {
    console.error('Error listing settings:', err);
    res.status(500).json({ error: 'Failed to list settings' });
  }
});

export default router;

export function getSettingValue(userId: string, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key) as
    | { value: string }
    | undefined;
  const raw = row?.value ?? '';
  return decryptSetting(raw, key);
}
