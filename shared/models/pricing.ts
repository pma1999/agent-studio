/**
 * Model pricing spec + the single cost engine used for every provider whose
 * responses carry no upstream `cost`.
 *
 * Rates are USD per 1M tokens. A spec may carry context tiers (a whole
 * absolute rate row applies above a context threshold; the threshold itself
 * belongs to the lower band) and a peak schedule (every rate multiplied
 * inside the listed UTC windows). Zero dependencies.
 */

export interface PriceRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PriceTier {
  /** The tier applies when the request context is strictly above this many tokens. */
  aboveContextTokens: number;
  rates: PriceRates;
}

export interface PeakWindow {
  /** UTC weekdays, 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Inclusive start hour (UTC). */
  startHour: number;
  /** Exclusive end hour (UTC). */
  endHour: number;
}

export interface PeakSchedule {
  multiplier: number;
  windows: PeakWindow[];
}

export type PricingSource = 'provider-api' | 'models.dev' | 'override' | 'subscription' | 'local';

export interface PricingSpec {
  rates: PriceRates;
  /** Sorted ascending by `aboveContextTokens`. */
  tiers?: PriceTier[];
  peak?: PeakSchedule;
  source: PricingSource;
}

/** Token usage split the engine prices. `inputTokens` excludes cached reads and cache writes. */
export interface PricedUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface CostContext {
  /** Real request context (input incl. cache + output) used to pick a tier. */
  contextTokens?: number;
  /** When the request ran; defaults to now. */
  at?: Date;
}

/** True when `at` falls inside any peak window. */
export function isPeakTime(peak: PeakSchedule | undefined, at: Date): boolean {
  if (!peak) return false;
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return peak.windows.some((w) => w.days.includes(day) && hour >= w.startHour && hour < w.endHour);
}

/** Rates that apply to a request (tier + peak resolved). */
export function effectiveRates(spec: PricingSpec, ctx: CostContext = {}): PriceRates {
  let rates = spec.rates;
  if (spec.tiers && ctx.contextTokens !== undefined) {
    for (const tier of spec.tiers) {
      if (ctx.contextTokens > tier.aboveContextTokens) rates = tier.rates;
    }
  }
  if (isPeakTime(spec.peak, ctx.at ?? new Date())) {
    const m = spec.peak!.multiplier;
    rates = {
      input: rates.input * m,
      output: rates.output * m,
      ...(rates.cacheRead !== undefined ? { cacheRead: rates.cacheRead * m } : {}),
      ...(rates.cacheWrite !== undefined ? { cacheWrite: rates.cacheWrite * m } : {}),
    };
  }
  return rates;
}

/** Cost in USD. Cache reads without a published rate bill as input; writes likewise. */
export function computeCost(spec: PricingSpec | null | undefined, usage: PricedUsage | null | undefined, ctx: CostContext = {}): number {
  if (!spec || !usage) return 0;
  const r = effectiveRates(spec, ctx);
  return (
    usage.inputTokens * r.input
    + usage.cacheReadTokens * (r.cacheRead ?? r.input)
    + usage.cacheWriteTokens * (r.cacheWrite ?? r.input)
    + usage.outputTokens * r.output
  ) / 1_000_000;
}

/**
 * Normalizes an OpenAI-compatible chat usage object (DeepSeek, OpenRouter-shape,
 * Abliteration, Arnict, OpenCode Go chat) into the priced split.
 * Handles `prompt_cache_hit/miss_tokens`, `prompt_tokens_details.cached_tokens`
 * and `prompt_cache_write_tokens`.
 */
export function pricedUsageFromChat(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_cache_write_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
} | null | undefined): PricedUsage | null {
  if (!usage) return null;
  const read = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const write = Math.max(usage.prompt_cache_write_tokens ?? 0, 0);
  const input = usage.prompt_cache_miss_tokens ?? Math.max((usage.prompt_tokens ?? 0) - read - write, 0);
  return {
    inputTokens: input,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    outputTokens: usage.completion_tokens ?? 0,
  };
}

/** Cached-read tokens reported by an OpenAI-compatible chat usage object. */
export function cachedTokensFromChat(usage: {
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
} | null | undefined): number {
  if (!usage) return 0;
  return usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
}

/** Converts a per-token USD decimal string (OpenRouter, Abliteration, Arnict) into $/1M. */
export function perMillionFromPerToken(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  // Round away float noise from the ×1e6 (e.g. 0.000000125 → 0.125).
  return Math.round(n * 1_000_000 * 1e9) / 1e9;
}

/** True when every rate is zero. */
export function isFreePricing(spec: PricingSpec | null | undefined): boolean {
  if (!spec) return false;
  const { input, output, cacheRead, cacheWrite } = spec.rates;
  return input === 0 && output === 0 && (cacheRead ?? 0) === 0 && (cacheWrite ?? 0) === 0;
}
