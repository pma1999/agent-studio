import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import {
  MCP_SECRET_PLACEHOLDER,
  createAndConnectMcpClient,
  isEncryptedMcpConfig,
  listMcpPrompts,
  listMcpResourceTemplates,
  listMcpResources,
  listMcpTools,
  maskMcpConfig,
  normalizeMcpConfig,
  parseStoredMcpConfig,
  prefixToolName,
  resolveMcpToolApproval,
  serializeMcpConfig,
  teardownRelaySession,
  type McpConnection,
} from '../mcp/index.js';
import { listPendingApprovalsFor } from '../mcp/toolApproval.js';
import { isAgentConnected } from '../agentRelay/registry.js';
import { slugFromServerName } from '../tools/index.js';
import type { McpServerConfig, McpTransport } from '../mcp/types.js';
import { AuthRequest } from '../middleware/auth.js';

const router = Router();
const MAX_SERVER_NAME_LENGTH = 200;

interface McpDbRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  name: string;
  transport: string;
  config: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setPrivateNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function normalizeServerName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('name is required');
  const name = value.trim();
  if (name.length > MAX_SERVER_NAME_LENGTH) throw new Error(`name must be at most ${MAX_SERVER_NAME_LENGTH} characters`);
  return name;
}

// POST /api/mcp-servers/approvals/:approvalId — resolve one exact, pending
// tools/call authorization. The nonce is one-shot and tenant-bound.
router.post('/approvals/:approvalId', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (typeof req.body?.approved !== 'boolean') {
    return res.status(400).json({ error: 'approved must be a boolean' });
  }
  const result = resolveMcpToolApproval(req.params.approvalId, userId, req.body.approved);
  if (result === 'not_found') return res.status(404).json({ error: 'Approval request not found or expired' });
  return res.json({ resolved: true, approved: result === 'approved' });
});

// GET /api/mcp-servers/pending-approvals?conversation_id= — owner-scoped read-only
// snapshot of the pending MCP tool approvals for one conversation (plan.md S7).
// Same payload shape as the live `{mcp_approval_required}` SSE event. Registered
// BEFORE the GET /:id handler so "pending-approvals" is never parsed as a server id.
router.get('/pending-approvals', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const conversationId = req.query.conversation_id;
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    return res.status(400).json({ error: 'conversation_id is required' });
  }
  // Tenancy check mirrors messages.ts: unknown AND foreign ids uniformly 404.
  const conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  return res.json({ approvals: listPendingApprovalsFor(userId, conversationId) });
});

function normalizeTransport(value: unknown, fallback?: McpTransport): McpTransport {
  const candidate = value === undefined ? fallback : typeof value === 'string' ? value.toLowerCase() : '';
  if (candidate !== 'url' && candidate !== 'stdio' && candidate !== 'relay') {
    throw new Error('transport must be "url", "stdio" or "relay"');
  }
  return candidate;
}

function parseIncomingConfig(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('config must be valid JSON');
  }
}

/**
 * Query strings and fragments can carry credentials. The core masker handles
 * explicit secret fields; the HTTP surface additionally redacts these opaque
 * URL components and restores them only when an update echoes our sentinel.
 */
function maskConfigForResponse(config: McpServerConfig): McpServerConfig {
  const masked = maskMcpConfig(config);
  if (!('url' in masked)) return masked;
  try {
    const url = new URL(masked.url);
    if (url.search) url.search = `?${MCP_SECRET_PLACEHOLDER}`;
    if (url.hash) url.hash = `#${MCP_SECRET_PLACEHOLDER}`;
    return { ...masked, url: url.href };
  } catch {
    // Invalid legacy values can still be listed without exposing the URL.
    return { ...masked, url: '[invalid MCP URL]' };
  }
}

function restoreMaskedUrl(input: unknown, previous: McpServerConfig | null): unknown {
  if (!isRecord(input) || !previous || !('url' in previous) || typeof input.url !== 'string') return input;
  const publicPrevious = maskConfigForResponse(previous);
  if ('url' in publicPrevious && input.url === publicPrevious.url) {
    return { ...input, url: previous.url };
  }
  return input;
}

function parseAndMigrateConfig(row: Pick<McpDbRow, 'id' | 'config'>, userId: string): McpServerConfig | null {
  const parsed = parseStoredMcpConfig(row.config);
  if (!parsed || isEncryptedMcpConfig(row.config)) return parsed;

  // Existing plaintext rows are upgraded opportunistically once encryption is
  // configured. A compare-and-swap avoids overwriting a concurrent update.
  try {
    const encrypted = serializeMcpConfig(parsed);
    db.prepare('UPDATE mcp_servers SET config = ? WHERE id = ? AND user_id = ? AND config = ?')
      .run(encrypted, row.id, userId, row.config);
  } catch {
    // Legacy rows remain readable when an installation has not configured the
    // key yet; new writes are still refused by serializeMcpConfig below.
  }
  return parsed;
}

function publicRow(row: McpDbRow, userId: string): Record<string, unknown> {
  const { user_id: _userId, ...safeRow } = row;
  const config = parseAndMigrateConfig(row, userId);
  const isRelay = row.transport === 'relay';
  return {
    ...safeRow,
    config: config ? maskConfigForResponse(config) : null,
    ...(isRelay ? { requires_agent: true, agent_connected: isAgentConnected(userId) } : {}),
  };
}

function configErrorStatus(error: unknown): number {
  return error instanceof Error && error.message.includes('ENCRYPTION_KEY') ? 503 : 400;
}

function configErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes('ENCRYPTION_KEY')) {
    return 'Secure MCP configuration storage is unavailable until ENCRYPTION_KEY is configured';
  }
  return error instanceof Error ? error.message : 'Invalid MCP server configuration';
}

function secretValues(config: McpServerConfig | null): string[] {
  if (!config) return [];
  const values: string[] = [];
  if ('url' in config) {
    values.push(config.url);
    values.push(...Object.values(config.headers ?? {}));
    if (config.auth?.type === 'bearer') values.push(config.auth.token);
    if (config.auth?.type === 'client_credentials') values.push(config.auth.clientSecret);
    try {
      const url = new URL(config.url);
      for (const value of url.searchParams.values()) values.push(value, encodeURIComponent(value));
      if (url.hash.length > 1) values.push(url.hash.slice(1));
    } catch { /* malformed legacy config */ }
  } else {
    values.push(...Object.values(config.env ?? {}));
  }
  return values.filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
}

function redactError(error: unknown, config: McpServerConfig | null): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secretValues(config)) message = message.split(secret).join('[redacted]');
  return message;
}

// GET /api/mcp-servers - List all MCP servers
router.get('/', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY name ASC').all(userId) as McpDbRow[];
    return res.json(rows.map((row) => publicRow(row, userId)));
  } catch (error) {
    console.error('Error listing MCP servers:', error);
    return res.status(500).json({ error: 'Failed to list MCP servers' });
  }
});

// GET /api/mcp-servers/:id - Get one MCP server
router.get('/:id', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?')
      .get(req.params.id, userId) as McpDbRow | undefined;
    if (!row) return res.status(404).json({ error: 'MCP server not found' });
    return res.json(publicRow(row, userId));
  } catch (error) {
    console.error('Error getting MCP server:', error);
    return res.status(500).json({ error: 'Failed to get MCP server' });
  }
});

// POST /api/mcp-servers - Create MCP server
router.post('/', (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  let name: string;
  let transport: McpTransport;
  let serializedConfig: string;
  try {
    name = normalizeServerName(req.body?.name);
    transport = normalizeTransport(req.body?.transport, 'url');
    const config = normalizeMcpConfig(transport, parseIncomingConfig(req.body?.config), {
      localExecutionApproved: req.body?.local_execution_approved === true,
    });
    serializedConfig = serializeMcpConfig(config);
  } catch (error) {
    return res.status(configErrorStatus(error)).json({ error: configErrorMessage(error) });
  }

  try {
    const id = nanoid();
    db.prepare(`
      INSERT INTO mcp_servers (id, user_id, name, transport, config)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, name, transport, serializedConfig);
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(id, userId) as McpDbRow;
    return res.status(201).json(publicRow(row, userId));
  } catch (error) {
    console.error('Error creating MCP server:', error);
    return res.status(500).json({ error: 'Failed to create MCP server' });
  }
});

// PUT /api/mcp-servers/:id - Update MCP server
router.put('/:id', async (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const existing = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?')
    .get(req.params.id, userId) as McpDbRow | undefined;
  if (!existing) return res.status(404).json({ error: 'MCP server not found' });

  let name: string | undefined;
  let transport: McpTransport;
  let serializedConfig: string | undefined;
  try {
    if (req.body?.name !== undefined) name = normalizeServerName(req.body.name);
    const existingTransport = normalizeTransport(existing.transport);
    transport = normalizeTransport(req.body?.transport, existingTransport);
    const previous = parseStoredMcpConfig(existing.config);
    if (req.body?.transport !== undefined && transport !== existingTransport && req.body?.config === undefined) {
      throw new Error('config is required when changing transport');
    }

    const shouldNormalizeConfig = req.body?.config !== undefined || req.body?.local_execution_approved === true;
    if (shouldNormalizeConfig) {
      if (!previous && req.body?.config === undefined) throw new Error('Existing MCP server configuration is invalid');
      const raw = req.body?.config === undefined ? previous : parseIncomingConfig(req.body.config);
      const restored = transport === existingTransport ? restoreMaskedUrl(raw, previous) : raw;
      const normalized = normalizeMcpConfig(transport, restored, {
        previous: transport === existingTransport ? previous : null,
        localExecutionApproved: req.body?.local_execution_approved === true,
      });
      serializedConfig = serializeMcpConfig(normalized);
    }
  } catch (error) {
    return res.status(configErrorStatus(error)).json({ error: configErrorMessage(error) });
  }

  try {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (req.body?.transport !== undefined) {
      updates.push('transport = ?');
      values.push(transport);
    }
    if (serializedConfig !== undefined) {
      updates.push('config = ?');
      values.push(serializedConfig);
    }
    if (updates.length > 0) {
      // Evict before committing the mutation. If the remote process cannot be
      // stopped cleanly, leave the persisted configuration untouched so the
      // caller never receives a failure after a write has already committed.
      await teardownRelaySession(userId, req.params.id);
      updates.push("updated_at = datetime('now')");
      values.push(req.params.id, userId);
      db.prepare(`UPDATE mcp_servers SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
    }

    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?')
      .get(req.params.id, userId) as McpDbRow;
    return res.json(publicRow(row, userId));
  } catch (error) {
    console.error('Error updating MCP server:', error);
    return res.status(500).json({ error: 'Failed to update MCP server' });
  }
});

// DELETE /api/mcp-servers/:id - Delete MCP server and its links
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = db.prepare('SELECT id FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!row) return res.status(404).json({ error: 'MCP server not found' });

    await teardownRelaySession(userId, req.params.id);
    db.transaction(() => {
      db.prepare(`
        DELETE FROM agent_mcp_servers
        WHERE mcp_server_id = ?
          AND agent_id IN (SELECT id FROM agents WHERE user_id = ?)
      `).run(req.params.id, userId);
      db.prepare('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?').run(req.params.id, userId);
    })();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting MCP server:', error);
    return res.status(500).json({ error: 'Failed to delete MCP server' });
  }
});

// POST /api/mcp-servers/:id/test - Connect and inspect advertised surfaces
router.post('/:id/test', async (req: AuthRequest, res: Response) => {
  setPrivateNoStore(res);
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?')
    .get(req.params.id, userId) as McpDbRow | undefined;
  if (!row) return res.status(404).json({ error: 'MCP server not found' });

  const config = parseAndMigrateConfig(row, userId);
  if (!config) return res.status(400).json({ ok: false, error: 'Invalid server config' });

  let transport: McpTransport;
  try {
    transport = normalizeTransport(row.transport);
  } catch (error) {
    return res.status(400).json({ ok: false, error: configErrorMessage(error) });
  }
  if (transport === 'relay' && !isAgentConnected(userId)) {
    return res.json({
      ok: false,
      error: 'Local agent (PC) is not connected. Start the local agent on your computer and try again.',
    });
  }

  let connection: McpConnection | null = null;
  try {
    connection = await createAndConnectMcpClient(
      { transport, config, serverId: row.id },
      { userId },
    );
    const capabilities = connection.info.capabilities ?? {};
    const namePrefix = `mcp_${slugFromServerName(row.name, row.id)}`;

    const tools = capabilities.tools ? await listMcpTools(connection.client, '') : [];
    const resourcesResult = capabilities.resources ? await listMcpResources(connection.client) : undefined;
    const templatesResult = capabilities.resources ? await listMcpResourceTemplates(connection.client) : undefined;
    const promptsResult = capabilities.prompts ? await listMcpPrompts(connection.client) : undefined;

    const payload = {
      ok: true,
      transport: connection.info.transport,
      protocolEra: connection.info.protocolEra,
      protocolVersion: connection.info.protocolVersion,
      serverInfo: connection.info.serverInfo,
      instructions: connection.info.instructions,
      capabilities,
      tools: tools.map((tool) => ({
        name: tool.name,
        name_in_chat: prefixToolName(namePrefix, tool.mcpToolName),
        description: tool.openAIDef.function.description,
        parameters: tool.openAIDef.function.parameters,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      })),
      ...(resourcesResult ? { resources: resourcesResult.resources } : {}),
      ...(templatesResult ? { resourceTemplates: templatesResult.resourceTemplates } : {}),
      ...(promptsResult ? { prompts: promptsResult.prompts } : {}),
      counts: {
        tools: tools.length,
        ...(resourcesResult ? { resources: resourcesResult.resources.length } : {}),
        ...(templatesResult ? { resourceTemplates: templatesResult.resourceTemplates.length } : {}),
        ...(promptsResult ? { prompts: promptsResult.prompts.length } : {}),
      },
    };
    await connection.close();
    connection = null;
    return res.json(payload);
  } catch (error) {
    return res.json({ ok: false, error: redactError(error, config) });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeError) {
        console.error('MCP test cleanup error:', redactError(closeError, config));
      }
    }
  }
});

export default router;
