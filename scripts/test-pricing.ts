/**
 * Shared cost engine: rates, context tiers, peak schedule, cache splits and
 * usage normalization. Offline, db-free.
 */
import assert from 'node:assert/strict';
import {
  computeCost,
  effectiveRates,
  isFreePricing,
  isPeakTime,
  perMillionFromPerToken,
  pricedUsageFromChat,
  type PricingSpec,
} from '../shared/models/pricing.js';
import { DEEPSEEK_PEAK_SCHEDULE } from '../server/catalog/overrides.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);

const tiered: PricingSpec = {
  rates: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
  tiers: [{ aboveContextTokens: 256000, rates: { input: 1.2, output: 4.8, cacheRead: 0.12, cacheWrite: 1.5 } }],
  source: 'models.dev',
};

ok('per-token decimals convert to $/1M without float noise', () => {
  assert.equal(perMillionFromPerToken('0.000000125'), 0.125);
  assert.equal(perMillionFromPerToken('0.0000005'), 0.5);
  assert.equal(perMillionFromPerToken('-1'), null, 'router placeholder');
  assert.equal(perMillionFromPerToken(''), null);
  assert.equal(perMillionFromPerToken(undefined), null);
});

ok('chat usage split: hit/miss/write never double counted', () => {
  assert.deepEqual(pricedUsageFromChat({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } }), {
    inputTokens: 600, cacheReadTokens: 400, cacheWriteTokens: 0, outputTokens: 50,
  });
  assert.deepEqual(pricedUsageFromChat({ prompt_tokens: 1000, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 900, completion_tokens: 1 }), {
    inputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 1,
  });
  assert.deepEqual(pricedUsageFromChat({ prompt_tokens: 1000, prompt_cache_hit_tokens: 100, prompt_cache_write_tokens: 300, completion_tokens: 0 }), {
    inputTokens: 600, cacheReadTokens: 100, cacheWriteTokens: 300, outputTokens: 0,
  });
  assert.equal(pricedUsageFromChat(null), null);
});

ok('cost uses base rates at or below the tier threshold and the tier row above it', () => {
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 };
  close(computeCost(tiered, usage, { contextTokens: 256000 }), 2.0);
  close(computeCost(tiered, usage, { contextTokens: 256001 }), 6.0);
  close(computeCost(tiered, usage), 2.0);
});

ok('cache reads and writes bill at their rates, falling back to input', () => {
  const usage = { inputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 0 };
  close(computeCost(tiered, usage), 0.54);
  close(computeCost({ rates: { input: 2, output: 3 }, source: 'provider-api' }, usage), 4);
});

ok('DeepSeek peak: ×2 Mon–Fri 01–04 and 06–10 UTC, base otherwise', () => {
  const peak = DEEPSEEK_PEAK_SCHEDULE.value;
  assert.equal(isPeakTime(peak, new Date('2026-09-16T02:30:00Z')), true, 'Wednesday 02:30');
  assert.equal(isPeakTime(peak, new Date('2026-09-16T04:00:00Z')), false, 'end hour exclusive');
  assert.equal(isPeakTime(peak, new Date('2026-09-16T09:59:00Z')), true);
  assert.equal(isPeakTime(peak, new Date('2026-09-19T02:30:00Z')), false, 'Saturday');
  const spec: PricingSpec = { rates: { input: 0.66, output: 1.98, cacheRead: 0.022 }, peak, source: 'override' };
  assert.deepEqual(effectiveRates(spec, { at: new Date('2026-09-16T07:00:00Z') }), { input: 1.32, output: 3.96, cacheRead: 0.044 });
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  close(computeCost(spec, usage, { at: new Date('2026-09-19T07:00:00Z') }), 0.66);
});

ok('missing spec or usage costs nothing; free detection', () => {
  assert.equal(computeCost(null, { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }), 0);
  assert.equal(computeCost(tiered, null), 0);
  assert.equal(isFreePricing({ rates: { input: 0, output: 0 }, source: 'provider-api' }), true);
  assert.equal(isFreePricing(tiered), false);
});

console.log(`\n${checks} checks passed`);
