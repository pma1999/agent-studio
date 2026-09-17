/**
 * Pure normalizer for OpenCode Go models: the live keyless `GET /v1/models`
 * id list, the models.dev `opencode-go` entries (metadata, cost tiers,
 * reasoning options, per-model SDK package = wire) and the official docs
 * markdown (`https://opencode.ai/docs/go.md`: endpoint table = what Go offers
 * today, usage-limits table = published rates and monthly spend cap per model).
 *
 * Reasoning wires, verified with a key (2026-09-15/16):
 * - chat: top-level `reasoning_effort`; `none` = off; no toggle or budget field
 *   (`thinking` is a no-op there).
 * - messages (Anthropic shape): `thinking.type` disabled|enabled with
 *   `budget_tokens`; graded models take `output_config.effort` instead and
 *   reject the classic budget form.
 * - responses: `reasoning.effort` (`none` = off where listed).
 */
import type { ReasoningCapability } from '../../../shared/models/reasoning.js';
import type { PriceRates, PricingSpec } from '../../../shared/models/pricing.js';
import type { CatalogModel, ModelTransport } from '../../../shared/models/catalog.js';
import { namespacedModelId } from '../../../shared/models/providers.js';
import { DEEPSEEK_PEAK_SCHEDULE, isDeepSeekFamily } from '../overrides.js';
import {
  modelsDevCapability,
  modelsDevHistoryField,
  modelsDevModalities,
  modelsDevPricing,
  modelsDevReasoningControls,
  modelsDevTransport,
  positiveInt,
  transportForSdkPackage,
  type ModelsDevModel,
  type ModelsDevProvider,
} from './modelsDev.js';

export interface OpencodeGoDocs {
  /** Model id → transport from the endpoint table (the models Go offers). */
  endpoints: Map<string, ModelTransport>;
  /** Model id → monthly spend cap in USD (`null` = unlimited). */
  monthlyLimits: Map<string, number | null>;
  /** Model id → base rates Go publishes itself ($/1M), field by field. */
  rates: Map<string, PriceRates>;
}

/** Splits a markdown table row into trimmed cells. */
function cells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Rows of the first markdown table whose header contains every column. */
function tableRows(markdown: string, columns: string[]): Array<Record<string, string>> {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const header = cells(lines[i]);
    if (header.length === 0 || !columns.every((c) => header.includes(c))) continue;
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const rows: Array<Record<string, string>> = [];
    for (let j = i + 2; j < lines.length; j++) {
      const row = cells(lines[j]);
      if (row.length === 0) break;
      rows.push(Object.fromEntries(header.map((h, k) => [h, row[k] ?? ''])));
    }
    return rows;
  }
  return [];
}

/** Display-name key tolerant of the docs' spacing/punctuation differences between tables. */
function nameKey(name: string): string {
  return name.replace(/\(.*?\)/g, '').replace(/<[^>]*>/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function transportFromEndpoint(endpoint: string): ModelTransport | null {
  if (/\/chat\/completions\b/.test(endpoint)) return 'chat';
  if (/\/messages\b/.test(endpoint)) return 'messages';
  if (/\/responses\b/.test(endpoint)) return 'responses';
  return null;
}

function monthlyLimit(cell: string): number | null | undefined {
  const withoutStrike = cell.replace(/~~.*?~~/g, '');
  if (/unlimited/i.test(withoutStrike)) return null;
  const amount = withoutStrike.match(/\$\s*([\d.]+)/);
  return amount ? Number(amount[1]) : undefined;
}

/** One price cell: an amount, 0 for "Free", `undefined` for "-" (not published). */
function rateCell(cell: string | undefined): number | undefined {
  if (cell === undefined) return undefined;
  const trimmed = cell.trim();
  if (/^free$/i.test(trimmed)) return 0;
  const amount = trimmed.match(/\$\s*([\d.]+)/);
  return amount ? Number(amount[1]) : undefined;
}

/**
 * Base band of a multi-row model: the price table splits tiered models into
 * "≤ N tokens"/"> N tokens" and DeepSeek into "(Off-Peak)"/"(Peak)". The base
 * row is the one that is neither — tiers come from models.dev and the peak
 * multiplier from the verified schedule, so taking a derived row would double
 * count. Read from the raw name: `nameKey` strips the qualifier.
 */
function isBaseRateRow(name: string): boolean {
  return !/\(\s*peak\s*\)/i.test(name) && !name.includes('>');
}

function ratesFromRow(row: Record<string, string>): PriceRates | null {
  const input = rateCell(row.Input);
  const output = rateCell(row.Output);
  if (input === undefined || output === undefined) return null;
  const cacheRead = rateCell(row['Cached Read']);
  const cacheWrite = rateCell(row['Cached Write']);
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** Parses the Go docs markdown. Tolerant: missing tables yield empty maps. */
export function parseOpencodeGoDocs(markdown: string): OpencodeGoDocs {
  const endpoints = new Map<string, ModelTransport>();
  const idByName = new Map<string, string>();
  for (const row of tableRows(markdown, ['Model', 'Model ID', 'Endpoint'])) {
    const id = row['Model ID'];
    const transport = transportFromEndpoint(row.Endpoint);
    if (!id || !transport) continue;
    endpoints.set(id, transport);
    idByName.set(nameKey(row.Model), id);
  }
  const monthlyLimits = new Map<string, number | null>();
  const rates = new Map<string, PriceRates>();
  for (const row of tableRows(markdown, ['Model', 'Monthly limit'])) {
    const id = idByName.get(nameKey(row.Model));
    if (!id) continue;
    const limit = monthlyLimit(row['Monthly limit']);
    if (limit !== undefined && !monthlyLimits.has(id)) monthlyLimits.set(id, limit);
    if (!rates.has(id) && isBaseRateRow(row.Model)) {
      const published = ratesFromRow(row);
      if (published) rates.set(id, published);
    }
  }
  return { endpoints, monthlyLimits, rates };
}

/** Wire support per Go transport (see module header). */
export function opencodeGoWire(transport: ModelTransport, metadata: ModelsDevModel | undefined) {
  switch (transport) {
    case 'messages': {
      const graded = (modelsDevReasoningControls(metadata ?? { id: '' })?.effortValues ?? []).length > 0;
      return { toggle: true, noneEffort: false, effort: true, budget: !graded };
    }
    case 'responses':
      return { toggle: false, noneEffort: true, effort: true, budget: false };
    default:
      return { toggle: false, noneEffort: true, effort: true, budget: false };
  }
}

/**
 * Wire precedence: an explicit per-model SDK package in models.dev, then the
 * official docs endpoint table, then the provider's default package. (Qwen
 * rows carry no per-model package; the docs serve them over `/messages`,
 * where their thinking wire is verified.)
 */
export function opencodeGoTransport(
  upstreamId: string,
  metadata: ModelsDevModel | undefined,
  provider: Pick<ModelsDevProvider, 'npm'> | undefined,
  docs: OpencodeGoDocs | null,
): ModelTransport {
  const explicit = metadata?.provider?.npm ? modelsDevTransport(metadata, provider ?? {}) : null;
  return explicit ?? docs?.endpoints.get(upstreamId) ?? transportForSdkPackage(provider?.npm) ?? 'chat';
}

export function opencodeGoReasoning(transport: ModelTransport, metadata: ModelsDevModel | undefined): ReasoningCapability {
  return modelsDevCapability(metadata, opencodeGoWire(transport, metadata));
}

/**
 * Rates come from Go's own price table where it publishes them (field by
 * field: models.dev misses e.g. the MiniMax cache-write rate and lags its
 * cached-read one); structure — context tiers — stays with models.dev, which
 * lists tiers the docs table does not. Peak is the verified DeepSeek schedule.
 */
export function opencodeGoPricing(
  upstreamId: string,
  metadata: ModelsDevModel | undefined,
  docs: OpencodeGoDocs | null,
): PricingSpec | null {
  const aggregated = modelsDevPricing(metadata);
  const published = docs?.rates.get(upstreamId) ?? null;
  if (!aggregated && !published) return null;
  const pricing: PricingSpec = aggregated
    ? { ...aggregated, rates: published ? { ...aggregated.rates, ...published } : aggregated.rates }
    : { rates: published!, source: 'override' };
  return isDeepSeekFamily(metadata?.family, upstreamId) ? { ...pricing, peak: DEEPSEEK_PEAK_SCHEDULE.value } : pricing;
}

export function opencodeGoCatalogModel(
  upstreamId: string,
  metadata: ModelsDevModel | undefined,
  provider: Pick<ModelsDevProvider, 'npm'> | undefined,
  docs: OpencodeGoDocs | null,
  lifecycle: CatalogModel['lifecycle'],
): CatalogModel {
  const transport = opencodeGoTransport(upstreamId, metadata, provider, docs);
  return {
    id: namespacedModelId('opencode-go', upstreamId),
    provider: 'opencode-go',
    upstreamId,
    name: metadata?.name || upstreamId,
    description: metadata?.description || '',
    contextLength: positiveInt(metadata?.limit?.context),
    maxOutputTokens: positiveInt(metadata?.limit?.output),
    inputModalities: modelsDevModalities(metadata),
    pricing: opencodeGoPricing(upstreamId, metadata, docs),
    transport,
    historyReasoningField: modelsDevHistoryField(metadata, 'reasoning'),
    reasoning: opencodeGoReasoning(transport, metadata),
    lifecycle,
    monthlyLimitUsd: docs?.monthlyLimits.get(upstreamId) ?? null,
  };
}

/**
 * Which live ids Go offers: models with metadata that are not deprecated, or
 * that the docs endpoint table still lists (deprecated but reachable).
 */
export function isOfferedByOpencodeGo(metadata: ModelsDevModel | undefined, upstreamId: string, docs: OpencodeGoDocs | null): boolean {
  if (!metadata) return false;
  if (metadata.status !== 'deprecated') return true;
  return docs?.endpoints.has(upstreamId) ?? false;
}
