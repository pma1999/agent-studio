import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import db, { migrate } from './db.js';
import { authMiddleware } from './middleware/auth.js';
import { setupGracefulShutdown, isShuttingDown } from './shutdown.js';
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
import skillsRouter from './routes/skills.js';
import { exportRouter, importRouter } from './routes/exportImport.js';
import chatCouncilRouter from './routes/chatCouncil.js';
import councilMembersRouter from './routes/councilMembers.js';
import { mountWsProbe } from './routes/agentProbe.js';
import agentRouter, { mountAgentTransport } from './routes/agent.js';
import agentFilesRouter from './routes/agentFiles.js';
import { startAgentFileSweep } from './agentFiles/storage.js';

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
const councilLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Stricter limit for council (expensive operation)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many council requests. Try again in a few minutes.' },
});

app.use('/api', apiLimiter);
app.use('/api/chat', chatLimiter);
app.use('/api/chat/council', councilLimiter);

// Reject new requests during shutdown so Railway routes them to the new instance.
app.use((req, res, next) => {
  if (isShuttingDown()) {
    res.setHeader('Connection', 'close');
    res.status(503).json({ error: 'Server is restarting. Please retry in a moment.' });
    return;
  }
  next();
});

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
app.use('/api/skills', authMiddleware, skillsRouter);
app.use('/api/export', authMiddleware, exportRouter);
app.use('/api/import', authMiddleware, importRouter);
app.use('/api/chat/council', authMiddleware, chatCouncilRouter);
app.use('/api/council', authMiddleware, councilMembersRouter);
app.use('/api/agent/files', agentFilesRouter);
app.use('/api/agent', agentRouter);

// Root: for load balancer / health probes that hit /
app.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'agent-studio-api' });
});

// Health check (Railway and others) — returns 503 during shutdown so the
// load balancer stops routing traffic to this instance.
app.get('/api/health', (_req, res) => {
  if (isShuttingDown()) {
    res.status(503).json({ status: 'shutting_down', timestamp: new Date().toISOString() });
    return;
  }
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

try {
  migrate();
} catch (err) {
  console.error('[server] Migration failed:', err);
  process.exit(1);
}
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Agent Studio server running on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown: handles SIGTERM/SIGINT, drains SSE streams, closes DB.
setupGracefulShutdown(server, db);
mountAgentTransport(server);
startAgentFileSweep();

// Temporary WebSocket viability probe (task-04) — off unless explicitly enabled.
if (process.env.ENABLE_WS_PROBE === 'true') {
  mountWsProbe(server);
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`[server] Port ${PORT} is in use. Close the other process and try again.\n`);
  } else {
    process.stderr.write('[server] ' + String(err) + '\n');
  }
  process.exit(1);
});
