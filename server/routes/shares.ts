import { Router, Request, Response } from 'express';
import { resolveShareToken } from '../shares/service.js';

const router = Router();

// GET /api/shares/:token - Public read-only share resolution (no auth; the
// unguessable token IS the credential). Mounted in server/index.ts beside the
// other public routes and inherits apiLimiter.
//
// GC7/GC8: every response — success, 404, or 500 — is marked no-store/private
// and noindex, and unknown/revoked/corrupt tokens get one uniform 404 so the
// endpoint is not an existence oracle.
router.get('/:token', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Robots-Tag', 'noindex');
  try {
    const result = resolveShareToken(req.params.token);
    if (result.kind === 'not-found') {
      return res.status(404).json({ error: 'Share not found' });
    }
    return res.json(result.snapshot);
  } catch (err) {
    console.error('Error resolving shared conversation:', err);
    res.status(500).json({ error: 'Failed to load shared conversation' });
  }
});

export default router;
