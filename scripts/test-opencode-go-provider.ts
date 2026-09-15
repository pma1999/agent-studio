/**
 * Offline acceptance harness for the OpenCode Go provider (7th provider).
 *
 * Pure registry/cost/transport dynamic smoke: imports ONLY the pure
 * `server/providers/index.ts` module (zero db/network imports) and asserts the
 * GC-frozen literals (§§1-7, chat-completions phase-1):
 *
 *   routing/strip/persist, flags (`supportsJsonSchema:false`), endpoint +
 *   label + key + headers (Bearer + User-Agent, never x-api-key), catalog
 *   ids/contexts/prices (docs "Usage limits" price table, fetched
 *   2026-09-15), cost spots (§6, 3-form cache split), transport matrix
 *   (chat/messages/responses/unknown + §7 verbatim messages), per-model
 *   history-replay field (D5, no `buildOpencodeGoReasoning` builder exists),
 *   `ultracode`/foreign-field absence.
 *
 * Usage:
 *   npx tsx scripts/test-opencode-go-provider.ts
 *
 * Reads no source text, performs no network or DB I/O — offline-safe.
 */
import assert from 'node:assert/strict';
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_CATALOG,
  OPENCODE_GO_CHAT_COMPLETIONS_URL,
  OPENCODE_GO_CHAT_TRANSPORT_MODELS,
  OPENCODE_GO_DOCS_URL,
  OPENCODE_GO_NON_CHAT_TRANSPORT,
  OPENCODE_GO_PREFIX,
  OPENCODE_GO_REASONING_CONTENT_MODELS,
  OPENCODE_GO_USER_AGENT,
  OPENCODE_GO_VALIDATE_MODEL,
  assistantReasoningField,
  computeOpencodeGoCost,
  getProviderConfig,
  isOpencodeGoModel,
  opencodeGoCachedTokens,
  opencodeGoFormatMismatchMessage,
  opencodeGoHistoryReasoningField,
  opencodeGoTransportFor,
  opencodeGoWrongTransportMessage,
  persistedModelId,
  resolveProviderId,
  toUpstreamModelId,
} from '../server/providers/index.js';
import * as providersNs from '../server/providers/index.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// Routing / strip / persist (GC §1 + §6 persistedModelId)
// ---------------------------------------------------------------------------

ok('resolveProviderId routes namespaced Go ids to opencode-go', () => {
  assert.equal(resolveProviderId('opencode-go:kimi-k3'), 'opencode-go');
  assert.equal(resolveProviderId('opencode-go:minimax-m2.7'), 'opencode-go');
  assert.equal(resolveProviderId('opencode-go:grok-4.6'), 'opencode-go');
});

ok('resolveProviderId leaves bare/upstream ids off Go (prefix is load-bearing)', () => {
  // Bare ids are OpenRouter-shaped without the prefix.
  assert.equal(resolveProviderId('kimi-k3'), 'openrouter');
  assert.equal(resolveProviderId('openai/gpt-4o'), 'openrouter');
  assert.equal(resolveProviderId('deepseek:deepseek-chat'), 'deepseek');
  assert.equal(resolveProviderId('codex:gpt-5'), 'codex');
  assert.equal(resolveProviderId('llamacpp:Qwen3'), 'llamacpp');
  assert.equal(resolveProviderId('abliteration:abliterated-model'), 'abliteration');
  assert.equal(resolveProviderId('arnict:zai/glm-5.3-flash-uncensored'), 'arnict');
});

ok('isOpencodeGoModel classifies both ways', () => {
  assert.equal(isOpencodeGoModel('opencode-go:kimi-k3'), true);
  assert.equal(isOpencodeGoModel('opencode-go:grok-4.6'), true);
  assert.equal(isOpencodeGoModel('kimi-k3'), false);
  assert.equal(isOpencodeGoModel('openai/gpt-4o'), false);
  assert.equal(isOpencodeGoModel(null), false);
});

ok('toUpstreamModelId strips the opencode-go prefix', () => {
  assert.equal(toUpstreamModelId('opencode-go:kimi-k3'), 'kimi-k3');
  assert.equal(toUpstreamModelId('opencode-go:minimax-m2.7'), 'minimax-m2.7');
});

ok('persistedModelId keeps the namespaced id for opencode-go', () => {
  assert.equal(
    persistedModelId('opencode-go', 'opencode-go:kimi-k3', 'kimi-k3'),
    'opencode-go:kimi-k3',
  );
  assert.equal(
    persistedModelId('opencode-go', 'opencode-go:grok-4.6', null),
    'opencode-go:grok-4.6',
  );
  // Contrast: openrouter records the echoed upstream variant.
  assert.equal(persistedModelId('openrouter', 'org/model', 'variant'), 'variant');
});

ok('OPENCODE_GO_PREFIX is the frozen namespaced prefix', () => {
  assert.equal(OPENCODE_GO_PREFIX, 'opencode-go:');
});

// ---------------------------------------------------------------------------
// Provider flags + endpoint + headers (GC §1 + §2)
// ---------------------------------------------------------------------------

ok('opencode-go capability flags are F,F,F,F (phase-1 smallest blast radius)', () => {
  const cfg = getProviderConfig('opencode-go');
  assert.equal(cfg.supportsProviderRouting, false);
  assert.equal(cfg.supportsPlugins, false);
  assert.equal(cfg.supportsReasoningParam, false);
  assert.equal(cfg.supportsJsonSchema, false);
});

ok('opencode-go endpoint + label + key setting are frozen', () => {
  const cfg = getProviderConfig('opencode-go');
  assert.equal(cfg.id, 'opencode-go');
  assert.equal(cfg.label, 'OpenCode Go');
  assert.equal(cfg.chatCompletionsUrl, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(cfg.apiKeySetting, 'opencode_go_api_key');
});

ok('opencode-go URL constants are frozen (canonical /zen/go/v1, no trailing slash)', () => {
  assert.equal(OPENCODE_GO_BASE_URL, 'https://opencode.ai/zen/go/v1');
  assert.equal(OPENCODE_GO_CHAT_COMPLETIONS_URL, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(OPENCODE_GO_USER_AGENT, 'agent-studio/1.0');
  assert.equal(OPENCODE_GO_DOCS_URL, 'https://opencode.ai/docs/go/');
  assert.equal(OPENCODE_GO_VALIDATE_MODEL, 'kimi-k3');
});

ok('opencode-go headers are Bearer + User-Agent (no x-api-key/Referer/Title)', () => {
  const headers = getProviderConfig('opencode-go').buildHeaders('k123');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['Authorization'], 'Bearer k123');
  assert.equal(headers['User-Agent'], 'agent-studio/1.0');
  assert.equal('x-api-key' in headers, false);
  assert.equal('HTTP-Referer' in headers, false);
  assert.equal('X-Title' in headers, false);
});

// ---------------------------------------------------------------------------
// Catalog (GC §3 frozen static table: 16 chat-transport ids with sourced prices)
// ---------------------------------------------------------------------------

ok('catalog carries exactly the 16 frozen chat-transport ids in order', () => {
  assert.deepEqual(
    OPENCODE_GO_CATALOG.map((m) => m.id),
    [
      'opencode-go:glm-5.3-flash',
      'opencode-go:glm-5.3',
      'opencode-go:glm-5.2',
      'opencode-go:glm-5.1',
      'opencode-go:kimi-k3',
      'opencode-go:kimi-k2.7-code',
      'opencode-go:kimi-k2.6',
      'opencode-go:longcat-2.0',
      'opencode-go:deepseek-v4.1-flash',
      'opencode-go:deepseek-v4-pro',
      'opencode-go:deepseek-v4-flash',
      'opencode-go:deepseek-v4-flash-vision-exp',
      'opencode-go:mimo-v2.5',
      'opencode-go:mimo-v2.5-pro',
      'opencode-go:hy4-preview',
      'opencode-go:hy3',
    ],
  );
});

ok('catalog names are frozen', () => {
  assert.deepEqual(
    OPENCODE_GO_CATALOG.map((m) => m.name),
    [
      'GLM-5.3-Flash',
      'GLM-5.3',
      'GLM-5.2',
      'GLM-5.1',
      'Kimi K3',
      'Kimi K2.7 Code',
      'Kimi K2.6',
      'LongCat-2.0',
      'DeepSeek V4.1 Flash',
      'DeepSeek V4 Pro',
      'DeepSeek V4 Flash',
      'DeepSeek V4 Flash Vision Exp',
      'MiMo-V2.5',
      'MiMo-V2.5-Pro',
      'Hy4 preview',
      'Hy3',
    ],
  );
});

ok('catalog contexts are frozen (api.json limit.context per model)', () => {
  assert.deepEqual(
    OPENCODE_GO_CATALOG.map((m) => m.context_length),
    [
      1000000,
      1000000,
      1000000,
      202752,
      1048576,
      262144,
      262144,
      1000000,
      1000000,
      1000000,
      1000000,
      1000000,
      1000000,
      1048576,
      1024000,
      256000,
    ],
  );
});

ok('catalog pricing is frozen (docs $/1M table per-token decimals)', () => {
  assert.deepEqual(
    OPENCODE_GO_CATALOG.map((m) => m.pricing),
    [
      { prompt: '0.00000015', completion: '0.0000005' },
      { prompt: '0.0000014', completion: '0.0000044' },
      { prompt: '0.0000014', completion: '0.0000044' },
      { prompt: '0.0000014', completion: '0.0000044' },
      { prompt: '0.000003', completion: '0.000015' },
      { prompt: '0.00000095', completion: '0.000004' },
      { prompt: '0.00000095', completion: '0.000004' },
      { prompt: '0.0000003', completion: '0.0000012' },
      { prompt: '0.00000015', completion: '0.0000006' },
      { prompt: '0.00000066', completion: '0.00000198' },
      { prompt: '0.00000015', completion: '0.0000006' },
      { prompt: '0.00000015', completion: '0.0000006' },
      { prompt: '0.00000014', completion: '0.00000028' },
      { prompt: '0.000000435', completion: '0.00000087' },
      { prompt: '0.000000834', completion: '0.000002501' },
      { prompt: '0.00000014', completion: '0.00000058' },
    ],
  );
});

ok('catalog descriptions promise no structured-output/reasoning controls', () => {
  for (const m of OPENCODE_GO_CATALOG) {
    assert.doesNotMatch(m.description, /structured output|json_schema|reasoning_effort|include_reasoning|thinking/i);
  }
});

ok('every catalog bare id is a chat-transport id (fail-closed catalog)', () => {
  assert.equal(OPENCODE_GO_CHAT_TRANSPORT_MODELS.size, 16);
  assert.equal(OPENCODE_GO_NON_CHAT_TRANSPORT.size, 13);
  for (const m of OPENCODE_GO_CATALOG) {
    const bare = toUpstreamModelId(m.id);
    assert.equal(OPENCODE_GO_CHAT_TRANSPORT_MODELS.has(bare), true, `${m.id} must be chat-transport`);
    assert.equal(OPENCODE_GO_NON_CHAT_TRANSPORT.has(bare), false, `${m.id} must not be phase-2`);
  }
});

// ---------------------------------------------------------------------------
// Cost (GC §6: static table + 3-form cache split, never overwrite upstream)
// ---------------------------------------------------------------------------

ok('cost spot: kimi-k3 1000 prompt + 500 completion = $0.0105', () => {
  const cost = computeOpencodeGoCost(
    { prompt_tokens: 1000, completion_tokens: 500 } as never,
    'kimi-k3',
  );
  assert.equal(cost, 0.0105);
});

ok('cost spot: kimi-k3 1000 prompt (250 cached) + 500 completion = $0.009825', () => {
  const expected = 9825 / 1_000_000;
  const viaHit = computeOpencodeGoCost(
    { prompt_tokens: 1000, prompt_cache_hit_tokens: 250, completion_tokens: 500 } as never,
    'kimi-k3',
  );
  const viaDetails = computeOpencodeGoCost(
    {
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 250 },
      completion_tokens: 500,
    } as never,
    'kimi-k3',
  );
  assert.ok(Math.abs(viaHit - expected) < 1e-12, `hit-form ${viaHit} ~= ${expected}`);
  assert.ok(Math.abs(viaDetails - expected) < 1e-12, `details-form ${viaDetails} ~= ${expected}`);
});

ok('cost hit rule: prompt_cache_hit_tokens wins, then details.cached_tokens, then 0', () => {
  assert.equal(
    opencodeGoCachedTokens({ prompt_cache_hit_tokens: 10, prompt_tokens_details: { cached_tokens: 99 } } as never),
    10,
  );
  assert.equal(opencodeGoCachedTokens({ prompt_tokens_details: { cached_tokens: 7 } } as never), 7);
  assert.equal(opencodeGoCachedTokens({} as never), 0);
  assert.equal(opencodeGoCachedTokens(null), 0);
  assert.equal(opencodeGoCachedTokens(undefined), 0);
});

ok('cost honors the explicit prompt_cache_miss_tokens split', () => {
  const cost = computeOpencodeGoCost(
    {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 250,
      prompt_cache_miss_tokens: 100,
      completion_tokens: 0,
    } as never,
    'kimi-k3',
  );
  assert.ok(Math.abs(cost - 375 / 1_000_000) < 1e-12, `explicit-miss ${cost} ~= ${375 / 1_000_000}`);
});

ok('cost miss clamps at zero when hit exceeds prompt_tokens', () => {
  const cost = computeOpencodeGoCost(
    { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens: 0 } as never,
    'kimi-k3',
  );
  assert.ok(Math.abs(cost - 15 / 1_000_000) < 1e-12, `clamped ${cost} ~= ${15 / 1_000_000}`);
});

ok('cost is 0 for unknown models and missing usage', () => {
  assert.equal(
    computeOpencodeGoCost({ prompt_tokens: 100, completion_tokens: 100 } as never, 'nope'),
    0,
  );
  assert.equal(computeOpencodeGoCost(null, 'kimi-k3'), 0);
  assert.equal(computeOpencodeGoCost(undefined, 'kimi-k3'), 0);
});

// ---------------------------------------------------------------------------
// Transport matrix (plan table: chat vs messages vs responses vs unknown)
// ---------------------------------------------------------------------------

ok('transport: chat ids resolve (bare and namespaced)', () => {
  assert.equal(opencodeGoTransportFor('kimi-k3'), 'chat');
  assert.equal(opencodeGoTransportFor('opencode-go:kimi-k3'), 'chat');
  assert.equal(opencodeGoTransportFor('glm-5.3-flash'), 'chat');
  assert.equal(opencodeGoTransportFor('deepseek-v4-pro'), 'chat');
  assert.equal(opencodeGoTransportFor('hy3'), 'chat');
});

ok('transport: messages ids resolve (bare and namespaced)', () => {
  assert.equal(opencodeGoTransportFor('minimax-m2.7'), 'messages');
  assert.equal(opencodeGoTransportFor('opencode-go:minimax-m2.7'), 'messages');
  assert.equal(opencodeGoTransportFor('qwen3.8-flash'), 'messages');
});

ok('transport: responses ids resolve (bare and namespaced)', () => {
  assert.equal(opencodeGoTransportFor('grok-4.6'), 'responses');
  assert.equal(opencodeGoTransportFor('opencode-go:grok-4.6'), 'responses');
  assert.equal(opencodeGoTransportFor('gpt-5.6-luna'), 'responses');
});

ok('transport: unknown ids fail open (never a silent misroute)', () => {
  assert.equal(opencodeGoTransportFor('opencode-go:zzz-desconocido'), 'unknown');
  assert.equal(opencodeGoTransportFor('zzz-desconocido'), 'unknown');
});

ok('wrong-transport messages are the frozen §7 literals', () => {
  assert.equal(
    opencodeGoWrongTransportMessage('minimax-m2.7', 'messages'),
    'Model minimax-m2.7 is served by OpenCode Go over POST /messages (Anthropic shape), which is phase-2 and not supported yet. Use a chat-transport model such as opencode-go:kimi-k3.',
  );
  assert.equal(
    opencodeGoWrongTransportMessage('grok-4.6', 'responses'),
    'Model grok-4.6 is served by OpenCode Go over POST /responses (Responses API), which is phase-2 and not supported yet. Use a chat-transport model such as opencode-go:kimi-k3.',
  );
});

ok('format-mismatch message is the frozen §7 literal', () => {
  assert.equal(
    opencodeGoFormatMismatchMessage('some-model', 'not supported for format oa-compat'),
    'OpenCode Go rejected model some-model on the chat-completions transport (not supported for format oa-compat). It likely needs a phase-2 transport; use a chat-transport model such as opencode-go:kimi-k3.',
  );
});

// ---------------------------------------------------------------------------
// Reasoning: no builder in phase-1 (D4/GC §5); replay field per model (D5)
// ---------------------------------------------------------------------------

ok('assistantReasoningField(opencode-go) stays the default reasoning field', () => {
  assert.equal(assistantReasoningField('opencode-go'), 'reasoning');
});

ok('no Go reasoning builder or large-model guard exists (phase-1 omit)', () => {
  const ns = providersNs as unknown as Record<string, unknown>;
  assert.equal(ns['buildOpencodeGoReasoning'], undefined);
  assert.equal(ns['buildOpenCodeGoReasoning'], undefined);
  assert.equal(ns['isOpencodeGoLargeModel'], undefined);
  assert.equal(ns['OPENCODE_GO_TOOLS_UNSUPPORTED_MESSAGE'], undefined);
});

ok('replay field: reasoning_content models resolve (bare and namespaced)', () => {
  assert.equal(OPENCODE_GO_REASONING_CONTENT_MODELS.size, 20);
  assert.equal(opencodeGoHistoryReasoningField('kimi-k3'), 'reasoning_content');
  assert.equal(opencodeGoHistoryReasoningField('opencode-go:kimi-k3'), 'reasoning_content');
  assert.equal(opencodeGoHistoryReasoningField('deepseek-v4-pro'), 'reasoning_content');
  assert.equal(opencodeGoHistoryReasoningField('glm-5.3-flash'), 'reasoning_content');
  assert.equal(opencodeGoHistoryReasoningField('mimo-v2.5'), 'reasoning_content');
});

ok('replay field: everything else replays as reasoning', () => {
  assert.equal(opencodeGoHistoryReasoningField('hy3'), 'reasoning');
  assert.equal(opencodeGoHistoryReasoningField('opencode-go:hy3'), 'reasoning');
  assert.equal(opencodeGoHistoryReasoningField('grok-4.6'), 'reasoning');
  assert.equal(opencodeGoHistoryReasoningField('hy4-preview'), 'reasoning');
});

// ---------------------------------------------------------------------------
// Forbidden (§4/§7/GC §9: no ultracode, no foreign fields)
// ---------------------------------------------------------------------------

ok('ultracode and total_credits never appear in the catalog', () => {
  assert.doesNotMatch(JSON.stringify(OPENCODE_GO_CATALOG), /ultracode/);
  assert.doesNotMatch(JSON.stringify(OPENCODE_GO_CATALOG), /total_credits/);
  for (const m of OPENCODE_GO_CATALOG) {
    assert.doesNotMatch(m.id, /ultracode/);
  }
});

console.log(`opencode-go provider tests passed (${checks} checks)`);
