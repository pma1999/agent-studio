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

// Trust proxy (Railway, Vercel, etc.) so rate limit and X-Forwarded-* work
app.set('trust proxy', 1);

// CORS: restrict origin in production. Set CORS_ORIGIN (comma-separated) on Railway.
const corsOrigin = process.env.CORS_ORIGIN;
const origin = corsOrigin
  ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
  : true; // allow all in development
app.use(cors({ origin, credentials: true }));

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

migrate();
const server = app.listen(PORT, () => {
  console.log(`[server] Agent Studio server running on http://localhost:${PORT}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`[server] Port ${PORT} is in use. Close the other process and try again.\n`);
  } else {
    process.stderr.write('[server] ' + String(err) + '\n');
  }
  process.exit(1);
});
