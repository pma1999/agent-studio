/**
 * Single-shot compaction summary call (compact-route).
 *
 * Same-model, tool-free, stream:false, temperature 0.2, max_tokens 4096.
 * Provider matrix per task brief; injectable fetchImpl for offline tests.
 */
import {
  getProviderForModel,
  toUpstreamModelId,
  buildDeepSeekThinking,
  buildAbliterationReasoning,
  isCodexModel,
  isLlamacppModel,
} from '../providers/index.js';
import { isLegacyLmStudioModel } from '../providers/llamacpp.js';
import { llamacppFetch } from '../providers/llamacppTransport.js';
import { runCodexTurn } from '../codex/chat.js';
import { getSettingValue } from '../routes/settings.js';

export interface CompactionSummaryArgs {
  userId: string;
  conversationId: string | null;
  /** Current conversations.codex_thread_id (may be null). DISCARDED by the atomic NULL. */
  codexThreadId: string | null;
  systemPrompt: string;
  /** Built compaction prompt (head + prior + focus + template). */
  prompt: string;
  /** Namespaced effective model id (messageModel || conversation.model || agent.model). */
  effectiveModel: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  runCodexTurnImpl?: typeof runCodexTurn;
  llamacppFetchImpl?: typeof llamacppFetch;
}

export interface CompactionSummaryResult {
  text: string;
}

export interface SummarizeErrorShape {
  code: string;
  status?: number;
  errorText?: string;
  message?: string;
}

function summarizeError(code: string, message: string, extra?: { status?: number; errorText?: string }): SummarizeErrorShape & Error {
  const err = new Error(message) as Error & SummarizeErrorShape;
  err.code = code;
  if (extra?.status !== undefined) err.status = extra.status;
  if (extra?.errorText !== undefined) err.errorText = extra.errorText;
  return err as SummarizeErrorShape & Error;
}

// Test seam: offline stub without network. The route's test script sets this;
// an explicit per-call fetchImpl still wins over the module seam.
let testFetchImpl: typeof fetch | null = null;
let testCodexImpl: typeof runCodexTurn | null = null;
let testLlamacppImpl: typeof llamacppFetch | null = null;

export function setSummarizeFetchImplForTests(fn: typeof fetch | null): void {
  testFetchImpl = fn;
}
export function setSummarizeCodexImplForTests(fn: typeof runCodexTurn | null): void {
  testCodexImpl = fn;
}
export function setSummarizeLlamacppImplForTests(fn: typeof llamacppFetch | null): void {
  testLlamacppImpl = fn;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === 'string') parts.push(p);
      else if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
        parts.push((p as { text: string }).text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

async function singleShotFetch(args: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${args.apiKey}`,
    'HTTP-Referer': 'http://localhost:5173',
    'X-Title': 'Agent Studio',
  };
  // DeepSeek-direct / Abliteration / Arnict use Bearer only (their builders
  // already shape the body); header shape above matches conversationTitles.ts
  // for OpenRouter and is accepted by the OpenAI-compatible direct endpoints.
  // For non-OpenRouter providers the extra Referer/Title headers are harmless.
  let response: Response;
  try {
    response = await args.fetchImpl(args.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(args.body),
      signal: args.signal,
    });
  } catch (err) {
    // AbortError propagates so the route can map stop/timeout/disconnect.
    throw err;
  }
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let message = `API error (${response.status})`;
    try {
      const parsed = JSON.parse(errorText) as { error?: { message?: string } };
      if (parsed?.error?.message) message = parsed.error.message;
      else if (errorText) message = errorText.slice(0, 500);
    } catch {
      if (errorText) message = errorText.slice(0, 500);
    }
    throw summarizeError('provider_error', message, { status: response.status, errorText: `${message}\n${errorText}`.slice(0, 2000) });
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  return extractMessageText(data?.choices?.[0]?.message?.content);
}

export async function runCompactionSummary(args: CompactionSummaryArgs): Promise<CompactionSummaryResult> {
  const { userId, effectiveModel } = args;
  const provider = getProviderForModel(effectiveModel);
  const upstream = toUpstreamModelId(effectiveModel);
  const signal = args.signal;

  // lmstudio:* ids from the removed provider are rejected before any network
  // (precedent: chat.ts 400 before key lookup). Here it surfaces as a
  // compaction.failed {code:'unsupported_model'} rather than HTTP 400.
  if (isLegacyLmStudioModel(effectiveModel) || provider.id === 'lmstudio') {
    throw summarizeError('unsupported_model', 'This conversation uses the removed LM Studio provider.');
  }

  // Codex models bridge to the app-server; the used thread id is DISCARDED by
  // the atomic codex_thread_id=NULL in the persist transaction. That orphans
  // one server-side thread per compact; startCodexReaper owns cleanup.
  if (isCodexModel(effectiveModel)) {
    const runTurn = args.runCodexTurnImpl ?? testCodexImpl ?? runCodexTurn;
    const result = await runTurn({
      userId,
      conversationId: args.conversationId,
      threadId: args.codexThreadId,
      systemPrompt: args.systemPrompt,
      messages: [{ role: 'user', content: args.prompt }],
      model: upstream || null,
      tools: [],
      toolChoice: 'none',
      ...(signal ? { signal } : {}),
    });
    return { text: result.content ?? '' };
  }

  if (isLlamacppModel(effectiveModel)) {
    // Mirror of server/routes/chat.ts llamacpp loopback POST (llamacppFetch
    // over direct/relay transport), single-shot variant: stream:false,
    // temperature 0.2, no tools/reasoning extras.
    const doFetch = args.llamacppFetchImpl ?? testLlamacppImpl ?? llamacppFetch;
    const body: Record<string, unknown> = {
      model: upstream,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.prompt },
      ],
      temperature: 0.2,
      max_tokens: 4096,
      stream: false,
    };
    let response: Response;
    try {
      response = await doFetch(userId, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw err;
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      let message = `API error (${response.status})`;
      try {
        const parsed = JSON.parse(errorText) as { error?: { message?: string } };
        if (parsed?.error?.message) message = parsed.error.message;
        else if (errorText) message = errorText.slice(0, 500);
      } catch {
        if (errorText) message = errorText.slice(0, 500);
      }
      throw summarizeError('provider_error', message, { status: response.status, errorText: `${message}\n${errorText}`.slice(0, 2000) });
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    return { text: extractMessageText(data?.choices?.[0]?.message?.content) };
  }

  // openrouter / deepseek / abliteration / arnict — POST chatCompletionsUrl.
  const fetchImpl = args.fetchImpl ?? testFetchImpl ?? fetch;
  const apiKey = getSettingValue(userId, provider.apiKeySetting);
  if (!apiKey?.trim()) {
    throw summarizeError('no_api_key', `${provider.label} API key not configured.`);
  }
  const body: Record<string, unknown> = {
    model: upstream,
    messages: [
      { role: 'system', content: args.systemPrompt },
      { role: 'user', content: args.prompt },
    ],
    temperature: 0.2,
    max_tokens: 4096,
    stream: false,
  };
  // Per-provider reasoning-off extras ONLY; NEVER provider/plugins/tools.
  if (provider.id === 'deepseek') {
    Object.assign(body, buildDeepSeekThinking(false, null));
  } else if (provider.id === 'abliteration') {
    Object.assign(body, buildAbliterationReasoning(false, null));
  } else if (provider.id === 'arnict') {
    body.reasoning = { enabled: false };
  }
  // openrouter: NO reasoning key.
  const text = await singleShotFetch({ url: provider.chatCompletionsUrl, apiKey, body, signal, fetchImpl });
  return { text };
}
