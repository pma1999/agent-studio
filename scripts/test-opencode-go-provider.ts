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
  OPENCODE_GO_ANTHROPIC_VERSION,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_CATALOG,
  OPENCODE_GO_CATALOG_VERSION,
  OPENCODE_GO_CHAT_COMPLETIONS_URL,
  OPENCODE_GO_CHAT_TRANSPORT_MODELS,
  OPENCODE_GO_DOCS_URL,
  OPENCODE_GO_LIST_EXCLUDED,
  OPENCODE_GO_MESSAGES_URL,
  OPENCODE_GO_NON_CHAT_TRANSPORT,
  OPENCODE_GO_PREFIX,
  OPENCODE_GO_PRICING,
  OPENCODE_GO_REASONING_CONTENT_MODELS,
  OPENCODE_GO_RESPONSES_URL,
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
  assert.equal(OPENCODE_GO_VALIDATE_MODEL, 'mimo-v2.5');
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
// Catalog (GC §3 frozen static table: T1 29 = 16 chat + 8 messages + 5
// responses; the 16 chat rows stay byte-identical below, scoped via slice)
// ---------------------------------------------------------------------------

ok('catalog carries exactly the 16 frozen chat-transport ids in order', () => {
  assert.deepEqual(
    OPENCODE_GO_CATALOG.slice(0, 16).map((m) => m.id),
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
    OPENCODE_GO_CATALOG.slice(0, 16).map((m) => m.name),
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
    OPENCODE_GO_CATALOG.slice(0, 16).map((m) => m.context_length),
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
    OPENCODE_GO_CATALOG.slice(0, 16).map((m) => m.pricing),
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

ok('every chat catalog bare id is a chat-transport id (fail-closed catalog)', () => {
  assert.equal(OPENCODE_GO_CHAT_TRANSPORT_MODELS.size, 16);
  assert.equal(OPENCODE_GO_NON_CHAT_TRANSPORT.size, 13);
  for (const m of OPENCODE_GO_CATALOG.slice(0, 16)) {
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

// ---------------------------------------------------------------------------
// T1 full catalog: 29 ids in frozen order (16 chat + 8 messages in docs-table
// order + 5 responses in docs-table order with grok-4.5 last), transport +
// sendable per entry, monthly limits, 9 exclusions with reason, version.
// ---------------------------------------------------------------------------

const T1_PHASE2_IDS = [
  'opencode-go:minimax-m3',
  'opencode-go:minimax-m2.7',
  'opencode-go:minimax-m2.5',
  'opencode-go:qwen3.8-max',
  'opencode-go:qwen3.8-flash',
  'opencode-go:qwen3.7-max',
  'opencode-go:qwen3.7-plus',
  'opencode-go:qwen3.6-plus',
  'opencode-go:grok-4.6',
  'opencode-go:gpt-5.6-luna',
  'opencode-go:muse-spark-1.3-contributor',
  'opencode-go:muse-spark-1.2-contributor',
  'opencode-go:grok-4.5',
];

ok('T1: catalog carries exactly the 29 frozen ids in order (grok-4.5 last)', () => {
  assert.equal(OPENCODE_GO_CATALOG.length, 29);
  assert.deepEqual(
    OPENCODE_GO_CATALOG.slice(16).map((m) => m.id),
    T1_PHASE2_IDS,
  );
  assert.equal(OPENCODE_GO_CATALOG[28].id, 'opencode-go:grok-4.5');
});

ok('T1: transport is correct per entry and sendable is true on all 29 (messages since T4, responses since T5)', () => {
  for (const m of OPENCODE_GO_CATALOG.slice(0, 16)) {
    assert.equal(m.transport, 'chat', `${m.id} transport`);
    assert.equal(m.sendable, true, `${m.id} sendable`);
  }
  const expectedTransport = [
    'messages', 'messages', 'messages', 'messages',
    'messages', 'messages', 'messages', 'messages',
    'responses', 'responses', 'responses', 'responses', 'responses',
  ];
  // T5: the 5 responses rows are send-enabled via POST /responses (T3 GO);
  // no transport hard-fails anymore, `unknown` ids still fail open.
  const expectedSendable = [
    true, true, true, true, true, true, true, true,
    true, true, true, true, true,
  ];
  OPENCODE_GO_CATALOG.slice(16).forEach((m, i) => {
    assert.equal(m.transport, expectedTransport[i], `${m.id} transport`);
    assert.equal(m.sendable, expectedSendable[i], `${m.id} sendable`);
  });
});

ok('T4: sendable is true in the 8 messages entries', () => {
  const messagesIds = [
    'opencode-go:minimax-m3',
    'opencode-go:minimax-m2.7',
    'opencode-go:minimax-m2.5',
    'opencode-go:qwen3.8-max',
    'opencode-go:qwen3.8-flash',
    'opencode-go:qwen3.7-max',
    'opencode-go:qwen3.7-plus',
    'opencode-go:qwen3.6-plus',
  ];
  const byId = new Map(OPENCODE_GO_CATALOG.map((m) => [m.id, m]));
  for (const id of messagesIds) {
    const m = byId.get(id);
    assert.ok(m, `${id} present`);
    assert.equal(m!.transport, 'messages', `${id} transport`);
    assert.equal(m!.sendable, true, `${id} sendable`);
  }
});

ok('T5: sendable is true in the 5 responses entries (Bearer-only sender, T3 GO)', () => {
  const responsesIds = [
    'opencode-go:grok-4.6',
    'opencode-go:gpt-5.6-luna',
    'opencode-go:muse-spark-1.3-contributor',
    'opencode-go:muse-spark-1.2-contributor',
    'opencode-go:grok-4.5',
  ];
  const byId = new Map(OPENCODE_GO_CATALOG.map((m) => [m.id, m]));
  for (const id of responsesIds) {
    const m = byId.get(id);
    assert.ok(m, `${id} present`);
    assert.equal(m!.transport, 'responses', `${id} transport`);
    assert.equal(m!.sendable, true, `${id} sendable`);
  }
  // grok-4.5 bills like any responses row despite the unknown monthly limit.
  assert.equal(byId.get('opencode-go:grok-4.5')!.monthlyLimitUsd, undefined);
  assert.equal(typeof byId.get('opencode-go:grok-4.5')!.priceNote, 'string');
});

ok('T1: phase-2 entries carry docs context + base-rate pricing + monthly limit (grok-4.5: no limit + priceNote)', () => {
  const byId = new Map(OPENCODE_GO_CATALOG.map((m) => [m.id, m]));
  const expected: Array<[string, number, { prompt: string; completion: string }, number?]> = [
    ['opencode-go:minimax-m3', 1000000, { prompt: '0.0000003', completion: '0.0000012' }, 60],
    ['opencode-go:minimax-m2.7', 204800, { prompt: '0.0000003', completion: '0.0000012' }, 60],
    ['opencode-go:minimax-m2.5', 204800, { prompt: '0.0000003', completion: '0.0000012' }, 60],
    ['opencode-go:qwen3.8-max', 1000000, { prompt: '0.000002', completion: '0.000006' }, 15],
    ['opencode-go:qwen3.8-flash', 1000000, { prompt: '0.00000015', completion: '0.00000047' }, 30],
    ['opencode-go:qwen3.7-max', 1000000, { prompt: '0.0000025', completion: '0.0000075' }, 30],
    ['opencode-go:qwen3.7-plus', 1000000, { prompt: '0.0000004', completion: '0.0000016' }, 60],
    ['opencode-go:qwen3.6-plus', 1000000, { prompt: '0.0000005', completion: '0.000003' }, 60],
    ['opencode-go:grok-4.6', 500000, { prompt: '0.000002', completion: '0.000006' }, 15],
    ['opencode-go:gpt-5.6-luna', 1050000, { prompt: '0.0000002', completion: '0.0000012' }, 15],
    ['opencode-go:muse-spark-1.3-contributor', 1048576, { prompt: '0.0000001', completion: '0.0000002' }, 60],
    ['opencode-go:muse-spark-1.2-contributor', 1048576, { prompt: '0.0000001', completion: '0.0000002' }, 60],
  ];
  for (const [id, ctx, pricing, limit] of expected) {
    const m = byId.get(id);
    assert.ok(m, `${id} present`);
    assert.equal(m!.context_length, ctx, `${id} context`);
    assert.deepEqual(m!.pricing, pricing, `${id} pricing`);
    assert.equal(m!.monthlyLimitUsd, limit, `${id} monthly limit`);
  }
  const grok45 = byId.get('opencode-go:grok-4.5');
  assert.ok(grok45, 'opencode-go:grok-4.5 present');
  assert.equal(grok45!.context_length, 500000, 'grok-4.5 context');
  assert.deepEqual(grok45!.pricing, { prompt: '0.000002', completion: '0.000006' }, 'grok-4.5 pricing');
  assert.equal(grok45!.monthlyLimitUsd, undefined, 'grok-4.5 has no known monthly limit');
  assert.equal(typeof grok45!.priceNote, 'string', 'grok-4.5 carries a priceNote');
  assert.ok((grok45!.priceNote as string).length > 0, 'grok-4.5 priceNote non-empty');
});

ok('T1: opencodeGoTransportFor resolves all 29 plus the 9 excluded as unknown', () => {
  for (const m of OPENCODE_GO_CATALOG.slice(0, 16)) {
    assert.equal(opencodeGoTransportFor(toUpstreamModelId(m.id)), 'chat', m.id);
  }
  for (const id of T1_PHASE2_IDS) {
    const bare = toUpstreamModelId(id);
    assert.equal(opencodeGoTransportFor(bare), OPENCODE_GO_NON_CHAT_TRANSPORT.get(bare), bare);
    assert.equal(opencodeGoTransportFor(id), OPENCODE_GO_NON_CHAT_TRANSPORT.get(bare), id);
  }
  const excluded = [...OPENCODE_GO_LIST_EXCLUDED.keys()];
  assert.equal(excluded.length, 9);
  for (const bare of excluded) {
    assert.equal(opencodeGoTransportFor(bare), 'unknown', `${bare} excluded -> unknown`);
    assert.equal(opencodeGoTransportFor(`${OPENCODE_GO_PREFIX}${bare}`), 'unknown', `${bare} namespaced -> unknown`);
  }
  assert.equal(opencodeGoTransportFor('zzz-desconocido'), 'unknown');
});

ok('T1: LIST_EXCLUDED holds exactly the 9 bare ids with reason, all absent from the catalog', () => {
  assert.deepEqual(
    [...OPENCODE_GO_LIST_EXCLUDED.keys()],
    [
      'glm-5',
      'kimi-k2.5',
      'mimo-v2-omni',
      'mimo-v2-pro',
      'omen-alpha',
      'qwen3.5-plus',
      'ox-alpha-free',
      'deepseek-flash',
      'hy3-preview',
    ],
  );
  assert.equal(
    OPENCODE_GO_LIST_EXCLUDED.get('deepseek-flash'),
    'sin metadata oficial (UNVERIFIED, probe T3 pendiente)',
  );
  assert.equal(
    OPENCODE_GO_LIST_EXCLUDED.get('hy3-preview'),
    'sin metadata oficial (UNVERIFIED, probe T3 pendiente)',
  );
  for (const [bare, reason] of OPENCODE_GO_LIST_EXCLUDED) {
    assert.equal(typeof reason, 'string', `${bare} reason`);
    assert.ok(reason.length > 0, `${bare} reason non-empty`);
  }
  const catalogBare = new Set(OPENCODE_GO_CATALOG.map((m) => toUpstreamModelId(m.id)));
  for (const bare of OPENCODE_GO_LIST_EXCLUDED.keys()) {
    assert.equal(catalogBare.has(bare), false, `${bare} absent from catalog`);
  }
  for (const m of OPENCODE_GO_CATALOG) {
    assert.equal(OPENCODE_GO_LIST_EXCLUDED.has(toUpstreamModelId(m.id)), false, `${m.id} not excluded`);
  }
});

ok('T1: chat entries carry their docs monthly limit (api.json limit + docs table)', () => {
  const byId = new Map(OPENCODE_GO_CATALOG.map((m) => [m.id, m]));
  const expected: Array<[string, number]> = [
    ['opencode-go:glm-5.3-flash', 60],
    ['opencode-go:glm-5.3', 15],
    ['opencode-go:glm-5.2', 60],
    ['opencode-go:glm-5.1', 60],
    ['opencode-go:kimi-k3', 15],
    ['opencode-go:kimi-k2.7-code', 60],
    ['opencode-go:kimi-k2.6', 60],
    ['opencode-go:longcat-2.0', 60],
    ['opencode-go:deepseek-v4.1-flash', 15],
    ['opencode-go:deepseek-v4-pro', 15],
    ['opencode-go:deepseek-v4-flash', 30],
    ['opencode-go:deepseek-v4-flash-vision-exp', 15],
    ['opencode-go:mimo-v2.5', 60],
    ['opencode-go:mimo-v2.5-pro', 15],
    ['opencode-go:hy4-preview', 30],
    ['opencode-go:hy3', 60],
  ];
  assert.equal(expected.length, 16);
  for (const [id, limit] of expected) {
    assert.equal(byId.get(id)!.monthlyLimitUsd, limit, `${id} monthly limit`);
  }
});

ok('T1: catalog version and phase-2 endpoint constants are frozen', () => {
  assert.equal(OPENCODE_GO_CATALOG_VERSION, '2026-09-15.29');
  assert.equal(OPENCODE_GO_MESSAGES_URL, 'https://opencode.ai/zen/go/v1/messages');
  assert.equal(OPENCODE_GO_RESPONSES_URL, 'https://opencode.ai/zen/go/v1/responses');
  assert.equal(OPENCODE_GO_ANTHROPIC_VERSION, '2023-06-01');
});

// ---------------------------------------------------------------------------
// T2 pricing: tiers/write/peak cost engine (docs usage-limits table,
// re-checked live 2026-09-15; promo DeepSeek V4.1 "4x · Ends Sep 20" active).
// ---------------------------------------------------------------------------

ok('T2: OPENCODE_GO_PRICING covers all 29 catalog ids with docs base rates', () => {
  assert.deepEqual(
    Object.keys(OPENCODE_GO_PRICING).sort(),
    OPENCODE_GO_CATALOG.map((m) => toUpstreamModelId(m.id)).sort(),
  );
  // Docs-win spot: minimax-m2.5 cached-read 0.06 (not api.json 0.03).
  assert.deepEqual(
    OPENCODE_GO_PRICING['minimax-m2.5'],
    { inHit: 0.06, inMiss: 0.3, out: 1.2, write: 0.375 },
  );
  assert.equal(OPENCODE_GO_PRICING['qwen3.8-flash'].write, 0.2);
  assert.equal(OPENCODE_GO_PRICING['kimi-k3'].write, undefined);
});

ok('T2: write tokens price at Cached Write, else at the miss rate', () => {
  const created = computeOpencodeGoCost(
    { prompt_tokens: 1000, prompt_cache_write_tokens: 200, completion_tokens: 100 } as never,
    'minimax-m2.7',
  );
  assert.ok(Math.abs(created - 435 / 1_000_000) < 1e-12, `write-rate ${created} ~= ${435 / 1_000_000}`);
  const fallback = computeOpencodeGoCost(
    { prompt_tokens: 1000, prompt_cache_write_tokens: 200, completion_tokens: 0 } as never,
    'kimi-k3',
  );
  assert.ok(Math.abs(fallback - 3000 / 1_000_000) < 1e-12, `miss-fallback ${fallback} ~= ${3000 / 1_000_000}`);
});

ok('T2: context tiers bill above the threshold, edge stays on the base tier', () => {
  const out1M = { prompt_tokens: 0, completion_tokens: 1_000_000 } as never;
  const cases: Array<[string, number, number, number]> = [
    // [model, baseOut, aboveOut, upToTokens]
    ['qwen3.7-plus', 1.6, 4.8, 256000],
    ['qwen3.6-plus', 3.0, 6.0, 256000],
    ['gpt-5.6-luna', 1.2, 1.8, 272000],
    ['grok-4.6', 6.0, 12.0, 200000],
    ['grok-4.5', 6.0, 12.0, 200000],
    ['minimax-m3', 1.2, 2.4, 512000],
  ];
  for (const [model, base, above, upTo] of cases) {
    assert.equal(computeOpencodeGoCost(out1M, model), base, `${model} base`);
    assert.equal(computeOpencodeGoCost(out1M, model, { contextTokens: upTo }), base, `${model} edge`);
    assert.equal(computeOpencodeGoCost(out1M, model, { contextTokens: upTo + 1 }), above, `${model} above`);
  }
  // Read + write follow the tier too (non-uniform multipliers are absolute rows).
  const hit1M = { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, completion_tokens: 0 } as never;
  assert.equal(computeOpencodeGoCost(hit1M, 'grok-4.6', { contextTokens: 200001 }), 1.0);
  const mk1M = { prompt_tokens: 0, prompt_cache_write_tokens: 1_000_000, completion_tokens: 0 } as never;
  assert.equal(computeOpencodeGoCost(mk1M, 'qwen3.7-plus', { contextTokens: 256000 }), 0.5);
  assert.equal(computeOpencodeGoCost(mk1M, 'qwen3.7-plus', { contextTokens: 256001 }), 1.5);
});

ok('T2: absent contextTokens bills the base tier without failing', () => {
  const out1M = { prompt_tokens: 0, completion_tokens: 1_000_000 } as never;
  assert.equal(computeOpencodeGoCost(out1M, 'qwen3.7-plus'), 1.6);
  assert.equal(computeOpencodeGoCost(out1M, 'qwen3.7-plus', {}), 1.6);
  assert.equal(computeOpencodeGoCost(out1M, 'qwen3.7-plus', { peak: true }), 1.6);
});

ok('T2: peak doubles DeepSeek in/out/read and is ignored elsewhere', () => {
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } as never;
  assert.equal(computeOpencodeGoCost(usage, 'deepseek-v4-pro'), 2.64);
  assert.equal(computeOpencodeGoCost(usage, 'deepseek-v4-pro', { peak: true }), 5.28);
  const hit1M = { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, completion_tokens: 0 } as never;
  assert.equal(computeOpencodeGoCost(hit1M, 'deepseek-v4-flash', { peak: true }), 0.006);
  // Non-DeepSeek rows ignore peak without error.
  assert.equal(
    computeOpencodeGoCost(
      { prompt_tokens: 1000, completion_tokens: 500 } as never,
      'kimi-k3',
      { peak: true },
    ),
    0.0105,
  );
  assert.equal(
    computeOpencodeGoCost(
      { prompt_tokens: 0, completion_tokens: 1_000_000 } as never,
      'qwen3.7-plus',
      { contextTokens: 256001, peak: true },
    ),
    4.8,
  );
});

ok('T2: unknown models and missing usage cost 0 even with opts', () => {
  const usage = { prompt_tokens: 100, completion_tokens: 100 } as never;
  assert.equal(computeOpencodeGoCost(usage, 'nope', { contextTokens: 999_999_999, peak: true }), 0);
  assert.equal(computeOpencodeGoCost(null, 'kimi-k3', { contextTokens: 1, peak: true }), 0);
  assert.equal(computeOpencodeGoCost(undefined, 'grok-4.6', { contextTokens: 200001 }), 0);
});

console.log(`opencode-go provider tests passed (${checks} checks)`);
