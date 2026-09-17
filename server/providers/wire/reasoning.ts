/**
 * Reasoning plan → request fields, per provider and transport.
 *
 * The plan (`shared/models/reasoning.ts#planReasoning`) already fits the
 * model's capability: levels are clamped, off is only planned where the host
 * can switch off, budgets are in range. This module only spells that plan on
 * each wire. Chat, council, titles and compaction all go through here.
 */
import type { CatalogModel } from '../../../shared/models/catalog.js';
import type { ReasoningPlan } from '../../../shared/models/reasoning.js';

/** Default classic-thinking budget when the caller set none (Anthropic `budget_tokens` floor is 1024). */
const MESSAGES_DEFAULT_BUDGET = 8192;
const MESSAGES_MIN_BUDGET = 1024;
const MESSAGES_FALLBACK_MAX_BUDGET = 32768;

export interface ChatReasoningOptions {
  /** A `response_format` JSON schema is active (Arnict: the trace would eat `max_tokens`). */
  structuredOutput?: boolean;
}

/**
 * Top-level fields for an OpenAI-compatible `/chat/completions` body.
 * (Anthropic-shape and Responses bodies use `messagesThinkingFields` /
 * `responsesReasoning`; Codex and llama.cpp have their own helpers.)
 */
export function chatReasoningFields(model: CatalogModel, plan: ReasoningPlan, opts: ChatReasoningOptions = {}): Record<string, unknown> {
  const cap = model.reasoning;
  const known = cap.status === 'known';
  switch (model.provider) {
    case 'openrouter': {
      if (known && !cap.supported) return {};
      if (!plan.enabled) {
        // Explicit off: many models reason by default (`default_enabled`).
        // Routers/unknown models keep the host default rather than guessing.
        return known && cap.canDisable ? { reasoning: { enabled: false } } : {};
      }
      const reasoning: Record<string, unknown> = {};
      if (plan.level) reasoning.effort = plan.level;
      if (plan.budget) reasoning.max_tokens = plan.budget;
      if (Object.keys(reasoning).length === 0) reasoning.enabled = true;
      return { reasoning };
    }
    case 'deepseek': {
      // Thinking is on by default; `thinking.type` is the switch.
      const out: Record<string, unknown> = { thinking: { type: plan.enabled ? 'enabled' : 'disabled' } };
      if (plan.enabled && plan.level) out.reasoning_effort = plan.level;
      return out;
    }
    case 'abliteration': {
      if (known && !cap.supported) return {};
      if (!plan.enabled) return known && cap.canDisable ? { reasoning_effort: 'none' } : {};
      return plan.level ? { reasoning_effort: plan.level } : {};
    }
    case 'arnict': {
      if (known && !cap.supported) return {};
      if (opts.structuredOutput || !plan.enabled) return { reasoning: { enabled: false } };
      return { reasoning: plan.level ? { enabled: true, effort: plan.level } : { enabled: true } };
    }
    case 'opencode-go': {
      // Chat wire: top-level `reasoning_effort`; `thinking` is a no-op there.
      if (known && !cap.supported) return {};
      if (!plan.enabled) return known && cap.canDisable ? { reasoning_effort: 'none' } : {};
      return plan.level ? { reasoning_effort: plan.level } : {};
    }
    case 'llamacpp':
      return llamacppReasoningFields(model, plan);
    default:
      return {};
  }
}

/**
 * llama-server: the chat template's `enable_thinking` switch, plus
 * `reasoning_effort` (passed to templates that read it) when a level is set.
 */
export function llamacppReasoningFields(model: CatalogModel, plan: ReasoningPlan): Record<string, unknown> {
  const out: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: plan.enabled } };
  if (plan.enabled && plan.level && (model.reasoning.status === 'unknown' || model.reasoning.levels.length > 0)) {
    out.reasoning_effort = plan.level;
  }
  return out;
}

/**
 * Anthropic-shape (`POST /messages`) thinking fields.
 * - No control (always on) or nothing known → nothing sent.
 * - Off → `thinking: {type: 'disabled'}`.
 * - Graded models → `output_config.effort` (they reject the classic budget form).
 * - On/off models → classic `thinking: {type: 'enabled', budget_tokens}`.
 */
export function messagesThinkingFields(model: CatalogModel, plan: ReasoningPlan): Record<string, unknown> {
  const cap = model.reasoning;
  if (cap.status === 'unknown' || !cap.supported) return {};
  if (cap.levels.length === 0 && !cap.canDisable) return {};
  if (!plan.enabled) return cap.canDisable ? { thinking: { type: 'disabled' } } : {};
  if (cap.levels.length > 0) return plan.level ? { output_config: { effort: plan.level } } : {};
  const min = Math.max(cap.budget?.min ?? MESSAGES_MIN_BUDGET, MESSAGES_MIN_BUDGET);
  const max = cap.budget?.max ?? MESSAGES_FALLBACK_MAX_BUDGET;
  const budget = Math.min(Math.max(plan.budget ?? MESSAGES_DEFAULT_BUDGET, min), max);
  return { thinking: { type: 'enabled', budget_tokens: budget } };
}

/**
 * Responses (`POST /responses`) `reasoning.effort`. Always sent: omitting it
 * lets the host reason at its (costly) default.
 */
export function responsesReasoning(model: CatalogModel, plan: ReasoningPlan): { effort: string } {
  const cap = model.reasoning;
  if (!plan.enabled) {
    if (cap.status === 'known' && cap.canDisable) return { effort: 'none' };
    return { effort: cap.levels[0] ?? 'low' };
  }
  return { effort: plan.level ?? cap.levels[0] ?? 'low' };
}

/**
 * Codex app-server turn `effort`: the planned level, `none` when the model
 * lists it and thinking is off, else null (the model's default).
 */
export function codexTurnEffort(model: CatalogModel, plan: ReasoningPlan): string | null {
  if (!plan.enabled) return model.reasoning.status === 'known' && model.reasoning.canDisable ? 'none' : null;
  return plan.level;
}

/**
 * OpenRouter may still reject `max` (router targets, metadata drift between
 * catalog refreshes): callers retry once with `xhigh` on that specific error.
 */
export function mayRetryMaxEffort(model: CatalogModel, plan: ReasoningPlan): boolean {
  return model.provider === 'openrouter' && plan.enabled && plan.level === 'max';
}
