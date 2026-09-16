import { nanoid } from 'nanoid';
import type {
  CouncilExecutionOptions,
  MemberResult,
  SynthesisResult,
  CouncilResult,
  ToolCallSpec,
  ToolResultRecord,
} from '../types.js';
import type { McpConnection } from '../mcp/index.js';
import { runTool, toOpenRouterTools } from '../tools/index.js';
import { parseReasoningToolCalls } from '../utils/parseReasoningToolCalls.js';
import {
  assertProviderRoutingCompatible,
  buildOpenRouterProviderPreference,
  parseProviderRoutingConfig,
  resolveProviderRouting,
  type ProviderRoutingConfig,
} from '../providerRouting.js';
import {
  getProviderForModel,
  toUpstreamModelId,
  assistantReasoningField,
  buildAbliterationReasoning,
  buildArnictReasoning,
  computeAbliterationCost,
  computeArnictCost,
  computeDeepSeekCost,
  computeOpencodeGoCost,
  isAbliterationLargeModel,
  ABLITERATION_LARGE_TEXT_ONLY_MESSAGE,
  opencodeGoFormatMismatchMessage,
  opencodeGoHistoryReasoningField,
  opencodeGoTransportFor,
  resolveProviderId,
  OPENCODE_GO_ANTHROPIC_VERSION,
  OPENCODE_GO_MESSAGES_URL,
  OPENCODE_GO_RESPONSES_URL,
  type ProviderConfig,
  type ProviderId,
} from '../providers/index.js';
import { injectDateTimeIntoCurrentTurn } from '../dateTimeContext.js';
import { runCodexTurn } from '../codex/chat.js';
import db from '../db.js';
import { getSettingValue } from '../routes/settings.js';
import { getAgentCapabilities } from '../agentRelay/registry.js';
import { isLegacyLmStudioModel, REMOVED_LMSTUDIO_MESSAGE } from '../providers/llamacpp.js';
import { goReasoningKnobFor, goReasoningNoControl, goReasoningOff, planGoMessagesBudget, planGoReasoningEffort } from '../../shared/opencodeGoReasoning.js';

import { llamacppFetch, LLAMACPP_CAPABILITY_ERROR, resolveLlamacppSamplingForModel } from '../providers/llamacppTransport.js';

const MEMBER_TIMEOUT_MS = 240000; // 4 minutes per member
const SYNTHESIS_TIMEOUT_MS = 240000; // 4 minutes for synthesis
const COMPARISON_EXTRACTION_TIMEOUT_MS = 60000; // 1 minute
const COMPARISON_EXTRACTION_MAX_TOKENS = 8192;
const COMPARISON_EXTRACTION_MAX_REPAIR_ATTEMPTS = 1;
const MAX_RETRIES = 1;
const MAX_MEMBER_CONTENT_FOR_COMPARISON = 2800; // chars per member to stay within context

// ---------------------------------------------------------------------------
// OpenCode Go `messages` transport sender (T4, Anthropic shape) — réplica del
// sender de `server/routes/chat.ts` para los dos paths del executor (miembro
// y síntesis). T3 VERIFIED-shape 2026-09-15: `POST {OPENCODE_GO_MESSAGES_URL}`
// con `model` bare + `max_tokens` + `messages` + `stream`, headers
// `anthropic-version` + `Bearer` + `x-api-key` (divergencia: `Bearer` solo
// 401s) + `x-opencode-session`. Tools OpenAI→Anthropic nativo:
// `{type:'function',function:{name,description,parameters}}` →
// `{name,description,input_schema:parameters}` (sin `tool_choice` ni
// `parallel_tool_calls`); `tool_calls`→`tool_use`, `tool`→`tool_result`;
// T5 K2-GO condicionado: el toggle (+ esfuerzo/presupuesto donde aplique)
// viaja vía `planCouncilGoMessagesThinking` (mismo contrato que el planner
// de chat.ts); `temperature`, tools `input_schema` y headers `x-api-key`
// intactos.
// ---------------------------------------------------------------------------

type CouncilOpenRouterToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

/** Extracts plain text from an OpenAI chat content value (string or parts array). */
function councilGoMessagesTextContent(content: string | unknown[] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const part = p as { type?: unknown; text?: unknown };
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** Anthropic `usage` shape (T3 P2/P3 literales) para el motor de coste T2. */
interface CouncilGoMessagesUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost?: string | number;
}

/**
 * Messages `thinking`/`output_config` planificado (T5, mismo contrato que
 * `planOpencodeGoMessagesThinking` en chat.ts — ver su comentario para el
 * wire K2 por familia): `[]`/unknown → omit; off → `disabled`; toggle+budget
 * on → clásico `thinking:{enabled,budget_tokens}`; adaptativo on →
 * `output_config:{effort}` clampado y validado (on sin esfuerzo → omit).
 */
function planCouncilGoMessagesThinking(
  upstreamModel: string,
  reasoningEnabled: boolean,
  reasoningEffort: string | null,
  reasoningMaxTokens: number | null,
): Record<string, unknown> {
  if (goReasoningNoControl(upstreamModel)) return {};
  const knob = goReasoningKnobFor(upstreamModel);
  if (knob === null) return {};
  if (!reasoningEnabled) return { thinking: { type: 'disabled' } };
  const levels = knob.effortValues;
  if (levels !== null && levels.length > 0) {
    if (reasoningEffort == null) return {};
    const planned = planGoReasoningEffort(upstreamModel, reasoningEffort);
    if (planned === null || !levels.includes(planned)) return {};
    return { output_config: { effort: planned } };
  }
  const budget = planGoMessagesBudget(upstreamModel, { maxTokens: reasoningMaxTokens });
  if (budget === null) return { thinking: { type: 'enabled' } };
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}

/**
 * Maps the chat-completions `messages` array to an Anthropic `POST /messages`
 * body (same contract as `buildOpencodeGoMessagesBody` in chat.ts): system
 * rows fold into top-level `system`, assistant `tool_calls` into `tool_use`
 * blocks, `tool` rows into `user` `tool_result` blocks, consecutive same-role
 * rows merge; history reasoning rows keep travelling as plain `content` (K2
 * replay sin bloques exigidos — no se fabrican thinking/signature).
 */
function buildCouncilGoMessagesBody(opts: {
  upstreamModel: string;
  messages: Array<{ role: string; content?: string | unknown[] | null; tool_call_id?: string; tool_calls?: unknown[] }>;
  openRouterTools: CouncilOpenRouterToolDef[];
  includeTools: boolean;
  temperature: number;
  maxTokens: number;
  reasoningEnabled: boolean;
  reasoningEffort: string | null;
  reasoningMaxTokens: number | null;
}): Record<string, unknown> {
  const systemTexts: string[] = [];
  const converted: Array<{ role: string; content: unknown }> = [];
  for (const m of opts.messages) {
    if (m.role === 'system') {
      const text = councilGoMessagesTextContent(m.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (m.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: councilGoMessagesTextContent(m.content) }],
      });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const blocks: unknown[] = [];
      const text = councilGoMessagesTextContent(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const raw of m.tool_calls) {
        const tc = raw as { id?: string; function?: { name?: string; arguments?: string } };
        let input: Record<string, unknown> = {};
        try {
          const parsedArgs: unknown = JSON.parse(tc.function?.arguments ?? '{}');
          if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
            input = parsedArgs as Record<string, unknown>;
          }
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id ?? '', name: tc.function?.name ?? '', input });
      }
      converted.push({ role: 'assistant', content: blocks });
      continue;
    }
    converted.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: councilGoMessagesTextContent(m.content),
    });
  }
  const merged: Array<{ role: string; content: unknown }> = [];
  for (const m of converted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      const a = Array.isArray(prev.content) ? (prev.content as unknown[]) : [{ type: 'text', text: prev.content ?? '' }];
      const b = Array.isArray(m.content) ? (m.content as unknown[]) : [{ type: 'text', text: m.content ?? '' }];
      prev.content = [...a, ...b];
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  const body: Record<string, unknown> = {
    model: opts.upstreamModel,
    messages: merged,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    stream: true,
  };
  // T5: mismo wire K2 que el builder de chat (nunca `effort` top-level).
  Object.assign(body, planCouncilGoMessagesThinking(opts.upstreamModel, opts.reasoningEnabled, opts.reasoningEffort, opts.reasoningMaxTokens));
  if (systemTexts.length > 0) body.system = systemTexts.join('\n\n');
  if (opts.includeTools && opts.openRouterTools.length > 0) {
    body.tools = opts.openRouterTools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  return body;
}

/**
 * Maps Anthropic messages usage onto `computeOpencodeGoCost` (same contract
 * as `mapOpencodeGoMessagesUsage` in chat.ts): explicit miss = `input_tokens`,
 * hit = `cache_read_input_tokens`, write (`prompt_cache_write_tokens`) =
 * `cache_creation_input_tokens`; tier by the real request context (cached
 * input + output); an upstream numeric `cost` wins and is never overwritten.
 */
function mapCouncilGoMessagesUsage(usage: CouncilGoMessagesUsage | null | undefined): {
  mappedUsage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number; prompt_cache_miss_tokens: number; prompt_cache_write_tokens: number };
  promptTotal: number;
  outputTokens: number;
  cachedTokens: number;
  upstreamCost: number | null;
} {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const created = usage?.cache_creation_input_tokens ?? 0;
  const read = usage?.cache_read_input_tokens ?? 0;
  let upstreamCost: number | null = null;
  if (usage?.cost !== undefined) {
    const n = typeof usage.cost === 'string' ? Number(usage.cost) : usage.cost;
    if (typeof n === 'number' && Number.isFinite(n)) upstreamCost = n;
  }
  return {
    mappedUsage: {
      prompt_tokens: input + read + created,
      completion_tokens: output,
      prompt_cache_hit_tokens: read,
      prompt_cache_miss_tokens: input,
      prompt_cache_write_tokens: created,
    },
    promptTotal: input + read + created,
    outputTokens: output,
    cachedTokens: read,
    upstreamCost,
  };
}

// ---------------------------------------------------------------------------
// OpenCode Go `responses` transport sender (T5, Responses API) — réplica del
// sender de `server/routes/chat.ts` para los dos paths del executor (miembro
// y síntesis). T3 VERIFIED 2026-09-15 (P4/P5): `POST {OPENCODE_GO_RESPONSES_URL}`
// con `model` bare + `input` + `stream`, `Bearer` solo (sin `x-api-key`, sin
// `anthropic-version`) + `x-opencode-session`. Tools en forma función OpenAI
// nativa; `tool_calls`→`function_call`, `tool`→`function_call_output`;
// `system`→`instructions`. `reasoning:{effort:<planificado>}` +
// `max_output_tokens` acotan el burn de `high`/`medium`-por-defecto (T3 K3);
// omitir `reasoning` está prohibido. El effort thread-ea el toggle vía
// `resolveCouncilReasoning` + matriz T1 (réplica del sender de chat.ts).
// ---------------------------------------------------------------------------

/**
 * Responses `reasoning.effort` planificado (T3, mismo contrato que
 * `planOpencodeGoResponsesEffort` en chat.ts): nunca se omite. Off →
 * `goReasoningOff` con fallback `low`; on sin esfuerzo → `low`; on con
 * esfuerzo → `planGoReasoningEffort` (clamp por matriz T1). Sin retry.
 */
function planCouncilGoResponsesEffort(
  upstreamModel: string,
  reasoningEnabled: boolean,
  reasoningEffort: string | null,
): string {
  if (!reasoningEnabled) return goReasoningOff(upstreamModel) ?? 'low';
  if (reasoningEffort == null) return 'low';
  return planGoReasoningEffort(upstreamModel, reasoningEffort) ?? 'low';
}

/**
 * Chat `reasoning_effort` planificado (T4 K1-GO, mismo contrato que el arm
 * de chat.ts): off → `goReasoningOff` (`none` donde listado, floor donde K1
 * midió burn, `null` sin control); on sin esfuerzo → `null` (omit: default
 * del proveedor); on con esfuerzo → `planGoReasoningEffort` (clamp por
 * matriz T1; unknown passthrough). `null` = omitir con log (`thinking`
 * jamás viaja).
 */
function planCouncilGoChatEffort(
  upstreamModel: string,
  reasoningEnabled: boolean,
  reasoningEffort: string | null,
): string | null {
  if (!reasoningEnabled) return goReasoningOff(upstreamModel);
  if (reasoningEffort == null) return null;
  return planGoReasoningEffort(upstreamModel, reasoningEffort);
}

/**
 * Maps the chat-completions `messages` array to a Responses `POST /responses`
 * body (same contract as `buildOpencodeGoResponsesBody` in chat.ts).
 */
function buildCouncilGoResponsesBody(opts: {
  upstreamModel: string;
  messages: Array<{ role: string; content?: string | unknown[] | null; tool_call_id?: string; tool_calls?: unknown[] }>;
  openRouterTools: CouncilOpenRouterToolDef[];
  includeTools: boolean;
  temperature: number;
  maxTokens: number;
  reasoningEnabled: boolean;
  reasoningEffort: string | null;
}): Record<string, unknown> {
  const instructionTexts: string[] = [];
  const input: unknown[] = [];
  for (const m of opts.messages) {
    if (m.role === 'system') {
      const text = councilGoMessagesTextContent(m.content);
      if (text) instructionTexts.push(text);
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: councilGoMessagesTextContent(m.content),
      });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const text = councilGoMessagesTextContent(m.content);
      if (text) input.push({ role: 'assistant', content: text });
      for (const raw of m.tool_calls) {
        const tc = raw as { id?: string; function?: { name?: string; arguments?: string } };
        input.push({
          type: 'function_call',
          call_id: tc.id ?? '',
          name: tc.function?.name ?? '',
          arguments: tc.function?.arguments ?? '{}',
        });
      }
      continue;
    }
    input.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: councilGoMessagesTextContent(m.content),
    });
  }
  const body: Record<string, unknown> = {
    model: opts.upstreamModel,
    input,
    temperature: opts.temperature,
    reasoning: { effort: planCouncilGoResponsesEffort(opts.upstreamModel, opts.reasoningEnabled, opts.reasoningEffort) },
    max_output_tokens: opts.maxTokens,
    stream: true,
  };
  if (instructionTexts.length > 0) body.instructions = instructionTexts.join('\n\n');
  if (opts.includeTools && opts.openRouterTools.length > 0) {
    // Same flat Responses wire form as `buildOpencodeGoResponsesBody` in
    // chat.ts (see note there): no nested `function`, no `strict`.
    body.tools = opts.openRouterTools.map((t, i) => {
      const name = t.function?.name;
      if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
        throw new Error(
          `OpenCode Go responses: tool at index ${i} has an invalid or missing name (expected /^[A-Za-z0-9_-]{1,128}$/)`,
        );
      }
      return {
        type: 'function',
        name,
        description: t.function.description,
        parameters: t.function.parameters,
      };
    });
  }
  return body;
}

/** Responses `usage` shape (T3 P4/P5 literales) para el motor de coste T2. */
interface CouncilGoResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
  cost?: string | number;
}

/**
 * Maps Responses usage onto `computeOpencodeGoCost` (same contract as
 * `mapOpencodeGoResponsesUsage` in chat.ts): explicit miss =
 * `input - cached`, hit = `cached_tokens`, out = `output_tokens`
 * (`reasoning_tokens` informative only); tier by the real request context
 * (input + output); an upstream numeric `cost` wins, never overwritten.
 */
function mapCouncilGoResponsesUsage(usage: CouncilGoResponsesUsage | null | undefined): {
  mappedResponsesUsage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number; prompt_cache_miss_tokens: number };
  promptTotal: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  upstreamCost: number | null;
} {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens ?? 0;
  let upstreamCost: number | null = null;
  if (usage?.cost !== undefined) {
    const n = typeof usage.cost === 'string' ? Number(usage.cost) : usage.cost;
    if (typeof n === 'number' && Number.isFinite(n)) upstreamCost = n;
  }
  return {
    mappedResponsesUsage: {
      prompt_tokens: input,
      completion_tokens: output,
      prompt_cache_hit_tokens: cached,
      prompt_cache_miss_tokens: Math.max(input - cached, 0),
    },
    promptTotal: input,
    outputTokens: output,
    cachedTokens: cached,
    reasoningTokens: reasoning,
    upstreamCost,
  };
}

/** Frozen §7 billing literals shared with chat (same text, council throw). */
const COUNCIL_GO_INVALID_KEY_MESSAGE =
  'Invalid OpenCode Go API key. Check your key in Settings → OpenCode Go.';
const COUNCIL_GO_LIMIT_MESSAGE =
  'OpenCode Go usage limit reached for this model. Check usage in the OpenCode console (https://opencode.ai/docs/go/) or enable the Zen-balance fallback there.';

/** OpenRouter JSON Schema for council comparison (structured output). */
const COUNCIL_COMPARISON_JSON_SCHEMA = {
  name: 'council_comparison',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      question_type: {
        type: 'string',
        enum: ['yes_no', 'open', 'comparison'],
        description: 'Whether the user question is binary (yes/no), open-ended, or a comparison.',
      },
      agreements: {
        type: 'array',
        maxItems: 7,
        description: 'Points on which multiple models agree.',
        items: {
          type: 'object',
          properties: {
            finding: { type: 'string', description: 'One-sentence statement all listed models agree on.' },
            model_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Exact model IDs that agree (e.g. anthropic/claude-3.5-sonnet).',
            },
            evidence: { type: 'string', description: 'Optional short evidence or source.' },
          },
          required: ['finding', 'model_ids'],
          additionalProperties: false,
        },
      },
      disagreements: {
        type: 'array',
        maxItems: 7,
        description: 'Topics where models differ.',
        items: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Short topic label.' },
            stances: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  model_id: { type: 'string', description: 'Exact model ID.' },
                  stance: { type: 'string', description: 'That model\'s position in one sentence.' },
                },
                required: ['model_id', 'stance'],
                additionalProperties: false,
              },
            },
            why_they_differ: { type: 'string', description: 'Brief explanation of the root cause of disagreement.' },
          },
          required: ['topic', 'stances', 'why_they_differ'],
          additionalProperties: false,
        },
      },
      unique_findings: {
        type: 'array',
        maxItems: 7,
        description: 'Insights mentioned by only one model.',
        items: {
          type: 'object',
          properties: {
            model_id: { type: 'string', description: 'Exact model ID.' },
            finding: { type: 'string', description: 'The unique insight in one sentence.' },
            why_it_matters: { type: 'string', description: 'Optional one-sentence significance.' },
          },
          required: ['model_id', 'finding'],
          additionalProperties: false,
        },
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

interface StreamChunk {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCallSpec[];
}

export class CouncilExecutor {
  /** Resolves the decrypted API key for a given provider (members/synthesizer may differ). */
  private getApiKey: (provider: ProviderId) => string;

  constructor(getApiKey: (provider: ProviderId) => string) {
    this.getApiKey = getApiKey;
  }

  /** Resolves the upstream endpoint (url + headers + bare model id) for a namespaced model id. */
  private resolveEndpoint(modelId: string): {
    url: string;
    headers: Record<string, string>;
    upstreamModel: string;
    provider: ProviderConfig;
  } {
    // D8 legacy guard: ids from the REMOVED LM Studio provider die BEFORE any
    // key lookup, upstream resolution, or network call — they must never fall
    // through to another provider.
    if (isLegacyLmStudioModel(modelId)) {
      throw new Error(REMOVED_LMSTUDIO_MESSAGE);
    }
    const provider = getProviderForModel(modelId);
    const apiKey = this.getApiKey(provider.id);
    // Local-provider requests (legacy lmstudio — rejected above — and
    // llama.cpp) are valid WITHOUT a key (local server); every other provider
    // requires its key.
    if (!apiKey?.trim() && provider.id !== 'lmstudio' && provider.id !== 'llamacpp') {
      throw new Error(`${provider.label} API key not configured`);
    }
    return {
      url: provider.chatCompletionsUrl,
      headers: provider.buildHeaders(apiKey || ''),
      upstreamModel: toUpstreamModelId(modelId),
      provider,
    };
  }

  /**
   * Resolves the app reasoning toggle/effort governing a council run (GC §4).
   * Council carries no per-message override: the conversation's agent row wins,
   * else the general-chat settings (same keys chat.ts uses). Fail-safe: any
   * error resolves to off (upstream reasons by default; omitting is the
   * off-switch — never send `thinking:false`/`include_reasoning:false`).
   */
  private resolveCouncilReasoning(conversationId: string, userId: string): { enabled: boolean; effort: string | null } {
    const off = { enabled: false, effort: null as string | null };
    try {
      const conv = db.prepare('SELECT agent_id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId) as { agent_id: string | null } | undefined;
      if (conv?.agent_id) {
        const agent = db.prepare('SELECT reasoning_enabled, reasoning_effort FROM agents WHERE id = ? AND user_id = ?').get(conv.agent_id, userId) as { reasoning_enabled: number | null; reasoning_effort: string | null } | undefined;
        if (agent) return { enabled: !!agent.reasoning_enabled, effort: agent.reasoning_effort ?? null };
      }
      const enabledRaw = getSettingValue(userId, 'general_chat_reasoning_enabled');
      return { enabled: enabledRaw === '1' || enabledRaw === 'true', effort: getSettingValue(userId, 'general_chat_reasoning_effort') || null };
    } catch {
      return off;
    }
  }

  /** True when any outgoing message carries array content with an image part. */
  private messagesHaveImagePart(messages: Array<{ content?: string | unknown[] | null }>): boolean {
    return messages.some((m) =>
      Array.isArray(m.content) &&
      (m.content as unknown[]).some((p) =>
        typeof p === 'object' && p !== null &&
        ((p as { type?: unknown }).type === 'image_url' || (p as { type?: unknown }).type === 'image')
      )
    );
  }

  /**
   * Upstream chat-completions seam for member/synthesizer/comparison calls:
   * llama.cpp rides its transport service (`llamacppFetch` — resolved loopback
   * port + direct/relay auto-select); every other provider keeps plain fetch
   * against the static config URL.
   */
  private async fetchUpstream(
    userId: string | undefined,
    ep: ReturnType<CouncilExecutor['resolveEndpoint']>,
    init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal | null },
  ): Promise<Response> {
    if (ep.provider.id === 'llamacpp') {
      if (!userId) throw new Error('llama.cpp requires a user context');
      // §2 capability gate: fires on the council entry point too. The frozen
      // message must surface HERE — llamacppFetch (task-2-owned) degrades a
      // connected-but-incapable agent to a generic "not reachable" 502.
      if (!(getAgentCapabilities(userId)?.includes('llamacpp') ?? false)) {
        throw new Error(LLAMACPP_CAPABILITY_ERROR);
      }
      return llamacppFetch(userId, '/v1/chat/completions', init);
    }
    return fetch(ep.url, init);
  }

  async execute(options: CouncilExecutionOptions): Promise<CouncilResult> {
    const startTime = Date.now();
    const synthesizerModel = options.synthesizerModel || 'anthropic/claude-3.5-sonnet';

    console.log(`\n🏛️  COUNCIL EXECUTION STARTED`);
    console.log(`   📊 Members: ${options.memberModels.length}`);
    console.log(`   🎯 Models: ${options.memberModels.map(m => m.split('/').pop()).join(', ')}`);
    console.log(`   🧠 Synthesizer: ${synthesizerModel.split('/').pop()}`);
    console.log(`   💬 Query: "${options.content.slice(0, 80)}${options.content.length > 80 ? '...' : ''}"`);
    console.log(`   🔧 Tools: ${options.tools?.length || 0}, MCPs: ${options.mcpClients?.size || 0}`);
    console.log('');

    // Phase 1: Execute all members in parallel with individual timeouts
    const memberPromises = options.memberModels.map((modelId, index) =>
      this.executeMemberWithTimeout(modelId, index, options)
    );

    const memberResultsSettled = await Promise.allSettled(memberPromises);

    // Convert settled results to MemberResult[]
    const memberResults: MemberResult[] = memberResultsSettled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.log(`   ❌ Member ${index + 1} FAILED: ${options.memberModels[index].split('/').pop()} - ${errorMsg}`);
        return {
          modelId: options.memberModels[index],
          providerRouting: resolveProviderRouting(
            parseProviderRoutingConfig(options.memberProviderRouting?.[options.memberModels[index]])
          ),
          content: '',
          tokensUsed: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          cost: 0,
          responseTimeMs: 0,
          status: 'error',
          errorMessage: errorMsg,
        };
      }
    });

    // Log member summary
    const successCount = memberResults.filter(r => r.status === 'success').length;
    const errorCount = memberResults.filter(r => r.status === 'error').length;
    const timeoutCount = memberResults.filter(r => r.status === 'timeout').length;

    console.log(`\n📊 MEMBER EXECUTION SUMMARY`);
    console.log(`   ✅ Success: ${successCount} | ❌ Errors: ${errorCount} | ⏱️ Timeouts: ${timeoutCount}`);
    memberResults.forEach((r, i) => {
      const modelName = r.modelId.split('/').pop();
      const icon = r.status === 'success' ? '✅' : r.status === 'timeout' ? '⏱️' : '❌';
      const details = r.status === 'success'
        ? `${r.tokensUsed?.toLocaleString() || 0} tokens, $${(r.cost || 0).toFixed(4)}, ${((r.responseTimeMs || 0) / 1000).toFixed(1)}s`
        : r.errorMessage?.slice(0, 40) || 'Unknown error';
      console.log(`   ${icon} [${i + 1}] ${modelName}: ${details}`);
    });

    // Phase 2: Synthesize results
    const synthesis = await this.synthesize(memberResults, options);

    const totalTime = Date.now() - startTime;
    const totalCost = this.calculateTotalCost(memberResults, synthesis);
    const totalTokens = this.calculateTotalTokens(memberResults, synthesis);

    // Final summary
    console.log(`\n🏁 COUNCIL EXECUTION COMPLETE`);
    console.log(`   ⏱️  Total Time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`   💰 Total Cost: $${totalCost.toFixed(4)}`);
    console.log(`   📝 Total Tokens: ${totalTokens.toLocaleString()}`);
    console.log(`   🧠 Synthesis: ${synthesis.tokensUsed?.toLocaleString() || 0} tokens, $${(synthesis.cost || 0).toFixed(4)}, ${((synthesis.responseTimeMs || 0) / 1000).toFixed(1)}s`);
    console.log(`   📄 Response Length: ${synthesis.content?.length || 0} chars`);
    console.log('');

    return {
      memberResults,
      synthesis,
      totalCost,
      totalTokens,
    };
  }

  private async executeMemberWithTimeout(
    modelId: string,
    index: number,
    options: CouncilExecutionOptions
  ): Promise<MemberResult> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout after ${MEMBER_TIMEOUT_MS}ms`));
      }, MEMBER_TIMEOUT_MS);

      this.executeMember(modelId, index, options)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  private async executeMember(
    modelId: string,
    index: number,
    options: CouncilExecutionOptions
  ): Promise<MemberResult> {
    const startTime = Date.now();
    const modelName = modelId.split('/').pop() || modelId;
    const requestedProviderRouting = resolveProviderRouting(
      parseProviderRoutingConfig(options.memberProviderRouting?.[modelId])
    );

    console.log(`   🚀 [${index + 1}/${options.memberModels.length}] Starting: ${modelName}`);

    // Notify start
    options.onMemberStart(index, modelId);

    let retries = 0;
    let lastError: Error | null = null;

    while (retries <= MAX_RETRIES) {
      try {
        const result = await this.executeMemberStream(modelId, index, options);
        const responseTimeMs = Date.now() - startTime;

        // Notify completion
        const memberResult: MemberResult = {
          ...result,
          responseTimeMs,
          status: 'success',
        };
        options.onMemberComplete(index, memberResult);

        const hasTools = result.toolCalls && result.toolCalls.length > 0;
        console.log(`   ✅ [${index + 1}] Complete: ${modelName} | ${result.tokensUsed?.toLocaleString() || 0} tokens | $${(result.cost || 0).toFixed(4)} | ${(responseTimeMs / 1000).toFixed(1)}s${hasTools ? ` | 🔧 ${result.toolCalls?.length} tools` : ''}`);

        return { ...result, responseTimeMs, status: 'success' };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retries++;

        if (retries <= MAX_RETRIES) {
          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
        }
      }
    }

    const responseTimeMs = Date.now() - startTime;
    const failedResult: MemberResult = {
      modelId,
      providerRouting: requestedProviderRouting,
      content: '',
      tokensUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      responseTimeMs,
      status: lastError?.message?.includes('Timeout') ? 'timeout' : 'error',
      errorMessage: lastError?.message || 'Unknown error',
    };

    const statusIcon = failedResult.status === 'timeout' ? '⏱️' : '❌';
    console.log(`   ${statusIcon} [${index + 1}] Failed: ${modelName} | ${failedResult.status} | ${failedResult.errorMessage?.slice(0, 50)}${failedResult.errorMessage && failedResult.errorMessage.length > 50 ? '...' : ''}`);

    options.onMemberComplete(index, failedResult);
    return failedResult;
  }

  private async executeMemberStream(
    modelId: string,
    index: number,
    options: CouncilExecutionOptions
  ): Promise<Omit<MemberResult, 'responseTimeMs' | 'status'>> {
    // ChatGPT (Codex) members: bridge the member turn to the user's app-server.
    if (resolveProviderId(modelId) === 'codex') {
      return this.executeMemberStreamCodex(modelId, options);
    }

    const ep = this.resolveEndpoint(modelId);
    const headers = ep.headers;
    // T4: `messages`-transport models ride the Anthropic sender (same contract
    // as chat.ts). T5: `responses`-transport models ride the Responses API
    // sender. `unknown` fails open.
    const isGoMessages = ep.provider.id === 'opencode-go' && opencodeGoTransportFor(ep.upstreamModel) === 'messages';
    const isGoResponses = ep.provider.id === 'opencode-go' && opencodeGoTransportFor(ep.upstreamModel) === 'responses';
    if (ep.provider.id === 'opencode-go') {
      // D9: upstream flags clients without a session as problematic (GC §1).
      ep.headers['x-opencode-session'] = options.conversationId ?? options.userId ?? 'unknown';
    }
    if (isGoMessages) {
      // T3 divergence (VERIFIED-shape + DIVERGENTE-auth): `x-api-key` travels
      // next to `Bearer` on `/messages`, plus `anthropic-version`.
      ep.url = OPENCODE_GO_MESSAGES_URL;
      ep.headers['anthropic-version'] = OPENCODE_GO_ANTHROPIC_VERSION;
      ep.headers['x-api-key'] = this.getApiKey('opencode-go');
    }
    if (isGoResponses) {
      // T3 VERIFIED (P4/P5): `/responses` authenticates with `Bearer` alone —
      // no `x-api-key`, no `anthropic-version` on this path.
      ep.url = OPENCODE_GO_RESPONSES_URL;
    }

    // Build messages
    const messages: Array<{ role: string; content?: string | unknown[] | null; tool_call_id?: string; tool_calls?: unknown[] }> = [
      { role: 'system', content: options.systemPrompt },
      ...options.messageHistory,
    ];

    // Handle attachments for the last user message (OpenRouter file-parser only)
    if (options.attachments && options.attachments.length > 0 && ep.provider.supportsPlugins) {
      const lastIdx = messages.length - 1;
      if (lastIdx >= 0 && messages[lastIdx].role === 'user') {
        const textPart = { type: 'text' as const, text: options.content };
        const fileParts = options.attachments.map((a) => ({
          type: 'file' as const,
          file: {
            filename: a.filename,
            file_data: a.file_data ?? a.url,
          },
        }));
        (messages[lastIdx] as Record<string, unknown>).content = [textPart, ...fileParts];
      }
    }

    // Append the (volatile) date/time to the current user turn so the system prompt +
    // history stay a cacheable prefix (matters for DeepSeek context caching across turns).
    if (options.dateTimeContext) {
      injectDateTimeIntoCurrentTurn(messages, options.dateTimeContext);
    }

    // Abliteration large models are text-only (GC §5): same guard as chat,
    // thrown in the member path before any network call.
    if (ep.provider.id === 'abliteration' && isAbliterationLargeModel(ep.upstreamModel) && this.messagesHaveImagePart(messages)) {
      throw new Error(ABLITERATION_LARGE_TEXT_ONLY_MESSAGE);
    }

    // Resolve tools (arnict accepts `tools` like any OpenRouter-shaped
    // provider: keyed parity, no gate — the generic attach below applies).
    // T4: `messages` tools ride the Anthropic `input_schema` mapping inside
    // the body builder; T5: `responses` tools ride the native function shape
    // inside its builder — never the OpenAI shape twice.
    const resolvedTools = options.tools || [];
    const openRouterTools = toOpenRouterTools(resolvedTools);

    // T3: el toggle+esfuerzo del council viaja al builder responses (miembro +
    // síntesis vía builders; cada vuelta del tool-loop re-deriva con los
    // mismos params).
    const councilReasoning = this.resolveCouncilReasoning(options.conversationId, options.userId);

    const requestBody: Record<string, unknown> = isGoMessages
      ? buildCouncilGoMessagesBody({
          upstreamModel: ep.upstreamModel,
          messages,
          openRouterTools: openRouterTools as CouncilOpenRouterToolDef[],
          includeTools: true,
          temperature: 0.7,
          maxTokens: 4096,
          reasoningEnabled: councilReasoning.enabled,
          reasoningEffort: councilReasoning.effort,
          // `resolveCouncilReasoning` no lleva max_tokens por restricción
          // global: el council presupuesta el default (8192) cuando el
          // toggle está on.
          reasoningMaxTokens: null,
        })
      : isGoResponses
        ? buildCouncilGoResponsesBody({
            upstreamModel: ep.upstreamModel,
            messages,
            openRouterTools: openRouterTools as CouncilOpenRouterToolDef[],
            includeTools: true,
            temperature: 0.7,
            maxTokens: 4096,
            reasoningEnabled: councilReasoning.enabled,
            reasoningEffort: councilReasoning.effort,
          })
        : {
            model: ep.upstreamModel,
            messages,
            temperature: 0.7,
            max_tokens: 4096,
            stream: true,
          };
    if (ep.provider.id === 'abliteration') {
      // Usage frame for static cost accounting (GC §6/§7) + the custom
      // reasoning arm (GC §4): top-level `reasoning_effort` verbatim, or
      // nothing when the toggle is off / effort unknown.
      requestBody.stream_options = { include_usage: true };
      const reasoning = this.resolveCouncilReasoning(options.conversationId, options.userId);
      Object.assign(requestBody, buildAbliterationReasoning(reasoning.enabled, reasoning.effort));
    }
    if (ep.provider.id === 'arnict') {
      // Usage frame for static cost accounting (GC §6) + the object
      // reasoning arm (GC §3/§4): `reasoning:{enabled,effort}` verbatim via
      // the frozen builder, same resolve pattern as the arm above.
      requestBody.stream_options = { include_usage: true };
      const reasoning = this.resolveCouncilReasoning(options.conversationId, options.userId);
      requestBody.reasoning = buildArnictReasoning(reasoning.enabled, reasoning.effort);
    }
    if (ep.provider.id === 'opencode-go') {
      // T4 K1-GO: el chat-transport (`unknown` incluido, fail-open) lleva el
      // mismo arm que chat (`reasoning_effort` top-level planificado por
      // matriz T1 vía `resolveCouncilReasoning`; off → `goReasoningOff`,
      // `[]`/toggle-only → omit con log; `thinking` jamás viaja).
      // `messages`/`responses` llevan su propio wire (builders); la
      // comparación sigue sin reasoning (M7). El campo top-level sobrevive
      // al tool-loop (el loop solo re-escribe messages/tools en este
      // transporte).
      // Usage frame for static cost accounting (GC §6). T4: `messages` carries
      // its usage inside `message_delta` (+ final `ping` cost); T5:
      // `responses` inside `response.completed` (+ final `ping` cost) — no
      // `stream_options` on either wire shape.
      if (!isGoMessages && !isGoResponses) {
        requestBody.stream_options = { include_usage: true };
        const plannedGoEffort = planCouncilGoChatEffort(ep.upstreamModel, councilReasoning.enabled, councilReasoning.effort);
        if (councilReasoning.enabled && councilReasoning.effort != null && plannedGoEffort !== councilReasoning.effort) {
          console.log(`[council] Reasoning effort clamped (go): requested=${councilReasoning.effort} applied=${plannedGoEffort ?? 'omitted'} model=${ep.upstreamModel}`);
        }
        if (plannedGoEffort) {
          requestBody.reasoning_effort = plannedGoEffort;
          console.log(`[council] opencode-go reasoning_effort: model=${ep.upstreamModel} effort=${plannedGoEffort}`);
        } else {
          console.log(`[council] opencode-go reasoning omitted (no control): model=${ep.upstreamModel} effort=${councilReasoning.effort ?? 'none'}`);
        }
      }
    }
    // §10 (+ Increment 2d): council members share the chat sampling resolver —
    // the fixed temp 0.7 above is superseded for llamacpp arms by resolution
    // v3 (global row ⊕ per-model sampling for THIS upstream key; single
    // source, no asymmetric branch). presence_penalty rides ONLY when set.
    if (ep.provider.id === 'llamacpp' && options.userId) {
      const s = resolveLlamacppSamplingForModel(options.userId, ep.upstreamModel);
      requestBody.temperature = s.temp;
      requestBody.top_p = s.top_p;
      requestBody.top_k = s.top_k;
      requestBody.min_p = s.min_p;
      requestBody.repeat_penalty = s.repeat_penalty;
      if (s.presence_penalty !== undefined) {
        requestBody.presence_penalty = s.presence_penalty;
      }
    }
    const providerRouting: ProviderRoutingConfig = ep.provider.supportsProviderRouting
      ? resolveProviderRouting(parseProviderRoutingConfig(options.memberProviderRouting?.[modelId]))
      : { mode: 'auto' };
    if (ep.provider.supportsProviderRouting) {
      assertProviderRoutingCompatible(modelId, providerRouting);
      const providerPreference = buildOpenRouterProviderPreference(providerRouting);
      if (providerPreference) {
        requestBody.provider = providerPreference;
      }
    }

    if (openRouterTools.length > 0 && !isGoMessages && !isGoResponses) {
      requestBody.tools = openRouterTools;
      requestBody.tool_choice = 'auto';
      requestBody.parallel_tool_calls = true;
    }

    if (options.pdfEngine && ep.provider.supportsPlugins) {
      requestBody.plugins = [{ id: 'file-parser', pdf: { engine: options.pdfEngine } }];
    }

    // Handle tool calling loop
    let iteration = 0;
    let fullContent = '';
    let fullReasoning = '';
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let cost = 0;
    const finalToolCalls: ToolCallSpec[] = [];
    const finalToolResults: ToolResultRecord[] = [];

    while (true) {
      if (options.signal?.aborted) {
        throw new Error('Execution cancelled');
      }

      if (isGoMessages) {
        // T4: re-map the OpenAI-shaped turn (tool_calls/tool rows appended
        // below) to the Anthropic wire shape every lap around the tool loop.
        // T5: mismo toggle+esfuerzo cada vuelta (el wire thinking/output_config
        // se conserva lap a lap; budget default por restricción global).
        const rebuilt = buildCouncilGoMessagesBody({
          upstreamModel: ep.upstreamModel,
          messages,
          openRouterTools: openRouterTools as CouncilOpenRouterToolDef[],
          includeTools: true,
          temperature: 0.7,
          maxTokens: 4096,
          reasoningEnabled: councilReasoning.enabled,
          reasoningEffort: councilReasoning.effort,
          reasoningMaxTokens: null,
        });
        requestBody.messages = rebuilt.messages;
        if (rebuilt.thinking !== undefined) requestBody.thinking = rebuilt.thinking;
        else delete requestBody.thinking;
        if (rebuilt.output_config !== undefined) requestBody.output_config = rebuilt.output_config;
        else delete requestBody.output_config;
        if (rebuilt.system !== undefined) requestBody.system = rebuilt.system;
        else delete requestBody.system;
        if (rebuilt.tools !== undefined) requestBody.tools = rebuilt.tools;
        else delete requestBody.tools;
      } else if (isGoResponses) {
        // T5: re-map the OpenAI-shaped turn to Responses `input` every lap.
        // T3: re-deriva el mismo effort cada vuelta (sin drift entre vueltas).
        const rebuilt = buildCouncilGoResponsesBody({
          upstreamModel: ep.upstreamModel,
          messages,
          openRouterTools: openRouterTools as CouncilOpenRouterToolDef[],
          includeTools: true,
          temperature: 0.7,
          maxTokens: 4096,
          reasoningEnabled: councilReasoning.enabled,
          reasoningEffort: councilReasoning.effort,
        });
        requestBody.input = rebuilt.input;
        requestBody.reasoning = rebuilt.reasoning;
        if (rebuilt.instructions !== undefined) requestBody.instructions = rebuilt.instructions;
        else delete requestBody.instructions;
        if (rebuilt.tools !== undefined) requestBody.tools = rebuilt.tools;
        else delete requestBody.tools;
      }

      const response = await this.fetchUpstream(options.userId, ep, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: options.signal,
      });

      if (!response.ok) {
        // Upstream lies about Content-Type (text/plain on JSON bodies): read
        // as text first, then parse by content, not by header.
        const errorText = await response.text();
        if (isGoMessages || isGoResponses) {
          // T4/T5: frozen §7 literals, same text as chat. 401 also covers the
          // T3 `AuthError/Missing API key` envelope (Bearer without x-api-key
          // on `/messages`; `/responses` is Bearer-only).
          let message = '';
          try {
            const errorJson = JSON.parse(errorText) as { error?: { message?: unknown } };
            if (typeof errorJson?.error?.message === 'string') message = errorJson.error.message;
          } catch {
            message = errorText;
          }
          if (response.status === 401) {
            console.log(`[council] opencode-go billing: status=401 model=${ep.upstreamModel}`);
            throw new Error(COUNCIL_GO_INVALID_KEY_MESSAGE);
          }
          if (response.status === 402 || response.status === 429) {
            console.log(`[council] opencode-go billing: status=${response.status} model=${ep.upstreamModel}`);
            throw new Error(COUNCIL_GO_LIMIT_MESSAGE);
          }
          if (/not supported for format|oa-compat/i.test(`${errorText} ${message}`)) {
            console.log(`[council] opencode-go format mismatch: model=${ep.upstreamModel}`);
            throw new Error(opencodeGoFormatMismatchMessage(ep.upstreamModel, errorText.slice(0, 200)));
          }
          const prefix = (message.trim() || errorText).trim().slice(0, 300);
          throw new Error(`OpenCode Go request failed (status ${response.status}): ${prefix || 'unknown error'}`);
        }
        if (ep.provider.id === 'opencode-go' && /not supported for format|oa-compat/i.test(errorText)) {
          console.log(`[council] opencode-go format mismatch: model=${ep.upstreamModel}`);
          throw new Error(opencodeGoFormatMismatchMessage(ep.upstreamModel, errorText.slice(0, 200)));
        }
        throw new Error(`API error (${response.status}): ${errorText}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const toolCallsByIndex: Record<number, { id?: string; type?: string; function?: { name?: string; arguments?: string } }> = {};
      let lastFinishReason: string | null = null;
      // T4 Anthropic stream state (message_delta usage + tool_use blocks +
      // final ping cost; same wire sequence as chat.ts).
      const councilToolBlocks: Record<number, { id?: string; name?: string; inputJson: string }> = {};
      let councilUsage: CouncilGoMessagesUsage | null = null;
      let councilStopReason: string | null = null;
      let councilPingCost: string | number | undefined;
      // T5 Responses stream state (output_text deltas + function_call items +
      // response.completed usage/cost + final ping cost; same wire as chat.ts).
      const councilResponsesCalls: Record<string, { callId?: string; name?: string; args: string }> = {};
      let councilResponsesUsage: CouncilGoResponsesUsage | null = null;
      let councilResponsesInlineCost: string | number | undefined;
      let councilResponsesPingCost: string | number | undefined;

      try {
        while (true) {
          if (options.signal?.aborted) {
            reader.cancel().catch(() => {});
            throw new Error('Execution cancelled');
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
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
                throw new Error(parsed.error.message || 'Stream error');
              }

              if (isGoMessages) {
                // T4 Anthropic SSE (T3 P3 literals): text_delta appends
                // content; input_json_delta accumulates tool args;
                // message_delta carries stop_reason + usage (no
                // cache_creation in stream); final ping carries cost.
                // T5: thinking_delta appends reasoningContent.
                const evtType = typeof parsed.type === 'string' ? parsed.type : '';
                if (evtType === 'content_block_start') {
                  const idx = typeof parsed.index === 'number' ? parsed.index : 0;
                  const block = parsed.content_block as { type?: string; id?: string; name?: string } | undefined;
                  if (block?.type === 'tool_use') {
                    councilToolBlocks[idx] = {
                      id: typeof block.id === 'string' ? block.id : undefined,
                      name: typeof block.name === 'string' ? block.name : undefined,
                      inputJson: '',
                    };
                  } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
                    // T5: thinking del modelo (texto en `thinking_delta`;
                    // `redacted_thinking` solo signature, ignorada: el replay
                    // K2 no exige bloques). Nunca placeholder de tool.
                  } else if (!councilToolBlocks[idx]) {
                    councilToolBlocks[idx] = { inputJson: '' };
                  }
                  continue;
                }
                if (evtType === 'content_block_delta') {
                  const idx = typeof parsed.index === 'number' ? parsed.index : 0;
                  // T5: `thinking_delta` captura el trace hacia
                  // `reasoningContent` del miembro (misma columna
                  // `reasoning_content` en persistencia de chat).
                  const d = parsed.delta as { text?: unknown; partial_json?: unknown; thinking?: unknown } | undefined;
                  if (d && typeof d.thinking === 'string' && d.thinking) {
                    fullReasoning += d.thinking;
                  } else if (d && typeof d.text === 'string' && d.text) {
                    fullContent += d.text;
                  } else if (d && typeof d.partial_json === 'string' && d.partial_json) {
                    if (!councilToolBlocks[idx]) councilToolBlocks[idx] = { inputJson: '' };
                    councilToolBlocks[idx].inputJson += d.partial_json;
                  }
                  continue;
                }
                if (evtType === 'content_block_stop' || evtType === 'message_start' || evtType === 'message_stop') continue;
                if (evtType === 'message_delta') {
                  const stopReason = parsed.delta?.stop_reason;
                  if (typeof stopReason === 'string' && stopReason) councilStopReason = stopReason;
                  if (parsed.usage) councilUsage = parsed.usage as CouncilGoMessagesUsage;
                  continue;
                }
                if (evtType === 'ping') {
                  if (parsed.cost !== undefined) councilPingCost = parsed.cost as string | number;
                  continue;
                }
                continue;
              }

              if (isGoResponses) {
                // T5 Responses SSE (T3 P5 literals): output_text deltas append
                // content; function_call items accumulate args;
                // response.completed carries usage + full output; final ping
                // carries cost. Same wire sequence as chat.ts.
                const evtType = typeof parsed.type === 'string' ? parsed.type : '';
                if (evtType === 'response.output_text.delta') {
                  const d = parsed.delta;
                  if (typeof d === 'string' && d) {
                    fullContent += d;
                  }
                  continue;
                }
                if (evtType === 'response.output_item.added') {
                  const item = parsed.item as { type?: unknown; call_id?: unknown; id?: unknown; name?: unknown; arguments?: unknown } | undefined;
                  if (item?.type === 'function_call') {
                    const key = typeof parsed.output_index === 'number'
                      ? String(parsed.output_index)
                      : (typeof item.call_id === 'string' ? item.call_id : String(Object.keys(councilResponsesCalls).length));
                    councilResponsesCalls[key] = {
                      callId: typeof item.call_id === 'string' ? item.call_id : (typeof item.id === 'string' ? item.id : undefined),
                      name: typeof item.name === 'string' ? item.name : undefined,
                      args: typeof item.arguments === 'string' ? item.arguments : '',
                    };
                  }
                  continue;
                }
                if (evtType.indexOf('function_call_arguments') >= 0 && evtType.indexOf('delta') >= 0) {
                  const key = typeof parsed.output_index === 'number'
                    ? String(parsed.output_index)
                    : (typeof parsed.item_id === 'string' ? parsed.item_id : '0');
                  const d = parsed.delta;
                  if (typeof d === 'string' && d) {
                    if (!councilResponsesCalls[key]) councilResponsesCalls[key] = { args: '' };
                    councilResponsesCalls[key].args += d;
                  }
                  continue;
                }
                if (evtType === 'response.completed') {
                  const resp = (parsed.response && typeof parsed.response === 'object'
                    ? parsed.response
                    : null) as { usage?: unknown; cost?: unknown; output?: unknown } | null;
                  const u = resp?.usage ?? parsed.usage;
                  if (u && typeof u === 'object') councilResponsesUsage = u as CouncilGoResponsesUsage;
                  if (resp?.cost !== undefined) councilResponsesInlineCost = resp.cost as string | number;
                  const out = Array.isArray(resp?.output) ? resp.output as unknown[] : [];
                  for (const raw of out) {
                    if (!raw || typeof raw !== 'object') continue;
                    const item = raw as { type?: unknown; call_id?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
                    if (item.type !== 'function_call') continue;
                    const callId = typeof item.call_id === 'string' ? item.call_id : (typeof item.id === 'string' ? item.id : '');
                    const name = typeof item.name === 'string' ? item.name : '';
                    const args = typeof item.arguments === 'string' ? item.arguments : '';
                    const hit = Object.values(councilResponsesCalls).find((t) => t.callId !== undefined && t.callId === callId);
                    if (hit) {
                      if (!hit.name && name) hit.name = name;
                      if (!hit.args && args) hit.args = args;
                    } else if (name) {
                      councilResponsesCalls[callId || `done-${Object.keys(councilResponsesCalls).length}`] = { callId: callId || undefined, name, args };
                    }
                  }
                  continue;
                }
                if (evtType === 'ping') {
                  if (parsed.cost !== undefined) councilResponsesPingCost = parsed.cost as string | number;
                  continue;
                }
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;

              if (delta?.reasoning || delta?.reasoning_content) {
                fullReasoning += delta.reasoning || delta.reasoning_content;
              }
              if (delta?.content) {
                fullContent += delta.content;
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
                    if (tc.function.arguments) {
                      toolCallsByIndex[idx].function!.arguments = (toolCallsByIndex[idx].function!.arguments || '') + tc.function.arguments;
                    }
                  }
                }
              }

              const usage = parsed.usage;
              if (usage) {
                totalTokens = usage.total_tokens ?? totalTokens;
                promptTokens = usage.prompt_tokens ?? promptTokens;
                completionTokens = usage.completion_tokens ?? completionTokens;
                if (usage.cost !== undefined) cost = usage.cost;
                else if (ep.provider.id === 'deepseek') cost = computeDeepSeekCost(usage, ep.upstreamModel);
                else if (ep.provider.id === 'abliteration') cost = computeAbliterationCost(usage, ep.upstreamModel);
                else if (ep.provider.id === 'arnict') cost = computeArnictCost(usage, ep.upstreamModel);
                else if (ep.provider.id === 'opencode-go' && !isGoMessages) cost = computeOpencodeGoCost(usage, ep.upstreamModel);
                if (usage.completion_tokens_details?.reasoning_tokens) {
                  reasoningTokens = usage.completion_tokens_details.reasoning_tokens;
                }
              }

              const fr = parsed.choices?.[0]?.finish_reason;
              if (fr && fr !== 'null') lastFinishReason = fr;
            } catch {
              // Skip malformed
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      if (isGoMessages) {
        // T4 Anthropic usage → T2 engine: hit = cache_read_input_tokens,
        // write (prompt_cache_write_tokens) = cache_creation_input_tokens,
        // explicit miss = input_tokens, tier by the real request context
        // (cached input + output); upstream numeric cost wins, never
        // overwritten. cached_tokens = cache_read.
        if (councilUsage) {
          const { mappedUsage, promptTotal, outputTokens, upstreamCost } =
            mapCouncilGoMessagesUsage(councilUsage);
          promptTokens = promptTotal;
          completionTokens = outputTokens;
          totalTokens = promptTotal + outputTokens;
          // No cached_tokens column on MemberResult; the cache_read split
          // still prices via `mappedUsage` above (hit rate).
          if (upstreamCost !== null) {
            cost = upstreamCost;
          } else if (councilPingCost !== undefined) {
            const n = typeof councilPingCost === 'string' ? Number(councilPingCost) : councilPingCost;
            if (typeof n === 'number' && Number.isFinite(n)) {
              cost = n;
            } else {
              const contextTokens = promptTotal + outputTokens;
              cost = computeOpencodeGoCost(mappedUsage, ep.upstreamModel, { contextTokens });
            }
          } else {
            const contextTokens = promptTotal + outputTokens;
            cost = computeOpencodeGoCost(mappedUsage, ep.upstreamModel, { contextTokens });
          }
        } else if (councilPingCost !== undefined) {
          const n = typeof councilPingCost === 'string' ? Number(councilPingCost) : councilPingCost;
          if (typeof n === 'number' && Number.isFinite(n)) cost = n;
        }
        lastFinishReason = councilStopReason === 'tool_use' ? 'tool_calls' : councilStopReason;
      }

      if (isGoResponses) {
        // T5 Responses usage → T2 engine: hit = cached_tokens, explicit miss
        // = input − cached, out = output_tokens (reasoning_tokens informative
        // only); tier by the real request context (input + output); upstream
        // numeric cost wins, never overwritten.
        const responsesEventCost = (raw: string | number | undefined): number | null => {
          if (raw === undefined) return null;
          const n = typeof raw === 'string' ? Number(raw) : raw;
          return (typeof n === 'number' && Number.isFinite(n)) ? n : null;
        };
        if (councilResponsesUsage) {
          const { mappedResponsesUsage, promptTotal, outputTokens, upstreamCost } =
            mapCouncilGoResponsesUsage(councilResponsesUsage);
          promptTokens = promptTotal;
          completionTokens = outputTokens;
          totalTokens = promptTotal + outputTokens;
          if (upstreamCost !== null) {
            cost = upstreamCost;
          } else {
            const eventCost = responsesEventCost(councilResponsesInlineCost) ?? responsesEventCost(councilResponsesPingCost);
            if (eventCost !== null) {
              cost = eventCost;
            } else {
              const contextTokens = promptTotal + outputTokens;
              cost = computeOpencodeGoCost(mappedResponsesUsage, ep.upstreamModel, { contextTokens });
            }
          }
        } else {
          const eventCost = responsesEventCost(councilResponsesInlineCost) ?? responsesEventCost(councilResponsesPingCost);
          if (eventCost !== null) cost = eventCost;
        }
        if (Object.keys(councilResponsesCalls).length > 0 && resolvedTools.length > 0) {
          lastFinishReason = 'tool_calls';
        }
      }

      // Tool calls: from delta (finish_reason === 'tool_calls') or parsed from reasoning (e.g. Kimi K2).
      // T4: Anthropic `tool_use` blocks arrive via content_block_start/delta
      // (never `choices[].delta.tool_calls`); they convert to the same
      // OpenAI-shaped calls and re-enter as `tool_result` blocks next lap.
      // T5: Responses `function_call` items convert the same way and re-enter
      // as `function_call_output` items next lap.
      let toolCallsArray: ToolCallSpec[] = [];
      if (isGoResponses) {
        if (resolvedTools.length > 0) {
          const keys = Object.keys(councilResponsesCalls).sort((a, b) => Number(a) - Number(b));
          toolCallsArray = keys.map((key) => ({
            id: councilResponsesCalls[key].callId || `call_${nanoid()}`,
            type: 'function' as const,
            function: {
              name: councilResponsesCalls[key].name || '',
              arguments: councilResponsesCalls[key].args || '{}',
            },
          })).filter((tc) => tc.function.name);
        }
      } else if (isGoMessages) {
        if (lastFinishReason === 'tool_calls' && resolvedTools.length > 0) {
          const indices = Object.keys(councilToolBlocks).map(Number).sort((a, b) => a - b);
          toolCallsArray = indices.map((idx) => ({
            id: councilToolBlocks[idx].id || `call_${nanoid()}`,
            type: 'function' as const,
            function: {
              name: councilToolBlocks[idx].name || '',
              arguments: councilToolBlocks[idx].inputJson || '{}',
            },
          })).filter((tc) => tc.function.name);
        }
      } else if (lastFinishReason === 'tool_calls' && resolvedTools.length > 0) {
        const indices = Object.keys(toolCallsByIndex).map(Number).sort((a, b) => a - b);
        toolCallsArray = indices.map((idx) => ({
          id: toolCallsByIndex[idx].id || `call_${nanoid()}`,
          type: (toolCallsByIndex[idx].type || 'function') as 'function',
          function: {
            name: toolCallsByIndex[idx].function?.name || '',
            arguments: toolCallsByIndex[idx].function?.arguments || '{}',
          },
        })).filter((tc) => tc.function.name);
      } else if (fullReasoning.trim() && resolvedTools.length > 0) {
        const fromReasoning = parseReasoningToolCalls(fullReasoning);
        if (fromReasoning.length > 0) {
          toolCallsArray = fromReasoning;
          console.log(`      📋 Tool calls parsed from reasoning for ${modelId.split('/').pop()}:`, toolCallsArray.map((t) => t.function.name).join(', '));
        }
      }

      if (toolCallsArray.length > 0) {
        messages.push({
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCallsArray,
          // DeepSeek thinking mode requires reasoning_content back on tool-call turns (else HTTP 400).
          // OpenCode Go replays per-model (D5): kimi-k3/deepseek-* need
          // `reasoning_content`, the rest use `reasoning`.
          ...(fullReasoning.trim() ? { [(ep.provider.id === 'opencode-go' ? opencodeGoHistoryReasoningField(ep.upstreamModel) : assistantReasoningField(ep.provider.id))]: fullReasoning } : {}),
        });

        // Execute tools
        console.log(`      🔧 Executing ${toolCallsArray.length} tool call(s) for ${modelId.split('/').pop()}...`);
        for (const tc of toolCallsArray) {
          const name = tc.function.name;
          const argsStr = tc.function.arguments || '{}';
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(argsStr);
          } catch {
            args = {};
          }

          const result = await runTool(
            resolvedTools as unknown as Parameters<typeof runTool>[0],
            name,
            args,
            options.mcpClients || new Map(),
            options.userId,
            undefined,
            undefined,
            {
              ...(options.authorizeMcpCall ? { authorizeMcpCall: options.authorizeMcpCall } : {}),
              mcpControl: {
                ...(options.signal ? { signal: options.signal } : {}),
              },
            }
          );

          const output = result.output ?? '';
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: output,
          });
          finalToolResults.push({ id: tc.id, content: output });
        }

        console.log(`      ✅ Tools completed for ${modelId.split('/').pop()}, continuing conversation...`);
        finalToolCalls.push(...toolCallsArray);
        iteration++;
        continue;
      }

      break;
    }

    return {
      modelId,
      providerRouting,
      content: fullContent,
      reasoningContent: fullReasoning || undefined,
      tokensUsed: totalTokens,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cost,
      toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
      toolResults: finalToolResults.length > 0 ? finalToolResults : undefined,
    };
  }

  private async executeMemberStreamCodex(
    modelId: string,
    options: CouncilExecutionOptions
  ): Promise<Omit<MemberResult, 'responseTimeMs' | 'status'>> {
    const upstreamModel = toUpstreamModelId(modelId);
    const messages: Array<{ role: string; content?: string | unknown[] | null; tool_call_id?: string | null; tool_calls?: unknown[] | null }> = [
      { role: 'system', content: options.systemPrompt },
      ...(options.messageHistory as Array<{ role: string; content?: string | unknown[] | null }>),
    ];

    const result = await runCodexTurn({
      userId: options.userId,
      conversationId: null,
      threadId: null,
      systemPrompt: options.systemPrompt,
      messages,
      model: upstreamModel,
      tools: options.tools || [],
      mcpClients: options.mcpClients as Map<string, McpConnection> | undefined,
      authorizeMcpCall: options.authorizeMcpCall,
      signal: options.signal,
    });

    return {
      modelId,
      providerRouting: { mode: 'auto' },
      content: result.content,
      reasoningContent: result.reasoning || undefined,
      tokensUsed: result.totalTokens,
      promptTokens: result.inputTokens,
      completionTokens: result.outputTokens,
      reasoningTokens: result.reasoningOutputTokens,
      cost: result.cost,
      toolCalls: result.toolCalls.length > 0
        ? result.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }))
        : undefined,
      toolResults: result.toolCalls.length > 0
        ? result.toolCalls.map((tc) => ({ id: tc.id, content: '' }))
        : undefined,
    };
  }

  private async synthesize(
    memberResults: MemberResult[],
    options: CouncilExecutionOptions
  ): Promise<SynthesisResult> {
    const startTime = Date.now();
    const synthesizerModel = options.synthesizerModel || 'anthropic/claude-3.5-sonnet';

    // Filter successful results
    const successfulResults = memberResults.filter((r) => r.status === 'success' && r.content);

    if (successfulResults.length === 0) {
      console.log(`   ❌ No successful member results to synthesize`);
      throw new Error('No successful member results to synthesize');
    }

    // Build synthesis prompt
    const synthesisPrompt = this.buildSynthesisPrompt(successfulResults, options.content);

    // ChatGPT (Codex) synthesizer: bridge through the user's app-server.
    if (resolveProviderId(synthesizerModel) === 'codex') {
      return this.synthesizeCodex(synthesisPrompt, synthesizerModel, options);
    }

    const ep = this.resolveEndpoint(synthesizerModel);
    const headers = ep.headers;
    // T4: `messages` synthesizers ride the same Anthropic sender as members.
    // T5: `responses` synthesizers ride the same Responses sender as members.
    const isGoMessages = ep.provider.id === 'opencode-go' && opencodeGoTransportFor(ep.upstreamModel) === 'messages';
    const isGoResponses = ep.provider.id === 'opencode-go' && opencodeGoTransportFor(ep.upstreamModel) === 'responses';
    if (ep.provider.id === 'opencode-go') {
      // D9: upstream flags clients without a session as problematic (GC §1).
      ep.headers['x-opencode-session'] = options.conversationId ?? options.userId ?? 'unknown';
    }
    if (isGoMessages) {
      ep.url = OPENCODE_GO_MESSAGES_URL;
      ep.headers['anthropic-version'] = OPENCODE_GO_ANTHROPIC_VERSION;
      ep.headers['x-api-key'] = this.getApiKey('opencode-go');
    }
    if (isGoResponses) {
      // T3 VERIFIED (P4/P5): Bearer-only on `/responses`.
      ep.url = OPENCODE_GO_RESPONSES_URL;
    }

    const providerRouting: ProviderRoutingConfig = ep.provider.supportsProviderRouting
      ? resolveProviderRouting(parseProviderRoutingConfig(options.synthesizerProviderRouting))
      : { mode: 'auto' };
    if (ep.provider.supportsProviderRouting) {
      assertProviderRoutingCompatible(synthesizerModel, providerRouting);
    }
    const synthesisMessages = [
      { role: 'system', content: 'You are a synthesis expert. Your task is to analyze multiple AI model responses and create a unified, comprehensive answer.' },
      { role: 'user', content: synthesisPrompt },
    ];
    // T3: la síntesis thread-ea el mismo toggle+esfuerzo que los miembros.
    const synthesisReasoning = this.resolveCouncilReasoning(options.conversationId, options.userId);
    const requestBody: Record<string, unknown> = isGoMessages
      ? buildCouncilGoMessagesBody({
          upstreamModel: ep.upstreamModel,
          messages: synthesisMessages,
          openRouterTools: [],
          includeTools: false,
          temperature: 0.7,
          maxTokens: 4096,
          reasoningEnabled: synthesisReasoning.enabled,
          reasoningEffort: synthesisReasoning.effort,
          reasoningMaxTokens: null,
        })
      : isGoResponses
        ? buildCouncilGoResponsesBody({
            upstreamModel: ep.upstreamModel,
            messages: synthesisMessages,
            openRouterTools: [],
            includeTools: false,
            temperature: 0.7,
            maxTokens: 4096,
            reasoningEnabled: synthesisReasoning.enabled,
            reasoningEffort: synthesisReasoning.effort,
          })
        : {
            model: ep.upstreamModel,
            messages: synthesisMessages,
            temperature: 0.7,
            max_tokens: 4096,
            stream: true,
          };
    // §10 (+ Increment 2d): the synthesizer arm rides the SAME ForModel
    // sampling resolver family when it targets an llamacpp model (fixed
    // temp 0.7 stays for every other arm; presence_penalty ONLY when set).
    if (ep.provider.id === 'llamacpp' && options.userId) {
      const s = resolveLlamacppSamplingForModel(options.userId, ep.upstreamModel);
      requestBody.temperature = s.temp;
      requestBody.top_p = s.top_p;
      requestBody.top_k = s.top_k;
      requestBody.min_p = s.min_p;
      requestBody.repeat_penalty = s.repeat_penalty;
      if (s.presence_penalty !== undefined) {
        requestBody.presence_penalty = s.presence_penalty;
      }
    }
    if (ep.provider.supportsProviderRouting) {
      const providerPreference = buildOpenRouterProviderPreference(providerRouting);
      if (providerPreference) {
        requestBody.provider = providerPreference;
      }
    }
    if (ep.provider.id === 'abliteration') {
      // Same relay contract as member bodies (GC §4/§6/§7).
      requestBody.stream_options = { include_usage: true };
      const reasoning = this.resolveCouncilReasoning(options.conversationId, options.userId);
      Object.assign(requestBody, buildAbliterationReasoning(reasoning.enabled, reasoning.effort));
    }
    if (ep.provider.id === 'arnict') {
      // Same relay contract as member bodies (GC §3/§6/§7): usage frame +
      // object reasoning arm via the frozen builder.
      requestBody.stream_options = { include_usage: true };
      const reasoning = this.resolveCouncilReasoning(options.conversationId, options.userId);
      requestBody.reasoning = buildArnictReasoning(reasoning.enabled, reasoning.effort);
    }
    if (ep.provider.id === 'opencode-go') {
      // Same relay contract as member bodies (T4 K1-GO): el chat-transport
      // (`unknown` incluido, fail-open) lleva `reasoning_effort` top-level
      // planificado por matriz T1 vía `resolveCouncilReasoning`; off →
      // `goReasoningOff`, `[]`/toggle-only → omit con log. `messages` via
      // the T4 sender, `responses` via the T5 sender.
      // T3: `responses` lleva el effort planificado desde su builder (nunca
      // omitido).
      // Usage frame for static cost (GC §6); `messages` carries its usage in
      // `message_delta` (+ final `ping` cost), `responses` in
      // `response.completed` (+ final `ping` cost) — no `stream_options`.
      if (!isGoMessages && !isGoResponses) {
        requestBody.stream_options = { include_usage: true };
        const plannedGoEffort = planCouncilGoChatEffort(ep.upstreamModel, synthesisReasoning.enabled, synthesisReasoning.effort);
        if (synthesisReasoning.enabled && synthesisReasoning.effort != null && plannedGoEffort !== synthesisReasoning.effort) {
          console.log(`[council] Reasoning effort clamped (go): requested=${synthesisReasoning.effort} applied=${plannedGoEffort ?? 'omitted'} model=${ep.upstreamModel}`);
        }
        if (plannedGoEffort) {
          requestBody.reasoning_effort = plannedGoEffort;
          console.log(`[council] opencode-go reasoning_effort: model=${ep.upstreamModel} effort=${plannedGoEffort}`);
        } else {
          console.log(`[council] opencode-go reasoning omitted (no control): model=${ep.upstreamModel} effort=${synthesisReasoning.effort ?? 'none'}`);
        }
      }
    }

    // Notify synthesis start
    console.log(`\n🧠 SYNTHESIS STARTED`);
    console.log(`   🎯 Model: ${synthesizerModel.split('/').pop()}`);
    console.log(`   📊 Input: ${successfulResults.length} successful responses`);
    console.log(`   🤖 Sources: ${successfulResults.map(r => r.modelId.split('/').pop()).join(', ')}`);

    options.onSynthesisStart(
      synthesizerModel,
      successfulResults
    );

    const response = await this.fetchUpstream(options.userId, ep, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`   ❌ Synthesis API Error: ${response.status} - ${errorText.slice(0, 100)}`);
      if (isGoMessages || isGoResponses) {
        // T4/T5: frozen §7 literals, same text as chat (also covers the T3
        // `AuthError/Missing API key` envelope on 401).
        if (response.status === 401) {
          throw new Error(COUNCIL_GO_INVALID_KEY_MESSAGE);
        }
        if (response.status === 402 || response.status === 429) {
          throw new Error(COUNCIL_GO_LIMIT_MESSAGE);
        }
        if (/not supported for format|oa-compat/i.test(errorText)) {
          console.log(`[council] opencode-go format mismatch: model=${ep.upstreamModel}`);
          throw new Error(opencodeGoFormatMismatchMessage(ep.upstreamModel, errorText.slice(0, 200)));
        }
        let message = '';
        try {
          const errorJson = JSON.parse(errorText) as { error?: { message?: unknown } };
          if (typeof errorJson?.error?.message === 'string') message = errorJson.error.message;
        } catch {
          message = errorText;
        }
        const prefix = (message.trim() || errorText).trim().slice(0, 300);
        throw new Error(`Synthesis API error (${response.status}): ${prefix || 'unknown error'}`);
      }
      if (ep.provider.id === 'opencode-go' && /not supported for format|oa-compat/i.test(errorText)) {
        console.log(`[council] opencode-go format mismatch: model=${ep.upstreamModel}`);
        throw new Error(opencodeGoFormatMismatchMessage(ep.upstreamModel, errorText.slice(0, 200)));
      }
      throw new Error(`Synthesis API error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No synthesis response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let fullReasoning = '';
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cost = 0;
    // T4 Anthropic stream state (same wire sequence as members).
    let synthUsage: CouncilGoMessagesUsage | null = null;
    let synthPingCost: string | number | undefined;
    // T5 Responses stream state (same wire sequence as members).
    let synthResponsesUsage: CouncilGoResponsesUsage | null = null;
    let synthResponsesInlineCost: string | number | undefined;
    let synthResponsesPingCost: string | number | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Synthesis timeout')), SYNTHESIS_TIMEOUT_MS);
    });

    const streamPromise = (async () => {
      try {
        while (true) {
          if (options.signal?.aborted) {
            reader.cancel().catch(() => {});
            throw new Error('Synthesis cancelled');
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(': ') || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              if (isGoMessages) {
                // T4 Anthropic SSE (T3 P3 literals): text_delta appends
                // content; message_delta carries usage (no cache_creation in
                // stream); final ping carries cost. T5: thinking_delta appends
                // reasoningContent (misma columna que el resto de reasoning).
                const evtType = typeof parsed.type === 'string' ? parsed.type : '';
                if (evtType === 'content_block_delta') {
                  const d = parsed.delta as { text?: unknown; thinking?: unknown } | undefined;
                  if (d && typeof d.thinking === 'string' && d.thinking) {
                    fullReasoning += d.thinking;
                    continue;
                  }
                  if (d && typeof d.text === 'string' && d.text) {
                    fullContent += d.text;
                    options.onSynthesisChunk(d.text);
                  }
                  continue;
                }
                if (evtType === 'message_delta') {
                  if (parsed.usage) synthUsage = parsed.usage as CouncilGoMessagesUsage;
                  continue;
                }
                if (evtType === 'ping') {
                  if (parsed.cost !== undefined) synthPingCost = parsed.cost as string | number;
                  continue;
                }
                // message_start (zeros), content_block_start/stop,
                // message_stop: no content to accumulate.
                continue;
              }
              if (isGoResponses) {
                // T5 Responses SSE (T3 P5 literals): output_text deltas append
                // content; response.completed carries usage; final ping
                // carries cost. Synthesis takes no tools: function_call items
                // are ignored here (same wire, member-only handling).
                const evtType = typeof parsed.type === 'string' ? parsed.type : '';
                if (evtType === 'response.output_text.delta') {
                  const d = parsed.delta;
                  if (typeof d === 'string' && d) {
                    fullContent += d;
                    options.onSynthesisChunk(d);
                  }
                  continue;
                }
                if (evtType === 'response.completed') {
                  const resp = (parsed.response && typeof parsed.response === 'object'
                    ? parsed.response
                    : null) as { usage?: unknown; cost?: unknown } | null;
                  const u = resp?.usage ?? parsed.usage;
                  if (u && typeof u === 'object') synthResponsesUsage = u as CouncilGoResponsesUsage;
                  if (resp?.cost !== undefined) synthResponsesInlineCost = resp.cost as string | number;
                  continue;
                }
                if (evtType === 'ping') {
                  if (parsed.cost !== undefined) synthResponsesPingCost = parsed.cost as string | number;
                  continue;
                }
                continue;
              }
              const delta = parsed.choices?.[0]?.delta;

              if (delta?.reasoning || delta?.reasoning_content) {
                fullReasoning += delta.reasoning || delta.reasoning_content;
              }
              if (delta?.content) {
                fullContent += delta.content;
                options.onSynthesisChunk(delta.content);
              }

              const usage = parsed.usage;
              if (usage) {
                totalTokens = usage.total_tokens ?? totalTokens;
                promptTokens = usage.prompt_tokens ?? promptTokens;
                completionTokens = usage.completion_tokens ?? completionTokens;
                if (usage.cost !== undefined) cost = usage.cost;
                else if (ep.provider.id === 'deepseek') cost = computeDeepSeekCost(usage, ep.upstreamModel);
                else if (ep.provider.id === 'abliteration') cost = computeAbliterationCost(usage, ep.upstreamModel);
                else if (ep.provider.id === 'arnict') cost = computeArnictCost(usage, ep.upstreamModel);
                else if (ep.provider.id === 'opencode-go' && !isGoMessages) cost = computeOpencodeGoCost(usage, ep.upstreamModel);
              }
            } catch {
              // Skip malformed
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    })();

    await Promise.race([streamPromise, timeoutPromise]);

    if (isGoMessages) {
      // T4 Anthropic usage → T2 engine: hit = cache_read_input_tokens, write
      // (prompt_cache_write_tokens) = cache_creation_input_tokens, explicit
      // miss = input_tokens, tier by the real request context (cached input +
      // output); upstream numeric cost wins, never overwritten.
      if (synthUsage) {
        const { mappedUsage, promptTotal, outputTokens, upstreamCost } =
          mapCouncilGoMessagesUsage(synthUsage);
        promptTokens = promptTotal;
        completionTokens = outputTokens;
        totalTokens = promptTotal + outputTokens;
        if (upstreamCost !== null) {
          cost = upstreamCost;
        } else if (synthPingCost !== undefined) {
          const n = typeof synthPingCost === 'string' ? Number(synthPingCost) : synthPingCost;
          if (typeof n === 'number' && Number.isFinite(n)) {
            cost = n;
          } else {
            const contextTokens = promptTotal + outputTokens;
            cost = computeOpencodeGoCost(mappedUsage, ep.upstreamModel, { contextTokens });
          }
        } else {
          const contextTokens = promptTotal + outputTokens;
          cost = computeOpencodeGoCost(mappedUsage, ep.upstreamModel, { contextTokens });
        }
      } else if (synthPingCost !== undefined) {
        const n = typeof synthPingCost === 'string' ? Number(synthPingCost) : synthPingCost;
        if (typeof n === 'number' && Number.isFinite(n)) cost = n;
      }
    }

    if (isGoResponses) {
      // T5 Responses usage → T2 engine: hit = cached_tokens, explicit miss =
      // input − cached, out = output_tokens; tier by the real request context
      // (input + output); upstream numeric cost wins, never overwritten.
      const synthEventCost = (raw: string | number | undefined): number | null => {
        if (raw === undefined) return null;
        const n = typeof raw === 'string' ? Number(raw) : raw;
        return (typeof n === 'number' && Number.isFinite(n)) ? n : null;
      };
      if (synthResponsesUsage) {
        const { mappedResponsesUsage, promptTotal, outputTokens, upstreamCost } =
          mapCouncilGoResponsesUsage(synthResponsesUsage);
        promptTokens = promptTotal;
        completionTokens = outputTokens;
        totalTokens = promptTotal + outputTokens;
        if (upstreamCost !== null) {
          cost = upstreamCost;
        } else {
          const eventCost = synthEventCost(synthResponsesInlineCost) ?? synthEventCost(synthResponsesPingCost);
          if (eventCost !== null) {
            cost = eventCost;
          } else {
            const contextTokens = promptTotal + outputTokens;
            cost = computeOpencodeGoCost(mappedResponsesUsage, ep.upstreamModel, { contextTokens });
          }
        }
      } else {
        const eventCost = synthEventCost(synthResponsesInlineCost) ?? synthEventCost(synthResponsesPingCost);
        if (eventCost !== null) cost = eventCost;
      }
    }

    const responseTimeMs = Date.now() - startTime;

    console.log(`   ✅ Synthesis Complete: ${totalTokens.toLocaleString()} tokens | $${(cost || 0).toFixed(4)} | ${(responseTimeMs / 1000).toFixed(1)}s`);

    // Comparison extraction runs in the route after sending council_complete, so the client is not blocked
    return {
      content: fullContent,
      reasoningContent: fullReasoning || undefined,
      tokensUsed: totalTokens,
      promptTokens,
      completionTokens,
      cost,
      responseTimeMs,
      providerRouting,
    };
  }

  /**
   * Codex-backed synthesis: streams chunks to the client exactly like the
   * generic streaming path (via options.onSynthesisChunk).
   */
  private async synthesizeCodex(
    synthesisPrompt: string,
    synthesizerModel: string,
    options: CouncilExecutionOptions
  ): Promise<SynthesisResult> {
    const startTime = Date.now();
    const messages = [
      { role: 'user' as const, content: synthesisPrompt },
    ];

    const result = await runCodexTurn({
      userId: options.userId,
      conversationId: null,
      threadId: null,
      systemPrompt: 'You are a synthesis expert. Your task is to analyze multiple AI model responses and create a unified, comprehensive answer.',
      messages,
      model: toUpstreamModelId(synthesizerModel),
      tools: [],
      mcpClients: options.mcpClients as Map<string, McpConnection> | undefined,
      authorizeMcpCall: options.authorizeMcpCall,
      signal: options.signal,
      emit: (evt) => {
        const chunk = evt.content;
        if (typeof chunk === 'string' && chunk) {
          options.onSynthesisChunk(chunk);
        }
      },
    });

    const responseTimeMs = Date.now() - startTime;
    console.log(`   ✅ Synthesis Complete (Codex): ${result.totalTokens.toLocaleString()} tokens | ${(responseTimeMs / 1000).toFixed(1)}s`);

    return {
      content: result.content,
      reasoningContent: result.reasoning || undefined,
      tokensUsed: result.totalTokens,
      promptTokens: result.inputTokens,
      completionTokens: result.outputTokens,
      cost: result.cost,
      responseTimeMs,
      providerRouting: { mode: 'auto' },
    };
  }

  /**
   * Single request to OpenRouter for comparison JSON (structured output).
   * Returns raw content string or throws on API error / missing content.
   */
  private async requestComparisonJson(
    messages: Array<{ role: string; content: string }>,
    maxTokens: number,
    synthesizerModel: string,
    providerRouting?: ProviderRoutingConfig | null,
    signal?: AbortSignal,
    userId?: string
  ): Promise<string> {
    // ChatGPT (Codex) synthesizer: structured output via turn outputSchema.
    if (resolveProviderId(synthesizerModel) === 'codex' && userId) {
      const result = await runCodexTurn({
        userId,
        conversationId: null,
        threadId: null,
        systemPrompt: 'You are an analyst. Output only the JSON object that matches the provided schema.',
        messages: [{ role: 'user', content: messages[0]?.content ?? '' }],
        model: toUpstreamModelId(synthesizerModel),
        outputSchema: COUNCIL_COMPARISON_JSON_SCHEMA.schema as Record<string, unknown>,
        tools: [],
        signal,
      });
      const raw = result.content.trim();
      if (!raw) throw new Error('Comparison API returned no content');
      return raw;
    }
    const ep = this.resolveEndpoint(synthesizerModel);
    if (ep.provider.id === 'opencode-go') {
      // D9 session header (GC §1). Only reachable when another provider
      // compares: a Go synthesizer skips comparison via supportsJsonSchema:false.
      ep.headers['x-opencode-session'] = userId ?? 'unknown';
    }
    const providerPreference = ep.provider.supportsProviderRouting
      ? buildOpenRouterProviderPreference(providerRouting)
      : undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Comparison extraction timeout')), COMPARISON_EXTRACTION_TIMEOUT_MS);
    });

    const fetchPromise = this.fetchUpstream(userId, ep, {
      method: 'POST',
      headers: ep.headers,
      body: JSON.stringify({
        model: ep.upstreamModel,
        messages,
        temperature: 0.3,
        max_tokens: maxTokens,
        stream: false,
        ...(providerPreference ? { provider: providerPreference } : {}),
        response_format: {
          type: 'json_schema',
          json_schema: COUNCIL_COMPARISON_JSON_SCHEMA,
        },
        // Schemas force reasoning off on arnict (keyed Gotcha 4: an active
        // trace canibalizes max_tokens into `length` with empty content).
        ...(ep.provider.id === 'arnict' ? { reasoning: { enabled: false } } : {}),
      }),
      signal,
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Comparison API ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('Comparison API returned no content');
    }

    return raw;
  }

  /** True if the error is from JSON.parse (truncated or malformed JSON). */
  private isJsonParseError(e: unknown): boolean {
    if (e instanceof SyntaxError) return true;
    const msg = e instanceof Error ? e.message : String(e);
    return /Unterminated string|Unexpected end|JSON at position/i.test(msg);
  }

  /**
   * Parse and validate comparison JSON. Returns raw string if valid, throws on parse error.
   */
  private parseComparisonJson(raw: string): string {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new SyntaxError('Comparison JSON is not an object');
    }
    return raw;
  }

  /**
   * Call OpenRouter with response_format json_schema to get structured comparison.
   * On invalid/truncated JSON, retries once with a repair prompt. Returns raw JSON string or null on failure (graceful degradation).
   * Public so the route can run it in the background after sending council_complete.
   */
  async extractComparison(
    memberResults: MemberResult[],
    synthesisContent: string,
    userQuery: string,
    synthesizerModel: string,
    providerRouting?: ProviderRoutingConfig | null,
    signal?: AbortSignal,
    userId?: string
  ): Promise<string | null> {
    // Structured comparison needs json_schema response_format (OpenRouter only).
    // For other providers (e.g. a DeepSeek synthesizer) skip gracefully — council still completes.
    if (!getProviderForModel(synthesizerModel).supportsJsonSchema) {
      console.log('   ℹ️ Skipping structured comparison: synthesizer provider lacks json_schema support');
      return null;
    }
    const normalizedProviderRouting = resolveProviderRouting(parseProviderRoutingConfig(providerRouting));
    assertProviderRoutingCompatible(synthesizerModel, normalizedProviderRouting);
    const truncatedResponses = memberResults.map((r) => ({
      model_id: r.modelId,
      content: r.content.length > MAX_MEMBER_CONTENT_FOR_COMPARISON
        ? r.content.slice(0, MAX_MEMBER_CONTENT_FOR_COMPARISON) + '…'
        : r.content,
    }));

    const prompt = `You are an analyst. Given the user's question, the individual AI model responses below, and the synthesized answer, output a structured comparison.

## User question
${userQuery}

## Individual model responses (excerpts)
${truncatedResponses.map((r, i) => `### Model ${i + 1}: ${r.model_id}\n${r.content}`).join('\n\n')}

## Synthesized answer
${synthesisContent.slice(0, 4000)}${synthesisContent.length > 4000 ? '…' : ''}

## Your task
1. Set question_type to "yes_no" if the question is binary (e.g. "Is X good?"), "open" for open-ended, or "comparison" for A vs B.
2. List up to 7 agreements: findings where at least two models agree. Use exact model_id strings as given above.
3. List up to 7 disagreements: topic, each model's stance (model_id + stance), and why_they_differ in one sentence.
4. List up to 7 unique_findings: insights from only one model (model_id, finding, optional why_it_matters).

Output only the JSON object that matches the schema. Use the exact model_id values from the responses (e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o).`;

    const repairPrompt = `The previous JSON response was truncated or invalid and could not be parsed. Output a complete, valid JSON object that matches the same schema (question_type, agreements, disagreements, unique_findings). Fix any unterminated strings, missing brackets, or cut-off values. Output only the JSON object, no explanation or markdown.`;

    let raw: string;
    try {
      raw = await this.requestComparisonJson(
        [{ role: 'user', content: prompt }],
        COMPARISON_EXTRACTION_MAX_TOKENS,
        synthesizerModel,
        normalizedProviderRouting,
        signal,
        userId
      );
    } catch (requestError) {
      if (requestError instanceof Error && requestError.name === 'AbortError') {
        throw new Error('Comparison extraction timeout');
      }
      throw requestError;
    }

    try {
      return this.parseComparisonJson(raw);
    } catch (parseError) {
      if (!this.isJsonParseError(parseError)) {
        throw parseError;
      }
      // First response was invalid or truncated JSON. Retry once with repair.
      const repairMessages: Array<{ role: string; content: string }> = [
        { role: 'user', content: prompt },
        { role: 'assistant', content: raw },
        { role: 'user', content: repairPrompt },
      ];

      try {
        const repairRaw = await this.requestComparisonJson(
          repairMessages,
          COMPARISON_EXTRACTION_MAX_TOKENS,
          synthesizerModel,
          normalizedProviderRouting,
          signal,
          userId
        );
        const result = this.parseComparisonJson(repairRaw);
        console.log(`   📊 Comparison extraction OK after repair`);
        return result;
      } catch (repairError) {
        const msg = repairError instanceof Error ? repairError.message : String(repairError);
        console.log(`   ⚠️ Comparison extraction failed after repair: ${msg.slice(0, 80)}`);
        return null;
      }
    }
  }

  private buildSynthesisPrompt(memberResults: MemberResult[], userQuery: string): string {
    const memberResponsesText = memberResults
      .map((r, i) => {
        const modelName = r.modelId.split('/').pop() || r.modelId;
        return `
### Response ${i + 1}: ${modelName}
${r.reasoningContent ? `**Reasoning Process:**
${r.reasoningContent}

` : ''}**Response:**
${r.content}
---
`;
      })
      .join('\n');

    return `You are a synthesis expert. Your task is to analyze multiple AI model responses to the same query and create a unified, comprehensive answer.

## Original Query
"""${userQuery}"""

## Input Responses
You will receive responses from ${memberResults.length} different AI models:

${memberResponsesText}

## Your Task
1. **Analyze all responses** for:
   - Areas of agreement (consensus)
   - Areas of disagreement or different perspectives
   - Unique insights from individual models
   - Factual discrepancies that need resolution

2. **Synthesize a unified response** that:
   - Presents the most accurate and complete answer
   - Acknowledges different perspectives where relevant
   - Resolves contradictions using your best judgment
   - Maintains a professional, helpful tone
   - Cites which models contributed key insights when relevant

3. **Structure your response** with:
   - A clear, direct answer to the query
   - Supporting details and context
   - Any important caveats or limitations

## Response Guidelines
- Be concise but thorough
- Do not simply concatenate responses
- Do not present conflicting information without resolution
- When models disagree, explain the different viewpoints and provide your synthesized conclusion
- Use markdown formatting for readability

Now provide your synthesized response:`;
  }

  private calculateTotalCost(memberResults: MemberResult[], synthesis: SynthesisResult): number {
    const memberCost = memberResults.reduce((sum, r) => sum + (r.cost || 0), 0);
    return memberCost + (synthesis.cost || 0);
  }

  private calculateTotalTokens(memberResults: MemberResult[], synthesis: SynthesisResult): number {
    const memberTokens = memberResults.reduce((sum, r) => sum + (r.tokensUsed || 0), 0);
    return memberTokens + (synthesis.tokensUsed || 0);
  }
}

export function createCouncilExecutor(getApiKey: (provider: ProviderId) => string): CouncilExecutor {
  return new CouncilExecutor(getApiKey);
}
