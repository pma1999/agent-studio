import { Router, Response } from 'express';
import { getSettingValue } from './settings.js';
import { AuthRequest } from '../middleware/auth.js';

const router = Router();

// GET /api/credits - Fetch OpenRouter credits/usage info
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const apiKey = getSettingValue(userId, 'openrouter_api_key');
    if (!apiKey?.trim()) {
      return res.status(400).json({ error: 'OpenRouter API key not configured' });
    }

    const response = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `OpenRouter API error: ${errorText}` });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Credits fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch credits information' });
  }
});

export default router;
