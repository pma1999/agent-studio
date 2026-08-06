import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { getSettingValue } from './settings.js';
import { resolveToolsForAgent, resolveToolsFromIds, toOpenRouterTools, runTool, appendToolInstructionsIfNeeded, getConversationToolOverride, selectToolResolutionSource } from '../tools/index.js';
import { annotationsFromWebSearchResults } from '../tools/registry.js';
import { runCommandTool } from '../tools/execCommand.js';
import type { RunToolResult } from '../tools/run.js';
import { parseReasoningToolCalls } from '../utils/parseReasoningToolCalls.js';
import type { McpConnection } from '../mcp/index.js';
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
} from '../providers/index.js';
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
  generateConversationTitleWithCodex,
  isAutoConversationTitlesEnabled,
} from '../conversationTitles.js';
import { isUserAllowed } from '../codex/instanceManager.js';
import { buildThreadIds } from '../messageTree.js';

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

// POST /api/chat - Send message and stream response
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  let clientDisconnected = false;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let abortController: AbortController | null = null;
  let mcpClients: Map<string, McpConnection> = new Map();

  // Stream cancellation: detect when the client disconnects
  // IMPORTANT: Use res.on('close'), NOT req.on('close').
  // req.on('close') fires when the request body stream is consumed (immediately for POST),
  // but res.on('close') fires when the client actually disconnects the response connection.
  res.on('close', () => {
    // Only treat as disconnect if we haven't finished writing the response
    if (!res.writableFinished) {
      console.log(`[chat] Client disconnected (res.close before writableFinished). abortController=${!!abortController}, upstreamReader=${!!upstreamReader}`);
      clientDisconnected = true;
      if (abortController) {
        abortController.abort();
      }
      if (upstreamReader) {
        upstreamReader.cancel().catch(() => {});
      }
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

    // API key for the resolved provider (decrypted server-side). The ChatGPT
    // (Codex) provider has no API key — its account state is validated in the
    // codex branch below.
    const apiKey = getSettingValue(userId, provider.apiKeySetting);
    if (!apiKey?.trim() && !isCodexModel(effectiveModel)) {
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
    const userMsgId = nanoid();
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
      } else if (titleEnabled && isUserAllowed(userId)) {
        // No OpenRouter key: generate the title through the ChatGPT connection.
        generatedTitlePromise = generateConversationTitleWithCodex(userId, content, agent.system_prompt).then(titleFallback);
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
    const conversationToolOverride = getConversationToolOverride(conversation.id);
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

    const apiUrl = provider.chatCompletionsUrl;

    const headers: Record<string, string> = provider.buildHeaders(apiKey);

    let actualModelFromResponse: string | null = null;

    const requestBody: Record<string, unknown> = {
      model: upstreamModel,
      messages,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      stream: true,
    };
    if (openRouterProviderPreference) {
      requestBody.provider = openRouterProviderPreference;
    }
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
        // 'max' is a ChatGPT/Codex-only effort tier; clamp it for other
        // providers so an Ultra selection never 400s on OpenRouter models.
        const safeEffort = reasoningEffort === 'max' && provider.id !== 'codex' ? 'xhigh' : reasoningEffort;
        if (safeEffort && safeEffort !== 'none') {
          reasoningParam.effort = safeEffort;
        } else if (safeEffort === 'none') {
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

    const useResponseHealing = !!agent.response_healing_enabled && !!responseFormat && provider.id !== 'codex';
    if (useResponseHealing) {
      requestBody.stream = false;
      const plugins = (requestBody.plugins as { id: string; pdf?: { engine: string } }[]) || [];
      if (!plugins.some((p) => p.id === 'response-healing')) {
        requestBody.plugins = [...plugins, { id: 'response-healing' }];
      }
    }

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
        // Keep the namespaced id for DeepSeek so history/UI shows DeepSeek-direct
        // (the upstream response reports the bare upstream model name).
        provider.id === 'deepseek' ? effectiveModel : (actualModelFromResponse ?? effectiveModel),
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

    // -----------------------------------------------------------------------
    // ChatGPT (Codex app-server) branch
    //
    // No chat-completions fetch: the turn is bridged to the user's per-user
    // `codex app-server` process (server/codex/chat.ts). Content/reasoning
    // deltas and tool events map onto the same SSE shapes the frontend already
    // consumes; tool calls run through the app's own tool executors.
    // -----------------------------------------------------------------------
    if (provider.id === 'codex') {
      abortController = new AbortController();

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
        emit: (evt) => {
          if (clientDisconnected || res.writableEnded) return;
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        },
        persistToolResult: (callId, _name, result) => {
          pendingToolRows.push({ callId, output: result.output });
        },
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
      const codexAssistantMsgId = saveAssistantMessage(codexResult.content, codexResult.reasoning, toolCallsJson, []);

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

      // Merge web-search citations from tool outputs, mirroring the generic path.
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

      if (codexResult.content || codexResult.reasoning) {
        updateAssistantMessage(codexAssistantMsgId, codexResult.content, codexResult.reasoning, finalAnnots);
      }
      sendDoneEvent(finalAnnots);
      res.end();
      return;
    }

    // Non-streaming path (Response Healing): single request, then forward full response as SSE
    if (requestBody.stream === false) {
      requestBody.messages = messages;
      abortController = new AbortController();
      const fetchTimeout = setTimeout(() => {
        if (abortController) abortController.abort();
      }, 120_000);
      let apiRes: globalThis.Response;
      try {
        apiRes = await fetch(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: abortController.signal,
        });
        clearTimeout(fetchTimeout);
      } catch (fetchErr: unknown) {
        clearTimeout(fetchTimeout);
        const err = fetchErr as Error;
        if (err.name === 'AbortError') {
          if (!clientDisconnected) {
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
        res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      let data: { choices?: { message?: { content?: string; reasoning_content?: string }; usage?: unknown }[]; usage?: Record<string, unknown> };
      try {
        data = (await apiRes.json()) as typeof data;
      } catch {
        res.write(`data: ${JSON.stringify({ error: 'Invalid JSON from API' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const fullContent = data.choices?.[0]?.message?.content ?? '';
      const msg = data.choices?.[0]?.message as { reasoning_content?: string; reasoning?: string } | undefined;
      const fullReasoning = (msg?.reasoning_content ?? msg?.reasoning ?? '').trim();
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
        res.write(`data: ${JSON.stringify({ reasoning: fullReasoning })}\n\n`);
      }
      if (fullContent) {
        res.write(`data: ${JSON.stringify({ content: fullContent })}\n\n`);
      }
      saveAssistantMessage(fullContent, fullReasoning, null, []);
      sendDoneEvent([]);
      res.end();
      return;
    }

    abortController = new AbortController();
    let iteration = 0;
    let lastFinishReason: string | null = null;
    let toolCallCount = 0;
    let toolTimeMs = 0;

    while (true) {
      actualModelFromResponse = null;
      streamedAnnotations = null;
      requestBody.messages = messages;
      if (openRouterTools.length > 0) {
        requestBody.tools = openRouterTools;
        requestBody.tool_choice = agent.tool_choice === 'none' ? 'none' : 'auto';
        requestBody.parallel_tool_calls = agent.parallel_tool_calls === 0 ? false : true;
      }

      console.log(`[chat] Request iteration ${iteration + 1} to ${apiUrl} messages=${messages.length}`);

      const fetchTimeout = setTimeout(() => {
        if (abortController) abortController.abort();
      }, 120_000);

      let apiResponse: globalThis.Response;
      try {
        apiResponse = await fetch(apiUrl, {
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
          if (!clientDisconnected) {
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
        res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (!apiResponse.body) {
        res.write(`data: ${JSON.stringify({ error: 'No response body from API' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      let fullContent = '';
      let fullReasoning = '';
      let streamHadRealError = false;
      const toolCallsByIndex: Record<number, { id?: string; type?: string; function?: { name?: string; arguments?: string } }> = {};
      lastFinishReason = null;

      const reader = apiResponse.body.getReader();
      upstreamReader = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      let chunkCount = 0;

      try {
        while (true) {
          if (clientDisconnected) break;
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          chunkCount++;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (clientDisconnected) break;
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(': ') || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                res.write(`data: ${JSON.stringify({ error: parsed.error.message || 'Stream error' })}\n\n`);
                continue;
              }
              if (parsed.model && typeof parsed.model === 'string' && parsed.model.trim()) {
                actualModelFromResponse = parsed.model;
              }

              const delta = parsed.choices?.[0]?.delta;

              const reasoningChunk = delta?.reasoning || delta?.reasoning_content;
              if (reasoningChunk) {
                fullReasoning += reasoningChunk;
                res.write(`data: ${JSON.stringify({ reasoning: reasoningChunk })}\n\n`);
              }
              if (delta?.content) {
                fullContent += delta.content;
                res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
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
        if ((streamErr as Error).name !== 'AbortError') {
          console.error('[chat] Stream error:', streamErr);
          // Distinct from a deliberate client disconnect or the 120s abort timeout
          // (both already handled elsewhere) — this is a genuine stream-read failure.
          if (!clientDisconnected) streamHadRealError = true;
        }
      }

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
        if (!clientDisconnected && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: 'Stream connection error - please retry' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      let cappedToolCallMessageId: string | null = null;
      if (toolCallsArray.length > 0) {
        messages.push({
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCallsArray,
          ...(fullReasoning.trim() ? { [assistantReasoningField(provider.id)]: fullReasoning } : {}),
        });

        const assistantMsgId = saveAssistantMessage(fullContent, fullReasoning, JSON.stringify(toolCallsArray), []);

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

          res.write(`data: ${JSON.stringify({ tool_call: { id, name, arguments: argsStr, source } })}\n\n`);

          const startedAt = Date.now();
          const keepaliveTimer = setInterval(() => {
            if (!clientDisconnected && !res.writableEnded) res.write(': keepalive\n\n');
          }, 15_000);

          let result;
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
              : await runTool(resolvedTools, name, args, mcpClients, userId, conversation_id, messages);
          } finally {
            clearInterval(keepaliveTimer);
          }
          const durationMs = Date.now() - startedAt;
          toolCallCount++;
          toolTimeMs += durationMs;
          res.write(`data: ${JSON.stringify(buildToolResultEvent(id, name, result, durationMs))}\n\n`);

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
          cappedToolCallMessageId = assistantMsgId;
          const budgetMessage = '\n\n_Tool-call budget for this turn was reached; stopping here._';
          fullContent += budgetMessage;
          res.write(`data: ${JSON.stringify({ content: budgetMessage })}\n\n`);
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
      if (cappedToolCallMessageId) {
        updateAssistantMessage(cappedToolCallMessageId, fullContent, fullReasoning, finalAnnots);
      } else if (fullContent || fullReasoning) {
        saveAssistantMessage(fullContent, fullReasoning, null, finalAnnots);
      }
      sendDoneEvent(finalAnnots);
      res.end();
      return;
    }

  } catch (err: unknown) {
    // AbortError is expected when client disconnects
    const errName = err instanceof Error ? err.name : '';
    if (errName === 'AbortError') {
      return;
    }
    console.error('Chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    // Unregister this SSE connection from the shutdown tracker.
    untrackStream(res);
    // Close MCP connections so stdio processes and HTTP sessions are released
    for (const conn of mcpClients.values()) {
      conn.close().catch((e) => console.error('[chat] MCP close error:', e));
    }
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
