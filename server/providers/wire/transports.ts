/**
 * Request bodies and usage mapping for the non-chat-completions transports
 * (Anthropic-shape `POST /messages`, OpenAI `POST /responses`), shared by the
 * chat route and the council executor.
 *
 * Both accept the app's OpenAI-shaped message array (system + history +
 * tool_calls/tool rows) and re-map it on every tool-loop iteration.
 * Verified shapes (OpenCode Go, keyed 2026-09-15): messages needs
 * `anthropic-version` + `x-api-key`; tools map to `{name, description,
 * input_schema}` without `tool_choice`/`parallel_tool_calls`; history
 * reasoning replays as plain content. Responses takes flat function tools
 * (`{type, name, description, parameters}`), `instructions` for system rows,
 * and always an explicit `reasoning.effort`.
 */
import type { CatalogModel } from '../../../shared/models/catalog.js';
import type { ReasoningPlan } from '../../../shared/models/reasoning.js';
import type { PricedUsage } from '../../../shared/models/pricing.js';
import { messagesThinkingFields, responsesReasoning } from './reasoning.js';

export type OutboundMessage = { role: string; content?: string | unknown[] | null; tool_call_id?: string; tool_calls?: unknown[] };
export type OpenAIToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

export interface TransportBodyInput {
  model: CatalogModel;
  plan: ReasoningPlan;
  messages: OutboundMessage[];
  tools: OpenAIToolDef[];
  /** False when the agent's tool choice is `none`. */
  includeTools: boolean;
  temperature: number;
  maxTokens: number;
}

/** Plain text of an OpenAI content value (string or parts array). */
export function contentText(content: string | unknown[] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const p = part as { type?: unknown; text?: unknown } | null;
      return p && p.type === 'text' && typeof p.text === 'string' ? p.text : '';
    })
    .join('');
}

export function buildMessagesBody(input: TransportBodyInput): Record<string, unknown> {
  const systemTexts: string[] = [];
  const converted: Array<{ role: string; content: unknown }> = [];
  for (const m of input.messages) {
    if (m.role === 'system') {
      const text = contentText(m.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (m.role === 'tool') {
      converted.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: contentText(m.content) }] });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const blocks: unknown[] = [];
      const text = contentText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const raw of m.tool_calls) {
        const tc = raw as { id?: string; function?: { name?: string; arguments?: string } };
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(tc.function?.arguments ?? '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          args = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id ?? '', name: tc.function?.name ?? '', input: args });
      }
      converted.push({ role: 'assistant', content: blocks });
      continue;
    }
    converted.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: contentText(m.content) });
  }
  // Anthropic requires alternating roles: merge consecutive same-role rows.
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
    model: input.model.upstreamId,
    messages: merged,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
    stream: true,
    ...messagesThinkingFields(input.model, input.plan),
  };
  if (systemTexts.length > 0) body.system = systemTexts.join('\n\n');
  if (input.includeTools && input.tools.length > 0) {
    body.tools = input.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  }
  return body;
}

const RESPONSES_TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export function buildResponsesBody(input: TransportBodyInput): Record<string, unknown> {
  const instructionTexts: string[] = [];
  const items: unknown[] = [];
  for (const m of input.messages) {
    if (m.role === 'system') {
      const text = contentText(m.content);
      if (text) instructionTexts.push(text);
      continue;
    }
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: contentText(m.content) });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const text = contentText(m.content);
      if (text) items.push({ role: 'assistant', content: text });
      for (const raw of m.tool_calls) {
        const tc = raw as { id?: string; function?: { name?: string; arguments?: string } };
        items.push({ type: 'function_call', call_id: tc.id ?? '', name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '{}' });
      }
      continue;
    }
    items.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: contentText(m.content) });
  }
  const body: Record<string, unknown> = {
    model: input.model.upstreamId,
    input: items,
    temperature: input.temperature,
    reasoning: responsesReasoning(input.model, input.plan),
    max_output_tokens: input.maxTokens,
    stream: true,
  };
  if (instructionTexts.length > 0) body.instructions = instructionTexts.join('\n\n');
  if (input.includeTools && input.tools.length > 0) {
    // Flat function form: a nested `function` leaves `tools[i].name` missing (400).
    body.tools = input.tools.map((t, i) => {
      const name = t.function?.name;
      if (typeof name !== 'string' || !RESPONSES_TOOL_NAME.test(name)) {
        throw new Error(`Responses transport: tool at index ${i} has an invalid or missing name (expected ${RESPONSES_TOOL_NAME})`);
      }
      return { type: 'function', name, description: t.function.description, parameters: t.function.parameters };
    });
  }
  return body;
}

/** Keys a transport body owns; replaced wholesale when a tool-loop iteration rebuilds it. */
export const MESSAGES_BODY_KEYS = ['messages', 'system', 'tools', 'thinking', 'output_config'] as const;
export const RESPONSES_BODY_KEYS = ['input', 'instructions', 'tools', 'reasoning'] as const;

/** Rebuilds a transport body in place (keeps caller-owned keys such as `max_tokens`). */
export function refreshTransportBody(target: Record<string, unknown>, rebuilt: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (rebuilt[key] !== undefined) target[key] = rebuilt[key];
    else delete target[key];
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function numericCost(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export interface MessagesUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost?: string | number;
}

export interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
  cost?: string | number;
}

export interface MappedTransportUsage {
  priced: PricedUsage;
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** Numeric upstream cost when the host reports one. */
  upstreamCost: number | null;
}

/** Anthropic usage: `input_tokens` excludes cache reads and writes. */
export function mapMessagesUsage(usage: MessagesUsage | null | undefined): MappedTransportUsage {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const write = usage?.cache_creation_input_tokens ?? 0;
  const read = usage?.cache_read_input_tokens ?? 0;
  return {
    priced: { inputTokens: input, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: output },
    promptTokens: input + read + write,
    outputTokens: output,
    cachedTokens: read,
    reasoningTokens: 0,
    upstreamCost: numericCost(usage?.cost),
  };
}

/** Responses usage: `input_tokens` includes cached tokens; reasoning is inside output. */
export function mapResponsesUsage(usage: ResponsesUsage | null | undefined): MappedTransportUsage {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    priced: { inputTokens: Math.max(input - cached, 0), cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output },
    promptTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
    upstreamCost: numericCost(usage?.cost),
  };
}

/** First numeric cost among event-carried values (inline response cost, final `ping`). */
export function firstNumericCost(...values: Array<string | number | undefined>): number | null {
  for (const value of values) {
    const n = numericCost(value);
    if (n !== null) return n;
  }
  return null;
}
