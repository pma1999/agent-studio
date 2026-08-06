/**
 * ChatGPT provider routes: connection status, device-code login ceremony,
 * logout, and the Codex model catalog.
 *
 * The heavy lifting lives in server/codex/instanceManager.ts (per-user
 * app-server processes). These routes are the thin HTTP surface the frontend
 * talks to.
 */

import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';
import {
  isUserAllowed,
  startChatgptLogin,
  cancelChatgptLogin,
  logoutChatgpt,
  getChatgptStatus,
  listChatgptModels,
  CodexForbiddenError,
  CodexUnavailableError,
} from '../codex/instanceManager.js';

const router = Router();

function codexErrorStatus(err: unknown): number {
  if (err instanceof CodexForbiddenError) return 403;
  return 400;
}

function codexErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// GET /api/chatgpt/status - account + rate-limit state (also tells the UI whether the provider is enabled)
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const status = await getChatgptStatus(userId);
    res.json(status);
  } catch (err) {
    res.status(codexErrorStatus(err)).json({ error: codexErrorMessage(err) });
  }
});

// POST /api/chatgpt/login - start the ChatGPT device-code sign-in
router.post('/login', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const pending = await startChatgptLogin(userId);
    res.json(pending);
  } catch (err) {
    res.status(codexErrorStatus(err)).json({ error: codexErrorMessage(err) });
  }
});

// POST /api/chatgpt/cancel - abort a pending sign-in
router.post('/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    await cancelChatgptLogin(userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(codexErrorStatus(err)).json({ error: codexErrorMessage(err) });
  }
});

// POST /api/chatgpt/logout - disconnect the ChatGPT account and reap the process
router.post('/logout', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!isUserAllowed(userId)) throw new CodexForbiddenError();
    await logoutChatgpt(userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(codexErrorStatus(err)).json({ error: codexErrorMessage(err) });
  }
});

// GET /api/chatgpt/models - models available to the connected ChatGPT account (namespaced codex:)
router.get('/models', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const models = await listChatgptModels(userId);
    res.json({ data: models });
  } catch (err) {
    res.status(codexErrorStatus(err)).json({ error: codexErrorMessage(err) });
  }
});

export default router;
