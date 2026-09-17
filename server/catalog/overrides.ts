/**
 * Verified facts that no machine-readable source publishes (or publishes
 * late). Each entry names its source and verification date; remove an entry
 * once the upstream source carries the same value (the adapters log when it
 * does).
 */
import type { PeakSchedule, PriceRates } from '../../shared/models/pricing.js';

export interface VerifiedOverride<T> {
  value: T;
  source: string;
  verifiedAt: string;
}

/**
 * DeepSeek tariff: peak rates are exactly 2× off-peak; peak = Mon–Fri
 * 01:00–04:00 and 06:00–10:00 UTC. Applies to DeepSeek-hosted models on the
 * direct API and on OpenCode Go (docs "Usage limits" note).
 */
export const DEEPSEEK_PEAK_SCHEDULE: VerifiedOverride<PeakSchedule> = {
  value: {
    multiplier: 2,
    windows: [
      { days: [1, 2, 3, 4, 5], startHour: 1, endHour: 4 },
      { days: [1, 2, 3, 4, 5], startHour: 6, endHour: 10 },
    ],
  },
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  verifiedAt: '2026-09-16',
};

/** DeepSeek direct off-peak rates ($/1M) where models.dev lags the official page. */
export const DEEPSEEK_DIRECT_RATES: VerifiedOverride<Readonly<Record<string, PriceRates>>> = {
  value: {
    'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.022 },
  },
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  verifiedAt: '2026-09-16',
};

/**
 * Distinct DeepSeek thinking levels when a model has no per-model metadata.
 * Official mapping: minimal/low → low; medium/high/xhigh → high; max → max.
 * The API accepts `none|minimal|low|medium|high|xhigh|max` (400 body lists
 * them); `none` measured `reasoning_tokens: 0` on 2026-09-16.
 */
export const DEEPSEEK_DISTINCT_LEVELS: VerifiedOverride<readonly string[]> = {
  value: ['low', 'high', 'max'],
  source: 'https://api-docs.deepseek.com/guides/thinking_mode',
  verifiedAt: '2026-09-16',
};

/** True for DeepSeek-built models (models.dev `family` or id). */
export function isDeepSeekFamily(family: string | undefined, upstreamId: string): boolean {
  return (family ?? '').startsWith('deepseek') || upstreamId.startsWith('deepseek-');
}
