/**
 * Council: thinking on the wire, for real.
 *
 * Until this migration the council sent no thinking at all to OpenRouter,
 * DeepSeek, Codex or llama.cpp, and its Go members had no wire of their own.
 * Source greps cannot prove that is fixed, so this harness runs the real
 * `CouncilExecutor.execute()` against a stubbed catalog and a captured
 * `fetch`, and asserts what each member and the synthesizer actually send:
 * the level the user asked for, clamped per model, on the transport the
 * catalog chose, with that transport's headers.
 *
 * Usage:
 *   npx tsx scripts/test-council-reasoning.ts
 *
 * Offline: no network (fetch is captured); a scratch DB only.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import type { CatalogModel } from '../shared/models/catalog.js';
import type { CouncilExecutionOptions, MemberResult } from '../server/types.js';

// Own scratch DB, chosen before `server/db.js` resolves one: this harness
// writes settings rows, and must never touch the developer's database.
const testDbPath = path.join(os.tmpdir(), `council-reasoning-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const { CouncilExecutor } = await import('../server/services/councilExecutor.js');
const { setModelCatalogForTests } = await import('../server/catalog/index.js');
const { stubModelCatalog } = await import('./helpers/catalogStub.js');
const { capabilityFromControls } = await import('../shared/models/reasoning.js');

migrate();

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

const USER = 'council-user';
const CONVERSATION = 'council-conversation';

// ---------------------------------------------------------------------------
// Catalog: one model per shape the council has to get right
// ---------------------------------------------------------------------------

const graded = (levels: string[], toggle: boolean) =>
  capabilityFromControls(
    { toggle, effortValues: levels, budget: null },
    { toggle, noneEffort: true, effort: true, budget: false },
  );

const budgeted = (max: number) =>
  capabilityFromControls(
    { toggle: true, effortValues: null, budget: { min: null, max } },
    { toggle: true, noneEffort: false, effort: true, budget: true },
  );

const CATALOG: Record<string, Partial<CatalogModel>> = {
  // OpenRouter: switchable and graded — it used to receive nothing.
  'vendor/router-model': { name: 'Router Model', transport: 'chat', reasoning: graded(['low', 'medium', 'high'], true) },
  // DeepSeek: thinking.type switch plus a clamped effort.
  'deepseek:deepseek-v4-pro': { provider: 'deepseek', transport: 'chat', name: 'DeepSeek V4 Pro', reasoning: graded(['high', 'max'], true) },
  // Go over the Anthropic shape, with a real token budget.
  'opencode-go:qwen3.7-plus': { provider: 'opencode-go', transport: 'messages', name: 'Qwen3.7 Plus', reasoning: budgeted(262144) },
  // Go over Responses, graded.
  'opencode-go:gpt-5.6-luna': { provider: 'opencode-go', transport: 'responses', name: 'GPT-5.6 Luna', reasoning: graded(['low', 'medium', 'high'], true) },
  // Synthesizer: a model that always reasons, at one level only.
  'opencode-go:kimi-k3': { provider: 'opencode-go', transport: 'chat', name: 'Kimi K3', reasoning: graded(['max'], false) },
};

setModelCatalogForTests(stubModelCatalog(CATALOG));

// ---------------------------------------------------------------------------
// Captured upstream
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

const sent: Captured[] = [];

/** Each transport answers in its own shape, so the whole round trip is exercised. */
function eventsFor(url: string, text: string): unknown[] {
  if (url.endsWith('/messages')) {
    return [
      { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 4, output_tokens: 2 } },
      { type: 'message_stop' },
    ];
  }
  if (url.endsWith('/responses')) {
    return [
      { type: 'response.output_text.delta', delta: text },
      { type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 2 } } },
    ];
  }
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ];
}

const sseBody = (url: string, text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of eventsFor(url, text)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input);
  sent.push({
    url,
    headers: { ...(init?.headers ?? {}) },
    body: JSON.parse(String(init?.body ?? '{}')),
  });
  return new Response(sseBody(url, 'ok'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}) as typeof fetch;

const bodyFor = (modelId: string): Captured => {
  const upstream = modelId.includes(':') ? modelId.split(':')[1] : modelId;
  const hit = sent.find((c) => c.body.model === upstream || c.body.model === modelId);
  assert.ok(hit, `no request captured for ${modelId} (sent: ${sent.map((s) => s.body.model).join(', ')})`);
  return hit!;
};

// ---------------------------------------------------------------------------
// The turn: general chat settings ask for High with a budget
// ---------------------------------------------------------------------------

db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(USER, 'general_chat_reasoning_enabled', 'true');
db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(USER, 'general_chat_reasoning_effort', 'high');
db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(USER, 'general_chat_reasoning_max_tokens', '20000');

const members: MemberResult[] = [];
const options: CouncilExecutionOptions = {
  conversationId: CONVERSATION,
  userId: USER,
  content: 'hello',
  memberModels: ['vendor/router-model', 'deepseek:deepseek-v4-pro', 'opencode-go:qwen3.7-plus', 'opencode-go:gpt-5.6-luna'],
  synthesizerModel: 'opencode-go:kimi-k3',
  systemPrompt: 'be brief',
  messageHistory: [{ role: 'user', content: 'hello' }],
  onMemberStart: () => {},
  onMemberComplete: (_index, result) => { members.push(result); },
  onSynthesisStart: () => {},
  onSynthesisChunk: () => {},
};

await new CouncilExecutor(() => 'k').execute(options);

// ---------------------------------------------------------------------------
// What each member actually sent
// ---------------------------------------------------------------------------

ok('every member answers on its own transport, and the synthesizer runs', () => {
  assert.equal(sent.length >= 5, true, `expected >= 5 requests, got ${sent.length}`);
  assert.equal(members.length, 4);
  for (const member of members) {
    assert.equal(member.content, 'ok', member.modelId);
    assert.equal(member.error ?? null, null, member.modelId);
  }
  // The Anthropic wire replays its trace into the member's reasoning column.
  const anthropic = members.find((m) => m.modelId === 'opencode-go:qwen3.7-plus');
  assert.equal(anthropic?.reasoningContent, 'weighing it');
});

ok('OpenRouter members now get thinking (they used to get none)', () => {
  const { body } = bodyFor('vendor/router-model');
  assert.deepEqual(body.reasoning, { effort: 'high' });
});

ok('DeepSeek members get the thinking switch plus a clamped effort', () => {
  const { body } = bodyFor('deepseek:deepseek-v4-pro');
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'high');
});

ok('Go members on the Anthropic shape get the budget, with that wire\'s headers', () => {
  const captured = bodyFor('opencode-go:qwen3.7-plus');
  assert.equal(captured.url, 'https://opencode.ai/zen/go/v1/messages');
  assert.equal(captured.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.headers['x-api-key'], 'k');
  assert.equal(captured.headers['x-opencode-session'], CONVERSATION);
  assert.deepEqual(captured.body.thinking, { type: 'enabled', budget_tokens: 20000 });
  assert.equal('reasoning_effort' in captured.body, false, 'the chat field never rides this wire');
});

ok('Go members on Responses get an explicit effort and Bearer alone', () => {
  const captured = bodyFor('opencode-go:gpt-5.6-luna');
  assert.equal(captured.url, 'https://opencode.ai/zen/go/v1/responses');
  assert.equal('x-api-key' in captured.headers, false);
  assert.equal('anthropic-version' in captured.headers, false);
  assert.deepEqual(captured.body.reasoning, { effort: 'high' });
});

ok('the synthesizer thinks too, clamped to what its model offers', () => {
  const { body } = bodyFor('opencode-go:kimi-k3');
  assert.equal(body.reasoning_effort, 'max', 'kimi-k3 offers only max');
});

ok('no request carries a level the model does not offer, or `ultra`', () => {
  for (const captured of sent) {
    const json = JSON.stringify(captured.body);
    assert.doesNotMatch(json, /ultra/i, captured.body.model);
    assert.doesNotMatch(json, /"reasoning_effort":"(minimal|xhigh)"/, captured.body.model);
  }
});

// ---------------------------------------------------------------------------
// Thinking off: every provider hears it, in its own words
// ---------------------------------------------------------------------------

db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(USER, 'general_chat_reasoning_enabled', 'false');
sent.length = 0;
members.length = 0;
await new CouncilExecutor(() => 'k').execute(options);

ok('off travels per provider: object, switch, disabled block, none-effort', () => {
  assert.deepEqual(bodyFor('vendor/router-model').body.reasoning, { enabled: false });
  assert.deepEqual(bodyFor('deepseek:deepseek-v4-pro').body.thinking, { type: 'disabled' });
  assert.deepEqual(bodyFor('opencode-go:qwen3.7-plus').body.thinking, { type: 'disabled' });
  assert.deepEqual(bodyFor('opencode-go:gpt-5.6-luna').body.reasoning, { effort: 'none' });
});

ok('a model that cannot stop thinking is asked for its cheapest level instead', () => {
  assert.equal(bodyFor('opencode-go:kimi-k3').body.reasoning_effort, 'max');
});

console.log(`council reasoning tests passed (${checks} checks)`);

for (const suffix of ['', '-wal', '-shm']) {
  try { (await import('node:fs')).rmSync(`${testDbPath}${suffix}`, { force: true }); } catch { /* best effort */ }
}
