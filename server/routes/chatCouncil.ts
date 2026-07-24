import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { getSettingValue } from './settings.js';
import { resolveToolsForAgent, resolveToolsFromIds, toOpenRouterTools, appendToolInstructionsIfNeeded } from '../tools/index.js';
import { CouncilExecutor } from '../services/councilExecutor.js';
import { getProviderConfig, resolveProviderId, type ProviderId } from '../providers/index.js';
import { buildDateTimeContext } from '../dateTimeContext.js';
import { AuthRequest } from '../middleware/auth.js';
import { trackStream, untrackStream } from '../shutdown.js';
import type { McpConnection } from '../mcp/index.js';
import type { CouncilConfig, CouncilMember } from '../types.js';
import {
  assertProviderRoutingCompatible,
  parseProviderRoutingConfig,
  parseProviderRoutingMap,
  serializeProviderRoutingConfig,
  serializeProviderRoutingMap,
  type ProviderRoutingConfig,
} from '../providerRouting.js';
import {
  AUTO_CONVERSATION_TITLES_SETTING_KEY,
  createFallbackConversationTitle,
  generateConversationTitleWithOpenRouter,
  isAutoConversationTitlesEnabled,
} from '../conversationTitles.js';

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
  tool_choice?: string;
  parallel_tool_calls?: number;
}

interface Conversation {
  id: string;
  user_id: string;
  agent_id: string | null;
  title: string;
  model?: string | null;
  provider_routing?: unknown;
}

const PDF_ENGINES = ['pdf-text', 'mistral-ocr', 'native'] as const;
type PDFEngine = (typeof PDF_ENGINES)[number];

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
  if (attachments.length > 5) {
    return { valid: [], error: 'Maximum 5 PDFs per message' };
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
      if (estimatedBytes > 20 * 1024 * 1024) {
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


function normalizeCouncilConfig(config: CouncilConfig): CouncilConfig {
  const memberProviderRouting = parseProviderRoutingMap(config.member_provider_routing);
  const synthesizerProviderRouting = parseProviderRoutingConfig(config.synthesizer_provider_routing);
  return {
    ...config,
    member_provider_routing: memberProviderRouting,
    synthesizer_provider_routing: synthesizerProviderRouting,
  };
}

// POST /api/chat/council - Execute council query with multi-model synthesis
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  let clientDisconnected = false;
  let abortController: AbortController | null = null;
  let mcpClients: Map<string, McpConnection> = new Map();

  res.on('close', () => {
    if (!res.writableFinished) {
      clientDisconnected = true;
      if (abortController) {
        abortController.abort();
      }
    }
  });

  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = req.body as {
      conversation_id?: string;
      content?: string;
      council_member_id?: string;
      council_config?: CouncilConfig;
      attachments?: unknown;
      pdf_engine?: string;
      timezone?: string;
      invoke_agent_id?: string;
    };

    const {
      conversation_id,
      content,
      council_member_id,
      council_config: inlineConfig,
      attachments: attachmentsRaw,
      pdf_engine: pdfEngineRaw,
      timezone: bodyTimezone,
      invoke_agent_id,
    } = body;

    if (!conversation_id || !content) {
      res.status(400).json({ error: 'conversation_id and content are required' });
      return;
    }

    const { valid: attachments, error: attachmentsError } = validateAttachments(attachmentsRaw);
    if (attachmentsError) {
      res.status(400).json({ error: attachmentsError });
      return;
    }

    const pdf_engine: PDFEngine = isPDFEngine(pdfEngineRaw) ? pdfEngineRaw : 'pdf-text';

    // Get conversation
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversation_id, userId) as Conversation | undefined;
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Get agent
    let agent: Agent | undefined;
    let generalSettings: ReturnType<typeof loadGeneralChatSettings> | undefined;

    if (invoke_agent_id) {
      agent = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(invoke_agent_id, userId) as Agent | undefined;
      if (!agent) {
        res.status(404).json({ error: 'Invoked agent not found' });
        return;
      }
    } else if (conversation.agent_id) {
      agent = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(conversation.agent_id, userId) as Agent | undefined;
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
    } else {
      generalSettings = loadGeneralChatSettings(userId);
      agent = createGeneralChatAgent(generalSettings);
    }

    // Resolve council configuration
    let councilConfig: CouncilConfig;
    if (council_member_id) {
      const member = db.prepare('SELECT * FROM council_members WHERE id = ? AND user_id = ?').get(council_member_id, userId) as CouncilMember | undefined;
      if (!member) {
        res.status(404).json({ error: 'Council configuration not found' });
        return;
      }
      const rawShow = (member as unknown as { show_member_responses?: number }).show_member_responses;
      councilConfig = {
        member_models: JSON.parse(member.member_models as unknown as string),
        member_provider_routing: parseProviderRoutingMap((member as unknown as { member_provider_routing?: unknown }).member_provider_routing),
        synthesizer_model: member.synthesizer_model,
        synthesizer_provider_routing: parseProviderRoutingConfig((member as unknown as { synthesizer_provider_routing?: unknown }).synthesizer_provider_routing),
        synthesis_prompt_template: member.synthesis_prompt_template || undefined,
        show_member_responses: rawShow !== 0,
        tool_ids: JSON.parse((member.tool_ids || '[]') as unknown as string),
        mcp_server_ids: JSON.parse((member.mcp_server_ids || '[]') as unknown as string),
      };
    } else if (inlineConfig) {
      councilConfig = normalizeCouncilConfig(inlineConfig);
    } else {
      res.status(400).json({ error: 'council_member_id or council_config is required' });
      return;
    }

    // Validate council config
    if (!councilConfig.member_models || councilConfig.member_models.length < 2) {
      res.status(400).json({ error: 'Council must have at least 2 member models' });
      return;
    }
    try {
      for (const modelId of councilConfig.member_models) {
        assertProviderRoutingCompatible(modelId, councilConfig.member_provider_routing?.[modelId]);
      }
      assertProviderRoutingCompatible(
        councilConfig.synthesizer_model || 'anthropic/claude-3.5-sonnet',
        councilConfig.synthesizer_provider_routing
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid provider routing' });
      return;
    }

    // Pre-flight: ensure an API key exists for every provider this run needs (members + synthesizer).
    const requiredProviders = new Set<ProviderId>();
    for (const modelId of councilConfig.member_models) requiredProviders.add(resolveProviderId(modelId));
    requiredProviders.add(resolveProviderId(councilConfig.synthesizer_model || 'anthropic/claude-3.5-sonnet'));
    const apiKeyByProvider = new Map<ProviderId, string>();
    for (const providerId of requiredProviders) {
      const cfg = getProviderConfig(providerId);
      const key = getSettingValue(userId, cfg.apiKeySetting);
      if (!key?.trim()) {
        res.status(400).json({ error: `${cfg.label} API key not configured. Please set your API key in Settings.` });
        return;
      }
      apiKeyByProvider.set(providerId, key);
    }
    const getApiKey = (providerId: ProviderId): string => apiKeyByProvider.get(providerId) ?? '';

    // Save user message
    const userMsgId = nanoid();
    const attachmentsMeta = attachments.length > 0 ? JSON.stringify(attachments.map((a) => ({ filename: a.filename }))) : null;
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, attachments)
      VALUES (?, ?, 'user', ?, ?)
    `).run(userMsgId, conversation_id, content, attachmentsMeta);

    // Update conversation title
    const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversation_id) as { cnt: number };
    let firstMessageTitle: string | null = null;
    let generatedTitlePromise: Promise<string | null> | null = null;
    if (msgCount.cnt === 1) {
      const fallbackTitle = createFallbackConversationTitle(content);
      firstMessageTitle = fallbackTitle;
      db.prepare('UPDATE conversations SET title = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').run(fallbackTitle, conversation_id, userId);

      const titleApiKey = getSettingValue(userId, 'openrouter_api_key');
      const titleEnabled = isAutoConversationTitlesEnabled(getSettingValue(userId, AUTO_CONVERSATION_TITLES_SETTING_KEY));
      if (titleEnabled && titleApiKey.trim()) {
        generatedTitlePromise = generateConversationTitleWithOpenRouter({
          apiKey: titleApiKey,
          userMessage: content,
          systemPrompt: agent.system_prompt,
        }).then((title) => {
          if (!title || title === fallbackTitle) return null;
          db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?').run(title, conversation_id, userId);
          return title;
        });
      }
    } else {
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(conversation_id, userId);
    }

    // Build message history
    const historyRows = db.prepare(`
      SELECT role, content, tool_call_id, tool_calls, annotations
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `).all(conversation_id) as { role: string; content: string; tool_call_id: string | null; tool_calls: string | null; annotations: string | null }[];

    const history = historyRows.map((row) => {
      if (row.role === 'tool') {
        return { role: 'tool' as const, tool_call_id: row.tool_call_id!, content: row.content || '' };
      }
      if (row.role === 'assistant') {
        const tool_calls = row.tool_calls ? (JSON.parse(row.tool_calls) as { id: string; type: string; function: { name: string; arguments: string } }[]) : undefined;
        const annotations = row.annotations ? (JSON.parse(row.annotations) as unknown[]) : undefined;
        const out: { role: 'assistant'; content: string | null; tool_calls?: unknown[]; annotations?: unknown[] } = {
          role: 'assistant',
          content: row.content || null,
        };
        if (tool_calls?.length) out.tool_calls = tool_calls;
        if (annotations?.length) out.annotations = annotations;
        return out;
      }
      return { role: row.role as 'user' | 'assistant', content: row.content };
    });

    // Resolve tools for council (same logic as chat: general → settings tool_ids, else agent tools)
    const resolved =
      agent.id === 'general' && generalSettings
        ? await resolveToolsFromIds(
            generalSettings.tool_ids || [],
            generalSettings.mcp_server_ids || [],
            userId
          )
        : await resolveToolsForAgent(agent.id, userId);
    let resolvedTools = resolved.resolvedTools;
    mcpClients = resolved.mcpClients;

    // Add council-specific tools if configured (resolve by id only: council belongs to user, tool_ids are from their config)
    if (councilConfig.tool_ids?.length || councilConfig.mcp_server_ids?.length) {
      const councilResolved = await resolveToolsFromIds(
        councilConfig.tool_ids || [],
        councilConfig.mcp_server_ids || [],
        userId,
        { byIdOnly: true }
      );
      // Merge tools avoiding duplicates
      const existingNames = new Set(resolvedTools.map((t) => t.name));
      for (const tool of councilResolved.resolvedTools) {
        if (!existingNames.has(tool.name)) {
          resolvedTools.push(tool);
          existingNames.add(tool.name);
        }
      }
      // Merge MCP clients
      for (const [key, value] of councilResolved.mcpClients) {
        if (!mcpClients.has(key)) {
          mcpClients.set(key, value);
        }
      }
    }

    // Create council run record
    const councilRunId = nanoid();
    const synthesizerModel = councilConfig.synthesizer_model || 'anthropic/claude-3.5-sonnet';
    const showMemberResponses = councilConfig.show_member_responses !== false ? 1 : 0;
    db.prepare(`
      INSERT INTO council_runs (
        id, user_id, conversation_id, user_message_id, synthesizer_model, synthesizer_provider_routing, member_provider_routing, member_count, system_prompt, status, started_at, show_member_responses
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now'), ?)
    `).run(
      councilRunId,
      userId,
      conversation_id,
      userMsgId,
      synthesizerModel,
      serializeProviderRoutingConfig(councilConfig.synthesizer_provider_routing),
      serializeProviderRoutingMap(councilConfig.member_provider_routing),
      councilConfig.member_models.length,
      agent.system_prompt,
      showMemberResponses
    );

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
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
        console.warn('[council] Conversation title generation skipped:', err instanceof Error ? err.message : String(err));
      });

    abortController = new AbortController();

    // Create executor and run council (resolves the right key per member/synthesizer provider)
    const executor = new CouncilExecutor(getApiKey);

    const result = await executor.execute({
      conversationId: conversation_id,
      userId,
      content,
      memberModels: councilConfig.member_models,
      synthesizerModel,
      memberProviderRouting: councilConfig.member_provider_routing,
      synthesizerProviderRouting: councilConfig.synthesizer_provider_routing,
      // System prompt stays static (cacheable prefix); date/time goes on the current turn.
      systemPrompt: appendToolInstructionsIfNeeded(agent.system_prompt, resolvedTools),
      dateTimeContext: buildDateTimeContext(bodyTimezone),
      messageHistory: history as Array<{ role: string; content: string }>,
      attachments: attachments.length > 0 ? attachments : undefined,
      pdfEngine: pdf_engine,
      tools: resolvedTools,
      mcpClients,
      onMemberStart: (index, modelId) => {
        if (!clientDisconnected) {
          res.write(`data: ${JSON.stringify({
            type: 'council_member_start',
            member_index: index,
            model_id: modelId,
            total_members: councilConfig.member_models.length,
          })}\n\n`);
        }
      },
      onMemberComplete: (index, memberResult) => {
        // Save member response to database
        const responseId = nanoid();
        db.prepare(`
          INSERT INTO council_responses (
            id, council_run_id, model_id, provider_routing, content, reasoning_content,
            tokens_used, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens,
            cost, response_time_ms, status, error_message, display_order, tool_calls, tool_results
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          responseId,
          councilRunId,
          memberResult.modelId,
          serializeProviderRoutingConfig(memberResult.providerRouting),
          memberResult.content || '',
          memberResult.reasoningContent || null,
          memberResult.tokensUsed,
          memberResult.promptTokens,
          memberResult.completionTokens,
          memberResult.reasoningTokens,
          0, // cached_tokens
          memberResult.cost,
          memberResult.responseTimeMs,
          memberResult.status,
          memberResult.errorMessage || null,
          index,
          memberResult.toolCalls ? JSON.stringify(memberResult.toolCalls) : null,
          memberResult.toolResults?.length ? JSON.stringify(memberResult.toolResults) : null
        );

        if (!clientDisconnected) {
          res.write(`data: ${JSON.stringify({
            type: 'council_member_complete',
            member_index: index,
            model_id: memberResult.modelId,
            status: memberResult.status,
            tokens_used: memberResult.tokensUsed,
            cost: memberResult.cost,
            response_time_ms: memberResult.responseTimeMs,
            error_message: memberResult.errorMessage,
          })}\n\n`);
        }
      },
      onSynthesisStart: (modelId, successfulMembers) => {
        if (!clientDisconnected) {
          res.write(`data: ${JSON.stringify({
            type: 'council_synthesis_start',
            synthesizer_model: modelId,
            successful_members: successfulMembers.length,
            failed_members: councilConfig.member_models.length - successfulMembers.length,
          })}\n\n`);
        }
      },
      onSynthesisChunk: (chunk) => {
        if (!clientDisconnected) {
          res.write(`data: ${JSON.stringify({
            type: 'council_synthesis_chunk',
            content: chunk,
          })}\n\n`);
        }
      },
      signal: abortController.signal,
    });

    // Save synthesis message
    const assistantMsgId = nanoid();
    db.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, tokens_used, prompt_tokens, completion_tokens,
        cost, reasoning_content, model, provider_routing, council_run_id, is_council_synthesis
      ) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      assistantMsgId,
      conversation_id,
      result.synthesis.content,
      result.totalTokens,
      result.synthesis.promptTokens,
      result.synthesis.completionTokens,
      result.totalCost,
      result.synthesis.reasoningContent || null,
      synthesizerModel,
      serializeProviderRoutingConfig(result.synthesis.providerRouting),
      councilRunId
    );

    // Update council run (comparison_json filled in background after completion event)
    const successfulCount = result.memberResults.filter((r) => r.status === 'success').length;
    const failedCount = result.memberResults.length - successfulCount;
    db.prepare(`
      UPDATE council_runs SET
        message_id = ?,
        status = ?,
        completed_at = datetime('now'),
        total_cost = ?,
        total_tokens = ?,
        total_prompt_tokens = ?,
        total_completion_tokens = ?,
        failed_members = ?
      WHERE id = ?
    `).run(
      assistantMsgId,
      failedCount > 0 ? 'partial_failure' : 'completed',
      result.totalCost,
      result.totalTokens,
      result.memberResults.reduce((sum, r) => sum + r.promptTokens, 0),
      result.memberResults.reduce((sum, r) => sum + r.completionTokens, 0),
      failedCount,
      councilRunId
    );

    // Send completion event so the client stops "synthesis in progress" immediately
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({
        type: 'council_complete',
        council_run_id: councilRunId,
        message_id: assistantMsgId,
        total_cost: result.totalCost,
        total_tokens: result.totalTokens,
        synthesis_tokens: result.synthesis.tokensUsed,
        synthesis_cost: result.synthesis.cost,
      })}\n\n`);
      res.write('data: [DONE]\n\n');
    }

    res.end();

    // Run comparison extraction in background; update council_run when done so next load shows tables
    const successfulResults = result.memberResults.filter((r) => r.status === 'success' && r.content);
    if (successfulResults.length > 0) {
      executor.extractComparison(successfulResults, result.synthesis.content, content, synthesizerModel, result.synthesis.providerRouting, undefined)
        .then((comparisonJson) => {
          if (comparisonJson) {
            db.prepare('UPDATE council_runs SET comparison_json = ? WHERE id = ?').run(comparisonJson, councilRunId);
            console.log(`   📊 Comparison extraction (background) OK`);
          }
        })
        .catch((err) => {
          console.log(`   ⚠️ Comparison extraction (background) skipped: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  } catch (err: unknown) {
    const errName = err instanceof Error ? err.name : '';
    if (errName === 'AbortError') {
      return;
    }

    console.error('Council chat error:', err);

    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({
        type: 'council_error',
        error: err instanceof Error ? err.message : 'Internal server error',
        phase: 'execution',
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    untrackStream(res);
    for (const conn of mcpClients.values()) {
      conn.close().catch((e) => console.error('[council] MCP close error:', e));
    }
  }
});

// Helper: Load general chat settings
function loadGeneralChatSettings(userId: string): {
  model: string;
  system_prompt: string;
  tool_ids: string[];
  mcp_server_ids: string[];
  provider_routing: ProviderRoutingConfig | null;
} {
  const defaults = {
    model: 'openrouter/auto',
    system_prompt: 'You are a helpful AI assistant.',
    tool_ids: [] as string[],
    mcp_server_ids: [] as string[],
    provider_routing: null as ProviderRoutingConfig | null,
  };

  try {
    const model = getSettingValue(userId, 'general_chat_model');
    const systemPrompt = getSettingValue(userId, 'general_chat_system_prompt');
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

    return {
      model: model || defaults.model,
      system_prompt: systemPrompt || defaults.system_prompt,
      tool_ids,
      mcp_server_ids,
      provider_routing: providerRouting,
    };
  } catch {
    return defaults;
  }
}

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
    tool_choice: 'auto',
    parallel_tool_calls: 1,
    provider_routing: settings.provider_routing,
  };
}

export default router;
