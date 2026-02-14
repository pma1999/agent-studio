import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { authMiddleware, AuthRequest, COOKIE_NAME } from '../middleware/auth.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET;
const DISABLE_AUTH = process.env.DISABLE_AUTH === 'true' || process.env.DISABLE_AUTH === '1';

// POST /api/auth/register
router.post('/register', (req: Request, res: Response) => {
  if (DISABLE_AUTH || !JWT_SECRET) {
    return res.status(400).json({ error: 'Registration is disabled' });
  }

  const { email, password } = req.body;
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const emailTrimmed = email.trim().toLowerCase();
  if (!emailTrimmed || emailTrimmed.length < 3) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailTrimmed);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const id = nanoid();
    const password_hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, emailTrimmed, password_hash);

    // Seed builtin tools for the new user (copy from default user)
    const defaultUser = db.prepare("SELECT id FROM users WHERE email = 'local@localhost' LIMIT 1").get() as { id: string } | undefined;
    if (defaultUser) {
      const builtins = db.prepare("SELECT id, name, description, parameters_schema, type, config FROM tools WHERE user_id = ? AND type = 'builtin'").all(defaultUser.id) as { id: string; name: string; description: string; parameters_schema: string; type: string; config: string | null }[];
      for (const t of builtins) {
        const newToolId = nanoid();
        db.prepare('INSERT INTO tools (id, user_id, name, description, parameters_schema, type, config) VALUES (?, ?, ?, ?, ?, ?, ?)').run(newToolId, id, t.name, t.description, t.parameters_schema, t.type, t.config);
      }
    }

    const token = jwt.sign({ sub: id }, JWT_SECRET, { expiresIn: '7d' });
    const crossOrigin = process.env.NODE_ENV === 'production' || !!process.env.CORS_ORIGIN;
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: crossOrigin,
      sameSite: crossOrigin ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.status(201).json({ token, user: { id, email: emailTrimmed } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', (req: Request, res: Response) => {
  if (DISABLE_AUTH || !JWT_SECRET) {
    return res.status(400).json({ error: 'Login is disabled' });
  }

  const { email, password } = req.body;
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const emailTrimmed = email.trim().toLowerCase();
  try {
    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(emailTrimmed) as
      | { id: string; email: string; password_hash: string }
      | undefined;
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '7d' });
    const crossOrigin = process.env.NODE_ENV === 'production' || !!process.env.CORS_ORIGIN;
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: crossOrigin,
      sameSite: crossOrigin ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (_req: Request, res: Response) => {
  const crossOrigin = process.env.NODE_ENV === 'production' || !!process.env.CORS_ORIGIN;
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: crossOrigin,
    sameSite: crossOrigin ? 'none' : 'lax',
    maxAge: 0,
  });
  res.json({ success: true });
});

// GET /api/auth/me - current user (requires auth when JWT_SECRET set)
router.get('/me', authMiddleware, (req: AuthRequest, res: Response) => {
  if (!req.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const user = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(req.userId) as
      | { id: string; email: string; created_at: string }
      | undefined;
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ id: user.id, email: user.email, created_at: user.created_at });
  } catch (err) {
    console.error('Auth me error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
