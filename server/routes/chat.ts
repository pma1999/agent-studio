import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { getSettingValue } from './settings.js';
import { resolveToolsForAgent, resolveToolsFromIds, toOpenRouterTools, runTool, appendToolInstructionsIfNeeded, getConversationToolOverride, selectToolResolutionSource } from '../tools/index.js';
import { annotationsFromWebSearchResults } from '../tools/registry.js';
import { runCommandTool } from '../tools/execCommand.js';
import type { RunToolResult } from '../tools/run.js';
import { parseReasoningToolCalls } from '../utils/parseReasoningToolCalls.js';
import {
  requestMcpToolApproval,
  type McpConnection,
  type McpToolAuthorizationRequest,
} from '../mcp/index.js';
import { AuthRequest } from '../middleware/auth.js';
import { trackStream, untrackStream, isShuttingDown } from '../shutdown.js';
import {
  assertProviderRoutingCompatible,
  buildOpenRouterProviderPreference,
  normalizeProviderRoutingConfig,
  parseProviderRoutingConfig,
  resolveProviderRouting,
  serializeProviderRoutingConfig,
  type ProviderRoutingConfig,
} from '../providerRouting.js';
import {
  getProviderForModel,
  toUpstreamModelId,
  assistantReasoningField,
  resolveAssistantHistoryContent,
  buildDeepSeekThinking,
  computeDeepSeekCost,
  deepSeekCachedTokens,
  isCodexModel,
  isLlamacppModel,
  persistedModelId,
} from '../providers/index.js';
import {
  createThinkStreamSplitter,
  isLegacyLmStudioModel,
  REMOVED_LMSTUDIO_MESSAGE,
  type ThinkSplitResult,
} from '../providers/llamacpp.js';
import {
  ensureLlamacppRunning,
  llamacppFetch,
  resolveLlamacppConfig,
  resolveLlamacppSamplingForModel,
} from '../providers/llamacppTransport.js';
import { runCodexTurn } from '../codex/chat.js';
import { CodexUnavailableError } from '../codex/instanceManager.js';
import { buildDateTimeContext, injectDateTimeIntoCurrentTurn } from '../dateTimeContext.js';
import {
  appendSkillCatalogIfNeeded,
  buildActivateSkillTool,
  buildReadSkillResourceTool,
  buildRunSkillScriptTool,
  hasSkillAlreadyActivated,
  injectSkillActivationIntoCurrentTurn,
  tryActivateSkill,
} from '../skills/activation.js';
import {
  getConversationSkillOverride,
  resolveSkillsForAgent,
  resolveSkillsFromIds,
  selectSkillResolutionSource,
} from '../skills/resolve.js';
import type { ResolvedSkill } from '../skills/resolve.js';
import {
  AUTO_CONVERSATION_TITLES_SETTING_KEY,
  createFallbackConversationTitle,
  generateConversationTitleWithOpenRouter,
  isAutoConversationTitlesEnabled,
} from '../conversationTitles.js';
import { buildThreadIds } from '../messageTree.js';
import {
  registerTurn,
  markTurnDisconnected,
  findTurnByConversation,
  abortTurn,
  clearTurn,
} from '../chatTurnRegistry.js';

const router = Router();

interface Agent {
  id: string;
  name: string;
  system_prompt: string;
  provider: string;
  base_url: string;
  model: string;
  provider_routing?: unknown;
  temperature: number;
  max_tokens: number;
  web_search_enabled: number; // SQLite boolean
  reasoning_enabled: number; // SQLite boolean
  reasoning_effort: string | null;
  reasoning_max_tokens: number | null;
  tool_choice?: string; // 'auto' | 'none'
  parallel_tool_calls?: number; // 0 | 1
  structured_output_enabled?: number;
  structured_output_schema?: string | null;
  response_healing_enabled?: number;
}

interface Conversation {
  id: string;
  user_id: string;
  agent_id: string | null;
  title: string;
  /** Per-conversation model override (from conversations.model column). */
  model?: string | null;
  provider_routing?: unknown;
  /** Message-tree cursor: id of the last message of the currently visible thread. */
  active_leaf_id?: string | null;
}

interface Annotation {
  type: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
  file?: { hash: string; name?: string; content?: unknown[] };
}

const MAX_PDF_ATTACHMENTS = 5;
const MAX_PDF_BASE64_BYTES = 20 * 1024 * 1024; // 20 MB
const PDF_ENGINES = ['pdf-text', 'mistral-ocr', 'native'] as const;
type PDFEngine = (typeof PDF_ENGINES)[number];

function readNonNegativeNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const MAX_TOOL_CALLS_PER_TURN = readNonNegativeNumberEnv('MAX_TOOL_CALLS_PER_TURN', 100_000);
export const MAX_TOOL_TIME_MS_PER_TURN = readNonNegativeNumberEnv('MAX_TOOL_TIME_MS_PER_TURN', 24 * 3_600_000);

export function isToolBudgetExceeded(toolCallCount: number, toolTimeMs: number): boolean {
  return toolCallCount >= MAX_TOOL_CALLS_PER_TURN || toolTimeMs >= MAX_TOOL_TIME_MS_PER_TURN;
}

/**
 * Skill tools (activate_skill, read_skill_resource, run_skill_script) are the reserved,
 * canonical owners of their names. If a stale/pre-existing user tool happens to share one of
 * these names (e.g. created before the tools.ts CRUD-level reservation existed), it must never
 * shadow or collide with the real skill tool in the final list sent to the model — the skill
 * tool always wins.
 */
export function excludeReservedSkillToolNames<T extends { name: string }>(
  baseTools: T[],
  skillTools: T[],
): T[] {
  const skillToolNames = new Set(skillTools.map((t) => t.name));
  return [
    ...baseTools.filter((t) => !skillToolNames.has(t.name)),
    ...skillTools,
  ];
}

export function buildToolOutputChunkEvent(
  id: string,
  chunk: { stream: 'stdout' | 'stderr'; text: string },
  seq: number,
) {
  return { tool_output_chunk: { id, stream: chunk.stream, text: chunk.text, seq } };
}

export function buildToolResultEvent(
  id: string,
  name: string,
  result: RunToolResult,
  durationMs: number,
) {
  return {
    tool_result: {
      id,
      name,
      ok: !result.isError,
      result: result.output,
      duration_ms: durationMs,
      source: result.source,
      ...(name === 'run_command' && result.metadata ? { metadata: result.metadata } : {}),
    },
  };
}

function isPDFEngine(s: unknown): s is PDFEngine {
  return typeof s === 'string' && PDF_ENGINES.includes(s as PDFEngine);
}

interface ChatAttachmentInput {
  filename: string;
  file_data?: string;
  url?: string;
}

function normalizeFileData(raw: string): string {
  const s = String(raw).trim();
  if (s.startsWith('data:application/pdf;base64,')) return s;
  if (s.startsWith('data:')) return s;
  return `data:application/pdf;base64,${s}`;
}

function validateAttachments(attachments: unknown): { valid: ChatAttachmentInput[]; error?: string } {
  if (!attachments || !Array.isArray(attachments)) return { valid: [] };
  if (attachments.length > MAX_PDF_ATTACHMENTS) {
    return { valid: [], error: `Maximum ${MAX_PDF_ATTACHMENTS} PDFs per message` };
  }
  const valid: ChatAttachmentInput[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    if (!a || typeof a !== 'object') continue;
    const filename = typeof (a as Record<string, unknown>).filename === 'string' ? (a as Record<string, unknown>).filename as string : '';
    const file_data = (a as Record<string, unknown>).file_data;
    const url = (a as Record<string, unknown>).url;
    const hasData = file_data !== undefined && file_data !== null && String(file_data).trim().length > 0;
    const hasUrl = typeof url === 'string' && url.trim().length > 0 && (url.startsWith('http://') || url.startsWith('https://'));
    if (!filename.toLowerCase().endsWith('.pdf')) {
      return { valid: [], error: `Attachment ${i + 1}: filename must end with .pdf` };
    }
    if (!hasData && !hasUrl) {
      return { valid: [], error: `Attachment ${i + 1}: provide file_data (base64) or url` };
    }
    if (hasData) {
      const raw = String(file_data).trim();
      const base64Part = raw.startsWith('data:') ? raw.split(',')[1] || raw : raw;
      const estimatedBytes = (base64Part.length * 3) / 4;
      if (estimatedBytes > MAX_PDF_BASE64_BYTES) {
        return { valid: [], error: `Attachment ${filename}: file too large (max 20 MB)` };
      }
    }
    valid.push({
      filename: filename || 'document.pdf',
      ...(hasData && { file_data: normalizeFileData(String(file_data)) }),
      ...(hasUrl && { url: (url as string).trim() }),
    });
  }
  return { valid };
}

// POST /api/chat/stop - Explicit Stop protocol (plan S4 / policy d / GC6).
// Aborts the registered live turn for a conversation; mere disconnects never
// do this. Owner-scoped via the registry's userId match.
router.post('/stop', (req: AuthRequest, res: Response): void => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const conversationId = (req.body as { conversation_id?: string }).conversation_id;
  // Uniform 404 for unknown AND foreign conversations — no existence oracle
  // across users (GC10). Keying by conversation is safe because the atomic
  // claim guarantees at most one active turn per conversation.
  const turn = conversationId ? findTurnByConversation(conversationId) : undefined;
  if (!turn || turn.userId !== userId) {
    res.status(404).json({ error: 'Turn not found' });
    return;
  }
  // Fires onAbort('stop') synchronously in the streaming request's context
  // (recording the reason + aborting its controller); that request then
  // finalizes its draft with generation_status='stopped' and releases the claim.
  abortTurn(turn.turnId, 'stop');
  res.status(200).json({ stopped: true });
});

// POST /api/chat - Send message and stream response
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  let clientDisconnected = false;
  let abortController: AbortController | null = null;
  let mcpClients: Map<string, McpConnection> = new Map();
  // Turn identity + lifecycle (plan S1/S5): the user message id doubles as turnId.
  let userMsgId: string | null = null;
  let turnConversationId: string | null = null;
  // Why this turn aborted. The registry invokes onAbort synchronously BEFORE
  // the controller abort surfaces, so every AbortError exit path can map to
  // the right terminal status: 'stop'/'orphan-timeout' → 'stopped',
  // 'shutdown' → 'error'; a bare 120s fetch timeout stays 'error'.
  let abortReason: 'stop' | 'orphan-timeout' | 'shutdown' | null = null;
  const terminalStatusForCurrentAbort = (): 'stopped' | 'error' =>
    abortReason === 'stop' || abortReason === 'orphan-timeout' ? 'stopped' : 'error';
  // Hooks into the per-request draft machinery (the helpers themselves live
  // deeper in the handler where their closure context exists). Null until
  // streaming setup completes — which also means no draft can exist yet — so
  // optional calls are provably no-ops.
  let forceFlushOpenDraft: (() => void) | null = null;
  let finalizeOpenDraftHook:
    | ((status: 'complete' | 'error' | 'stopped', opts?: { toolCallsJson?: string | null; anns?: unknown[] }) => void)
    | null = null;

  // Disconnect detection — disconnect ≠ cancel (plan S3 / GC4).
  // IMPORTANT: Use res.on('close'), NOT req.on('close').
  // req.on('close') fires when the request body stream is consumed (immediately for POST),
  // but res.on('close') fires when the client actually disconnects the response connection.
  // A closed tab NEVER aborts upstream generation or cancels the reader. It only
  // flags the disconnect (SSE writes get skipped), starts the registry's orphan
  // grace timer, and force-flushes any open draft row so partial output is
  // durable. Cancellation happens ONLY via POST /api/chat/stop, orphan timeout,
  // or shutdown aborts.
  res.on('close', () => {
    // Only treat as disconnect if we haven't finished writing the response
    if (!res.writableFinished) {
      console.log(`[chat] Client disconnected (res.close before writableFinished); generation continues server-side`);
      clientDisconnected = true;
      if (userMsgId) {
        markTurnDisconnected(userMsgId);
      }
      forceFlushOpenDraft?.();
    }
  });

  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = req.body as { conversation_id?: string; content?: string; reasoning?: unknown; attachments?: unknown; pdf_engine?: string; model?: string; provider_routing?: unknown; invoke_agent_id?: string; invoke_skill_names?: unknown; timezone?: string; edit_message_id?: string };
    const { conversation_id, content, reasoning, attachments: attachmentsRaw, pdf_engine: pdfEngineRaw, model: messageModel, provider_routing: messageProviderRoutingRaw, invoke_agent_id, invoke_skill_names, timezone: bodyTimezone, edit_message_id } = body;

    if (!conversation_id || !content) {
      res.status(400).json({ error: 'conversation_id and content are required' });
      return;
    }

    // MCP approvals survive disconnection (plan S7 / GC9): the disconnect-based
    // deny is gone. The pending approval stays resolvable within its existing
    // fail-closed bounds — APPROVAL_TIMEOUT_MS expiry, tenant+conversation
    // binding, one-shot resolution, and abort-signal denial (Stop /
    // orphan-timeout / shutdown) are unchanged. The emit closure skips the SSE
    // write silently instead of throwing when nobody is listening.
    const authorizeMcpCall = async (request: McpToolAuthorizationRequest): Promise<boolean> => {
      return requestMcpToolApproval({
        userId,
        conversationId: conversation_id,
        request,
        ...(abortController?.signal ? { signal: abortController.signal } : {}),
        emit: (approval) => {
          if (res.writableEnded) return;
          res.write(`data: ${JSON.stringify({ mcp_approval_required: approval })}\n\n`);
        },
      });
    };

    if (invoke_skill_names !== undefined && (!Array.isArray(invoke_skill_names) || !invoke_skill_names.every((n: unknown) => typeof n === 'string'))) {
      res.status(400).json({ error: 'invoke_skill_names must be an array of strings' });
      return;
    }

    const { valid: attachments, error: attachmentsError } = validateAttachments(attachmentsRaw);

    if (attachmentsError) {
      res.status(400).json({ error: attachmentsError });
      return;
    }

    const pdf_engine: PDFEngine = isPDFEngine(pdfEngineRaw) ? pdfEngineRaw : 'pdf-text';

    // Get conversation (must belong to user)
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversation_id, userId) as Conversation | undefined;
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // ---- Turn open: atomic per-conversation claim (plan S5 / GC7). ----
    // better-sqlite3 is synchronous, so two interleaved POSTs cannot both win
    // this conditional UPDATE — the check-then-set race is closed in SQL.
    // active_turn_id is the durable "generating here" signal that survives
    // disconnects and drives reopen polling.
    userMsgId = nanoid();
    turnConversationId = conversation_id;
    const claim = db
      .prepare('UPDATE conversations SET active_turn_id = ? WHERE id = ? AND user_id = ? AND active_turn_id IS NULL')
      .run(userMsgId, conversation_id, userId);
    if (claim.changes === 0) {
      res.status(409).json({ error: 'A response is already being generated in this conversation' });
      return;
    }

    // Register the live turn so Stop / orphan-timeout / shutdown can reach it.
    // This controller IS the route's abortController for the whole request
    // (branch-local re-creations removed); the registry invokes onAbort
    // synchronously first, then aborts this controller, tripping the existing
    // upstream-cancel paths.
    abortController = new AbortController();
    registerTurn({
      turnId: userMsgId,
      userId,
      conversationId: conversation_id,
      controller: abortController,
      onAbort: (reason) => {
        abortReason = reason;
      },
    });

    // Get agent for this request
    // Priority: 1) invoke_agent_id (@agent mention), 2) conversation's agent_id, 3) general chat settings
    let agent: Agent | undefined;
    let processedByAgentId: string | null = null;
    let generalSettings: ReturnType<typeof loadGeneralChatSettings> | undefined;

    if (invoke_agent_id) {
      // User invoked a specific agent with @agentname
      agent = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(invoke_agent_id, userId) as Agent | undefined;
      if (!agent) {
        res.status(404).json({ error: 'Invoked agent not found' });
        return;
      }
      processedByAgentId = agent.id;
    } else if (conversation.agent_id) {
      // Conversation has an associated agent
      agent = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(conversation.agent_id, userId) as Agent | undefined;
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
    } else {
      // General chat - load settings from database or use defaults
      generalSettings = loadGeneralChatSettings(userId);
      agent = createGeneralChatAgent(generalSettings);
    }

    const messageProviderRouting = messageProviderRoutingRaw === undefined
      ? null
      : normalizeProviderRoutingConfig(messageProviderRoutingRaw);
    if (messageProviderRoutingRaw !== undefined && messageProviderRoutingRaw !== null && !messageProviderRouting) {
      res.status(400).json({ error: 'provider_routing is invalid' });
      return;
    }

    // Hierarchy: message override > conversation override > agent/general default > auto
    const effectiveModel = messageModel || conversation.model || agent.model;

    // Resolve the upstream provider from the (namespaced) model id.
    const provider = getProviderForModel(effectiveModel);
    const upstreamModel = toUpstreamModelId(effectiveModel);

    // D8 legacy guard: ids from the REMOVED LM Studio provider are rejected
    // BEFORE any key lookup, settings read, or network call — they must never
    // fall through to another provider.
    if (isLegacyLmStudioModel(effectiveModel)) {
      res.status(400).json({ error: REMOVED_LMSTUDIO_MESSAGE });
      return;
    }

    // API key for the resolved provider (decrypted server-side). The ChatGPT
    // (Codex) provider has no API key — its account state is validated in the
    // codex branch below. llama.cpp requests are valid WITHOUT an API key too
    // (loopback server spawned without --api-key).
    const apiKey = getSettingValue(userId, provider.apiKeySetting);
    if (!apiKey?.trim() && !isCodexModel(effectiveModel) && !isLlamacppModel(effectiveModel)) {
      res.status(400).json({ error: `${provider.label} API key not configured. Please set your API key in Settings.` });
      return;
    }

    // PDF attachments rely on OpenRouter's file-parser plugin; other providers reject `file` parts.
    if (attachments.length > 0 && !provider.supportsPlugins) {
      res.status(400).json({ error: `PDF attachments are currently supported only with OpenRouter models, not ${provider.label}.` });
      return;
    }

    // Provider routing is an OpenRouter concept; resolve+validate only when supported.
    const effectiveProviderRouting: ProviderRoutingConfig = provider.supportsProviderRouting
      ? resolveProviderRouting(
          messageProviderRouting,
          parseProviderRoutingConfig(conversation.provider_routing),
          parseProviderRoutingConfig(agent.provider_routing)
        )
      : { mode: 'auto' };
    if (provider.supportsProviderRouting) {
      try {
        assertProviderRoutingCompatible(effectiveModel, effectiveProviderRouting);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid provider routing' });
        return;
      }
    }
    const openRouterProviderPreference = provider.supportsProviderRouting
      ? buildOpenRouterProviderPreference(effectiveProviderRouting)
      : undefined;
    const effectiveProviderRoutingJson = provider.supportsProviderRouting
      ? serializeProviderRoutingConfig(effectiveProviderRouting)
      : null;

    // Save user message (content + optional attachments metadata for UI).
    // Message-tree semantics:
    //  - normal send: new turn (turn_id = own id, variant_seq = 1), parent = active leaf
    //  - edit/retry (edit_message_id): new variant of the target's turn
    //    (parent = target's parent, turn_id = target's turn_id, variant_seq = MAX+1).
    //    Identical content = retry: a new variant is still created.
    const attachmentsMeta = attachments.length > 0 ? JSON.stringify(attachments.map((a) => ({ filename: a.filename }))) : null;

    // Chain tail of this turn: every assistant/tool message inserted below is
    // chained via parent_id to the previous insert of the turn.
    let chainTailId: string = userMsgId;
    let turnId: string = userMsgId;
    let variantSeq: number = 1;

    const updateActiveLeaf = (msgId: string) => {
      db.prepare("UPDATE conversations SET active_leaf_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(msgId, conversation_id, userId);
    };

    if (edit_message_id) {
      const editTarget = db.prepare('SELECT id, role, parent_id, turn_id FROM messages WHERE id = ? AND conversation_id = ?').get(edit_message_id, conversation_id) as { id: string; role: string; parent_id: string | null; turn_id: string | null } | undefined;
      if (!editTarget) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      if (editTarget.role !== 'user') {
        res.status(400).json({ error: 'Only user messages can be edited or re-run' });
        return;
      }
      const maxSeq = (db.prepare('SELECT COALESCE(MAX(variant_seq), 0) as m FROM messages WHERE turn_id = ?').get(editTarget.turn_id) as { m: number }).m;
      variantSeq = maxSeq + 1;
      turnId = editTarget.turn_id ?? editTarget.id;
      // v1: attachments are not re-sent when editing/retrying.
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, attachments, parent_id, turn_id, variant_seq, model)
        VALUES (?, ?, 'user', ?, NULL, ?, ?, ?, ?)
      `).run(userMsgId, conversation_id, content, editTarget.parent_id, turnId, variantSeq, messageModel ?? null);
    } else {
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, attachments, parent_id, turn_id, variant_seq, model)
        VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?)
      `).run(userMsgId, conversation_id, content, attachmentsMeta, conversation.active_leaf_id ?? null, userMsgId, 1, messageModel ?? null);
    }
    updateActiveLeaf(userMsgId);

    // Update conversation title if first message
    const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversation_id) as { cnt: number };
    let firstMessageTitle: string | null = null;
    let generatedTitlePromise: Promise<string | null> | null = null;
    if (msgCount.cnt === 1) {
      const fallbackTitle = createFallbackConversationTitle(content);
      firstMessageTitle = fallbackTitle;
      db.prepare('UPDATE conversations SET title = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').run(fallbackTitle, conversation_id, userId);

      const titleApiKey = getSettingValue(userId, 'openrouter_api_key');
      const titleEnabled = isAutoConversationTitlesEnabled(getSettingValue(userId, AUTO_CONVERSATION_TITLES_SETTING_KEY));
      const titleFallback = (title: string | null) => {
        if (!title || title === fallbackTitle) return null;
        db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?').run(title, conversation_id, userId);
        return title;
      };
      if (titleEnabled && titleApiKey.trim()) {
        generatedTitlePromise = generateConversationTitleWithOpenRouter({
          apiKey: titleApiKey,
          userMessage: content,
          systemPrompt: agent.system_prompt,
        }).then(titleFallback);
      }
    } else {
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(conversation_id, userId);
    }

    // Build messages array (include tool_calls, tool role, annotations, reasoning for assistant → skip re-parse PDFs).
    // History is reconstructed by walking parent_id from the active leaf (thread
    // semantics — hidden variant branches stay out of the LLM context). The leaf
    // was just updated to the new user message; buildThreadIds falls back to
    // created_at ASC defensively if the chain is broken or the leaf is missing.
    const historyRows = db.prepare(`
      SELECT id, parent_id, role, content, tool_call_id, tool_calls, annotations, reasoning_content
      FROM messages
      WHERE conversation_id = ?
    `).all(conversation_id) as { id: string; parent_id: string | null; role: string; content: string; tool_call_id: string | null; tool_calls: string | null; annotations: string | null; reasoning_content: string | null }[];

    const historyRowById = new Map(historyRows.map((r) => [r.id, r]));
    const freshLeaf = (db.prepare('SELECT active_leaf_id FROM conversations WHERE id = ?').get(conversation_id) as { active_leaf_id: string | null }).active_leaf_id;
    const history = buildThreadIds(conversation_id, freshLeaf ?? userMsgId)
      .map((id) => historyRowById.get(id))
      .filter((row): row is NonNullable<typeof row> => !!row)
      .map((row) => {
      if (row.role === 'tool') {
        return { role: 'tool' as const, tool_call_id: row.tool_call_id!, content: row.content || '' };
      }
      if (row.role === 'assistant') {
        const tool_calls = row.tool_calls ? (JSON.parse(row.tool_calls) as { id: string; type: string; function: { name: string; arguments: string } }[]) : undefined;
        const annotations = row.annotations ? (JSON.parse(row.annotations) as unknown[]) : undefined;
        const out: { role: 'assistant'; content: string | null; tool_calls?: unknown[]; annotations?: unknown[]; reasoning?: string; reasoning_content?: string } = {
          role: 'assistant',
          content: resolveAssistantHistoryContent(row.content, !!tool_calls?.length),
        };
        if (tool_calls?.length) out.tool_calls = tool_calls;
        if (annotations?.length) out.annotations = annotations;
        // DeepSeek thinking mode requires reasoning_content on tool-call turns (else HTTP 400);
        // OpenRouter uses `reasoning`. Field name follows the resolved provider.
        if (row.reasoning_content?.trim()) out[assistantReasoningField(provider.id)] = row.reasoning_content;
        return out;
      }
      return { role: row.role as 'user' | 'assistant', content: row.content };
    });

    // User timezone: request body (browser) overrides stored setting; invalid values are ignored
    const userTimezone =
      (typeof bodyTimezone === 'string' ? bodyTimezone.trim() : null) ||
      getSettingValue(userId, 'user_timezone') ||
      null;

    // System prompt is kept STATIC (no volatile timestamp) so it stays a cacheable prefix.
    let messages: Array<{ role: string; content?: string | unknown[] | null; tool_call_id?: string; tool_calls?: unknown[]; annotations?: unknown[] }> = [
      { role: 'system', content: agent.system_prompt },
      ...history,
    ];

    // If this turn has PDF attachments, replace the last message (current user) content with OpenRouter multimodal array
    const lastIdx = messages.length - 1;
    if (attachments.length > 0 && lastIdx >= 0 && messages[lastIdx].role === 'user') {
      const textPart = { type: 'text' as const, text: content };
      const fileParts = attachments.map((a) => ({
        type: 'file' as const,
        file: {
          filename: a.filename,
          file_data: a.file_data ?? a.url,
        },
      }));
      (messages[lastIdx] as Record<string, unknown>).content = [textPart, ...fileParts];
    }

    // Inject the (volatile, per-second) date/time into the CURRENT user turn — never the
    // system prompt — so system + history remain a stable, cacheable prefix (DeepSeek/Anthropic/OpenAI).
    injectDateTimeIntoCurrentTurn(messages, buildDateTimeContext(userTimezone));

    // Resolve tools for this agent (with user context for settings)
    // Hierarchy: conversation tool/MCP override > agent/general default (no message-level tier for tools)
    const conversationToolOverride = getConversationToolOverride(conversation.id, userId);
    const toolSource = selectToolResolutionSource({
      conversationOverride: conversationToolOverride,
      isGeneralChat: agent.id === 'general',
      generalSettings: generalSettings ? { tool_ids: generalSettings.tool_ids || [], mcp_server_ids: generalSettings.mcp_server_ids || [] } : null,
    });
    const resolved = toolSource.kind === 'agent-default'
      ? await resolveToolsForAgent(agent.id, userId)
      : await resolveToolsFromIds(toolSource.tool_ids, toolSource.mcp_server_ids, userId);

    // Resolve skills for this agent/conversation — mirrors the tool resolution above; skills
    // have no MCP-style async connection to manage and no isUsable-style gating (a skill's
    // usability never depends on external connectivity, only on assignment).
    const conversationSkillOverride = getConversationSkillOverride(conversation.id);
    const skillSource = selectSkillResolutionSource({
      conversationOverride: conversationSkillOverride,
      isGeneralChat: agent.id === 'general',
      generalSettings: generalSettings ? { skill_ids: generalSettings.skill_ids || [] } : null,
    });
    const resolvedSkills: ResolvedSkill[] = skillSource.kind === 'agent-default'
      ? resolveSkillsForAgent(agent.id, userId)
      : resolveSkillsFromIds(skillSource.skill_ids, userId);
    const skillTools = [
      buildActivateSkillTool(resolvedSkills),
      buildReadSkillResourceTool(resolvedSkills),
      buildRunSkillScriptTool(resolvedSkills, userId),
    ]
      .filter((t): t is NonNullable<typeof t> => t !== null);

    const resolvedTools = excludeReservedSkillToolNames(resolved.resolvedTools, skillTools);
    mcpClients = resolved.mcpClients;
    const openRouterTools = toOpenRouterTools(resolvedTools);

    // Augment system prompt with MCP tool naming instruction when applicable
    if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
      messages[0].content = appendToolInstructionsIfNeeded(messages[0].content, resolvedTools);
      messages[0].content = appendSkillCatalogIfNeeded(messages[0].content, resolvedSkills);
    }

    const requestedSkillNames = Array.isArray(invoke_skill_names) ? invoke_skill_names : [];
    for (const rawName of requestedSkillNames) {
      if (typeof rawName !== 'string' || !rawName.trim()) continue;
      const entry = resolvedSkills.find((skill) => skill.name === rawName.trim());
      if (!entry) {
        console.warn(`[chat] invoke_skill_names: '${rawName}' is not a resolved skill for this conversation, skipping`);
        continue;
      }
      const activation = tryActivateSkill({ name: entry.name, userId, currentMessages: messages });
      if (!activation) {
        console.warn(`[chat] invoke_skill_names: skill '${entry.name}' could not be loaded, skipping`);
        continue;
      }
      if (activation.alreadyActive) continue; // silent no-op — the model already has this in context, no new signal needed
      injectSkillActivationIntoCurrentTurn(messages, activation.content);
    }

    // Early exit if server is shutting down (shouldn't reach here due to
    // middleware, but defend in depth for requests already past middleware).
    if (isShuttingDown()) {
      res.status(503).json({ error: 'Server is restarting. Please retry in a moment.' });
      return;
    }

    // Set up SSE headers and flush them immediately
    // This is critical when behind a proxy (like Vite dev server) to
    // establish the streaming connection before the upstream fetch begins
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Register this SSE connection for graceful shutdown draining.
    trackStream(res);

    const sendConversationTitleEvent = (title: string) => {
      if (clientDisconnected || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ type: 'conversation_title', conversation_id, title })}\n\n`);
    };
    if (firstMessageTitle) {
      sendConversationTitleEvent(firstMessageTitle);
    }
    generatedTitlePromise
      ?.then((title) => {
        if (title) sendConversationTitleEvent(title);
      })
      .catch((err) => {
        console.warn('[chat] Conversation title generation skipped:', err instanceof Error ? err.message : String(err));
      });

    // Static providers fetch their configured endpoint; llama.cpp serves a
    // loopback OpenAI-compatible API on the port resolved from settings/env,
    // so apiUrl is rebuilt per request (the static chatCompletionsUrl stays ''
    // for it). apiUrl stays defined so logs and error messages keep a concrete
    // endpoint. No Authorization header is ever sent for llama.cpp.
    let apiUrl = provider.chatCompletionsUrl;

    let headers: Record<string, string> = provider.buildHeaders(apiKey);
    // ONE hoisted resolveLlamacppConfig(userId) per request, shared by the
    // apiUrl block below and the sampling seam further down.
    let llamacppConfig: ReturnType<typeof resolveLlamacppConfig> | null = null;
    if (isLlamacppModel(effectiveModel)) {
      llamacppConfig = resolveLlamacppConfig(userId);
      apiUrl = `http://127.0.0.1:${llamacppConfig.port}/v1/chat/completions`;
      headers = provider.buildHeaders('');
    }

    let actualModelFromResponse: string | null = null;

    const requestBody: Record<string, unknown> = {
      model: upstreamModel,
      messages,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      stream: true,
    };
    if (isLlamacppModel(effectiveModel) && llamacppConfig) {
      // Increment 2 + 2d (§6/§10): resolution v3 — global llamacpp_sampling row
      // ⊕ per-model sampling for THIS upstream key, through the SAME ForModel
      // resolver councilExecutor uses (single source). The resolved row wins
      // over agent.temperature for llamacpp; `temp`→`temperature` is the ONLY
      // name mapping.
      const s = resolveLlamacppSamplingForModel(userId, upstreamModel);
      requestBody.temperature = s.temp;
      requestBody.top_p = s.top_p;
      requestBody.top_k = s.top_k;
      requestBody.min_p = s.min_p;
      requestBody.repeat_penalty = s.repeat_penalty;
      // OPTIONAL §10 Increment 2d knob: included ONLY when set — an absent key
      // is omitted from the request body entirely (never sent as 0).
      if (s.presence_penalty !== undefined) {
        requestBody.presence_penalty = s.presence_penalty;
      }
    }
    if (openRouterProviderPreference) {
      requestBody.provider = openRouterProviderPreference;
    }

    // Tools attach normally for every chat-completions provider — llama.cpp
    // has no advisory capability gate; the old LM Studio tool-veto concept
    // died with that provider.
    if (openRouterTools.length > 0) {
      requestBody.tools = openRouterTools;
      requestBody.tool_choice = agent.tool_choice === 'none' ? 'none' : 'auto';
      requestBody.parallel_tool_calls = agent.parallel_tool_calls === 0 ? false : true;
    }
    if (attachments.length > 0 && provider.supportsPlugins) {
      requestBody.plugins = [{ id: 'file-parser', pdf: { engine: pdf_engine } }];
    }

    // Reasoning / Thinking: per-message override takes precedence over agent defaults
    const reasoningOverride = reasoning as { enabled?: boolean; effort?: string; max_tokens?: number } | undefined;
    let reasoningEnabled = !!agent.reasoning_enabled;
    let reasoningEffort = agent.reasoning_effort || null;
    let reasoningMaxTokens = agent.reasoning_max_tokens || null;

    if (reasoningOverride) {
      if (reasoningOverride.enabled !== undefined) reasoningEnabled = reasoningOverride.enabled;
      if (reasoningOverride.effort !== undefined) reasoningEffort = reasoningOverride.effort;
      if (reasoningOverride.max_tokens !== undefined) reasoningMaxTokens = reasoningOverride.max_tokens;
    }

    if (provider.supportsReasoningParam) {
      if (reasoningEnabled) {
        const reasoningParam: Record<string, unknown> = {};
        // 'max' is supported by some OpenRouter models only; it is sent
        // as-is and degraded to 'xhigh' with a single retry when the model
        // rejects it (see effortMaxRejected handling below).
        if (reasoningEffort && reasoningEffort !== 'none') {
          reasoningParam.effort = reasoningEffort;
        } else if (reasoningEffort === 'none') {
          reasoningParam.effort = 'none';
        }
        if (reasoningMaxTokens && reasoningMaxTokens > 0) {
          reasoningParam.max_tokens = reasoningMaxTokens;
        }
        if (Object.keys(reasoningParam).length === 0) {
          reasoningParam.enabled = true;
        }
        requestBody.reasoning = reasoningParam;
        console.log(`[chat] Reasoning enabled:`, JSON.stringify(reasoningParam));
      }
    } else if (provider.id === 'deepseek') {
      // DeepSeek toggles thinking mode via top-level `thinking` (+ optional reasoning_effort),
      // driven by the app's Reasoning switch. Default off → non-thinking (fast/cheap).
      Object.assign(requestBody, buildDeepSeekThinking(reasoningEnabled, reasoningEffort));
    }

    if (isLlamacppModel(effectiveModel)) {
      // llama.cpp request-body extras (§6): a usage frame on stream close, and
      // an explicit thinking toggle for the jinja chat template of Qwen3-class
      // models. The per-chat toggle is the master switch: ON ⇒
      // enable_thinking:true so the model thinks regardless of template
      // default; OFF ⇒ enable_thinking:false = fully off (verified live on
      // b10516: this per-request flag is the only effective suppressor —
      // --reasoning-budget 0 is NOT).
      requestBody.stream_options = { include_usage: true };
      requestBody.chat_template_kwargs = { enable_thinking: reasoningEnabled };
    }

    // Structured outputs (OpenRouter JSON Schema)
    // Accept both: short form { name, strict, schema } or full API form { type: "json_schema", json_schema: { name, strict, schema } }
    const structuredEnabled = !!agent.structured_output_enabled;
    const schemaRaw = agent.structured_output_schema;
    let responseFormat: { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } } | undefined;
    if (provider.supportsJsonSchema && structuredEnabled && schemaRaw && typeof schemaRaw === 'string' && schemaRaw.trim()) {
      try {
        const parsed = JSON.parse(schemaRaw.trim()) as {
          type?: string;
          json_schema?: { name?: string; strict?: boolean; schema?: unknown };
          name?: string;
          strict?: boolean;
          schema?: unknown;
        };
        const config = parsed.type === 'json_schema' && parsed.json_schema
          ? parsed.json_schema
          : { name: parsed.name, strict: parsed.strict, schema: parsed.schema };
        const schema = config.schema as Record<string, unknown> | undefined;
        if (config.name && schema && typeof schema === 'object' && schema.type === 'object') {
          responseFormat = {
            type: 'json_schema',
            json_schema: {
              name: String(config.name),
              strict: config.strict !== false,
              schema,
            },
          };
          requestBody.response_format = responseFormat;
        } else {
          console.warn('[chat] Structured output enabled but schema invalid (need name and schema.type "object"). Skipping response_format.');
        }
      } catch (e) {
        console.warn('[chat] Structured output schema JSON parse error:', e);
      }
    }

    // Response healing is an OpenRouter plugin: codex has no chat-completions
    // fetch and llama.cpp serves response_format json_schema natively (the
    // 'response-healing' field is meaningless upstream), so both are excluded.
    const useResponseHealing = !!agent.response_healing_enabled && !!responseFormat && provider.id !== 'codex' && provider.id !== 'llamacpp';
    if (useResponseHealing) {
      requestBody.stream = false;
      const plugins = (requestBody.plugins as { id: string; pdf?: { engine: string } }[]) || [];
      if (!plugins.some((p) => p.id === 'response-healing')) {
        requestBody.plugins = [...plugins, { id: 'response-healing' }];
      }
    }

    // Ultra effort ('max') is model-dependent on OpenRouter: send it as-is and
    // retry once with 'xhigh' when the model rejects the value. llama.cpp never
    // receives a reasoning param, so a local model error merely mentioning
    // "max" must never trigger this retry.
    const requestedMaxEffort = reasoningEnabled && reasoningEffort === 'max' && provider.id !== 'codex' && provider.id !== 'llamacpp';
    let maxEffortFallbackDone = false;
    const effortMaxRejected = (msg: string): boolean =>
      /unsupported value: ?'?max|'max' is not supported|max is not supported/i.test(msg);
    const shouldRetryMaxEffort = (errorMsg: string): boolean =>
      requestedMaxEffort && !maxEffortFallbackDone && effortMaxRejected(errorMsg);
    const degradeMaxEffort = (): void => {
      maxEffortFallbackDone = true;
      const reasoningParam = requestBody.reasoning as Record<string, unknown> | undefined;
      if (reasoningParam && typeof reasoningParam === 'object') {
        reasoningParam.effort = 'xhigh';
      }
    };

    // Helpers for persistence and SSE (annotations can be citation or file type from OpenRouter)
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let cachedTokens = 0;
    let cost = 0;
    const annotations: unknown[] = [];
    let streamedAnnotations: unknown[] | null = null;

    const saveAssistantMessage = (content: string, reasoning: string, toolCallsJson: string | null, anns: unknown[]) => {
      const assistantMsgId = nanoid();
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, provider_routing, tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, tool_calls, model, processed_by_agent_id, parent_id, turn_id, variant_seq)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assistantMsgId,
        conversation_id,
        content || '',
        effectiveProviderRoutingJson,
        totalTokens,
        promptTokens,
        completionTokens,
        cost,
        anns.length > 0 ? JSON.stringify(anns) : null,
        reasoning || null,
        reasoningTokens,
        cachedTokens,
        toolCallsJson,
        // Namespaced providers (deepseek, llamacpp) echo the bare upstream key,
        // so history/UI keeps the NAMESPACED id (shared helper in providers).
        persistedModelId(provider.id, effectiveModel, actualModelFromResponse),
        processedByAgentId,
        chainTailId,
        turnId,
        variantSeq
      );
      chainTailId = assistantMsgId;
      updateActiveLeaf(assistantMsgId);
      return assistantMsgId;
    };

    const updateAssistantMessage = (assistantMsgId: string, content: string, reasoning: string, anns: unknown[]) => {
      db.prepare(`
        UPDATE messages
        SET content = ?, annotations = ?, reasoning_content = ?
        WHERE id = ?
      `).run(
        content || '',
        anns.length > 0 ? JSON.stringify(anns) : null,
        reasoning || null,
        assistantMsgId
      );
    };

    const sendDoneEvent = (anns: unknown[]) => {
      if (clientDisconnected || res.writableEnded) return;
      const doneData: Record<string, unknown> = {
        done: true,
        tokens: totalTokens,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cost,
        reasoning_tokens: reasoningTokens,
        cached_tokens: cachedTokens,
      };
      if (anns.length > 0) doneData.annotations = anns;
      res.write(`data: ${JSON.stringify(doneData)}\n\n`);
      res.write('data: [DONE]\n\n');
    };

    // ---------------------------------------------------------------------
    // Draft-row-per-segment persistence (plan S2 / GC3 / GC8).
    //
    // One assistant draft row per while(true) iteration ("segment"): lazily
    // INSERTed on the first content/reasoning delta with
    // generation_status='streaming', updated in place at most once per second
    // while text changes, and finalized with a terminal generation_status by
    // EVERY exit path (GC5). openDraftId is reset at the top of each
    // iteration; an upstream failure before any delta persists nothing
    // assistant-side — exactly today's failure semantics.
    // ---------------------------------------------------------------------
    let fullContent = '';
    let fullReasoning = '';
    let openDraftId: string | null = null;
    let draftLastFlushAt = 0;
    let draftFlushedContent = '';
    let draftFlushedReasoning = '';
    const DRAFT_FLUSH_INTERVAL_MS = 1000;

    /** Idempotently materialize the segment's draft row; returns its id. */
    const ensureDraftRow = (): string => {
      if (openDraftId) return openDraftId;
      const draftId = nanoid();
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, provider_routing, tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, tool_calls, model, processed_by_agent_id, parent_id, turn_id, variant_seq, generation_status)
        VALUES (?, ?, 'assistant', '', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 'streaming')
      `).run(
        draftId,
        conversation_id,
        effectiveProviderRoutingJson,
        totalTokens,
        promptTokens,
        completionTokens,
        cost,
        reasoningTokens,
        cachedTokens,
        persistedModelId(provider.id, effectiveModel, actualModelFromResponse),
        processedByAgentId,
        chainTailId,
        turnId,
        variantSeq
      );
      openDraftId = draftId;
      chainTailId = draftId;
      updateActiveLeaf(draftId);
      return draftId;
    };

    /**
     * Throttled in-place flush of accumulated text into the open draft.
     * Writes only when content or reasoning changed AND ≥1000 ms have passed
     * since the previous write (GC8); force=true bypasses only the interval
     * (segment end, disconnect detection, every exit path). Plain synchronous
     * UPDATE — no timers that could outlive the request.
     */
    const flushDraft = (force = false): void => {
      if (!openDraftId) return;
      if (fullContent === draftFlushedContent && fullReasoning === draftFlushedReasoning) return;
      if (!force && Date.now() - draftLastFlushAt < DRAFT_FLUSH_INTERVAL_MS) return;
      db.prepare('UPDATE messages SET content = ?, reasoning_content = ? WHERE id = ?')
        .run(fullContent || '', fullReasoning || null, openDraftId);
      draftLastFlushAt = Date.now();
      draftFlushedContent = fullContent;
      draftFlushedReasoning = fullReasoning;
    };

    /**
     * Terminal write for the current segment: authoritative content/reasoning
     * (+ current token counters and model — matching what today's milestone
     * INSERT persisted), optional tool_calls/annotations, and the terminal
     * generation_status. With no open draft this is a deliberate no-op unless
     * a tool-calls JSON warrants a row, which recreates today's empty-content
     * assistant-with-tool_calls INSERT shape. A row is never inserted twice
     * for the same segment (GC3).
     */
    const finalizeDraft = (
      status: 'complete' | 'error' | 'stopped',
      opts?: { toolCallsJson?: string | null; anns?: unknown[] },
    ): void => {
      const toolCallsJson = opts?.toolCallsJson ?? null;
      if (!openDraftId && !toolCallsJson) return;
      const draftId = openDraftId ?? ensureDraftRow();
      const sets = ['content = ?', 'reasoning_content = ?', 'model = ?', 'tokens_used = ?', 'prompt_tokens = ?', 'completion_tokens = ?', 'cost = ?', 'reasoning_tokens = ?', 'cached_tokens = ?', 'generation_status = ?'];
      const vals: Array<string | number | null> = [
        fullContent || '',
        fullReasoning || null,
        persistedModelId(provider.id, effectiveModel, actualModelFromResponse),
        totalTokens,
        promptTokens,
        completionTokens,
        cost,
        reasoningTokens,
        cachedTokens,
        status,
      ];
      if (toolCallsJson !== null) {
        sets.push('tool_calls = ?');
        vals.push(toolCallsJson);
      }
      if (opts?.anns !== undefined) {
        sets.push('annotations = ?');
        vals.push(opts.anns.length > 0 ? JSON.stringify(opts.anns) : null);
      }
      vals.push(draftId);
      db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    };

    // Route-level hooks (declarations at the top of the handler): the close
    // handler force-flushes on disconnect; the outer catch finalizes 'error'.
    forceFlushOpenDraft = () => flushDraft(true);
    finalizeOpenDraftHook = finalizeDraft;

    // -----------------------------------------------------------------------
    // ChatGPT (Codex app-server) branch
    //
    // No chat-completions fetch: the turn is bridged to the user's per-user
    // `codex app-server` process (server/codex/chat.ts). Content/reasoning
    // deltas and tool events map onto the same SSE shapes the frontend already
    // consumes; tool calls run through the app's own tool executors.
    // -----------------------------------------------------------------------
    if (provider.id === 'codex') {
      // abortController was created and registered at turn open — the registry
      // holds THE controller for this request, so Stop/orphan-timeout/shutdown
      // reach the in-flight runCodexTurn signal directly. Disconnect no longer
      // aborts anything; the emit wrapper below keeps persisting deltas.

      const codexRow = db.prepare('SELECT codex_thread_id FROM conversations WHERE id = ?').get(conversation_id) as
        | { codex_thread_id: string | null }
        | undefined;
      let codexThreadId = codexRow?.codex_thread_id ?? null;
      // Editing/retrying rewrites the visible history — start a fresh thread
      // (seeded with the reconstructed history) so the model sees the edit.
      if (edit_message_id) codexThreadId = null;

      // Tool rows are buffered and persisted after the assistant message so the
      // message tree keeps the generic path's order: user → assistant → tools.
      const pendingToolRows: Array<{ callId: string; output: string }> = [];

      const codexResult = await runCodexTurn({
        userId,
        conversationId: conversation_id,
        threadId: codexThreadId,
        systemPrompt: agent.system_prompt,
        messages,
        model: upstreamModel,
        reasoningEffort: reasoningEnabled ? reasoningEffort : null,
        outputSchema: responseFormat?.json_schema?.schema ?? null,
        tools: resolvedTools,
        toolChoice: agent.tool_choice === 'none' ? 'none' : 'auto',
        mcpClients,
        signal: abortController.signal,
        authorizeMcpCall,
        emit: (evt) => {
          // Accumulate streamed deltas into the segment draft so partial output
          // is durable even with nobody connected (plan S3 codex branch).
          if (typeof evt.content === 'string' && evt.content) {
            fullContent += evt.content;
            ensureDraftRow();
            flushDraft();
          }
          if (typeof evt.reasoning === 'string' && evt.reasoning) {
            fullReasoning += evt.reasoning;
            ensureDraftRow();
            flushDraft();
          }
          if (res.writableEnded) return;
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        },
        persistToolResult: (callId, _name, result) => {
          pendingToolRows.push({ callId, output: result.output });
        },
        getDraftId: () => openDraftId,
      });

      db.prepare('UPDATE conversations SET codex_thread_id = ? WHERE id = ? AND user_id = ?')
        .run(codexResult.threadId, conversation_id, userId);

      totalTokens = codexResult.totalTokens;
      promptTokens = codexResult.inputTokens;
      completionTokens = codexResult.outputTokens;
      reasoningTokens = codexResult.reasoningOutputTokens;
      cachedTokens = codexResult.cachedInputTokens;

      // Persist the assistant message (with tool_calls when any ran)…
      const toolCallsJson = codexResult.toolCalls.length > 0
        ? JSON.stringify(codexResult.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })))
        : null;
      // Authoritative overwrite of the streamed draft: whatever the emit
      // wrapper accumulated, codexResult.content/reasoning wins (mirrors the
      // previous post-save updateAssistantMessage), with tool_calls JSON as
      // today. If no delta ever arrived, finalize materializes the row.
      fullContent = codexResult.content;
      fullReasoning = codexResult.reasoning;
      finalizeDraft('complete', { toolCallsJson, anns: [] });

      // …then the tool result rows in execution order.
      for (const row of pendingToolRows) {
        const toolMsgId = nanoid();
        db.prepare(`
          INSERT INTO messages (id, conversation_id, role, content, tool_call_id, parent_id, turn_id, variant_seq)
          VALUES (?, ?, 'tool', ?, ?, ?, ?, ?)
        `).run(toolMsgId, conversation_id, row.output, row.callId, chainTailId, turnId, variantSeq);
        chainTailId = toolMsgId;
        updateActiveLeaf(toolMsgId);
      }

      // Merge web-search citations from tool outputs into the already-finalized
      // draft (same two-step persist as before: assistant first, then tools,
      // then annotations).
      const finalAnnots: unknown[] = [];
      for (const row of pendingToolRows) {
        try {
          const data = JSON.parse(row.output);
          const results = Array.isArray(data) ? data : (data.results || []);
          if (Array.isArray(results) && results.length > 0 && results[0].url) {
            finalAnnots.push(...annotationsFromWebSearchResults(results));
            break;
          }
        } catch {
          // ignore non-JSON tool outputs
        }
      }

      if (openDraftId && (codexResult.content || codexResult.reasoning)) {
        updateAssistantMessage(openDraftId, codexResult.content, codexResult.reasoning, finalAnnots);
      }
      sendDoneEvent(finalAnnots);
      res.end();
      return;
    }

    // Non-streaming path (Response Healing): single request, then forward full response as SSE
    if (requestBody.stream === false) {
      requestBody.messages = messages;
      // No draft machinery here (plan S3): a whole-response JSON has no
      // partials to persist; survival means the fetch completes despite
      // disconnect and the existing saveAssistantMessage lands the full text.
      while (true) {
        // Reuses the turn-open abortController (registry-owned). The 120s
        // timeout is always cleared on every path below before looping, so a
        // stale timer can never fire into the next attempt.
        const fetchTimeout = setTimeout(() => {
          if (abortController) abortController.abort();
        }, 120_000);
        let apiRes: globalThis.Response;
        try {
          apiRes = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: abortController!.signal,
          });
          clearTimeout(fetchTimeout);
        } catch (fetchErr: unknown) {
          clearTimeout(fetchTimeout);
          const err = fetchErr as Error;
          if (err.name === 'AbortError') {
            // A genuine 120s timeout or a registry abort (Stop/orphan/shutdown)
            // — a client disconnect itself never aborts this fetch anymore.
            // Nothing accumulated here and no draft exists, so finalize is a
            // deliberate no-op; the reason mapping keeps status semantics uniform.
            finalizeDraft(terminalStatusForCurrentAbort());
            if (!clientDisconnected && !res.writableEnded) {
              res.write(`data: ${JSON.stringify({ error: 'Request timed out or was cancelled' })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }
            return;
          }
          throw fetchErr;
        }
        if (!apiRes.ok) {
          const errorText = await apiRes.text();
          let errorMsg = `API error (${apiRes.status})`;
          try {
            const errorJson = JSON.parse(errorText);
            errorMsg = errorJson.error?.message || errorMsg;
          } catch {
            errorMsg = errorText || errorMsg;
          }
          if (shouldRetryMaxEffort(errorMsg)) {
            // Retry is upstream-driven: connection state must not cancel it (GC4).
            console.warn('[chat] Model rejected reasoning effort "max", retrying with "xhigh":', errorMsg);
            degradeMaxEffort();
            continue;
          }
          finalizeDraft('error'); // no-op safeguard: healing never opens a draft
          if (!clientDisconnected && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }

        let data: { choices?: { message?: { content?: string; reasoning_content?: string }; usage?: unknown }[]; usage?: Record<string, unknown> };
      try {
        data = (await apiRes.json()) as typeof data;
      } catch {
        finalizeDraft('error'); // no-op safeguard: healing never opens a draft
        if (!clientDisconnected && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: 'Invalid JSON from API' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }
      fullContent = data.choices?.[0]?.message?.content ?? '';
      const msg = data.choices?.[0]?.message as { reasoning_content?: string; reasoning?: string } | undefined;
      fullReasoning = (msg?.reasoning_content ?? msg?.reasoning ?? '').trim();
      const usage = data.usage;
      const u = usage as Record<string, unknown> | undefined;
      if (u) {
        totalTokens = (u.total_tokens as number) ?? totalTokens;
        promptTokens = (u.prompt_tokens as number) ?? promptTokens;
        completionTokens = (u.completion_tokens as number) ?? completionTokens;
        if (u.cost !== undefined) cost = u.cost as number;
        const details = u.completion_tokens_details as { reasoning_tokens?: number } | undefined;
        if (details?.reasoning_tokens) reasoningTokens = details.reasoning_tokens;
        const promptDetails = u.prompt_tokens_details as { cached_tokens?: number } | undefined;
        if (promptDetails?.cached_tokens !== undefined) cachedTokens = promptDetails.cached_tokens;
        if (provider.id === 'deepseek') {
          cachedTokens = deepSeekCachedTokens(u);
          if (u.cost === undefined) cost = computeDeepSeekCost(u, upstreamModel);
        }
      }
      const dataWithModel = data as { model?: string };
      if (dataWithModel.model && typeof dataWithModel.model === 'string' && dataWithModel.model.trim()) {
        actualModelFromResponse = dataWithModel.model;
      }
      if (fullReasoning) {
        if (!clientDisconnected && !res.writableEnded) res.write(`data: ${JSON.stringify({ reasoning: fullReasoning })}\n\n`);
      }
      if (fullContent) {
        if (!clientDisconnected && !res.writableEnded) res.write(`data: ${JSON.stringify({ content: fullContent })}\n\n`);
      }
      saveAssistantMessage(fullContent, fullReasoning, null, []);
      sendDoneEvent([]);
      res.end();
      return;
      }
    }

    // llama.cpp pre-flight: make sure the requested model IS the loaded child
    // (swap = stop → spawn happens inside ensureLlamacppRunning). SSE keepalive
    // comments keep proxies from closing the idle connection while a cold
    // 20+ GB load runs. The pre-flight NEVER throws and NEVER aborts the
    // request — failures surface later at the fetch seam as descriptive 502s.
    if (provider.id === 'llamacpp') {
      const llamacppKeepalive = setInterval(() => {
        if (!clientDisconnected && !res.writableEnded) res.write(': keepalive\n\n');
      }, 15_000);
      try {
        const ensured = await ensureLlamacppRunning(userId, upstreamModel);
        if (ensured.running) {
          console.log(`[chat] llama.cpp model ready (mode=${ensured.mode})`);
        } else {
          console.warn(`[chat] llama.cpp pre-flight failed (${ensured.error ?? 'unknown reason'}) — continuing; the request will surface a descriptive error at the fetch seam.`);
        }
      } catch (preFlightErr) {
        // belt-and-braces: ensureLlamacppRunning is total, but the keepalive
        // must be cleared on EVERY path regardless.
        console.warn('[chat] llama.cpp pre-flight threw (continuing):', preFlightErr instanceof Error ? preFlightErr.message : String(preFlightErr));
      } finally {
        clearInterval(llamacppKeepalive);
      }
    }

    let iteration = 0;
    let lastFinishReason: string | null = null;
    let toolCallCount = 0;
    let toolTimeMs = 0;

    while (true) {
      actualModelFromResponse = null;
      streamedAnnotations = null;
      // New segment → new draft row (GC3: one row per streamed segment).
      openDraftId = null;
      draftLastFlushAt = 0;
      draftFlushedContent = '';
      draftFlushedReasoning = '';
      fullContent = '';
      fullReasoning = '';
      requestBody.messages = messages;
      if (openRouterTools.length > 0) {
        requestBody.tools = openRouterTools;
        requestBody.tool_choice = agent.tool_choice === 'none' ? 'none' : 'auto';
        requestBody.parallel_tool_calls = agent.parallel_tool_calls === 0 ? false : true;
      }

      // Per-segment <think>…</think> state — instantiated EVERY iteration so
      // splitter state never leaks across agentic-loop segments.
      const thinkSplitter = provider.id === 'llamacpp' ? createThinkStreamSplitter() : null;
      const emitThinkSplit = (split: ThinkSplitResult): void => {
        if (split.reasoning) {
          fullReasoning += split.reasoning;
          ensureDraftRow();
          flushDraft();
          if (!clientDisconnected && !res.writableEnded) res.write(`data: ${JSON.stringify({ reasoning: split.reasoning })}\n\n`);
        }
        if (split.content) {
          fullContent += split.content;
          ensureDraftRow();
          flushDraft();
          if (!clientDisconnected && !res.writableEnded) res.write(`data: ${JSON.stringify({ content: split.content })}\n\n`);
        }
      };

      console.log(`[chat] Request iteration ${iteration + 1} to ${apiUrl} messages=${messages.length}`);

      const fetchTimeout = setTimeout(() => {
        if (abortController) abortController.abort();
      }, 120_000);

      let apiResponse: globalThis.Response;
      try {
        apiResponse = provider.id === 'llamacpp'
          ? await llamacppFetch(userId, '/v1/chat/completions', {
              method: 'POST',
              headers,
              body: JSON.stringify(requestBody),
              signal: abortController!.signal,
            })
          : await fetch(apiUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(requestBody),
              signal: abortController!.signal,
            });
        clearTimeout(fetchTimeout);
      } catch (fetchErr: unknown) {
        clearTimeout(fetchTimeout);
        const err = fetchErr as Error;
        if (err.name === 'AbortError') {
          // 120s timeout (abortReason still null → 'error') or a registry
          // abort: Stop/orphan-timeout finalize as 'stopped' (GC5).
          finalizeDraft(terminalStatusForCurrentAbort());
          if (!clientDisconnected && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: 'Request timed out or was cancelled' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }
        throw fetchErr;
      }

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        let errorMsg = `API error (${apiResponse.status})`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMsg = errorJson.error?.message || errorMsg;
        } catch {
          errorMsg = errorText || errorMsg;
        }
        if (shouldRetryMaxEffort(errorMsg)) {
          // Retry is upstream-driven: connection state must not cancel it (GC4).
          console.warn('[chat] Model rejected reasoning effort "max", retrying with "xhigh":', errorMsg);
          degradeMaxEffort();
          continue;
        }
        finalizeDraft('error');
        if (!clientDisconnected && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      if (!apiResponse.body) {
        finalizeDraft('error');
        if (!clientDisconnected && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: 'No response body from API' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      // fullContent/fullReasoning live next to the draft helpers (they feed
      // ensureDraftRow/flushDraft) and are reset per iteration above.
      let streamHadRealError = false;
      // Set when the upstream read throws AbortError mid-body-read. The 120s
      // fetch timeout only covers connect and is always cleared by then, so
      // this is exclusively a registry abort (Stop / orphan-timeout /
      // shutdown) — the final close must label the persisted partial with the
      // mapped terminal status, not 'complete' (finding F1).
      let readLoopAborted = false;
      const toolCallsByIndex: Record<number, { id?: string; type?: string; function?: { name?: string; arguments?: string } }> = {};
      lastFinishReason = null;

      const reader = apiResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let chunkCount = 0;

      try {
        // Survival (plan S3): no clientDisconnected checks here — the upstream
        // stream is read to completion regardless of connection state.
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          chunkCount++;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(': ') || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                if (!clientDisconnected && !res.writableEnded) {
                  res.write(`data: ${JSON.stringify({ error: parsed.error.message || 'Stream error' })}\n\n`);
                }
                continue;
              }
              if (parsed.model && typeof parsed.model === 'string' && parsed.model.trim()) {
                actualModelFromResponse = parsed.model;
              }

              const delta = parsed.choices?.[0]?.delta;

              const reasoningChunk = delta?.reasoning || delta?.reasoning_content;
              if (reasoningChunk) {
                fullReasoning += reasoningChunk;
                ensureDraftRow();
                flushDraft();
                if (!clientDisconnected && !res.writableEnded) res.write(`data: ${JSON.stringify({ reasoning: reasoningChunk })}\n\n`);
              }
              if (delta?.content) {
                if (thinkSplitter) {
                  // llama.cpp (Qwen3-class): <think>…</think> bodies are
                  // reasoning; the rest is content. Each part rides its
                  // existing SSE/draft path.
                  emitThinkSplit(thinkSplitter.push(delta.content));
                } else {
                  fullContent += delta.content;
                  ensureDraftRow();
                  flushDraft();
                  if (!clientDisconnected && !res.writableEnded) res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
                }
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsByIndex[idx]) toolCallsByIndex[idx] = {};
                  if (tc.id) toolCallsByIndex[idx].id = tc.id;
                  if (tc.type) toolCallsByIndex[idx].type = tc.type;
                  if (tc.function) {
                    toolCallsByIndex[idx].function = toolCallsByIndex[idx].function || {};
                    if (tc.function.name) toolCallsByIndex[idx].function!.name = tc.function.name;
                    if (tc.function.arguments) toolCallsByIndex[idx].function!.arguments = (toolCallsByIndex[idx].function!.arguments || '') + tc.function.arguments;
                  }
                }
              }

              const usage = parsed.usage;
              if (usage) {
                totalTokens = usage.total_tokens ?? totalTokens;
                promptTokens = usage.prompt_tokens ?? promptTokens;
                completionTokens = usage.completion_tokens ?? completionTokens;
                if (usage.cost !== undefined) cost = usage.cost;
                if (usage.completion_tokens_details?.reasoning_tokens) reasoningTokens = usage.completion_tokens_details.reasoning_tokens;
                if (usage.prompt_tokens_details?.cached_tokens !== undefined) cachedTokens = usage.prompt_tokens_details.cached_tokens;
                if (provider.id === 'deepseek') {
                  cachedTokens = deepSeekCachedTokens(usage);
                  if (usage.cost === undefined) cost = computeDeepSeekCost(usage, upstreamModel);
                }
              }

              // Capture file (and other) annotations from stream for PDF skip-reparse on follow-ups
              const msgAnnotations = parsed.choices?.[0]?.message?.annotations ?? parsed.choices?.[0]?.delta?.annotations;
              if (Array.isArray(msgAnnotations) && msgAnnotations.length > 0) {
                streamedAnnotations = msgAnnotations;
              }

              const fr = parsed.choices?.[0]?.finish_reason;
              if (fr && fr !== 'null') lastFinishReason = fr;
            } catch {
              // skip malformed
            }
          }
        }
      } catch (streamErr: unknown) {
        if ((streamErr as Error).name === 'AbortError') {
          // Registry abort (Stop / orphan-timeout / shutdown) landing during
          // the body read: onAbort already recorded the reason before the
          // controller aborted, and the 120s timeout cannot be the source
          // here (it only covers connect). Remember it so the final close
          // finalizes with the mapped terminal status instead of 'complete'.
          readLoopAborted = true;
        } else {
          console.error('[chat] Stream error:', streamErr);
          // Distinct from the 120s abort timeout / registry aborts (both
          // handled via AbortError elsewhere) — a genuine stream-read failure.
          // Client connection state is irrelevant now that disconnects don't
          // abandon the stream: mark it so the turn finalizes as an error.
          streamHadRealError = true;
        }
      }

      // Stream ended: drain anything still buffered in the <think> splitter
      // (e.g. an unterminated <think> tail is reasoning) so persistence, the
      // reasoning-tool-call fallback parser, and finalize see complete text.
      if (thinkSplitter) emitThinkSplit(thinkSplitter.flush());

      const finishReason = lastFinishReason;

      // Tool calls: from delta (finish_reason === 'tool_calls') or parsed from reasoning (e.g. Kimi K2)
      let toolCallsArray: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      if (finishReason === 'tool_calls' && resolvedTools.length > 0) {
        const indices = Object.keys(toolCallsByIndex).map(Number).sort((a, b) => a - b);
        toolCallsArray = indices.map((idx) => {
          const t = toolCallsByIndex[idx];
          return {
            id: t?.id || `call_${nanoid()}`,
            type: (t?.type || 'function') as 'function',
            function: {
              name: t?.function?.name || '',
              arguments: t?.function?.arguments || '{}',
            },
          };
        }).filter((tc) => tc.function.name);
      } else if (fullReasoning.trim() && resolvedTools.length > 0) {
        const fromReasoning = parseReasoningToolCalls(fullReasoning);
        if (fromReasoning.length > 0) {
          toolCallsArray = fromReasoning.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
          if (toolCallsArray.length > 0) {
            console.log('[chat] tool calls parsed from reasoning:', toolCallsArray.map((t) => t.function.name).join(', '));
          }
        }
      }

      // Genuine stream-read failure that left nothing usable to persist or report as
      // success: surface it as an error instead of silently truncating the turn.
      if (streamHadRealError && !fullContent && toolCallsArray.length === 0) {
        finalizeDraft('error');
        if (!clientDisconnected && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: 'Stream connection error - please retry' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      if (toolCallsArray.length > 0) {
        messages.push({
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCallsArray,
          ...(fullReasoning.trim() ? { [assistantReasoningField(provider.id)]: fullReasoning } : {}),
        });

        // Milestone persist via the segment draft (plan S2): the row already
        // exists when text streamed this iteration; create-then-finalize
        // reproduces today's empty-content assistant-with-tool_calls INSERT
        // when no text streamed. Row count and tree shape are unchanged.
        ensureDraftRow();
        finalizeDraft('complete', { toolCallsJson: JSON.stringify(toolCallsArray) });

        for (const tc of toolCallsArray) {
          const id = tc.id;
          const name = tc.function.name;
          const argsStr = tc.function.arguments || '{}';
          const resolvedTool = resolvedTools.find((t) => t.name === name);
          const source = resolvedTool?.type || 'unknown';
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(argsStr);
          } catch {
            args = {};
          }

          if (!clientDisconnected && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ tool_call: { id, name, arguments: argsStr, source } })}\n\n`);
          }

          const startedAt = Date.now();
          const keepaliveTimer = setInterval(() => {
            if (!clientDisconnected && !res.writableEnded) res.write(': keepalive\n\n');
          }, 15_000);

          let result;
          let lastMcpProgressAt = 0;
          try {
            let outputSeq = 0;
            result = name === 'run_command'
              ? await runCommandTool(args, userId, {
                signal: abortController?.signal ?? new AbortController().signal,
                onOutputChunk: (chunk) => {
                  if (clientDisconnected || res.writableEnded) return;
                  res.write(`data: ${JSON.stringify(buildToolOutputChunkEvent(id, chunk, outputSeq++))}\n\n`);
                },
              })
              : await runTool(
                  resolvedTools,
                  name,
                  args,
                  mcpClients,
                  userId,
                  conversation_id,
                  messages,
                  {
                    authorizeMcpCall,
                    possibleCrossToolData: toolCallCount > 0,
                    mcpControl: {
                      ...(abortController?.signal ? { signal: abortController.signal } : {}),
                      onProgress: (progress) => {
                        if (clientDisconnected || res.writableEnded) return;
                        const now = Date.now();
                        if (now - lastMcpProgressAt < 100 && progress.progress !== progress.total) return;
                        lastMcpProgressAt = now;
                        res.write(`data: ${JSON.stringify({
                          tool_progress: {
                            id,
                            name,
                            progress: progress.progress,
                            ...(progress.total !== undefined ? { total: progress.total } : {}),
                            ...(progress.message ? { message: progress.message.slice(0, 2_000) } : {}),
                          },
                        })}\n\n`);
                      },
                    },
                  }
                );
          } finally {
            clearInterval(keepaliveTimer);
          }
          const durationMs = Date.now() - startedAt;
          toolCallCount++;
          toolTimeMs += durationMs;
          if (!clientDisconnected && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(buildToolResultEvent(id, name, result, durationMs))}\n\n`);
          }
          // Artifact SSE: emit {"artifact": <ChatArtifact>} immediately after tool_result for create/update artifact tools.
          if ((name === 'create_artifact' || name === 'update_artifact') && !clientDisconnected && !res.writableEnded) {
            try {
              const out = JSON.parse(result.output) as { ok?: boolean; artifactId?: string };
              if (out?.ok === true && typeof out.artifactId === 'string') {
                const { getArtifact } = await import('../artifacts/storage.js');
                const art = getArtifact(out.artifactId, userId);
                if (art) {
                  // Best-effort message_id linkage to current draft, if available.
                  if (!art.message_id && typeof openDraftId === 'string' && openDraftId) {
                    try {
                      db.prepare('UPDATE artifacts SET message_id = ? WHERE id = ? AND user_id = ?').run(openDraftId, art.id, userId);
                      art.message_id = openDraftId;
                    } catch { /* skip linkage */ }
                  }
                  res.write(`data: ${JSON.stringify({ artifact: art })}\n\n`);
                }
              }
            } catch { /* never break the turn over a notification failure */ }
          }

          messages.push({ role: 'tool', tool_call_id: id, content: result.output });

          const toolMsgId = nanoid();
          db.prepare(`
            INSERT INTO messages (id, conversation_id, role, content, tool_call_id, parent_id, turn_id, variant_seq)
            VALUES (?, ?, 'tool', ?, ?, ?, ?, ?)
          `).run(toolMsgId, conversation_id, result.output, id, chainTailId, turnId, variantSeq);
          chainTailId = toolMsgId;
          updateActiveLeaf(toolMsgId);
        }

        iteration++;
        if (isToolBudgetExceeded(toolCallCount, toolTimeMs)) {
          // Budget cap: append the notice to the capped segment's draft and
          // fall through — the final close below finalizes it 'complete'.
          const budgetMessage = '\n\n_Tool-call budget for this turn was reached; stopping here._';
          fullContent += budgetMessage;
          if (!clientDisconnected && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ content: budgetMessage })}\n\n`);
          }
        } else {
          continue;
        }
      }

      // finish_reason stop or null or no tool_calls: final text response
      // Use streamed annotations (e.g. PDF file annotations) when present, then merge web search citations
      let finalAnnots: unknown[] = streamedAnnotations ?? annotations;
      if (resolvedTools.length > 0 && messages.length > 0) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role === 'tool' && 'content' in m) {
            try {
              const data = JSON.parse((m as { content: string }).content);
              const results = Array.isArray(data) ? data : (data.results || (data.error ? [] : []));
              if (Array.isArray(results) && results.length > 0 && results[0].url) {
                finalAnnots = [...finalAnnots, ...annotationsFromWebSearchResults(results)];
                break;
              }
            } catch {
              // ignore
            }
          }
        }
      }
      // Final close (plan S2): the segment's draft — created by any streamed
      // delta, or by the milestone finalize when tools ran — gets its terminal
      // write with final annotations. No draft and no text ⇒ persist nothing,
      // exactly like today. A Stop/orphan/shutdown abort during the body read
      // labels the partial 'stopped'/'error' by reason instead of 'complete'
      // (policy d / finding F1); normal completion stays 'complete'.
      if (openDraftId || fullContent || fullReasoning) {
        finalizeDraft(readLoopAborted ? terminalStatusForCurrentAbort() : 'complete', { anns: finalAnnots });
      }
      sendDoneEvent(finalAnnots);
      res.end();
      return;
    }

  } catch (err: unknown) {
    const errName = err instanceof Error ? err.name : '';
    if (errName === 'AbortError') {
      // Registry abort (Stop/orphan-timeout/shutdown — onAbort already recorded
      // the reason) or a genuine timeout surfacing here: finalize by reason.
      finalizeOpenDraftHook?.(terminalStatusForCurrentAbort());
      return;
    }
    console.error('Chat error:', err);
    // GC5: an unexpected exception mid-turn still terminates its draft.
    finalizeOpenDraftHook?.('error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else if (!clientDisconnected && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    // Unregister this SSE connection from the shutdown tracker.
    untrackStream(res);

    // GC5: forget the turn and release the conversation's claim on every exit
    // path. clearTurn also cancels any pending orphan timer; the release only
    // matches our own turnId, so it stays idempotent even when this request
    // lost the 409 race or never claimed at all.
    if (userMsgId && turnConversationId) {
      clearTurn(userMsgId);
      db.prepare('UPDATE conversations SET active_turn_id = NULL WHERE id = ? AND active_turn_id = ?')
        .run(turnConversationId, userMsgId);
    }

    // Close MCP connections so stdio processes and HTTP sessions are released
    const closeResults = await Promise.allSettled(
      [...new Set(mcpClients.values())].map((connection) => connection.close())
    );
    for (const result of closeResults) {
      if (result.status === 'rejected') console.error('[chat] MCP close error:', result.reason);
    }
    mcpClients.clear();
  }
});

// Helper: Load general chat settings from database with defaults
function loadGeneralChatSettings(userId: string): {
  model: string;
  system_prompt: string;
  reasoning_enabled: boolean;
  reasoning_effort: string | null;
  reasoning_max_tokens: number | null;
  tool_ids: string[];
  mcp_server_ids: string[];
  skill_ids: string[];
  tool_choice: string;
  parallel_tool_calls: number;
  provider_routing: ProviderRoutingConfig | null;
} {
  const defaults = {
    model: 'openrouter/auto',
    system_prompt: 'You are a helpful AI assistant. You provide thoughtful, well-structured responses.',
    reasoning_enabled: false,
    reasoning_effort: null as string | null,
    reasoning_max_tokens: null as number | null,
    tool_ids: [] as string[],
    mcp_server_ids: [] as string[],
    skill_ids: [] as string[],
    tool_choice: 'auto',
    parallel_tool_calls: 1,
    provider_routing: null as ProviderRoutingConfig | null,
  };

  try {
    const model = getSettingValue(userId, 'general_chat_model');
    const systemPrompt = getSettingValue(userId, 'general_chat_system_prompt');
    const reasoningEnabled = getSettingValue(userId, 'general_chat_reasoning_enabled');
    const reasoningEffort = getSettingValue(userId, 'general_chat_reasoning_effort');
    const reasoningMaxTokens = getSettingValue(userId, 'general_chat_reasoning_max_tokens');
    const toolChoice = getSettingValue(userId, 'general_chat_tool_choice');
    const parallelToolCallsRaw = getSettingValue(userId, 'general_chat_parallel_tool_calls');
    const providerRouting = parseProviderRoutingConfig(getSettingValue(userId, 'general_chat_provider_routing'));

    let tool_ids = defaults.tool_ids;
    const rawToolIds = getSettingValue(userId, 'general_chat_tool_ids');
    if (rawToolIds && typeof rawToolIds === 'string') {
      try {
        const parsed = JSON.parse(rawToolIds) as unknown;
        if (Array.isArray(parsed)) tool_ids = parsed.filter((id): id is string => typeof id === 'string');
      } catch {
        // keep default
      }
    }

    let mcp_server_ids = defaults.mcp_server_ids;
    const rawMcpIds = getSettingValue(userId, 'general_chat_mcp_server_ids');
    if (rawMcpIds && typeof rawMcpIds === 'string') {
      try {
        const parsed = JSON.parse(rawMcpIds) as unknown;
        if (Array.isArray(parsed)) mcp_server_ids = parsed.filter((id): id is string => typeof id === 'string');
      } catch {
        // keep default
      }
    }

    let skill_ids = defaults.skill_ids;
    const rawSkillIds = getSettingValue(userId, 'general_chat_skill_ids');
    if (rawSkillIds && typeof rawSkillIds === 'string') {
      try {
        const parsed = JSON.parse(rawSkillIds) as unknown;
        if (Array.isArray(parsed)) skill_ids = parsed.filter((id): id is string => typeof id === 'string');
      } catch {
        // keep default
      }
    }

    const parallel_tool_calls = parallelToolCallsRaw === '0' ? 0 : 1;

    return {
      model: model || defaults.model,
      system_prompt: systemPrompt || defaults.system_prompt,
      reasoning_enabled: reasoningEnabled === '1' || reasoningEnabled === 'true',
      reasoning_effort: reasoningEffort || defaults.reasoning_effort,
      reasoning_max_tokens: reasoningMaxTokens ? parseInt(reasoningMaxTokens, 10) : defaults.reasoning_max_tokens,
      tool_ids,
      mcp_server_ids,
      skill_ids,
      tool_choice: toolChoice === 'none' ? 'none' : 'auto',
      parallel_tool_calls,
      provider_routing: providerRouting,
    };
  } catch {
    return defaults;
  }
}

// Helper: Create a virtual agent config for general chat
function createGeneralChatAgent(settings: ReturnType<typeof loadGeneralChatSettings>): Agent {
  return {
    id: 'general',
    name: 'General Chat',
    system_prompt: settings.system_prompt,
    provider: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    model: settings.model,
    temperature: 0.7,
    max_tokens: 60000,
    web_search_enabled: 0,
    reasoning_enabled: settings.reasoning_enabled ? 1 : 0,
    reasoning_effort: settings.reasoning_effort,
    reasoning_max_tokens: settings.reasoning_max_tokens,
    tool_choice: settings.tool_choice,
    parallel_tool_calls: settings.parallel_tool_calls,
    provider_routing: settings.provider_routing,
    structured_output_enabled: 0,
    structured_output_schema: null,
    response_healing_enabled: 0,
  };
}

export default router;
