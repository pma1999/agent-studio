import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';
import { getArtifact, listConversationArtifacts } from '../artifacts/storage.js';

const router = Router();

// GET /api/conversations/:id/artifacts  (mounted at /api/conversations -> path /:id/artifacts)
router.get('/:id/artifacts', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const artifacts = listConversationArtifacts(req.params.id, userId);
    res.json({ artifacts });
  } catch (err) {
    if (err instanceof Error && err.message === 'conversation not found') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    console.error('Error listing artifacts:', err);
    res.status(500).json({ error: 'Failed to list artifacts' });
  }
});

// GET /api/artifacts/:id  (mounted at /api/artifacts -> path /:id)
router.get('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const artifact = getArtifact(req.params.id, userId);
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    res.json(artifact);
  } catch (err) {
    console.error('Error getting artifact:', err);
    res.status(500).json({ error: 'Failed to get artifact' });
  }
});

export default router;
