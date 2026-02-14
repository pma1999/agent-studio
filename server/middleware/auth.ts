import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import db, { ensureLocalUser } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET;
const DISABLE_AUTH = process.env.DISABLE_AUTH === 'true' || process.env.DISABLE_AUTH === '1';

export interface AuthRequest extends Request {
  userId?: string;
}

const COOKIE_NAME = 'agent_studio_token';

export function getTokenFromRequest(req: Request): string | null {
  const cookie = req.cookies?.[COOKIE_NAME];
  if (cookie && typeof cookie === 'string') return cookie;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  if (DISABLE_AUTH || !JWT_SECRET) {
    let row = db.prepare("SELECT id FROM users WHERE email = 'local@localhost' LIMIT 1").get() as { id: string } | undefined;
    if (!row?.id) {
      const localId = ensureLocalUser();
      if (localId) row = { id: localId };
    }
    req.userId = row?.id ?? undefined;
    next();
    return;
  }

  const token = getTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    if (!payload.sub) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  if (DISABLE_AUTH || !JWT_SECRET) {
    let row = db.prepare("SELECT id FROM users WHERE email = 'local@localhost' LIMIT 1").get() as { id: string } | undefined;
    if (!row?.id) {
      const localId = ensureLocalUser();
      if (localId) row = { id: localId };
    }
    req.userId = row?.id ?? undefined;
    next();
    return;
  }

  const token = getTokenFromRequest(req);
  if (!token) {
    delete req.userId;
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    req.userId = payload.sub || undefined;
  } catch {
    delete req.userId;
  }
  next();
}

export { COOKIE_NAME };
