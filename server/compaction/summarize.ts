/**
 * Single-shot compaction summary call (compact-route).
 *
 * Same-model, tool-free, stream:false, temperature 0.2, max_tokens 4096.
 * Provider matrix per task brief; injectable fetchImpl for offline tests.
 */
import {
  getProviderForModel,
  toUpstreamModelId,
  isCodexModel,
  isLlamacppModel,
  OPENCODE_GO_ANTHROPIC_VERSION,
  OPENCODE_GO_MESSAGES_URL,
  OPENCODE_GO_RESPONSES_URL,
} from '../providers/index.js';
import { chatReasoningFields } from '../providers/wire/reasoning.js';
import { buildMessagesBody, buildResponsesBody } from '../providers/wire/transports.js';
import { modelCatalog } from '../catalog/index.js';
import { planReasoning } from '../../shared/models/reasoning.js';
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

/** Text of a non-streamed chat-completions, Anthropic-shape or Responses reply. */
function replyText(data: unknown): string {
  const d = data as {
    choices?: Array<{ message?: { content?: unknown } }>;
    content?: Array<{ type?: string; text?: unknown }>;
    output_text?: unknown;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }>;
  } | null;
  if (d?.choices) return extractMessageText(d.choices[0]?.message?.content);
  if (Array.isArray(d?.content)) return extractMessageText(d.content.filter((b) => b?.type === 'text'));
  if (typeof d?.output_text === 'string') return d.output_text;
  if (Array.isArray(d?.output)) {
    return extractMessageText(
      d.output.filter((item) => item?.type === 'message').flatMap((item) => (item.content ?? []).filter((c) => c?.type === 'output_text')),
    );
  }
  return '';
}

async function singleShotFetch(args: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<string> {
  let response: Response;
  try {
    response = await args.fetchImpl(args.url, {
      method: 'POST',
      headers: args.headers,
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
    throw summarizeError('provider_error', message, { status: response.status, errorText: `${message}
${errorText}`.slice(0, 2000) });
  }
  // Some gateways send JSON as text/plain: parse by content.
  return replyText(JSON.parse(await response.text()));
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

  // A summary is a mechanical rewrite: run it with the least thinking the
  // model allows (off where it can be switched off).
  const summaryModel = await modelCatalog().resolveModel(userId, effectiveModel);
  const summaryPlan = planReasoning(summaryModel.reasoning, { enabled: false });

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
    // temperature 0.2, no tools, thinking at the least the model allows.
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
      ...chatReasoningFields(summaryModel, summaryPlan),
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

  // Hosted providers: the catalog decides the wire (chat-completions, or
  // Anthropic-shape / Responses for OpenCode Go models served there).
  const fetchImpl = args.fetchImpl ?? testFetchImpl ?? fetch;
  const apiKey = getSettingValue(userId, provider.apiKeySetting);
  if (!apiKey?.trim()) {
    throw summarizeError('no_api_key', `${provider.label} API key not configured.`);
  }
  const headers = provider.buildHeaders(apiKey);
  if (provider.id === 'opencode-go') headers['x-opencode-session'] = args.conversationId ?? `compact-${userId}`;
  const conversation = [
    { role: 'system', content: args.systemPrompt },
    { role: 'user', content: args.prompt },
  ];
  const transportInput = { model: summaryModel, plan: summaryPlan, messages: conversation, tools: [], includeTools: false, temperature: 0.2, maxTokens: 4096 };
  if (provider.id === 'opencode-go' && summaryModel.transport === 'messages') {
    headers['anthropic-version'] = OPENCODE_GO_ANTHROPIC_VERSION;
    headers['x-api-key'] = apiKey.trim();
    const text = await singleShotFetch({ url: OPENCODE_GO_MESSAGES_URL, headers, body: { ...buildMessagesBody(transportInput), stream: false }, signal, fetchImpl });
    return { text };
  }
  if (provider.id === 'opencode-go' && summaryModel.transport === 'responses') {
    const text = await singleShotFetch({ url: OPENCODE_GO_RESPONSES_URL, headers, body: { ...buildResponsesBody(transportInput), stream: false }, signal, fetchImpl });
    return { text };
  }
  // Tools, provider routing and plugins never travel on a summary.
  const body: Record<string, unknown> = {
    model: upstream,
    messages: conversation,
    temperature: 0.2,
    max_tokens: 4096,
    stream: false,
    ...chatReasoningFields(summaryModel, summaryPlan),
  };
  const text = await singleShotFetch({ url: provider.chatCompletionsUrl, headers, body, signal, fetchImpl });
  return { text };
}
