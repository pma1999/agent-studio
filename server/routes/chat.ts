import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { getSettingValue } from './settings.js';
import { resolveToolsForAgent, toOpenRouterTools, runTool } from '../tools/index.js';
import { annotationsFromWebSearchResults } from '../tools/registry.js';
import type { McpConnection } from '../mcp/index.js';
import { AuthRequest } from '../middleware/auth.js';
import { trackStream, untrackStream, isShuttingDown } from '../shutdown.js';

const router = Router();
const MAX_TOOL_ITERATIONS = 10;

interface Agent {
  id: string;
  name: string;
  system_prompt: string;
  provider: string;
  base_url: string;
  model: string;
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
  agent_id: string;
  title: string;
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
    const body = req.body as { conversation_id?: string; content?: string; reasoning?: unknown; attachments?: unknown; pdf_engine?: string };
    const { conversation_id, content, reasoning, attachments: attachmentsRaw, pdf_engine: pdfEngineRaw } = body;

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

    // Get conversation (must belong to user)
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversation_id, userId) as Conversation | undefined;
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Get agent (must belong to user)
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(conversation.agent_id, userId) as Agent | undefined;
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // OpenRouter only: get API key from settings (decrypted server-side)
    const apiKey = getSettingValue(userId, 'openrouter_api_key');
    if (!apiKey?.trim()) {
      res.status(400).json({ error: 'OpenRouter API key not configured. Please set your API key in Settings.' });
      return;
    }

    // Save user message (content + optional attachments metadata for UI)
    const userMsgId = nanoid();
    const attachmentsMeta = attachments.length > 0 ? JSON.stringify(attachments.map((a) => ({ filename: a.filename }))) : null;
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, attachments)
      VALUES (?, ?, 'user', ?, ?)
    `).run(userMsgId, conversation_id, content, attachmentsMeta);

    // Update conversation title if first message
    const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversation_id) as { cnt: number };
    if (msgCount.cnt === 1) {
      const title = content.length > 50 ? content.substring(0, 50) + '...' : content;
      db.prepare('UPDATE conversations SET title = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?').run(title, conversation_id, userId);
    } else {
      db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(conversation_id, userId);
    }

    // Build messages array (include tool_calls, tool role, and annotations for assistant → skip re-parse PDFs)
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

    // Resolve tools for this agent (with user context for settings)
    const resolved = await resolveToolsForAgent(agent.id, userId);
    const resolvedTools = resolved.resolvedTools;
    mcpClients = resolved.mcpClients;
    const openRouterTools = toOpenRouterTools(resolvedTools);

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

    const apiUrl = 'https://openrouter.ai/api/v1/chat/completions';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'http://localhost:5173',
      'X-Title': 'Agent Studio',
    };

    const requestBody: Record<string, unknown> = {
      model: agent.model,
      messages,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      stream: true,
    };
    if (openRouterTools.length > 0) {
      requestBody.tools = openRouterTools;
      requestBody.tool_choice = agent.tool_choice === 'none' ? 'none' : 'auto';
      requestBody.parallel_tool_calls = agent.parallel_tool_calls === 0 ? false : true;
    }
    if (attachments.length > 0) {
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

    if (reasoningEnabled) {
      const reasoningParam: Record<string, unknown> = {};
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

    // Structured outputs (OpenRouter JSON Schema)
    // Accept both: short form { name, strict, schema } or full API form { type: "json_schema", json_schema: { name, strict, schema } }
    const structuredEnabled = !!agent.structured_output_enabled;
    const schemaRaw = agent.structured_output_schema;
    let responseFormat: { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } } | undefined;
    if (structuredEnabled && schemaRaw && typeof schemaRaw === 'string' && schemaRaw.trim()) {
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

    const useResponseHealing = !!agent.response_healing_enabled && !!responseFormat;
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
        INSERT INTO messages (id, conversation_id, role, content, tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, tool_calls)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assistantMsgId,
        conversation_id,
        content || '',
        totalTokens,
        promptTokens,
        completionTokens,
        cost,
        anns.length > 0 ? JSON.stringify(anns) : null,
        reasoning || null,
        reasoningTokens,
        cachedTokens,
        toolCallsJson
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

    while (iteration < MAX_TOOL_ITERATIONS) {
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
        if ((streamErr as Error).name !== 'AbortError') console.error('[chat] Stream error:', streamErr);
      }

      const finishReason = lastFinishReason;

      if (finishReason === 'tool_calls' && resolvedTools.length > 0) {
        const indices = Object.keys(toolCallsByIndex).map(Number).sort((a, b) => a - b);
        const toolCallsArray = indices.map((idx) => {
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

        if (toolCallsArray.length === 0) {
          console.log('[chat] finish_reason tool_calls but no valid tool_calls collected');
          break;
        }

        messages.push({
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCallsArray,
        });

        saveAssistantMessage(fullContent, fullReasoning, JSON.stringify(toolCallsArray), []);

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
          const result = await runTool(resolvedTools, name, args, mcpClients, userId);
          const durationMs = Date.now() - startedAt;
          res.write(`data: ${JSON.stringify({
            tool_result: {
              id,
              name,
              ok: !result.isError,
              result: result.output,
              duration_ms: durationMs,
              source: result.source,
            },
          })}\n\n`);

          messages.push({ role: 'tool', tool_call_id: id, content: result.output });

          const toolMsgId = nanoid();
          db.prepare(`
            INSERT INTO messages (id, conversation_id, role, content, tool_call_id)
            VALUES (?, ?, 'tool', ?, ?)
          `).run(toolMsgId, conversation_id, result.output, id);
        }

        iteration++;
        continue;
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
      if (fullContent || fullReasoning) {
        saveAssistantMessage(fullContent, fullReasoning, null, finalAnnots);
      }
      sendDoneEvent(finalAnnots);
      res.end();
      return;
    }

    if (iteration >= MAX_TOOL_ITERATIONS) {
      res.write(`data: ${JSON.stringify({ done: true, warning: 'Maximum tool iterations reached' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
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

export default router;
