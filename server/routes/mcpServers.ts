import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { createAndConnectMcpClient, listMcpTools, prefixToolName } from '../mcp/index.js';
import { slugFromServerName } from '../tools/index.js';
import type { McpServerConfig, McpTransport } from '../mcp/types.js';
import { AuthRequest } from '../middleware/auth.js';

const router = Router();

function parseConfig(configStr: string | null): McpServerConfig | null {
  if (!configStr) return null;
  try {
    return JSON.parse(configStr) as McpServerConfig;
  } catch {
    return null;
  }
}

// GET /api/mcp-servers - List all MCP servers
router.get('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY name ASC').all(userId) as Record<string, unknown>[];
    const result = rows.map((r) => ({
      ...r,
      config: r.config ? parseConfig(r.config as string) : null,
    }));
    res.json(result);
  } catch (err) {
    console.error('Error listing MCP servers:', err);
    res.status(500).json({ error: 'Failed to list MCP servers' });
  }
});

// GET /api/mcp-servers/:id - Get one MCP server
router.get('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown> | undefined;
    if (!row) {
      return res.status(404).json({ error: 'MCP server not found' });
    }
    const result = {
      ...row,
      config: row.config ? parseConfig(row.config as string) : null,
    };
    res.json(result);
  } catch (err) {
    console.error('Error getting MCP server:', err);
    res.status(500).json({ error: 'Failed to get MCP server' });
  }
});

// POST /api/mcp-servers - Create MCP server
router.post('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { name, transport, config } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const t = (transport || 'url').toLowerCase();
    if (t !== 'url' && t !== 'stdio') {
      return res.status(400).json({ error: 'transport must be "url" or "stdio"' });
    }

    const cfg = config != null ? (typeof config === 'string' ? JSON.parse(config) : config) : {};
    if (t === 'url') {
      if (!cfg.url || typeof cfg.url !== 'string' || !cfg.url.trim()) {
        return res.status(400).json({ error: 'config.url is required for URL transport' });
      }
      if (cfg.headers !== undefined && (typeof cfg.headers !== 'object' || Array.isArray(cfg.headers) || cfg.headers === null)) {
        return res.status(400).json({ error: 'config.headers must be an object of string key-value pairs' });
      }
    } else {
      if (!cfg.command || typeof cfg.command !== 'string' || !cfg.command.trim()) {
        return res.status(400).json({ error: 'config.command is required for stdio transport' });
      }
      if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
        return res.status(400).json({ error: 'config.args must be an array of strings' });
      }
      if (cfg.env !== undefined && (typeof cfg.env !== 'object' || Array.isArray(cfg.env) || cfg.env === null)) {
        return res.status(400).json({ error: 'config.env must be an object of string key-value pairs' });
      }
      if (cfg.cwd !== undefined && typeof cfg.cwd !== 'string') {
        return res.status(400).json({ error: 'config.cwd must be a string' });
      }
    }

    const id = nanoid();
    db.prepare(`
      INSERT INTO mcp_servers (id, user_id, name, transport, config)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, name.trim(), t, JSON.stringify(cfg));

    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Record<string, unknown>;
    const result = {
      ...row,
      config: row.config ? parseConfig(row.config as string) : null,
    };
    res.status(201).json(result);
  } catch (err) {
    console.error('Error creating MCP server:', err);
    res.status(500).json({ error: 'Failed to create MCP server' });
  }
});

// PUT /api/mcp-servers/:id - Update MCP server
router.put('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const existing = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown> | undefined;
    if (!existing) {
      return res.status(404).json({ error: 'MCP server not found' });
    }

    const { name, transport, config } = req.body;

    let t: McpTransport | null = null;
    if (transport !== undefined) {
      const tLower = (transport as string).toLowerCase();
      if (tLower !== 'url' && tLower !== 'stdio') {
        return res.status(400).json({ error: 'transport must be "url" or "stdio"' });
      }
      t = tLower as McpTransport;
    }

    let configStr: string | null = null;
    if (config !== undefined) {
      const cfg = typeof config === 'string' ? JSON.parse(config) : config;
      const effectiveTransport = (t ?? (existing.transport as string)) as McpTransport;
      if (effectiveTransport === 'url') {
        if (!cfg?.url || typeof cfg.url !== 'string' || !cfg.url.trim()) {
          return res.status(400).json({ error: 'config.url is required for URL transport' });
        }
        if (cfg.headers !== undefined && (typeof cfg.headers !== 'object' || Array.isArray(cfg.headers) || cfg.headers === null)) {
          return res.status(400).json({ error: 'config.headers must be an object of string key-value pairs' });
        }
      } else {
        if (!cfg?.command || typeof cfg.command !== 'string' || !cfg.command.trim()) {
          return res.status(400).json({ error: 'config.command is required for stdio transport' });
        }
        if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
          return res.status(400).json({ error: 'config.args must be an array of strings' });
        }
        if (cfg.env !== undefined && (typeof cfg.env !== 'object' || Array.isArray(cfg.env) || cfg.env === null)) {
          return res.status(400).json({ error: 'config.env must be an object of string key-value pairs' });
        }
        if (cfg.cwd !== undefined && typeof cfg.cwd !== 'string') {
          return res.status(400).json({ error: 'config.cwd must be a string' });
        }
      }
      configStr = JSON.stringify(cfg);
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    if (name !== undefined) {
      updates.push('name = ?');
      values.push(typeof name === 'string' ? name.trim() : name);
    }
    if (t !== null) {
      updates.push('transport = ?');
      values.push(t);
    }
    if (configStr !== null) {
      updates.push('config = ?');
      values.push(configStr);
    }
    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(req.params.id, userId);
      db.prepare(`UPDATE mcp_servers SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
    }

    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown>;
    const result = {
      ...row,
      config: row.config ? parseConfig(row.config as string) : null,
    };
    res.json(result);
  } catch (err) {
    console.error('Error updating MCP server:', err);
    res.status(500).json({ error: 'Failed to update MCP server' });
  }
});

// DELETE /api/mcp-servers/:id - Delete MCP server (cascade agent_mcp_servers)
router.delete('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = db.prepare('SELECT id FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!row) {
      return res.status(404).json({ error: 'MCP server not found' });
    }
    db.prepare('DELETE FROM agent_mcp_servers WHERE mcp_server_id = ?').run(req.params.id);
    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting MCP server:', err);
    res.status(500).json({ error: 'Failed to delete MCP server' });
  }
});

// POST /api/mcp-servers/:id/test - Connect and list tools (verify configuration)
router.post('/:id/test', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = db.prepare('SELECT id, name, transport, config FROM mcp_servers WHERE id = ? AND user_id = ?').get(req.params.id, userId) as
      | { id: string; name: string; transport: string; config: string }
      | undefined;
    if (!row) {
      return res.status(404).json({ error: 'MCP server not found' });
    }

    const config = parseConfig(row.config);
    if (!config) {
      return res.status(400).json({ ok: false, error: 'Invalid server config' });
    }

    const transport = row.transport as McpTransport;
    if (transport !== 'url' && transport !== 'stdio') {
      return res.status(400).json({ ok: false, error: 'Invalid transport' });
    }

    const connection = await createAndConnectMcpClient({ transport, config }, { userId });
    try {
      const tools = await listMcpTools(connection.client, '');

      // Gather server capabilities if available
      let capabilities: { resources?: boolean; prompts?: boolean; tools?: boolean } | undefined;
      try {
        const caps = connection.client.getServerCapabilities();
        if (caps) {
          capabilities = {
            resources: !!caps.resources,
            prompts: !!caps.prompts,
            tools: !!caps.tools,
          };
        }
      } catch { /* capabilities not critical */ }

      await connection.close();
      const namePrefix = `mcp_${slugFromServerName(row.name, row.id)}`;
      res.json({
        ok: true,
        tools: tools.map((t) => ({
          name: t.name,
          name_in_chat: prefixToolName(namePrefix, t.mcpToolName),
          description: t.openAIDef.function.description,
          parameters: t.openAIDef.function.parameters,
        })),
        capabilities,
      });
    } catch (err) {
      await connection.close();
      throw err;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('MCP test error:', err);
    res.json({ ok: false, error: msg });
  }
});

export default router;
