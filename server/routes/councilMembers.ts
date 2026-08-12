import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
import { validateOwnedIds } from '../mcp/ownership.js';
import type { CouncilMember, CouncilRun, CouncilResponse, CouncilRunDetail, CouncilComparison, ToolResultRecord, ToolCallSpec } from '../types.js';
import {
  assertProviderRoutingCompatible,
  parseProviderRoutingConfig,
  parseProviderRoutingMap,
  serializeProviderRoutingConfig,
  serializeProviderRoutingMap,
} from '../providerRouting.js';

const router = Router();

// GET /api/council/runs - List council runs for a conversation
router.get('/runs', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const conversationId = req.query.conversation_id as string;
    if (!conversationId) {
      res.status(400).json({ error: 'conversation_id is required' });
      return;
    }

    // Verify conversation belongs to user
    const conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const runs = db.prepare(`
      SELECT
        cr.id,
        cr.status,
        cr.member_count,
        cr.synthesizer_model,
        cr.total_cost,
        cr.total_tokens,
        cr.failed_members,
        cr.started_at,
        cr.completed_at,
        m.content as message_preview
      FROM council_runs cr
      LEFT JOIN messages m ON cr.message_id = m.id
      WHERE cr.conversation_id = ? AND cr.user_id = ?
      ORDER BY cr.created_at DESC
    `).all(conversationId, userId) as Array<{
      id: string;
      status: string;
      member_count: number;
      synthesizer_model: string;
      total_cost: number;
      total_tokens: number;
      failed_members: number;
      started_at: string;
      completed_at: string | null;
      message_preview: string | null;
    }>;

    res.json(runs.map((run) => ({
      ...run,
      successful_members: run.member_count - run.failed_members,
      message_preview: run.message_preview
        ? run.message_preview.substring(0, 100) + (run.message_preview.length > 100 ? '...' : '')
        : null,
    })));
  } catch (err) {
    console.error('Error listing council runs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/council/runs/:id - Get detailed council run with responses
router.get('/runs/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;

    const run = db.prepare(`
      SELECT
        cr.*,
        m.content as synthesis_content,
        m.reasoning_content as synthesis_reasoning,
        m.tokens_used as synthesis_tokens,
        m.cost as synthesis_cost,
        m.provider_routing as synthesis_provider_routing
      FROM council_runs cr
      LEFT JOIN messages m ON cr.message_id = m.id
      WHERE cr.id = ? AND cr.user_id = ?
    `).get(id, userId) as (CouncilRun & {
      synthesis_content?: string;
      synthesis_reasoning?: string;
      synthesis_tokens?: number;
      synthesis_cost?: number;
      synthesis_provider_routing?: unknown;
      comparison_json?: string | null;
    }) | undefined;

    if (!run) {
      res.status(404).json({ error: 'Council run not found' });
      return;
    }

    type RawRow = Omit<CouncilResponse, 'tool_calls' | 'tool_results'> & {
      tool_calls?: string | ToolCallSpec[];
      tool_results?: string;
      provider_routing?: unknown;
    };
    const rawResponses = db.prepare(`
      SELECT * FROM council_responses
      WHERE council_run_id = ?
      ORDER BY display_order ASC
    `).all(id) as RawRow[];
    const responses: CouncilResponse[] = rawResponses.map((r) => {
      const { tool_calls: rawTc, tool_results: rawTr, ...rest } = r;
      let tool_calls: CouncilResponse['tool_calls'];
      if (Array.isArray(rawTc)) {
        tool_calls = rawTc;
      } else if (typeof rawTc === 'string' && rawTc.trim()) {
        try {
          tool_calls = JSON.parse(rawTc) as CouncilResponse['tool_calls'];
        } catch {
          tool_calls = undefined;
        }
      } else {
        tool_calls = undefined;
      }
      let tool_results: ToolResultRecord[] | undefined;
      if (typeof rawTr === 'string' && rawTr.trim()) {
        try {
          const parsed = JSON.parse(rawTr) as unknown;
          tool_results = Array.isArray(parsed) ? parsed : undefined;
        } catch {
          tool_results = undefined;
        }
      }
      return {
        ...rest,
        provider_routing: parseProviderRoutingConfig(rest.provider_routing),
        tool_calls,
        tool_results,
      };
    });

    const rawShow = (run as { show_member_responses?: number }).show_member_responses;
    const comparisonJsonRaw = run.comparison_json;
    let comparison: CouncilComparison | undefined;
    if (comparisonJsonRaw && comparisonJsonRaw.trim()) {
      try {
        comparison = JSON.parse(comparisonJsonRaw) as CouncilComparison;
      } catch {
        comparison = undefined;
      }
    }
    const result: CouncilRunDetail = {
      ...run,
      show_member_responses: rawShow !== 0,
      responses,
      comparison,
      synthesizer_provider_routing: parseProviderRoutingConfig((run as unknown as { synthesizer_provider_routing?: unknown }).synthesizer_provider_routing),
      member_provider_routing: parseProviderRoutingMap((run as unknown as { member_provider_routing?: unknown }).member_provider_routing),
      synthesis_message: run.synthesis_content
        ? {
            id: run.message_id || '',
            conversation_id: run.conversation_id,
            role: 'assistant',
            content: run.synthesis_content,
            reasoning_content: run.synthesis_reasoning,
            tokens_used: run.synthesis_tokens || 0,
            cost: run.synthesis_cost || 0,
            model: run.synthesizer_model,
            provider_routing: parseProviderRoutingConfig(run.synthesis_provider_routing),
            council_run_id: run.id,
            created_at: run.completed_at || run.started_at,
          }
        : undefined,
    };

    res.json(result);
  } catch (err) {
    console.error('Error getting council run:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/council/members - List user's council configurations
router.get('/members', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const members = db.prepare(`
      SELECT * FROM council_members
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId) as CouncilMember[];

    // Parse JSON fields
    const parsed = members.map((m) => ({
      ...m,
      member_models: JSON.parse(m.member_models as unknown as string),
      member_provider_routing: parseProviderRoutingMap((m as unknown as { member_provider_routing?: unknown }).member_provider_routing),
      synthesizer_provider_routing: parseProviderRoutingConfig((m as unknown as { synthesizer_provider_routing?: unknown }).synthesizer_provider_routing),
      tool_ids: JSON.parse((m.tool_ids as unknown as string) || '[]'),
      mcp_server_ids: JSON.parse((m.mcp_server_ids as unknown as string) || '[]'),
    }));

    res.json(parsed);
  } catch (err) {
    console.error('Error listing council members:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/council/members - Create new council configuration
router.post('/members', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const {
      name,
      description,
      member_models,
      member_provider_routing,
      synthesizer_model,
      synthesizer_provider_routing,
      synthesis_prompt_template,
      auto_expand_responses,
      show_member_responses,
      tool_ids,
      mcp_server_ids,
    } = req.body as Partial<CouncilMember>;

    // Validation
    if (!name || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (!member_models || !Array.isArray(member_models) || member_models.length < 2) {
      res.status(400).json({ error: 'At least 2 member models are required' });
      return;
    }

    if (member_models.length > 10) {
      res.status(400).json({ error: 'Maximum 10 member models allowed' });
      return;
    }

    const ownedToolIds = validateOwnedIds(tool_ids ?? [], 'tool_ids', userId);
    if (!ownedToolIds.ok) {
      res.status(400).json({ error: ownedToolIds.error });
      return;
    }
    const ownedMcpServerIds = validateOwnedIds(mcp_server_ids ?? [], 'mcp_server_ids', userId);
    if (!ownedMcpServerIds.ok) {
      res.status(400).json({ error: ownedMcpServerIds.error });
      return;
    }

    const parsedMemberProviderRouting = parseProviderRoutingMap(member_provider_routing);
    const parsedSynthesizerProviderRouting = parseProviderRoutingConfig(synthesizer_provider_routing);
    try {
      for (const modelId of member_models) {
        assertProviderRoutingCompatible(modelId, parsedMemberProviderRouting[modelId]);
      }
      assertProviderRoutingCompatible(
        synthesizer_model || 'anthropic/claude-3.5-sonnet',
        parsedSynthesizerProviderRouting
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid provider routing' });
      return;
    }

    const id = nanoid();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO council_members (
        id, user_id, name, description, member_models, member_provider_routing, synthesizer_model,
        synthesizer_provider_routing, synthesis_prompt_template, auto_expand_responses, show_member_responses,
        tool_ids, mcp_server_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      name.trim(),
      description || null,
      JSON.stringify(member_models),
      serializeProviderRoutingMap(parsedMemberProviderRouting),
      synthesizer_model || 'anthropic/claude-3.5-sonnet',
      serializeProviderRoutingConfig(parsedSynthesizerProviderRouting),
      synthesis_prompt_template || null,
      auto_expand_responses ? 1 : 0,
      show_member_responses !== false ? 1 : 0,
      JSON.stringify(ownedToolIds.ids),
      JSON.stringify(ownedMcpServerIds.ids),
      now,
      now
    );

    const created = db.prepare('SELECT * FROM council_members WHERE id = ? AND user_id = ?').get(id, userId) as CouncilMember;
    res.status(201).json({
      ...created,
      member_models: JSON.parse(created.member_models as unknown as string),
      member_provider_routing: parseProviderRoutingMap((created as unknown as { member_provider_routing?: unknown }).member_provider_routing),
      synthesizer_provider_routing: parseProviderRoutingConfig((created as unknown as { synthesizer_provider_routing?: unknown }).synthesizer_provider_routing),
      tool_ids: JSON.parse((created.tool_ids as unknown as string) || '[]'),
      mcp_server_ids: JSON.parse((created.mcp_server_ids as unknown as string) || '[]'),
    });
  } catch (err) {
    console.error('Error creating council member:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/council/members/:id - Update council configuration
router.put('/members/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;

    // Verify ownership
    const existing = db.prepare('SELECT * FROM council_members WHERE id = ? AND user_id = ?').get(id, userId) as CouncilMember | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Council configuration not found' });
      return;
    }

    const {
      name,
      description,
      member_models,
      member_provider_routing,
      synthesizer_model,
      synthesizer_provider_routing,
      synthesis_prompt_template,
      auto_expand_responses,
      show_member_responses,
      tool_ids,
      mcp_server_ids,
    } = req.body as Partial<CouncilMember>;

    // Validation
    if (member_models) {
      if (!Array.isArray(member_models) || member_models.length < 2) {
        res.status(400).json({ error: 'At least 2 member models are required' });
        return;
      }
      if (member_models.length > 10) {
        res.status(400).json({ error: 'Maximum 10 member models allowed' });
        return;
      }
    }

    const nextMemberModels = member_models ?? JSON.parse(existing.member_models as unknown as string) as string[];
    const nextMemberProviderRouting = member_provider_routing !== undefined
      ? parseProviderRoutingMap(member_provider_routing)
      : parseProviderRoutingMap((existing as unknown as { member_provider_routing?: unknown }).member_provider_routing);
    const nextSynthesizerModel = synthesizer_model ?? existing.synthesizer_model;
    const nextSynthesizerProviderRouting = synthesizer_provider_routing !== undefined
      ? parseProviderRoutingConfig(synthesizer_provider_routing)
      : parseProviderRoutingConfig((existing as unknown as { synthesizer_provider_routing?: unknown }).synthesizer_provider_routing);

    try {
      for (const modelId of nextMemberModels) {
        assertProviderRoutingCompatible(modelId, nextMemberProviderRouting[modelId]);
      }
      assertProviderRoutingCompatible(nextSynthesizerModel, nextSynthesizerProviderRouting);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid provider routing' });
      return;
    }

    let ownedToolIds: string[] | undefined;
    if (tool_ids !== undefined) {
      const validation = validateOwnedIds(tool_ids, 'tool_ids', userId);
      if (!validation.ok) {
        res.status(400).json({ error: validation.error });
        return;
      }
      ownedToolIds = validation.ids;
    }
    let ownedMcpServerIds: string[] | undefined;
    if (mcp_server_ids !== undefined) {
      const validation = validateOwnedIds(mcp_server_ids, 'mcp_server_ids', userId);
      if (!validation.ok) {
        res.status(400).json({ error: validation.error });
        return;
      }
      ownedMcpServerIds = validation.ids;
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name.trim());
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (member_models !== undefined) {
      updates.push('member_models = ?');
      values.push(JSON.stringify(member_models));
    }
    if (member_provider_routing !== undefined) {
      updates.push('member_provider_routing = ?');
      values.push(serializeProviderRoutingMap(nextMemberProviderRouting));
    }
    if (synthesizer_model !== undefined) {
      updates.push('synthesizer_model = ?');
      values.push(synthesizer_model);
    }
    if (synthesizer_provider_routing !== undefined) {
      updates.push('synthesizer_provider_routing = ?');
      values.push(serializeProviderRoutingConfig(nextSynthesizerProviderRouting));
    }
    if (synthesis_prompt_template !== undefined) {
      updates.push('synthesis_prompt_template = ?');
      values.push(synthesis_prompt_template);
    }
    if (auto_expand_responses !== undefined) {
      updates.push('auto_expand_responses = ?');
      values.push(auto_expand_responses ? 1 : 0);
    }
    if (show_member_responses !== undefined) {
      updates.push('show_member_responses = ?');
      values.push(show_member_responses ? 1 : 0);
    }
    if (ownedToolIds !== undefined) {
      updates.push('tool_ids = ?');
      values.push(JSON.stringify(ownedToolIds));
    }
    if (ownedMcpServerIds !== undefined) {
      updates.push('mcp_server_ids = ?');
      values.push(JSON.stringify(ownedMcpServerIds));
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    values.push(userId);

    db.prepare(`
      UPDATE council_members
      SET ${updates.join(', ')}
      WHERE id = ? AND user_id = ?
    `).run(...values);

    const updated = db.prepare('SELECT * FROM council_members WHERE id = ? AND user_id = ?').get(id, userId) as CouncilMember;
    res.json({
      ...updated,
      member_models: JSON.parse(updated.member_models as unknown as string),
      member_provider_routing: parseProviderRoutingMap((updated as unknown as { member_provider_routing?: unknown }).member_provider_routing),
      synthesizer_provider_routing: parseProviderRoutingConfig((updated as unknown as { synthesizer_provider_routing?: unknown }).synthesizer_provider_routing),
      tool_ids: JSON.parse((updated.tool_ids as unknown as string) || '[]'),
      mcp_server_ids: JSON.parse((updated.mcp_server_ids as unknown as string) || '[]'),
    });
  } catch (err) {
    console.error('Error updating council member:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/council/members/:id - Delete council configuration
router.delete('/members/:id', (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;

    const result = db.prepare('DELETE FROM council_members WHERE id = ? AND user_id = ?').run(id, userId);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Council configuration not found' });
      return;
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error deleting council member:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
