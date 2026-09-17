/**
 * Model catalog adapters and cache with injected upstreams (real payloads
 * captured 2026-09-16): caching, stale-on-error, persisted snapshots, legacy
 * resolution, per-user isolation, key rotation and revoked keys. Offline,
 * db-free (adapters are built directly, not through the production registry).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CachedResource, createMemorySnapshotStore } from '../server/catalog/cache.js';
import { createOpenRouterAdapter } from '../server/catalog/adapters/openrouter.js';
import { createAbliterationAdapter, createArnictAdapter, createDeepseekAdapter } from '../server/catalog/adapters/direct.js';
import { createOpencodeGoAdapter } from '../server/catalog/adapters/opencodeGo.js';
import { createCodexAdapter } from '../server/catalog/adapters/codex.js';
import { createModelCatalogRegistry, type CatalogAdapters } from '../server/catalog/registry.js';
import { parseOpencodeGoDocs } from '../server/catalog/normalize/opencodeGo.js';
import { openRouterCatalogModel, type OpenRouterModelEntry } from '../server/catalog/normalize/openrouter.js';
import { computeCost } from '../shared/models/pricing.js';
import type { ModelsDevSource, OpencodeGoDocsSource } from '../server/catalog/sources.js';
import type { ModelsDevProvider } from '../server/catalog/normalize/modelsDev.js';
import type { ProviderCatalogAdapter } from '../server/catalog/types.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/models');
const raw = (name: string) => readFileSync(resolve(FIXTURES, name), 'utf8');

let checks = 0;
async function ok(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization') });
    return handler(url, init);
  };
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

const modelsDevData = JSON.parse(raw('modelsdev-api.json')) as Record<string, ModelsDevProvider>;
const modelsDev: ModelsDevSource = { provider: async (key) => modelsDevData[key] ?? null };
const docs: OpencodeGoDocsSource = { docs: async () => parseOpencodeGoDocs(raw('opencode-go-docs.md')) };
const ctx = (userId: string) => ({ userId });

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
await ok('cache: fresh hits skip the fetch; expiry refetches; one flight per scope', async () => {
  let now = 0;
  let fetches = 0;
  const cache = new CachedResource<number>({ ttlMs: 100, now: () => now });
  const fetcher = async () => ++fetches;
  const [a, b] = await Promise.all([cache.get('s', 'v', fetcher), cache.get('s', 'v', fetcher)]);
  assert.equal(fetches, 1);
  assert.equal(a.value, 1);
  assert.equal(b.value, 1);
  now = 50;
  assert.equal((await cache.get('s', 'v', fetcher)).value, 1);
  now = 150;
  assert.equal((await cache.get('s', 'v', fetcher)).value, 2);
});

await ok('cache: failed refresh serves last good as stale; cold failure throws', async () => {
  let now = 0;
  const cache = new CachedResource<string>({ ttlMs: 10, now: () => now });
  await cache.get('s', 'v', async () => 'good');
  now = 100;
  const hit = await cache.get('s', 'v', async () => { throw new Error('down'); });
  assert.deepEqual([hit.value, hit.stale], ['good', true]);
  await assert.rejects(cache.get('other', 'v', async () => { throw new Error('down'); }));
});

await ok('cache: snapshot survives a restart; variant mismatch never reads it', async () => {
  const store = createMemorySnapshotStore();
  await new CachedResource<string>({ ttlMs: 10, store }).get('s', 'key-a', async () => 'list-a');
  const restarted = new CachedResource<string>({ ttlMs: 10, store });
  const hit = await restarted.get('s', 'key-a', async () => { throw new Error('upstream down at boot'); });
  assert.deepEqual([hit.value, hit.stale], ['list-a', true]);
  await assert.rejects(restarted.get('s', 'key-b', async () => { throw new Error('down'); }), 'another key never sees key-a data');
});

await ok('cache: fatal errors forget the scope instead of serving stale data', async () => {
  const store = createMemorySnapshotStore();
  const cache = new CachedResource<string>({ ttlMs: 0, store, isFatal: (e) => (e as Error).message === 'revoked' });
  await cache.get('s', 'v', async () => 'list');
  await assert.rejects(cache.get('s', 'v', async () => { throw new Error('revoked'); }));
  assert.equal(store.records.has('s'), false);
  assert.equal(cache.peek('s', 'v'), null);
});

await ok('cache: getFast returns known data immediately and refreshes in the background', async () => {
  let now = 0;
  const cache = new CachedResource<string>({ ttlMs: 10, now: () => now });
  await cache.get('s', 'v', async () => 'old');
  now = 100;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const hit = await cache.getFast('s', 'v', async () => { await gate; return 'new'; });
  assert.equal(hit.value, 'old');
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await cache.getFast('s', 'v', async () => 'unused')).value, 'new');
});

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------
await ok('OpenRouter: live list normalized; unknown ids resolve with unknown capability', async () => {
  const upstream = fakeFetch(() => text(raw('openrouter-models.json')));
  const adapter = createOpenRouterAdapter({ fetchImpl: upstream.impl });
  const catalog = await adapter.list(ctx('u1'));
  assert.equal(catalog.state, 'ok');
  assert.ok(catalog.models.length > 50);
  const fable = await adapter.resolve(ctx('u1'), 'anthropic/claude-fable-5.1');
  assert.equal(fable.reasoning.canDisable, false);
  assert.equal(fable.pricing?.rates.input, 10);
  const gone = await adapter.resolve(ctx('u2'), 'vendor/retired-model');
  assert.deepEqual([gone.reasoning.status, gone.lifecycle, gone.transport], ['unknown', 'legacy', 'chat']);
  assert.equal(upstream.calls.length, 1, 'public data shared across users');
});

await ok('OpenRouter: entry mapping — names, windows, modalities and per-token prices', async () => {
  const entries = JSON.parse(raw('openrouter-models.json')).data as OpenRouterModelEntry[];
  const gemini = openRouterCatalogModel(entries.find((e) => e.id === 'google/gemini-3.8-flash')!);
  assert.equal(gemini.name, 'Google: Gemini 3.8 Flash');
  assert.deepEqual([gemini.contextLength, gemini.maxOutputTokens], [1048576, 65536]);
  // `file`/`audio`/`video` survive; anything the app cannot send is dropped.
  assert.deepEqual(gemini.inputModalities, ['text', 'image', 'video', 'file', 'audio']);
  // Per-token decimals become $/1M without float noise.
  assert.deepEqual(gemini.pricing?.rates, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.041666667 });
  assert.equal(gemini.pricing?.source, 'provider-api');
  assert.deepEqual([gemini.transport, gemini.historyReasoningField, gemini.lifecycle], ['chat', 'reasoning', 'active']);

  // `min_prompt_tokens` override rows are context tiers (threshold is exclusive).
  const grok = openRouterCatalogModel(entries.find((e) => e.id === 'x-ai/grok-4.6')!);
  assert.deepEqual(grok.pricing?.tiers, [
    { aboveContextTokens: 199999, rates: { input: 4, output: 12, cacheRead: 1 } },
  ]);
  assert.equal(computeCost(grok.pricing, { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, { contextTokens: 300_000 }), 4);

  // Time-window overrides are not tiers: the response carries the real cost.
  const timeWindowed = openRouterCatalogModel(entries.find((e) => e.id === '~deepseek/deepseek-flash-latest')!);
  assert.equal(timeWindowed.pricing?.tiers, undefined);
  assert.equal(timeWindowed.pricing?.rates.input, 0.15);
});

// ---------------------------------------------------------------------------
// DeepSeek (key-gated)
// ---------------------------------------------------------------------------
function deepseekUpstream(idsByKey: Record<string, string[]>) {
  return fakeFetch((_url, init) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const ids = idsByKey[auth.replace('Bearer ', '')];
    return ids ? json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }) : text('Authentication Fails (governor)', 401);
  });
}

await ok('DeepSeek: without a key lists public metadata as needs-connection', async () => {
  const upstream = deepseekUpstream({});
  const adapter = createDeepseekAdapter({ fetchImpl: upstream.impl, modelsDev, getApiKey: () => null });
  const catalog = await adapter.list(ctx('u1'));
  assert.equal(catalog.state, 'needs-connection');
  assert.ok(catalog.models.some((m) => m.id === 'deepseek:deepseek-v4-pro'));
  assert.equal(upstream.calls.length, 0, 'never calls upstream without a key');
});

await ok('DeepSeek: live ids only; unlisted id with metadata resolves as legacy', async () => {
  const upstream = deepseekUpstream({ 'key-1': ['deepseek-flash', 'deepseek-v4-pro'] });
  const adapter = createDeepseekAdapter({ fetchImpl: upstream.impl, modelsDev, getApiKey: () => 'key-1' });
  const catalog = await adapter.list(ctx('u1'));
  assert.deepEqual(catalog.models.map((m) => m.id), ['deepseek:deepseek-flash', 'deepseek:deepseek-v4-pro']);
  const legacy = await adapter.resolve(ctx('u1'), 'deepseek-v4-flash');
  assert.deepEqual([legacy.lifecycle, legacy.reasoning.status], ['legacy', 'known']);
  const unknownId = await adapter.resolve(ctx('u1'), 'deepseek-v9');
  assert.deepEqual([unknownId.lifecycle, unknownId.historyReasoningField], ['legacy', 'reasoning_content']);
});

await ok('isolation: users never see each other’s keyed lists; a rotated key refetches', async () => {
  const keys: Record<string, string> = { alice: 'key-alice', bob: 'key-bob' };
  const upstream = deepseekUpstream({ 'key-alice': ['deepseek-flash'], 'key-bob': ['deepseek-v4-pro'], 'key-alice-2': ['deepseek-v4-pro'] });
  const store = createMemorySnapshotStore();
  const adapter = createDeepseekAdapter({ fetchImpl: upstream.impl, modelsDev, store, getApiKey: (u) => keys[u] ?? null });
  assert.deepEqual((await adapter.list(ctx('alice'))).models.map((m) => m.upstreamId), ['deepseek-flash']);
  assert.deepEqual((await adapter.list(ctx('bob'))).models.map((m) => m.upstreamId), ['deepseek-v4-pro']);
  assert.deepEqual((await adapter.list(ctx('alice'))).models.map((m) => m.upstreamId), ['deepseek-flash'], 'cached, still alice');
  assert.equal(upstream.calls.length, 2);
  for (const record of store.records.values()) {
    assert.ok(!JSON.stringify(record).includes('key-alice') && !JSON.stringify(record).includes('key-bob'), 'snapshots never hold keys');
  }
  keys.alice = 'key-alice-2';
  assert.deepEqual((await adapter.list(ctx('alice'))).models.map((m) => m.upstreamId), ['deepseek-v4-pro']);
  assert.equal(upstream.calls.length, 3, 'rotated key is a cache miss');
  assert.equal(upstream.calls[2].auth, 'Bearer key-alice-2');
});

await ok('revoked key: needs-connection, the old live list is not served', async () => {
  let valid = true;
  const upstream = fakeFetch(() => (valid ? json({ data: [{ id: 'deepseek-flash' }] }) : text('Authentication Fails', 401)));
  const adapter = createDeepseekAdapter({ fetchImpl: upstream.impl, modelsDev, getApiKey: () => 'k' });
  assert.equal((await adapter.list(ctx('u'))).state, 'ok');
  valid = false;
  const catalog = await adapter.list(ctx('u'), { force: true });
  assert.equal(catalog.state, 'needs-connection');
  assert.match(catalog.message ?? '', /rejected the API key/);
});

// ---------------------------------------------------------------------------
// Abliteration + Arnict (key-gated, real live payloads)
// ---------------------------------------------------------------------------
await ok('Abliteration: live list + models.dev levels', async () => {
  const upstream = fakeFetch(() => text(raw('abliteration-models.json')));
  const adapter = createAbliterationAdapter({ fetchImpl: upstream.impl, modelsDev, getApiKey: () => 'k' });
  const catalog = await adapter.list(ctx('u'));
  assert.deepEqual(catalog.models.map((m) => [m.upstreamId, m.reasoning.canDisable]), [
    ['abliterated-model', true],
    ['abliterated-model-large', true],
    ['abliterated-model-large-v2', false],
  ]);
  assert.equal(upstream.calls[0].url, 'https://api.abliteration.ai/v1/models');
});

await ok('Arnict: live list only with a key; nothing public without one', async () => {
  const upstream = fakeFetch(() => text(raw('arnict-models.json')));
  const withKey = createArnictAdapter({ fetchImpl: upstream.impl, getApiKey: () => 'k' });
  assert.deepEqual((await withKey.list(ctx('u'))).models.map((m) => m.id), [
    'arnict:zai/glm-5.3-flash-uncensored',
    'arnict:qwen/qwen3.8-27b',
    'arnict:zai/glm-5.3-flash-uncensored/flex',
  ]);
  const withoutKey = createArnictAdapter({ fetchImpl: upstream.impl, getApiKey: () => '  ' });
  const catalog = await withoutKey.list(ctx('u'));
  assert.deepEqual([catalog.state, catalog.models.length], ['needs-connection', 0]);
});

// ---------------------------------------------------------------------------
// OpenCode Go
// ---------------------------------------------------------------------------
await ok('OpenCode Go: live ∩ offered (new models appear, unreachable deprecated ones do not)', async () => {
  const upstream = fakeFetch(() => text(raw('opencode-go-models.json')));
  const adapter = createOpencodeGoAdapter({ fetchImpl: upstream.impl, modelsDev, docs, getApiKey: () => 'k' });
  const catalog = await adapter.list(ctx('u'));
  const ids = catalog.models.map((m) => m.upstreamId);
  assert.ok(ids.includes('union-alpha'), 'new model listed without code changes');
  assert.ok(ids.includes('minimax-m2.5'), 'deprecated but still in the docs endpoint table');
  for (const hidden of ['grok-4.5', 'glm-5', 'kimi-k2.5', 'hy3-preview', 'deepseek-flash', 'omen-alpha']) {
    assert.ok(!ids.includes(hidden), hidden);
  }
  assert.equal(catalog.models.find((m) => m.upstreamId === 'minimax-m2.5')?.lifecycle, 'deprecated');
  assert.equal(catalog.state, 'ok');
});

await ok('OpenCode Go: without a key the list stays visible as needs-connection; unknown ids keep a sane wire', async () => {
  const upstream = fakeFetch(() => text(raw('opencode-go-models.json')));
  const adapter = createOpencodeGoAdapter({ fetchImpl: upstream.impl, modelsDev, docs, getApiKey: () => null });
  const catalog = await adapter.list(ctx('u'));
  assert.equal(catalog.state, 'needs-connection');
  assert.ok(catalog.models.length > 20);
  const future = await adapter.resolve(ctx('u'), 'brand-new-model');
  assert.deepEqual([future.transport, future.reasoning.status], ['chat', 'unknown']);
  const retired = await adapter.resolve(ctx('u'), 'grok-4.5');
  assert.deepEqual([retired.lifecycle, retired.transport], ['legacy', 'responses']);
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
class NotConnected extends Error {}
class Forbidden extends Error {}

await ok('Codex: disconnected account is needs-connection and never serves the old list', async () => {
  let connected = true;
  const fixtureModels = JSON.parse(raw('codex-model-list.json')).data;
  const adapter = createCodexAdapter({
    listModels: async () => {
      if (!connected) throw new NotConnected('ChatGPT account not connected. Open Settings → ChatGPT and complete the sign-in.');
      return fixtureModels;
    },
    isForbidden: (e) => e instanceof Forbidden,
    isUnavailable: (e) => e instanceof NotConnected,
    ttlMs: 0,
  });
  assert.equal((await adapter.list(ctx('u'))).models.length, 6);
  connected = false;
  const catalog = await adapter.list(ctx('u'));
  assert.deepEqual([catalog.state, catalog.models.length], ['needs-connection', 0]);
  const forbidden = createCodexAdapter({ listModels: async () => { throw new Forbidden(); }, isForbidden: (e) => e instanceof Forbidden, isUnavailable: () => false });
  assert.equal((await forbidden.list(ctx('u'))).state, 'unavailable');
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
await ok('registry: resolves by id scheme and lists every provider but the removed one', async () => {
  const stub = (provider: ProviderCatalogAdapter['provider']): ProviderCatalogAdapter => ({
    provider,
    list: async () => ({ provider, state: 'ok', models: [], fetchedAt: null, message: null }),
    resolve: async (_c, upstreamId) => ({ ...(await createOpenRouterAdapter({ fetchImpl: async () => json({ data: [] }) }).resolve(ctx('x'), upstreamId)), provider }),
    invalidate: () => {},
  });
  const adapters = Object.fromEntries(
    (['openrouter', 'deepseek', 'codex', 'lmstudio', 'llamacpp', 'abliteration', 'arnict', 'opencode-go'] as const).map((p) => [p, stub(p)]),
  ) as CatalogAdapters;
  const registry = createModelCatalogRegistry(adapters);
  assert.equal((await registry.resolveModel('u', 'opencode-go:kimi-k3')).provider, 'opencode-go');
  assert.equal((await registry.resolveModel('u', 'opencode-go:kimi-k3')).upstreamId, 'kimi-k3');
  assert.equal((await registry.resolveModel('u', 'arnict:zai/glm-5.3')).upstreamId, 'zai/glm-5.3');
  assert.equal((await registry.resolveModel('u', 'anthropic/claude-fable-5.1')).provider, 'openrouter');
  const catalog = await registry.getCatalog('u');
  assert.ok(!catalog.providers.some((p) => p.provider === 'lmstudio'));
  assert.equal(catalog.providers.length, 7);
});

// ---------------------------------------------------------------------------
// Fixtures never carry credentials
// ---------------------------------------------------------------------------
await ok('fixtures contain no API keys', () => {
  const keyShapes = [/\bsk-[A-Za-z0-9]{24,}/, /\bak_[A-Za-z0-9]{24,}/, /\barn_live_[A-Za-z0-9]{16,}/, /Bearer\s+[A-Za-z0-9_-]{20,}/];
  for (const name of readdirSync(FIXTURES)) {
    const content = raw(name);
    for (const shape of keyShapes) assert.ok(!shape.test(content), `${name} matches ${shape}`);
  }
});

console.log(`\n${checks} checks passed`);
