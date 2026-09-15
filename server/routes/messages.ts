import { Router, Response } from 'express';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
import { parseProviderRoutingConfig } from '../providerRouting.js';
import { buildThreadIds } from '../messageTree.js';
import { estimateTokens } from '../compaction/serialize.js';
import { resolveWindow, SUGGEST_PCT } from '../compaction/policy.js';
import { getSettingValue } from './settings.js';
import {
  resolveToolsForAgent,
  resolveToolsFromIds,
  toOpenRouterTools,
  getConversationToolOverride,
  selectToolResolutionSource,
} from '../tools/index.js';

const router = Router();

const GENERAL_DEFAULT_MODEL = 'openrouter/auto';
const GENERAL_DEFAULT_PROMPT =
  'You are a helpful AI assistant. You provide thoughtful, well-structured responses.';

/**
 * Parse a `compaction_meta` JSON column. Parse failures yield `{}` (banner
 * fields read as null, never a 500). Never throws.
 */
export function parseCompactionMeta(raw: string | null | undefined): Record<string, unknown> {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return {};
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export interface CompactionDescriptor {
  id: string;
  created_at: unknown;
  model: unknown;
  tokens_before: unknown;
  tokens_after: unknown;
  focus: unknown;
  pre_compact_leaf_id: unknown;
  messages_compacted: unknown;
  tail_message_ids: unknown;
  count: number;
}

interface CompactionThreadRow {
  id: string;
  created_at?: unknown;
  role: string;
  model?: unknown;
  compaction_meta?: string | null;
}

/**
 * Newest checkpoint descriptor in the VISIBLE thread (root → leaf order),
 * or null when the thread has no `role='compaction'` row. `totalCount` is
 * supplied by the caller and surfaces as `count` — the route passes the number
 * of checkpoints ON THIS THREAD (checkpoints abandoned by an Undo are off-thread
 * and must not be counted). Field values come from the row + parsed meta;
 * corrupt meta degrades to null fields, never throws.
 */
export function selectVisibleCompaction(
  threadRowsInOrder: CompactionThreadRow[],
  totalCount: number,
): CompactionDescriptor | null {
  let newest: CompactionThreadRow | null = null;
  for (const row of threadRowsInOrder) {
    if (row.role === 'compaction') newest = row;
  }
  if (!newest) return null;
  const meta = parseCompactionMeta(newest.compaction_meta ?? null);
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const strArrayOrNull = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((id): id is string => typeof id === 'string') ? [...v] : null;
  return {
    id: newest.id,
    created_at: newest.created_at ?? null,
    model: meta.model ?? newest.model ?? null,
    tokens_before: numOrNull(meta.tokens_before),
    tokens_after: numOrNull(meta.tokens_after),
    focus: (meta.focus as unknown) ?? null,
    pre_compact_leaf_id: (meta.pre_compact_leaf_id as unknown) ?? null,
    messages_compacted: numOrNull(meta.messages_compacted),
    tail_message_ids: strArrayOrNull(meta.tail_message_ids),
    count: totalCount,
  };
}

export interface ContextEstimateTailRow {
  content: unknown;
  tool_calls?: string | null;
  reasoning_content?: string | null;
  annotations?: string | null;
  attachments?: string | null;
}

export interface ContextEstimateInput {
  systemPrompt: string;
  /** Stored compaction content verbatim (prefix + template), or null when no checkpoint. */
  summaryContent: string | null;
  /** Tail rows of the CURRENT model view (after the last checkpoint, or the full thread). */
  tailRows: ContextEstimateTailRow[];
  /** `JSON.stringify` of the resolved tool definitions for this conversation. */
  toolsJson: string;
  effectiveModel: string;
}

export interface ContextEstimate {
  tokens: number;
  limit: number | null;
  pct: number | null;
  suggest_compact: boolean;
}

/**
 * Advisory context estimate over the CURRENT model view (G7/G12): system
 * prompt chars + summary content chars (0 without a checkpoint) + tail-row
 * chars (content + tool/reasoning/annotation/attachment raw fields, i.e. what
 * travels verbatim to the provider) + resolved tool-def JSON chars — each
 * component via `estimateTokens` (G5 `ceil(chars/4)`), summed. `limit` is
 * `resolveWindow(effectiveModel)`; unknown windows yield
 * `limit:null, pct:null` with the advisory off. Suggests at 60% (`SUGGEST_PCT`).
 */
export function buildContextEstimate(input: ContextEstimateInput): ContextEstimate {
  let tokens = estimateTokens(input.systemPrompt ?? '');
  if (input.summaryContent) tokens += estimateTokens(input.summaryContent);
  for (const row of input.tailRows) {
    let contentText: string;
    if (typeof row.content === 'string') {
      contentText = row.content;
    } else if (row.content == null) {
      contentText = '';
    } else {
      try {
        contentText = JSON.stringify(row.content) ?? '';
      } catch {
        contentText = '';
      }
    }
    tokens += estimateTokens(contentText);
    if (row.tool_calls) tokens += estimateTokens(row.tool_calls);
    if (row.reasoning_content) tokens += estimateTokens(row.reasoning_content);
    if (row.annotations) tokens += estimateTokens(row.annotations);
    if (row.attachments) tokens += estimateTokens(row.attachments);
  }
  tokens += estimateTokens(input.toolsJson ?? '');
  const limit = typeof input.effectiveModel === 'string' ? resolveWindow(input.effectiveModel) : null;
  if (limit == null) return { tokens, limit: null, pct: null, suggest_compact: false };
  const pct = tokens / limit;
  return { tokens, limit, pct, suggest_compact: pct >= SUGGEST_PCT };
}

function readGeneralSettings(userId: string): { model: string; system_prompt: string; tool_ids: string[]; mcp_server_ids: string[] } {
  const parseIds = (key: string): string[] => {
    const raw = getSettingValue(userId, key);
    if (!raw || typeof raw !== 'string') return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    model: getSettingValue(userId, 'general_chat_model') || GENERAL_DEFAULT_MODEL,
    system_prompt: getSettingValue(userId, 'general_chat_system_prompt') || GENERAL_DEFAULT_PROMPT,
    tool_ids: parseIds('general_chat_tool_ids'),
    mcp_server_ids: parseIds('general_chat_mcp_server_ids'),
  };
}

// GET /api/conversations/:id/messages - Get all messages for a conversation
router.get('/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, userId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = db.prepare(`
      SELECT m.*, a.name as processed_by_agent_name
      FROM messages m
      LEFT JOIN agents a ON m.processed_by_agent_id = a.id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
    `).all(req.params.id) as Record<string, unknown>[];

    // Parse JSON columns (annotations, tool_calls, attachments)
    const parsed = messages.map((msg) => ({
      ...msg,
      annotations: msg.annotations ? JSON.parse(msg.annotations as string) : null,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls as string) : null,
      attachments: msg.attachments ? JSON.parse(msg.attachments as string) : null,
      provider_routing: parseProviderRoutingConfig(msg.provider_routing),
    }));

    // Deliberate contract change: the flat array becomes { messages, active_leaf_id }
    // so the client can render the thread tree (editing / variants / branches).
    // active_turn_id (plan.md S6) is additive and optional for poll-based reopen
    // reconciliation; null whenever no turn is live.
    //
    // Compact-view additions (G7, additive only — the three fields above are
    // untouched): `compaction` (newest checkpoint descriptor in the VISIBLE
    // thread, or null) + `context_estimate` (advisory over the CURRENT model
    // view). View computation never fails the request: corrupt meta degrades
    // to null fields and estimator errors fall back to advisory-off.
    const conv = conversation as {
      active_leaf_id?: string | null;
      active_turn_id?: string | null;
      agent_id?: string | null;
      model?: string | null;
    };
    let compaction: CompactionDescriptor | null = null;
    let contextEstimate: ContextEstimate = { tokens: 0, limit: null, pct: null, suggest_compact: false };
    try {
      const activeLeafId = conv.active_leaf_id ?? null;
      const threadIds = buildThreadIds(req.params.id, activeLeafId);
      const byId = new Map<string, Record<string, unknown>>(messages.map((m) => [String(m.id), m]));
      const threadRows = threadIds
        .map((id) => byId.get(id))
        .filter((r): r is Record<string, unknown> => !!r);
      // Checkpoints ON THE VISIBLE THREAD, not conversation-wide: an Undone
      // checkpoint hangs off an abandoned branch, is invisible in the UI, and
      // must not inflate the count that drives the multi-compaction accuracy
      // warning (the client now renders exactly one card per thread checkpoint).
      const totalCount = threadRows.reduce((n, r) => (String(r.role) === 'compaction' ? n + 1 : n), 0);
      compaction = selectVisibleCompaction(
        threadRows.map((r) => ({
          id: String(r.id),
          created_at: r.created_at,
          role: String(r.role),
          model: r.model,
          compaction_meta: (r.compaction_meta as string | null) ?? null,
        })),
        totalCount,
      );

      let lastCompIdx = -1;
      for (let i = 0; i < threadRows.length; i++) {
        if (String(threadRows[i]!.role) === 'compaction') lastCompIdx = i;
      }
      const summaryContent =
        lastCompIdx >= 0 ? String((threadRows[lastCompIdx] as Record<string, unknown>).content ?? '') : null;
      const tailRows = (lastCompIdx >= 0 ? threadRows.slice(lastCompIdx + 1) : threadRows).map((r) => ({
        content: r.content as unknown,
        tool_calls: (r.tool_calls as string | null) ?? null,
        reasoning_content: (r.reasoning_content as string | null) ?? null,
        annotations: (r.annotations as string | null) ?? null,
        attachments: (r.attachments as string | null) ?? null,
      }));

      // Effective model + system prompt mirror POST /api/chat precedence
      // (message override N/A here): conversation.model || agent.model.
      let agent: { system_prompt: string; model: string } | undefined;
      if (conv.agent_id) {
        agent = db.prepare('SELECT system_prompt, model FROM agents WHERE id = ? AND user_id = ?').get(conv.agent_id, userId) as
          | { system_prompt: string; model: string }
          | undefined;
      }
      const general = readGeneralSettings(userId);
      const systemPrompt = agent?.system_prompt ?? general.system_prompt;
      const effectiveModel = conv.model || agent?.model || general.model;

      // Resolved tool-def JSON chars (same source hierarchy as chat; MCP
      // failures degrade to '[]', never to a 500).
      let toolsJson = '[]';
      try {
        const override = getConversationToolOverride(req.params.id, userId);
        const isGeneralChat = !conv.agent_id;
        const source = selectToolResolutionSource({
          conversationOverride: override,
          isGeneralChat,
          generalSettings: { tool_ids: general.tool_ids, mcp_server_ids: general.mcp_server_ids },
        });
        if (source.kind === 'agent-default') {
          if (conv.agent_id) {
            const resolved = await resolveToolsForAgent(conv.agent_id, userId);
            try {
              toolsJson = JSON.stringify(toOpenRouterTools(resolved.resolvedTools));
            } finally {
              const closes = [...new Set(resolved.mcpClients.values())].map((c) => c.close());
              await Promise.allSettled(closes);
            }
          }
        } else {
          const resolved = await resolveToolsFromIds(source.tool_ids, source.mcp_server_ids, userId);
          try {
            toolsJson = JSON.stringify(toOpenRouterTools(resolved.resolvedTools));
          } finally {
            const closes = [...new Set(resolved.mcpClients.values())].map((c) => c.close());
            await Promise.allSettled(closes);
          }
        }
      } catch {
        toolsJson = '[]';
      }

      contextEstimate = buildContextEstimate({
        systemPrompt,
        summaryContent,
        tailRows,
        toolsJson,
        effectiveModel: effectiveModel ?? '',
      });
    } catch {
      // View fields stay at their null/advisory-off defaults; the durable
      // array + cursors below are unaffected.
    }

    res.json({
      messages: parsed,
      active_leaf_id: (conversation as { active_leaf_id?: string | null }).active_leaf_id ?? null,
      active_turn_id: (conversation as { active_turn_id?: string | null }).active_turn_id ?? null,
      compaction,
      context_estimate: contextEstimate,
    });
  } catch (err) {
    console.error('Error listing messages:', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

export default router;
