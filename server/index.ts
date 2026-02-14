import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import db, { migrate } from './db.js';
import { authMiddleware } from './middleware/auth.js';
import authRouter from './routes/auth.js';
import agentsRouter from './routes/agents.js';
import conversationsRouter from './routes/conversations.js';
import messagesRouter from './routes/messages.js';
import chatRouter from './routes/chat.js';
import settingsRouter from './routes/settings.js';
import modelsRouter from './routes/models.js';
import creditsRouter from './routes/credits.js';
import usageRouter from './routes/usage.js';
import toolsRouter from './routes/tools.js';
import mcpServersRouter from './routes/mcpServers.js';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

// Trust proxy (Railway, Vercel, etc.) so rate limit and X-Forwarded-* work
app.set('trust proxy', 1);

// CORS: allow origin from CORS_ORIGIN (comma-separated). Required in production for Vercel frontend.
const corsOriginRaw = process.env.CORS_ORIGIN ?? '';
const allowedOrigins = corsOriginRaw
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);
const corsOptions: cors.CorsOptions = {
  origin: allowedOrigins.length > 0
    ? (origin, cb) => {
        if (origin && allowedOrigins.includes(origin)) {
          cb(null, true);
        } else {
          cb(null, false);
        }
      }
    : true, // no CORS_ORIGIN = allow any (dev only)
  credentials: true,
  optionsSuccessStatus: 204,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));

// Rate limits
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat messages. Try again in a few minutes.' },
});

app.use('/api', apiLimiter);
app.use('/api/chat', chatLimiter);

app.use(express.json({ limit: '30mb' })); // allow PDF base64 in chat (backend validates max 20MB per file)
app.use(cookieParser());

// Public routes (no auth)
app.use('/api/auth', authRouter);

// Protected API routes (auth required when JWT_SECRET set; else default user)
app.use('/api/agents', authMiddleware, agentsRouter);
app.use('/api/conversations', authMiddleware, conversationsRouter);
app.use('/api/conversations', authMiddleware, messagesRouter); // same base path, different routes (e.g. /:id/messages)
app.use('/api/chat', authMiddleware, chatRouter);
app.use('/api/settings', authMiddleware, settingsRouter);
app.use('/api/models', authMiddleware, modelsRouter);
app.use('/api/credits', authMiddleware, creditsRouter);
app.use('/api/usage', authMiddleware, usageRouter);
app.use('/api/tools', authMiddleware, toolsRouter);
app.use('/api/mcp-servers', authMiddleware, mcpServersRouter);

// Root: for load balancer / health probes that hit /
app.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'agent-studio-api' });
});

// Health check (Railway and others)
app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug: what the server actually sees in its DB (remove after fixing)
app.get('/api/debug/db-check', (_req, res) => {
  try {
    const users = db.prepare('SELECT id, email FROM users ORDER BY email').all() as { id: string; email: string }[];
    const agentCounts = db.prepare(`
      SELECT u.email, COUNT(a.id) as count
      FROM users u LEFT JOIN agents a ON a.user_id = u.id
      GROUP BY u.id
    `).all() as { email: string; count: number }[];
    const admin = users.find((u) => u.email === 'pablomiguelargudo@gmail.com');
    const agentsForAdmin = admin
      ? (db.prepare('SELECT id, name, user_id FROM agents WHERE user_id = ?').all(admin.id) as { id: string; name: string; user_id: string }[])
      : [];
    res.json({
      hint: 'Server DB state (remove /api/debug/db-check after debugging)',
      env_DATABASE_PATH: process.env.DATABASE_PATH ?? '(not set – server uses default path, not /data)',
      users: users.map((u) => ({ email: u.email, id: u.id })),
      agents_per_user: agentCounts,
      admin_user_id: admin?.id ?? null,
      agents_for_admin_count: agentsForAdmin.length,
      agents_for_admin: agentsForAdmin.map((a) => ({ id: a.id, name: a.name })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  setImmediate(() => {
    try {
      migrate();
    } catch (err) {
      console.error('[server] Migration failed:', err);
    }
  });
  console.log(`[server] Agent Studio server running on http://0.0.0.0:${PORT}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`[server] Port ${PORT} is in use. Close the other process and try again.\n`);
  } else {
    process.stderr.write('[server] ' + String(err) + '\n');
  }
  process.exit(1);
});
