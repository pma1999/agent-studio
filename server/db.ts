import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '..');
const defaultDbPath = path.join(DB_DIR, 'agent-studio.db');
const DB_PATH = process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : defaultDbPath;
const legacyPath = path.join(DB_DIR, 'kimi-studio.db');

if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

// Optional: rename legacy DB file so existing installs keep their data (skip if file locked)
let dbPathToUse = DB_PATH;
if (!process.env.DATABASE_PATH && fs.existsSync(legacyPath) && !fs.existsSync(DB_PATH)) {
  try {
    fs.renameSync(legacyPath, DB_PATH);
  } catch {
    dbPathToUse = legacyPath;
  }
}

let db: Database.Database;
try {
  db = new Database(dbPathToUse);
} catch {
  if (dbPathToUse === legacyPath) {
    dbPathToUse = DB_PATH;
    db = new Database(DB_PATH);
  } else {
    throw new Error('Cannot open database');
  }
}

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      emoji TEXT DEFAULT '🤖',
      system_prompt TEXT NOT NULL,
      base_url TEXT DEFAULT 'https://openrouter.ai/api/v1',
      model TEXT DEFAULT 'openrouter/auto',
      temperature REAL DEFAULT 0.6,
      max_tokens INTEGER DEFAULT 8192,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT DEFAULT 'New conversation',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
      content TEXT NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  `);

  // Migration: add provider column if it doesn't exist
  const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  const hasProvider = agentColumns.some((col) => col.name === 'provider');
  if (!hasProvider) {
    db.exec("ALTER TABLE agents ADD COLUMN provider TEXT DEFAULT 'openrouter'");
  }

  // Migration: add web_search_enabled column to agents
  const hasWebSearch = agentColumns.some((col) => col.name === 'web_search_enabled');
  if (!hasWebSearch) {
    db.exec("ALTER TABLE agents ADD COLUMN web_search_enabled INTEGER DEFAULT 0");
  }

  // Migration: add reasoning columns to agents
  const agentColNames = new Set(agentColumns.map((c) => c.name));
  if (!agentColNames.has('reasoning_enabled')) {
    db.exec("ALTER TABLE agents ADD COLUMN reasoning_enabled INTEGER DEFAULT 0");
  }
  if (!agentColNames.has('reasoning_effort')) {
    db.exec("ALTER TABLE agents ADD COLUMN reasoning_effort TEXT DEFAULT NULL");
  }
  if (!agentColNames.has('reasoning_max_tokens')) {
    db.exec("ALTER TABLE agents ADD COLUMN reasoning_max_tokens INTEGER DEFAULT NULL");
  }
  if (!agentColNames.has('tool_choice')) {
    db.exec("ALTER TABLE agents ADD COLUMN tool_choice TEXT DEFAULT 'auto'");
  }
  if (!agentColNames.has('parallel_tool_calls')) {
    db.exec("ALTER TABLE agents ADD COLUMN parallel_tool_calls INTEGER DEFAULT 1");
  }
  if (!agentColNames.has('structured_output_enabled')) {
    db.exec("ALTER TABLE agents ADD COLUMN structured_output_enabled INTEGER DEFAULT 0");
  }
  if (!agentColNames.has('structured_output_schema')) {
    db.exec("ALTER TABLE agents ADD COLUMN structured_output_schema TEXT DEFAULT NULL");
  }
  if (!agentColNames.has('response_healing_enabled')) {
    db.exec("ALTER TABLE agents ADD COLUMN response_healing_enabled INTEGER DEFAULT 0");
  }

  // Migration: add cost/usage/reasoning columns to messages
  const msgColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const msgColNames = new Set(msgColumns.map((c) => c.name));

  if (!msgColNames.has('prompt_tokens')) {
    db.exec("ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER DEFAULT 0");
  }
  if (!msgColNames.has('completion_tokens')) {
    db.exec("ALTER TABLE messages ADD COLUMN completion_tokens INTEGER DEFAULT 0");
  }
  if (!msgColNames.has('cost')) {
    db.exec("ALTER TABLE messages ADD COLUMN cost REAL DEFAULT 0");
  }
  if (!msgColNames.has('annotations')) {
    db.exec("ALTER TABLE messages ADD COLUMN annotations TEXT DEFAULT NULL");
  }
  if (!msgColNames.has('reasoning_content')) {
    db.exec("ALTER TABLE messages ADD COLUMN reasoning_content TEXT DEFAULT NULL");
  }
  if (!msgColNames.has('reasoning_tokens')) {
    db.exec("ALTER TABLE messages ADD COLUMN reasoning_tokens INTEGER DEFAULT 0");
  }
  if (!msgColNames.has('cached_tokens')) {
    db.exec("ALTER TABLE messages ADD COLUMN cached_tokens INTEGER DEFAULT 0");
  }

  // --- Tools system: tables and message columns ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      parameters_schema TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('builtin', 'http')),
      config TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_tools (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tools_tool ON agent_tools(tool_id);
  `);

  // MCP servers and agent-MCP links
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK(transport IN ('url', 'stdio')),
      config TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_mcp_servers (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, mcp_server_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_agent ON agent_mcp_servers(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_mcp ON agent_mcp_servers(mcp_server_id);
  `);

  // Messages: allow role 'tool' and add tool_call_id, tool_calls (SQLite cannot alter CHECK)
  const msgColsAfter = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const msgColSet = new Set(msgColsAfter.map((c) => c.name));
  const hasToolCallId = msgColSet.has('tool_call_id');
  const hasToolCalls = msgColSet.has('tool_calls');

  // Recreate messages table to allow role 'tool' and ensure tool columns exist
  const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get() as { sql: string } | undefined;
  const checkHasToolRole = tableInfo?.sql?.includes("'tool'") ?? false;
  if (!checkHasToolRole || !hasToolCallId || !hasToolCalls) {
    db.exec(`
      CREATE TABLE messages_new (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL DEFAULT '',
        tokens_used INTEGER DEFAULT 0,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        annotations TEXT DEFAULT NULL,
        reasoning_content TEXT DEFAULT NULL,
        reasoning_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        tool_call_id TEXT DEFAULT NULL,
        tool_calls TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    if (hasToolCallId && hasToolCalls) {
      db.exec(`INSERT INTO messages_new SELECT id, conversation_id, role, COALESCE(content,''), tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, tool_call_id, tool_calls, created_at FROM messages`);
    } else {
      db.exec(`INSERT INTO messages_new (id, conversation_id, role, content, tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, tool_call_id, tool_calls, created_at)
        SELECT id, conversation_id, role, COALESCE(content,''), tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, NULL, NULL, created_at FROM messages`);
    }
    db.exec(`DROP TABLE messages`);
    db.exec(`ALTER TABLE messages_new RENAME TO messages`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)`);
  }

  // Migration: add attachments column for PDF (and other file) metadata on user messages
  const msgColsFinal = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const msgColSetFinal = new Set(msgColsFinal.map((c) => c.name));
  if (!msgColSetFinal.has('attachments')) {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT DEFAULT NULL");
  }

  // Seed builtin tools if none exist
  const toolsCount = db.prepare('SELECT COUNT(*) as cnt FROM tools').get() as { cnt: number };
  if (toolsCount.cnt === 0) {
    const { nanoid } = await_nanoid();
    const webSearchId = nanoid();
    const getTimeId = nanoid();
    db.prepare(`
      INSERT INTO tools (id, name, description, parameters_schema, type, config)
      VALUES (?, 'web_search', ?, ?, 'builtin', ?)
    `).run(
      webSearchId,
      'Search the web for current information. Use when the user asks about recent events, facts, or when you need up-to-date or external information.',
      JSON.stringify({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Max results (default 5)', default: 5 },
        },
        required: ['query'],
      }),
      JSON.stringify({ provider: 'exa' })
    );
    db.prepare(`
      INSERT INTO tools (id, name, description, parameters_schema, type, config)
      VALUES (?, 'get_current_time', ?, ?, 'builtin', NULL)
    `).run(
      getTimeId,
      'Get the current date and time in ISO 8601 format. Use when the user asks for the current time, date, or timezone.',
      JSON.stringify({ type: 'object', properties: {}, required: [] })
    );
  }

  // Migrate web_search_enabled -> agent_tools: for each agent with web_search_enabled=1, add web_search tool
  const webSearchTool = db.prepare("SELECT id FROM tools WHERE name = 'web_search'").get() as { id: string } | undefined;
  if (webSearchTool) {
    const agentsWithWeb = db.prepare("SELECT id FROM agents WHERE web_search_enabled = 1").all() as { id: string }[];
    for (const a of agentsWithWeb) {
      const exists = db.prepare('SELECT 1 FROM agent_tools WHERE agent_id = ? AND tool_id = ?').get(a.id, webSearchTool.id);
      if (!exists) {
        db.prepare('INSERT OR IGNORE INTO agent_tools (agent_id, tool_id) VALUES (?, ?)').run(a.id, webSearchTool.id);
      }
    }
  }

  // Migration: convert any legacy provider to OpenRouter
  db.prepare(`
    UPDATE agents SET provider = 'openrouter', base_url = 'https://openrouter.ai/api/v1', model = 'openrouter/auto'
    WHERE provider != 'openrouter' OR provider IS NULL
  `).run();

  // Seed default agent if none exist
  const count = db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as { cnt: number };
  if (count.cnt === 0) {
    const { nanoid } = await_nanoid();
    db.prepare(`
      INSERT INTO agents (id, name, description, emoji, system_prompt, base_url, model, temperature, max_tokens, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nanoid(),
      'AI Assistant',
      'A versatile AI assistant. Great for general conversations, brainstorming, and creative tasks. Uses OpenRouter for access to many models.',
      '✨',
      'You are a helpful, creative, and knowledgeable AI assistant. You provide thoughtful, well-structured responses. You are conversational and friendly while maintaining depth and accuracy. When asked about code, you explain clearly. When asked about creative topics, you are imaginative and inspiring.',
      'https://openrouter.ai/api/v1',
      'openrouter/auto',
      0.7,
      4096,
      'openrouter'
    );
  }

  // --- Multi-tenant: users table and user_id on all data tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);

  let defaultUserId: string | null = (db.prepare("SELECT id FROM users WHERE email = 'local@localhost'").get() as { id: string } | undefined)?.id ?? null;
  if (!defaultUserId) {
    const { nanoid } = await_nanoid();
    defaultUserId = nanoid();
    const placeholderHash = '$2b$10$placeholder.hash.for.migration.only';
    try {
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync('changeme', 10);
      db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(defaultUserId, 'local@localhost', hash);
    } catch {
      db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(defaultUserId, 'local@localhost', placeholderHash);
    }
  }

  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!agentCols.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE agents ADD COLUMN user_id TEXT');
    db.prepare('UPDATE agents SET user_id = ? WHERE user_id IS NULL').run(defaultUserId);
    db.exec('CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id)');
  }

  const convCols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!convCols.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN user_id TEXT');
    db.prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL').run(defaultUserId);
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
  }

  const toolCols = db.prepare("PRAGMA table_info(tools)").all() as { name: string }[];
  if (!toolCols.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE tools ADD COLUMN user_id TEXT');
    db.prepare('UPDATE tools SET user_id = ? WHERE user_id IS NULL').run(defaultUserId);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tools_user_id ON tools(user_id)');
  }

  const mcpCols = db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[];
  if (!mcpCols.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE mcp_servers ADD COLUMN user_id TEXT');
    db.prepare('UPDATE mcp_servers SET user_id = ? WHERE user_id IS NULL').run(defaultUserId);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_servers_user_id ON mcp_servers(user_id)');
  }

  // Settings: migrate from (key, value) to (user_id, key, value)
  const settingsInfo = db.prepare("PRAGMA table_info(settings)").all() as { name: string }[];
  const settingsHasUserId = settingsInfo.some((c) => c.name === 'user_id');
  if (!settingsHasUserId) {
    db.exec(`
      CREATE TABLE settings_new (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (user_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_settings_new_user_id ON settings_new(user_id);
    `);
    db.prepare('INSERT INTO settings_new (user_id, key, value) SELECT ?, key, value FROM settings').run(defaultUserId);
    db.exec('DROP TABLE settings');
    db.exec('ALTER TABLE settings_new RENAME TO settings');
  }

  // Initial admin user for deployment: create or update from INITIAL_ADMIN_PASSWORD
  const INITIAL_ADMIN_EMAIL = 'pablomiguelargudo@gmail.com';
  const adminPasswordEnv = process.env.INITIAL_ADMIN_PASSWORD;
  const adminPasswordSet = typeof adminPasswordEnv === 'string' && adminPasswordEnv.length >= 8;

  const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(INITIAL_ADMIN_EMAIL) as { id: string } | undefined;

  if (existingAdmin && adminPasswordSet) {
    try {
      const bcrypt = require('bcrypt');
      const password_hash = bcrypt.hashSync(adminPasswordEnv, 12);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, existingAdmin.id);
      console.log('[Agent Studio] Initial admin password updated from INITIAL_ADMIN_PASSWORD.');
    } catch (e) {
      console.error('[Agent Studio] Failed to update initial admin password:', e);
    }
  } else if (!existingAdmin && defaultUserId) {
    const { nanoid } = await_nanoid();
    const newAdminId = nanoid();
    const rawPassword = adminPasswordSet ? adminPasswordEnv! : crypto.randomBytes(16).toString('base64url');
    try {
      const bcrypt = require('bcrypt');
      const password_hash = bcrypt.hashSync(rawPassword, 12);
      db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(newAdminId, INITIAL_ADMIN_EMAIL, password_hash);
      db.prepare('UPDATE agents SET user_id = ? WHERE user_id = ?').run(newAdminId, defaultUserId);
      db.prepare('UPDATE conversations SET user_id = ? WHERE user_id = ?').run(newAdminId, defaultUserId);
      db.prepare('UPDATE settings SET user_id = ? WHERE user_id = ?').run(newAdminId, defaultUserId);
      db.prepare('UPDATE tools SET user_id = ? WHERE user_id = ?').run(newAdminId, defaultUserId);
      db.prepare('UPDATE mcp_servers SET user_id = ? WHERE user_id = ?').run(newAdminId, defaultUserId);
      console.log('[Agent Studio] Initial admin created: ' + INITIAL_ADMIN_EMAIL);
      if (!adminPasswordSet) {
        console.log('[Agent Studio] One-time password (save it, then change after first login): ' + rawPassword);
      }
    } catch (e) {
      console.error('[Agent Studio] Failed to create initial admin:', e);
    }
  }
}

// Synchronous nanoid workaround for seeding
function await_nanoid() {
  let id = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  for (let i = 0; i < 21; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return { nanoid: () => id };
}

export default db;
