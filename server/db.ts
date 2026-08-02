import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { backfillMessageTree } from './messageTree.js';

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

export const DB_DIRECTORY = path.dirname(dbPathToUse);

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
      provider_routing TEXT DEFAULT NULL,
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
      provider_routing TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
      content TEXT NOT NULL,
      provider_routing TEXT DEFAULT NULL,
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
  if (!agentColNames.has('provider_routing')) {
    db.exec("ALTER TABLE agents ADD COLUMN provider_routing TEXT DEFAULT NULL");
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
      transport TEXT NOT NULL CHECK(transport IN ('url', 'stdio', 'relay')),
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
        provider_routing TEXT DEFAULT NULL,
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
      db.exec(`INSERT INTO messages_new (id, conversation_id, role, content, provider_routing, tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, tool_call_id, tool_calls, created_at)
        SELECT id, conversation_id, role, COALESCE(content,''), NULL, tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, tool_call_id, tool_calls, created_at FROM messages`);
    } else {
      db.exec(`INSERT INTO messages_new (id, conversation_id, role, content, provider_routing, tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, tool_call_id, tool_calls, created_at)
        SELECT id, conversation_id, role, COALESCE(content,''), NULL, tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, NULL, NULL, created_at FROM messages`);
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

  // Migration: add model column to messages for per-message model tracking
  if (!msgColSetFinal.has('model')) {
    db.exec("ALTER TABLE messages ADD COLUMN model TEXT DEFAULT NULL");
  }
  if (!msgColSetFinal.has('provider_routing')) {
    db.exec("ALTER TABLE messages ADD COLUMN provider_routing TEXT DEFAULT NULL");
  }

  // Seed builtin tools if none exist (each call to await_nanoid() returns a new id)
  const toolsCount = db.prepare('SELECT COUNT(*) as cnt FROM tools').get() as { cnt: number };
  if (toolsCount.cnt === 0) {
    const webSearchId = await_nanoid().nanoid();
    const getTimeId = await_nanoid().nanoid();
    const webFetchId = await_nanoid().nanoid();
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
    const webFetchDesc = 'Fetch the main content of a web page as markdown or text via Jina Reader. Use when the user provides a URL to read, summarize, or analyze.';
    const webFetchSchema = {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL of the page to fetch' },
        max_chars: { type: 'number', description: 'Maximum characters to return per call (1000–2000000). Default 200000. Use with offset to paginate long pages.' },
        offset: { type: 'number', description: 'Character offset for pagination. Use 0 or omit for first segment; then use the next_offset from the response for the next segment.' },
        respond_with: { type: 'string', description: 'Output format: content, markdown, html, or text', default: 'markdown' },
        timeout_seconds: { type: 'number', description: 'Timeout in seconds (1-180)', default: 45 },
        no_cache: { type: 'boolean', description: 'Bypass cache' },
        wait_for_selector: { type: 'string', description: 'CSS selector to wait for' },
        target_selector: { type: 'string', description: 'CSS selector to extract only that part' },
        remove_selector: { type: 'string', description: 'CSS selector of elements to remove' },
        user_agent: { type: 'string', description: 'Custom User-Agent' },
        referer: { type: 'string', description: 'Referer header' },
        locale: { type: 'string', description: 'Browser locale (e.g. en-US)' },
        retain_images: { type: 'string', description: 'none, all, alt, all_p, or alt_p' },
        retain_links: { type: 'string', description: 'none, all, text, or gpt-oss' },
        with_links_summary: { type: 'boolean', description: 'Include links summary section' },
        with_images_summary: { type: 'boolean', description: 'Include images summary section' },
        respond_timing: { type: 'string', description: 'html, visible-content, mutation-idle, resource-idle, media-idle, network-idle' },
        engine: { type: 'string', description: 'browser, direct, or cf-browser-rendering' },
      },
      required: ['url'],
    };
    db.prepare(`
      INSERT INTO tools (id, name, description, parameters_schema, type, config)
      VALUES (?, 'web_fetch', ?, ?, 'builtin', NULL)
    `).run(webFetchId, webFetchDesc, JSON.stringify(webFetchSchema));
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

  const convCols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string; notnull?: number }[];
  if (!convCols.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN user_id TEXT');
    db.prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL').run(defaultUserId);
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
  }

  // Migration: add model column to conversations for per-conversation model override
  if (!convCols.some((c) => c.name === 'model')) {
    db.exec('ALTER TABLE conversations ADD COLUMN model TEXT DEFAULT NULL');
  }
  if (!convCols.some((c) => c.name === 'provider_routing')) {
    db.exec('ALTER TABLE conversations ADD COLUMN provider_routing TEXT DEFAULT NULL');
  }

  // Migration: make agent_id nullable in conversations for general chat support
  // SQLite doesn't support ALTER COLUMN, so we need to recreate the table.
  // foreign_keys must be OFF: DROP TABLE conversations is the FK parent of
  // messages, and with cascading FKs enabled the implicit DELETE would wipe
  // every message in the database. Same pattern as the tools recreation below.
  type PragmaCol = { name: string; notnull?: number };
  const agentIdCol = convCols.find((c) => c.name === 'agent_id') as PragmaCol | undefined;
  if (agentIdCol && agentIdCol.notnull === 1) {
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
        CREATE TABLE conversations_new (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
          title TEXT DEFAULT 'New conversation',
          model TEXT DEFAULT NULL,
          provider_routing TEXT DEFAULT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_conversations_new_agent ON conversations_new(agent_id);
        CREATE INDEX idx_conversations_new_user_id ON conversations_new(user_id);
        INSERT INTO conversations_new (id, user_id, agent_id, title, model, provider_routing, created_at, updated_at)
          SELECT id, user_id, agent_id, title, model, provider_routing, created_at, updated_at FROM conversations;
        DROP TABLE conversations;
        ALTER TABLE conversations_new RENAME TO conversations;
      `);
      console.log('[Agent Studio] Migrated conversations: agent_id is now nullable');
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // Migration: conversation-level tool/MCP override (tools_overridden flag + link tables)
  const convColsForToolOverride = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!convColsForToolOverride.some((c) => c.name === 'tools_overridden')) {
    db.exec('ALTER TABLE conversations ADD COLUMN tools_overridden INTEGER DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_tools (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_tools_conversation ON conversation_tools(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_tools_tool ON conversation_tools(tool_id);
    CREATE TABLE IF NOT EXISTS conversation_mcp_servers (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, mcp_server_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_mcp_servers_conversation ON conversation_mcp_servers(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_mcp_servers_mcp ON conversation_mcp_servers(mcp_server_id);
  `);

  // Migration: add processed_by_agent_id to messages for @agent tracking
  const msgColsFinal2 = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!msgColsFinal2.some((c) => c.name === 'processed_by_agent_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN processed_by_agent_id TEXT DEFAULT NULL");
    db.exec("ALTER TABLE messages ADD COLUMN processed_by_agent_name TEXT DEFAULT NULL");
    console.log('[Agent Studio] Added processed_by_agent tracking to messages');
  }

  const toolCols = db.prepare("PRAGMA table_info(tools)").all() as { name: string }[];
  if (!toolCols.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE tools ADD COLUMN user_id TEXT');
    db.prepare('UPDATE tools SET user_id = ? WHERE user_id IS NULL').run(defaultUserId);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tools_user_id ON tools(user_id)');
  }

  // Migration: allow multiple tools with same name (per user) so each user can have web_fetch
  const toolsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tools'").get() as { sql: string } | undefined;
  const hasUniqueOnName = toolsTableSql?.sql?.includes('name') && toolsTableSql?.sql?.includes('UNIQUE') && !toolsTableSql?.sql?.includes('UNIQUE(user_id, name)');
  if (hasUniqueOnName) {
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
        CREATE TABLE tools_new (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          parameters_schema TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('builtin', 'http')),
          config TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(user_id, name)
        );
        INSERT INTO tools_new (id, user_id, name, description, parameters_schema, type, config, created_at, updated_at)
        SELECT id, user_id, name, description, parameters_schema, type, config, created_at, updated_at FROM tools;
        DROP TABLE tools;
        ALTER TABLE tools_new RENAME TO tools;
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_tools_user_id ON tools(user_id)');
      console.log('[Agent Studio] Migrated tools: name is now UNIQUE per (user_id, name)');
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  const mcpCols = db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[];
  if (!mcpCols.some((c) => c.name === 'user_id')) {
    db.exec('ALTER TABLE mcp_servers ADD COLUMN user_id TEXT');
    db.prepare('UPDATE mcp_servers SET user_id = ? WHERE user_id IS NULL').run(defaultUserId);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_servers_user_id ON mcp_servers(user_id)');
  }

  // Migration: allow relay transport for MCP servers (hosted by the user's local agent).
  // SQLite cannot alter a CHECK constraint, so recreate the table when needed,
  // preserving all existing columns (incl. user_id).
  const mcpTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_servers'").get() as { sql: string } | undefined;
  if (!mcpTableSql?.sql?.includes("'relay'")) {
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
        CREATE TABLE mcp_servers_new (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          name TEXT NOT NULL,
          transport TEXT NOT NULL CHECK(transport IN ('url', 'stdio', 'relay')),
          config TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO mcp_servers_new (id, user_id, name, transport, config, created_at, updated_at)
        SELECT id, user_id, name, transport, config, created_at, updated_at FROM mcp_servers;
        DROP TABLE mcp_servers;
        ALTER TABLE mcp_servers_new RENAME TO mcp_servers;
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_servers_user_id ON mcp_servers(user_id)');
      console.log('[Agent Studio] Migrated mcp_servers: transport now supports relay');
    } finally {
      db.pragma('foreign_keys = ON');
    }
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
  }

  // Reassign any data still under default user (local@localhost) to the admin (e.g. after restoring a local DB).
  // IMPORTANT: Only update tools that would not duplicate (user_id, name). Admin may already have web_fetch
  // from a previous migration run; moving (defaultUserId, 'web_fetch') would then violate UNIQUE(user_id, name).
  if (existingAdmin && defaultUserId && existingAdmin.id !== defaultUserId) {
    db.transaction(() => {
      db.prepare('UPDATE agents SET user_id = ? WHERE user_id = ?').run(existingAdmin.id, defaultUserId);
      db.prepare('UPDATE conversations SET user_id = ? WHERE user_id = ?').run(existingAdmin.id, defaultUserId);
      db.prepare(`
        INSERT INTO settings (user_id, key, value)
        SELECT ?, key, value FROM settings WHERE user_id = ?
        ON CONFLICT(user_id, key) DO NOTHING
      `).run(existingAdmin.id, defaultUserId);
      db.prepare('DELETE FROM settings WHERE user_id = ?').run(defaultUserId);
      db.prepare(`
        UPDATE tools SET user_id = ? WHERE user_id = ? AND name NOT IN (SELECT name FROM tools WHERE user_id = ?)
      `).run(existingAdmin.id, defaultUserId, existingAdmin.id);
      db.prepare('UPDATE mcp_servers SET user_id = ? WHERE user_id = ?').run(existingAdmin.id, defaultUserId);
    })();
  }

  if (!existingAdmin && defaultUserId) {
    const { nanoid } = await_nanoid();
    const newAdminId = nanoid();
    const rawPassword = adminPasswordSet ? adminPasswordEnv! : crypto.randomBytes(16).toString('base64url');
    try {
      const bcrypt = require('bcrypt');
      const password_hash = bcrypt.hashSync(rawPassword, 12);
      db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(newAdminId, INITIAL_ADMIN_EMAIL, password_hash);
      db.transaction(() => {
        db.prepare('UPDATE agents SET user_id = ? WHERE user_id = ?').run(newAdminId, defaultUserId);
        db.prepare('UPDATE conversations SET user_id = ? WHERE user_id = ?').run(newAdminId, defaultUserId);
        db.prepare(`
          INSERT INTO settings (user_id, key, value)
          SELECT ?, key, value FROM settings WHERE user_id = ?
          ON CONFLICT(user_id, key) DO NOTHING
        `).run(newAdminId, defaultUserId);
        db.prepare('DELETE FROM settings WHERE user_id = ?').run(defaultUserId);
        db.prepare(`
          UPDATE tools SET user_id = ? WHERE user_id = ? AND name NOT IN (SELECT name FROM tools WHERE user_id = ?)
        `).run(newAdminId, defaultUserId, newAdminId);
        db.prepare('UPDATE mcp_servers SET user_id = ? WHERE user_id = ?').run(newAdminId, defaultUserId);
      })();
      console.log('[Agent Studio] Initial admin created: ' + INITIAL_ADMIN_EMAIL);
      if (!adminPasswordSet) {
        console.log('[Agent Studio] One-time password (save it, then change after first login): ' + rawPassword);
      }
    } catch (e) {
      console.error('[Agent Studio] Failed to create initial admin:', e);
    }
  }

  // Migration: ensure every user has web_fetch builtin.
  // ORDER: Must run after the reassign blocks above. Reassign moves default user's tools to admin; if we ran
  // web_fetch insert first we would insert (admin, 'web_fetch'), then reassign would try to create a second
  // (admin, 'web_fetch') from (defaultUserId, 'web_fetch') → UNIQUE violation.
  const webFetchDesc = 'Fetch the main content of a web page as markdown or text via Jina Reader. Use when the user provides a URL to read, summarize, or analyze.';
  const webFetchSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL of the page to fetch' },
      max_chars: { type: 'number', description: 'Maximum characters to return per call (1000–2000000). Default 200000. Use with offset to paginate long pages.' },
      offset: { type: 'number', description: 'Character offset for pagination. Use 0 or omit for first segment; then use the next_offset from the response for the next segment.' },
      respond_with: { type: 'string', description: 'Output format: content, markdown, html, or text', default: 'markdown' },
      timeout_seconds: { type: 'number', description: 'Timeout in seconds (1-180)', default: 45 },
      no_cache: { type: 'boolean', description: 'Bypass cache' },
      wait_for_selector: { type: 'string', description: 'CSS selector to wait for' },
      target_selector: { type: 'string', description: 'CSS selector to extract only that part' },
      remove_selector: { type: 'string', description: 'CSS selector of elements to remove' },
      user_agent: { type: 'string', description: 'Custom User-Agent' },
      referer: { type: 'string', description: 'Referer header' },
      locale: { type: 'string', description: 'Browser locale (e.g. en-US)' },
      retain_images: { type: 'string', description: 'none, all, alt, all_p, or alt_p' },
      retain_links: { type: 'string', description: 'none, all, text, or gpt-oss' },
      with_links_summary: { type: 'boolean', description: 'Include links summary section' },
      with_images_summary: { type: 'boolean', description: 'Include images summary section' },
      respond_timing: { type: 'string', description: 'html, visible-content, mutation-idle, resource-idle, media-idle, network-idle' },
      engine: { type: 'string', description: 'browser, direct, or cf-browser-rendering' },
    },
    required: ['url'],
  };
  const allUserIds = db.prepare('SELECT id FROM users').all() as { id: string }[];
  const hasWebFetchStmt = db.prepare('SELECT 1 FROM tools WHERE user_id = ? AND name = ?');
  const insertWebFetchStmt = db.prepare(`
    INSERT INTO tools (id, user_id, name, description, parameters_schema, type, config)
    VALUES (?, ?, 'web_fetch', ?, ?, 'builtin', NULL)
  `);
  for (const { id: uid } of allUserIds) {
    if (hasWebFetchStmt.get(uid, 'web_fetch')) continue;
    const { nanoid } = await_nanoid();
    insertWebFetchStmt.run(nanoid(), uid, webFetchDesc, JSON.stringify(webFetchSchema));
  }

  // Migration: align existing web_fetch tools with pagination schema (max_chars, offset).
  db.prepare(
    `UPDATE tools SET parameters_schema = ? WHERE name = 'web_fetch' AND type = 'builtin'`
  ).run(JSON.stringify(webFetchSchema));

  // Migration: ensure every user has the run_command builtin. Usability is
  // gated separately by resolve.ts on that user's e2b_api_key.
  const runCommandDesc = "Execute a shell command in a real, persistent working environment (a paired local machine or an isolated cloud sandbox) to run scripts, install packages, inspect/edit files, or call CLIs. Returns stdout, stderr, and exit_code as JSON; a non-zero exit_code or non-empty stderr does not necessarily mean the command failed to run — inspect the output. Available backends: 'local' (the user's own paired machine — real files, installed tools, persists across calls) and 'sandbox' (an ephemeral isolated cloud VM — no access to the user's files, resets between conversations, requires the user's own sandbox account). Use backend='auto' (default) to let the system pick whichever is configured; specify 'local' or 'sandbox' only when the task specifically needs that environment's characteristics.";
  const runCommandSchema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace root. Omit to use the default workspace root.' },
      backend: { type: 'string', description: "'auto' (default), 'local', or 'sandbox'." },
      timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 120, hard ceiling 1800).' },
    },
    required: ['command'],
  };
  const hasRunCommandStmt = db.prepare('SELECT 1 FROM tools WHERE user_id = ? AND name = ?');
  const insertRunCommandStmt = db.prepare(`
    INSERT INTO tools (id, user_id, name, description, parameters_schema, type, config)
    VALUES (?, ?, 'run_command', ?, ?, 'builtin', NULL)
  `);
  for (const { id: uid } of allUserIds) {
    if (hasRunCommandStmt.get(uid, 'run_command')) continue;
    const { nanoid } = await_nanoid();
    insertRunCommandStmt.run(nanoid(), uid, runCommandDesc, JSON.stringify(runCommandSchema));
  }
  db.prepare(
    `UPDATE tools SET description = ?, parameters_schema = ? WHERE name = 'run_command' AND type = 'builtin'`
  ).run(runCommandDesc, JSON.stringify(runCommandSchema));

  // Migration: ensure every user has the local file-operation builtins. These
  // rows are copied to newly registered users by auth.ts, so keep this seed and
  // the registry definitions aligned manually.
  const fileToolSeeds = [
    {
      name: 'read_file',
      description: 'Read a text file from the connected local agent with line numbers (like cat -n) and offset/limit paging (defaults to the first 2000 lines). Binary files are rejected. Requires a connected local agent.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          offset: { type: 'number', description: '1-based first line to read. Defaults to 1.' },
          limit: { type: 'number', description: 'Maximum number of lines to read. Defaults to 2000.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file with the exact content provided (without shell quoting); parent directories are created automatically. Before overwriting an existing file, you must read it first with read_file. Requires a connected local agent.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          content: { type: 'string', description: 'Exact text content to write.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact, unique text match in a file; set replace_all to replace every match. You must read an existing file first with read_file before editing it. Requires a connected local agent.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          old_string: { type: 'string', description: 'Exact text to find.' },
          new_string: { type: 'string', description: 'Text to insert in place of the match.' },
          replace_all: { type: 'boolean', description: 'Replace all matches instead of requiring an exact unique match.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a file or directory; recursive is required for a non-empty directory. Deletes outside the workspace or large/recursive deletes require local human confirmation within 60 seconds. Requires a connected local agent.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path relative to the workspace root.' },
          recursive: { type: 'boolean', description: 'Allow deletion of a directory and its contents.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_directory',
      description: 'List one level of a directory (non-recursively); defaults to the workspace root. Requires a connected local agent.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "Directory path relative to the workspace root. Defaults to '.'." },
        },
        required: [],
      },
    },
    {
      name: 'send_file',
      description: 'Deliver a file from the connected local machine to the user as a downloadable link in the chat — use this after creating a file (e.g. with run_command or write_file) that the user should be able to download, such as a chart image, document, spreadsheet, or export. The download link stays valid for about 72 hours and then expires automatically. Requires a connected local agent.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root (or an absolute path within it) of the file to deliver.' },
        },
        required: ['path'],
      },
    },
  ];
  const existingFileToolStmt = db.prepare('SELECT id, type FROM tools WHERE user_id = ? AND name = ?');
  const hasToolNameStmt = db.prepare('SELECT 1 FROM tools WHERE user_id = ? AND name = ?');
  const renameCustomToolStmt = db.prepare('UPDATE tools SET name = ? WHERE id = ?');
  const insertFileToolStmt = db.prepare(`
    INSERT INTO tools (id, user_id, name, description, parameters_schema, type, config)
    VALUES (?, ?, ?, ?, ?, 'builtin', NULL)
  `);
  for (const fileTool of fileToolSeeds) {
    for (const { id: uid } of allUserIds) {
      const existingTool = existingFileToolStmt.get(uid, fileTool.name) as { id: string; type: string } | undefined;
      if (existingTool?.type === 'builtin') continue;
      if (existingTool) {
        const customNameBase = `${fileTool.name}_custom`;
        let customName = customNameBase;
        let suffix = 2;
        while (hasToolNameStmt.get(uid, customName)) {
          customName = `${customNameBase}_${suffix}`;
          suffix += 1;
        }
        // Keep the custom row's id, config, schema, and description intact while
        // freeing the builtin's canonical name under UNIQUE(user_id, name).
        renameCustomToolStmt.run(customName, existingTool.id);
      }
      const { nanoid } = await_nanoid();
      insertFileToolStmt.run(nanoid(), uid, fileTool.name, fileTool.description, JSON.stringify(fileTool.schema));
    }
    db.prepare(
      `UPDATE tools SET description = ?, parameters_schema = ? WHERE name = ? AND type = 'builtin'`
    ).run(fileTool.description, JSON.stringify(fileTool.schema), fileTool.name);
  }

  // --- Model Council migrations ---
  migrateCouncilTables();

  // --- Tool execution audit log (run_command and future exec-shaped tools) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      tool_call_id TEXT,
      tool_name TEXT NOT NULL,
      backend TEXT NOT NULL CHECK(backend IN ('local','e2b','mcp-stdio')),
      command TEXT,
      cwd TEXT,
      exit_code INTEGER,
      duration_ms INTEGER,
      blocked_pattern TEXT,
      confirmation_required INTEGER DEFAULT 0,
      confirmation_result TEXT CHECK(confirmation_result IN ('approved','declined','timeout') OR confirmation_result IS NULL),
      is_error INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tool_executions_user_id ON tool_executions(user_id);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_conversation_id ON tool_executions(conversation_id);
  `);

  // --- Paired local agents (raw tokens are never persisted) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS paired_agents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_paired_agents_user_id ON paired_agents(user_id);
    CREATE INDEX IF NOT EXISTS idx_paired_agents_token_hash ON paired_agents(token_hash);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_files_user_id ON agent_files(user_id);
    CREATE INDEX IF NOT EXISTS idx_agent_files_expires_at ON agent_files(expires_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      license TEXT,
      compatibility TEXT,
      metadata TEXT,
      allowed_tools TEXT,
      disable_model_invocation INTEGER NOT NULL DEFAULT 0,
      source_filename TEXT NOT NULL,
      storage_dir TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_skills_user_id ON skills(user_id);
    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, skill_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_skills_skill ON agent_skills(skill_id);
    CREATE TABLE IF NOT EXISTS conversation_skills (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, skill_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_skills_conversation ON conversation_skills(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_skills_skill ON conversation_skills(skill_id);
  `);

  const convColsForSkillOverride = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!convColsForSkillOverride.some((c) => c.name === 'skills_overridden')) {
    db.exec('ALTER TABLE conversations ADD COLUMN skills_overridden INTEGER DEFAULT 0');
  }

  // --- Message tree: editing / retry / variants / threads ---
  // Idempotent block: runs only when the columns are missing, so the legacy
  // backfill below executes exactly once per database.
  const msgColsTree = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const msgColSetTree = new Set(msgColsTree.map((c) => c.name));
  const convColsTree = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  const convColSetTree = new Set(convColsTree.map((c) => c.name));
  if (!msgColSetTree.has('parent_id') || !convColSetTree.has('active_leaf_id')) {
    if (!msgColSetTree.has('parent_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN parent_id TEXT');
    }
    if (!msgColSetTree.has('turn_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN turn_id TEXT');
    }
    if (!msgColSetTree.has('variant_seq')) {
      db.exec('ALTER TABLE messages ADD COLUMN variant_seq INTEGER NOT NULL DEFAULT 1');
    }
    if (!convColSetTree.has('active_leaf_id')) {
      db.exec('ALTER TABLE conversations ADD COLUMN active_leaf_id TEXT');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
      CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id);
    `);
    // Backfill legacy linear histories into parent/turn/variant chains (single transaction).
    backfillMessageTree();
    console.log('[Agent Studio] Migrated messages to message-tree (parent_id/turn_id/variant_seq)');
  }
}

function migrateCouncilTables() {
  // Create council_runs table - tracks each council execution
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      synthesizer_model TEXT NOT NULL DEFAULT 'anthropic/claude-3.5-sonnet',
      synthesizer_provider_routing TEXT DEFAULT NULL,
      member_provider_routing TEXT DEFAULT '{}',
      member_count INTEGER NOT NULL DEFAULT 3,
      system_prompt TEXT,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'partial_failure', 'failed')) DEFAULT 'running',
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      total_cost REAL DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_prompt_tokens INTEGER DEFAULT 0,
      total_completion_tokens INTEGER DEFAULT 0,
      failed_members INTEGER DEFAULT 0,
      error_log TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_council_runs_user ON council_runs(user_id);
    CREATE INDEX IF NOT EXISTS idx_council_runs_conversation ON council_runs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_council_runs_message ON council_runs(message_id);
    CREATE INDEX IF NOT EXISTS idx_council_runs_status ON council_runs(status);
  `);

  // Create council_members table - stores council configurations
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_members (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      member_models TEXT NOT NULL,
      member_provider_routing TEXT DEFAULT '{}',
      synthesizer_model TEXT NOT NULL DEFAULT 'anthropic/claude-3.5-sonnet',
      synthesizer_provider_routing TEXT DEFAULT NULL,
      synthesis_prompt_template TEXT,
      auto_expand_responses INTEGER DEFAULT 0,
      show_member_responses INTEGER DEFAULT 1,
      tool_ids TEXT DEFAULT '[]',
      mcp_server_ids TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_council_members_user ON council_members(user_id);
  `);

  // Create council_responses table - individual responses from each council member
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_responses (
      id TEXT PRIMARY KEY,
      council_run_id TEXT NOT NULL REFERENCES council_runs(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      provider_routing TEXT DEFAULT NULL,
      content TEXT NOT NULL,
      reasoning_content TEXT,
      tokens_used INTEGER DEFAULT 0,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      response_time_ms INTEGER,
      status TEXT NOT NULL CHECK(status IN ('success', 'error', 'timeout', 'cancelled')) DEFAULT 'success',
      error_message TEXT,
      display_order INTEGER DEFAULT 0,
      tool_calls TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_council_responses_run ON council_responses(council_run_id);
    CREATE INDEX IF NOT EXISTS idx_council_responses_model ON council_responses(model_id);
    CREATE INDEX IF NOT EXISTS idx_council_responses_status ON council_responses(status);
  `);

  // Council responses: store tool results (JSON array of { id, content }) for display like normal chat
  const councilRespCols = db.prepare("PRAGMA table_info(council_responses)").all() as { name: string }[];
  if (!councilRespCols.some((c) => c.name === 'tool_results')) {
    db.exec("ALTER TABLE council_responses ADD COLUMN tool_results TEXT DEFAULT NULL");
  }
  if (!councilRespCols.some((c) => c.name === 'provider_routing')) {
    db.exec("ALTER TABLE council_responses ADD COLUMN provider_routing TEXT DEFAULT NULL");
  }

  // Add council columns to messages table
  const msgCols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!msgCols.some((c) => c.name === 'council_run_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN council_run_id TEXT DEFAULT NULL REFERENCES council_runs(id) ON DELETE SET NULL");
    db.exec("ALTER TABLE messages ADD COLUMN is_council_synthesis INTEGER DEFAULT 0");
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_council_run ON messages(council_run_id)");
  }

  // Add show_member_responses to council_runs (default 1 = true)
  const runCols = db.prepare("PRAGMA table_info(council_runs)").all() as { name: string }[];
  if (!runCols.some((c) => c.name === 'show_member_responses')) {
    db.exec("ALTER TABLE council_runs ADD COLUMN show_member_responses INTEGER DEFAULT 1");
  }

  // Add comparison_json for structured agreement/disagreement/unique findings
  const runCols2 = db.prepare("PRAGMA table_info(council_runs)").all() as { name: string }[];
  if (!runCols2.some((c) => c.name === 'comparison_json')) {
    db.exec("ALTER TABLE council_runs ADD COLUMN comparison_json TEXT DEFAULT NULL");
  }
  if (!runCols2.some((c) => c.name === 'synthesizer_provider_routing')) {
    db.exec("ALTER TABLE council_runs ADD COLUMN synthesizer_provider_routing TEXT DEFAULT NULL");
  }
  if (!runCols2.some((c) => c.name === 'member_provider_routing')) {
    db.exec("ALTER TABLE council_runs ADD COLUMN member_provider_routing TEXT DEFAULT '{}'");
  }

  const councilMemberCols = db.prepare("PRAGMA table_info(council_members)").all() as { name: string }[];
  if (!councilMemberCols.some((c) => c.name === 'member_provider_routing')) {
    db.exec("ALTER TABLE council_members ADD COLUMN member_provider_routing TEXT DEFAULT '{}'");
  }
  if (!councilMemberCols.some((c) => c.name === 'synthesizer_provider_routing')) {
    db.exec("ALTER TABLE council_members ADD COLUMN synthesizer_provider_routing TEXT DEFAULT NULL");
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

/**
 * Ensures the local@localhost user exists (for local / no-auth mode).
 * Call this when auth is disabled and the local user is missing.
 * Returns the user id or null if creation failed.
 */
export function ensureLocalUser(): string | null {
  try {
    const row = db.prepare("SELECT id FROM users WHERE email = 'local@localhost' LIMIT 1").get() as { id: string } | undefined;
    if (row?.id) return row.id;
    const { nanoid } = await_nanoid();
    const id = nanoid();
    const placeholderHash = '$2b$10$placeholder.hash.for.migration.only';
    try {
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync('changeme', 10);
      db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, 'local@localhost', hash);
    } catch {
      db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, 'local@localhost', placeholderHash);
    }
    return id;
  } catch {
    return null;
  }
}

export default db;
