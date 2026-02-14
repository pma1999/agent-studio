import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { migrate } from './db.js';
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

// #region agent log
const DEBUG_LOG = (payload: { location: string; message: string; data?: Record<string, unknown>; hypothesisId?: string; runId?: string }) => {
  const body = { ...payload, timestamp: Date.now() };
  fetch('http://127.0.0.1:7242/ingest/9c157064-d6b8-432a-a01b-6edcc79b3bd4', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
};
// #endregion

// Trust proxy (Railway, Vercel, etc.) so rate limit and X-Forwarded-* work
app.set('trust proxy', 1);

// CORS: allow origin from CORS_ORIGIN (comma-separated). Required in production for Vercel frontend.
const corsOriginRaw = process.env.CORS_ORIGIN ?? '';
const allowedOrigins = corsOriginRaw
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);
// #region agent log
DEBUG_LOG({ location: 'server/index.ts:startup', message: 'CORS config', data: { corsOriginSet: corsOriginRaw.length > 0, allowedOrigins, allowedCount: allowedOrigins.length }, hypothesisId: 'H1' });
console.log('[CORS-DEBUG] startup', JSON.stringify({ corsOriginSet: corsOriginRaw.length > 0, allowedOrigins, allowedCount: allowedOrigins.length }));
// #endregion
const corsOptions: cors.CorsOptions = {
  origin: allowedOrigins.length > 0
    ? (origin, cb) => {
        // #region agent log
        const allowed = !!(origin && allowedOrigins.includes(origin));
        DEBUG_LOG({ location: 'server/index.ts:cors-callback', message: 'CORS origin check', data: { origin: origin ?? '(undefined)', allowed, allowedOrigins }, hypothesisId: 'H1,H4,H5' });
        console.log('[CORS-DEBUG] origin check', JSON.stringify({ origin: origin ?? '(undefined)', allowed, allowedOrigins }));
        // #endregion
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
// #region agent log
app.use((req, _res, next) => {
  DEBUG_LOG({ location: 'server/index.ts:request', message: 'incoming request', data: { method: req.method, path: req.path, origin: req.headers.origin ?? '(none)' }, hypothesisId: 'H2,H3,H4' });
  console.log('[CORS-DEBUG] request', JSON.stringify({ method: req.method, path: req.path, origin: req.headers.origin ?? '(none)' }));
  next();
});
// #endregion

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

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  migrate();
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
