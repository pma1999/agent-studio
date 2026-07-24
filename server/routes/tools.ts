import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { getAllBuiltinNames } from '../tools/registry.js';
import { AuthRequest } from '../middleware/auth.js';

const router = Router();

const NAME_REGEX = /^[a-z][a-z0-9_]*$/;

// Names reserved outright for the Agent Skills feature's own built-in tools (see
// server/skills/activation.ts). No custom tool — builtin or http — may use these names,
// to prevent a name collision that would make runTool()'s name-based dispatch ambiguous.
export const RESERVED_SKILL_TOOL_NAMES = ['activate_skill', 'read_skill_resource', 'run_skill_script'] as const;

// GET /api/tools - List all tools
router.get('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = db.prepare('SELECT * FROM tools WHERE user_id = ? ORDER BY type ASC, name ASC').all(userId) as Record<string, unknown>[];
    const parsed = rows.map((r) => ({
      ...r,
      parameters_schema: r.parameters_schema ? JSON.parse(r.parameters_schema as string) : {},
      config: r.config ? JSON.parse(r.config as string) : null,
    }));
    res.json(parsed);
  } catch (err) {
    console.error('Error listing tools:', err);
    res.status(500).json({ error: 'Failed to list tools' });
  }
});

// GET /api/tools/:id - Get one tool
router.get('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = db.prepare('SELECT * FROM tools WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown> | undefined;
    if (!row) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    const parsed = {
      ...row,
      parameters_schema: row.parameters_schema ? JSON.parse(row.parameters_schema as string) : {},
      config: row.config ? JSON.parse(row.config as string) : null,
    };
    res.json(parsed);
  } catch (err) {
    console.error('Error getting tool:', err);
    res.status(500).json({ error: 'Failed to get tool' });
  }
});

// POST /api/tools - Create tool
router.post('/', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { name, description, parameters_schema, type, config } = req.body;

    if (!name || typeof name !== 'string' || !description || typeof description !== 'string') {
      return res.status(400).json({ error: 'name and description are required' });
    }
    const trimmedName = name.trim();
    if (!NAME_REGEX.test(trimmedName)) {
      return res.status(400).json({ error: 'name must be snake_case (e.g. web_search, get_current_time)' });
    }
    if ((RESERVED_SKILL_TOOL_NAMES as readonly string[]).includes(trimmedName)) {
      return res.status(400).json({ error: `"${trimmedName}" is a reserved name used by the Skills feature and cannot be used for a custom tool` });
    }

    const schema = parameters_schema != null ? (typeof parameters_schema === 'string' ? JSON.parse(parameters_schema) : parameters_schema) : { type: 'object', properties: {}, required: [] };
    if (!schema || schema.type !== 'object') {
      return res.status(400).json({ error: 'parameters_schema must be a JSON object with type "object"' });
    }

    const toolType = (type || 'http').toLowerCase();
    if (toolType !== 'builtin' && toolType !== 'http') {
      return res.status(400).json({ error: 'type must be "builtin" or "http"' });
    }

    if (toolType === 'builtin') {
      const allowed = getAllBuiltinNames();
      if (!allowed.includes(trimmedName)) {
        return res.status(400).json({ error: `builtin tool must be one of: ${allowed.join(', ')}` });
      }
      const existing = db.prepare('SELECT id FROM tools WHERE name = ? AND user_id = ?').get(trimmedName, userId);
      if (existing) {
        return res.status(400).json({ error: 'A tool with this name already exists' });
      }
    }

    if (toolType === 'http') {
      const cfg = config != null ? (typeof config === 'string' ? JSON.parse(config) : config) : {};
      if (!cfg.url || typeof cfg.url !== 'string' || !cfg.url.trim()) {
        return res.status(400).json({ error: 'HTTP tools require config.url' });
      }
      const method = (cfg.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') {
        return res.status(400).json({ error: 'config.method must be GET or POST' });
      }
    }

    const id = nanoid();
    const configStr = config != null ? JSON.stringify(typeof config === 'string' ? JSON.parse(config) : config) : null;
    db.prepare(`
      INSERT INTO tools (id, user_id, name, description, parameters_schema, type, config)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, trimmedName, description.trim(), JSON.stringify(schema), toolType, configStr);

    const row = db.prepare('SELECT * FROM tools WHERE id = ?').get(id) as Record<string, unknown>;
    const parsed = {
      ...row,
      parameters_schema: row.parameters_schema ? JSON.parse(row.parameters_schema as string) : {},
      config: row.config ? JSON.parse(row.config as string) : null,
    };
    res.status(201).json(parsed);
  } catch (err) {
    console.error('Error creating tool:', err);
    res.status(500).json({ error: 'Failed to create tool' });
  }
});

// PUT /api/tools/:id - Update tool (description, parameters_schema, config only)
router.put('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const existing = db.prepare('SELECT * FROM tools WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown> | undefined;
    if (!existing) {
      return res.status(404).json({ error: 'Tool not found' });
    }

    const { description, parameters_schema, config } = req.body;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(typeof description === 'string' ? description.trim() : description);
    }
    if (parameters_schema !== undefined) {
      const schema = typeof parameters_schema === 'string' ? JSON.parse(parameters_schema) : parameters_schema;
      if (!schema || schema.type !== 'object') {
        return res.status(400).json({ error: 'parameters_schema must be a JSON object with type "object"' });
      }
      updates.push('parameters_schema = ?');
      values.push(JSON.stringify(schema));
    }
    if (config !== undefined) {
      const cfg = typeof config === 'string' ? JSON.parse(config) : config;
      const toolType = (existing.type as string) || 'http';
      if (toolType === 'http' && cfg && (!cfg.url || !cfg.url.trim())) {
        return res.status(400).json({ error: 'HTTP tools require config.url' });
      }
      updates.push('config = ?');
      values.push(cfg ? JSON.stringify(cfg) : null);
    }

    if (updates.length === 0) {
      const row = db.prepare('SELECT * FROM tools WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown>;
      return res.json({
        ...row,
        parameters_schema: row.parameters_schema ? JSON.parse(row.parameters_schema as string) : {},
        config: row.config ? JSON.parse(row.config as string) : null,
      });
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id, userId);
    db.prepare(`UPDATE tools SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM tools WHERE id = ? AND user_id = ?').get(req.params.id, userId) as Record<string, unknown>;
    const parsed = {
      ...row,
      parameters_schema: row.parameters_schema ? JSON.parse(row.parameters_schema as string) : {},
      config: row.config ? JSON.parse(row.config as string) : null,
    };
    res.json(parsed);
  } catch (err) {
    console.error('Error updating tool:', err);
    res.status(500).json({ error: 'Failed to update tool' });
  }
});

// DELETE /api/tools/:id - Delete tool (and remove from agent_tools). Do not allow deleting builtin by name.
router.delete('/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = db.prepare('SELECT id, name FROM tools WHERE id = ? AND user_id = ?').get(req.params.id, userId) as { id: string; name: string } | undefined;
    if (!row) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    const builtinNames = getAllBuiltinNames();
    if (builtinNames.includes(row.name)) {
      return res.status(400).json({ error: 'Built-in tools cannot be deleted. Remove them from agents instead.' });
    }
    db.prepare('DELETE FROM agent_tools WHERE tool_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tools WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting tool:', err);
    res.status(500).json({ error: 'Failed to delete tool' });
  }
});

export default router;
