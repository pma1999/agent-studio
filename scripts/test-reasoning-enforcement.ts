/**
 * Backend enforcement of the reasoning contract: send-time planning (chat) vs
 * persistence (agents, import/export).
 *
 * Send time is capability-driven: `chat.ts` resolves the model in the catalog
 * and runs the one shared planner; there is no per-provider branch left. The
 * planner's behaviour is asserted live here; the wiring that puts it on the
 * send path is asserted by source gates, as is the absence of the old
 * per-provider machinery.
 *
 * Persistence stays permissive on purpose: any valid level can be stored for
 * any model (models change their levels), and the clamp happens when sending.
 *
 * Usage:
 *   npx tsx scripts/test-reasoning-enforcement.ts
 *
 * Offline: no network, no DB (sources are read as text; only pure functions
 * and the zod schema are imported).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clampReasoningEffort } from '../shared/reasoningEfforts.js';
import { capabilityFromControls, planReasoning, unknownReasoning } from '../shared/models/reasoning.js';
import { parseImportPayload } from '../server/schemas/exportImport.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

const src = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const chatSrc = src('server/routes/chat.ts');
const councilSrc = src('server/services/councilExecutor.ts');
const agentsSrc = src('server/routes/agents.ts');
const schemaSrc = src('server/schemas/exportImport.ts');
const providersSrc = src('server/providers/index.ts');

// ---------------------------------------------------------------------------
// Wiring: one path from catalog to wire, in chat and in council
// ---------------------------------------------------------------------------

ok('chat.ts resolves the model in the catalog and plans with the shared planner', () => {
  assert.match(chatSrc, /modelCatalog\(\)\.resolveModel\(/);
  assert.match(chatSrc, /planReasoning\(catalogModel\.reasoning, reasoningRequest\)/);
  assert.match(chatSrc, /from '\.\.\/\.\.\/shared\/models\/reasoning\.js'/);
});

ok('chat.ts spells the plan on the wire through the shared builders only', () => {
  assert.match(chatSrc, /chatReasoningFields\(catalogModel, reasoningPlan/);
  assert.match(chatSrc, /from '\.\.\/providers\/wire\/reasoning\.js'/);
  // Every transport comes from the same module; no hand-rolled bodies.
  assert.match(chatSrc, /messagesThinkingFields|buildMessagesBody/);
  assert.match(chatSrc, /responsesReasoning|buildResponsesBody/);
  assert.match(chatSrc, /codexTurnEffort\(catalogModel, reasoningPlan\)/);
});

ok('chat.ts logs the plan, with the adjustments it had to make', () => {
  assert.ok(chatSrc.includes('[chat] Reasoning plan: model='), 'plan log line');
  for (const field of ['capability=', 'enabled=', 'level=', 'budget=']) {
    assert.ok(chatSrc.includes(field), `log field ${field}`);
  }
  assert.match(chatSrc, /describeAdjustments\(/);
});

ok('council plans with the same planner and the same builders', () => {
  assert.match(councilSrc, /planReasoning\(/);
  assert.match(councilSrc, /from '\.\.\/providers\/wire\/reasoning\.js'/);
  assert.match(councilSrc, /modelCatalog\(\)\.resolveModel\(/);
});

ok('no per-provider reasoning machinery survives on the send path', () => {
  const retired = [
    'getCachedOpenRouterSupportedEfforts',
    'lookupSupportedEfforts',
    'supportsReasoningParam',
    'buildDeepSeekThinking',
    'buildAbliterationReasoning',
    'buildArnictReasoning',
    'planOpencodeGoMessagesThinking',
    'planOpencodeGoResponsesEffort',
    'opencodeGoTransportFor',
    'OPENCODE_GO_CHAT_TRANSPORT_MODELS',
  ];
  for (const symbol of retired) {
    for (const [name, text] of [['chat.ts', chatSrc], ['councilExecutor.ts', councilSrc], ['providers/index.ts', providersSrc]] as const) {
      assert.ok(!text.includes(symbol), `${symbol} still referenced in ${name}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Send-time behaviour: the planner is the single rule
// ---------------------------------------------------------------------------

const graded = (levels: string[], toggle: boolean) =>
  capabilityFromControls({ toggle, effortValues: levels, budget: null }, { toggle, noneEffort: true, effort: true, budget: false });

ok('send: a requested level outside the model falls to the nearest lower one', () => {
  assert.equal(planReasoning(graded(['minimal', 'low'], true), { enabled: true, level: 'max' }).level, 'low');
  assert.equal(clampReasoningEffort('max', ['minimal', 'low']), 'low');
});

ok('send: a model with no gradation takes no level (bare on/off)', () => {
  const plan = planReasoning(graded([], true), { enabled: true, level: 'high' });
  assert.deepEqual([plan.enabled, plan.level], [true, null]);
  assert.equal(clampReasoningEffort('high', []), null);
});

ok('send: unknown capability is fail-open — the request travels as asked', () => {
  const plan = planReasoning(unknownReasoning(), { enabled: true, level: 'max', budget: 4096 });
  assert.deepEqual([plan.enabled, plan.level, plan.budget], [true, 'max', 4096]);
  assert.equal(clampReasoningEffort('max', null), 'max');
  assert.equal(clampReasoningEffort('max', undefined), 'max');
});

ok('send: off is honoured where the model can be switched off', () => {
  const plan = planReasoning(graded(['low', 'high'], true), { enabled: false });
  assert.deepEqual([plan.enabled, plan.level, plan.adjustments], [false, null, []]);
  assert.equal(clampReasoningEffort('none', ['high', 'max']), 'none');
});

ok('send: a model that always reasons is forced on at its cheapest level, and says so', () => {
  const plan = planReasoning(graded(['low', 'high'], false), { enabled: false });
  assert.deepEqual([plan.enabled, plan.level], [true, 'low']);
  assert.deepEqual(plan.adjustments, [{ kind: 'forced-on' }]);
});

// ---------------------------------------------------------------------------
// Persistence: permissive by design, validated against the shared vocabulary
// ---------------------------------------------------------------------------

ok('agents.ts validates against the shared vocabulary with a 400', () => {
  assert.match(agentsSrc, /isReasoningEffort/);
  assert.ok(agentsSrc.includes('reasoning_effort must be one of'), '400 message');
});

ok('exportImport.ts pins the enum to the 6 levels plus none', () => {
  assert.match(schemaSrc, /reasoning_effort: z\.enum/);
  for (const value of ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']) {
    assert.ok(schemaSrc.includes(`'${value}'`), `missing '${value}'`);
  }
  assert.ok(!/'ultra'/.test(schemaSrc), 'ultra is not part of the vocabulary');
});

function agentsPayload(effort: unknown): unknown {
  return {
    version: 1,
    kind: 'agents',
    exported_at: new Date().toISOString(),
    agents: [{ id: 'a1', name: 'A', system_prompt: 'p', reasoning_effort: effort }],
  };
}

ok('import: a valid level is accepted and the rest of the agent survives', () => {
  const out = parseImportPayload(agentsPayload('high'));
  assert.equal(out.kind, 'agents');
  if (out.kind !== 'agents') throw new Error('unreachable');
  assert.equal(out.agents[0].reasoning_effort, 'high');
  assert.equal(out.agents[0].name, 'A');
  assert.equal(out.agents[0].system_prompt, 'p');
  assert.equal(out.agents[0].model, 'openrouter/auto');
});

ok('import: anything outside the vocabulary is rejected', () => {
  assert.throws(() => parseImportPayload(agentsPayload('ultra')), /reasoning_effort/i);
  assert.throws(() => parseImportPayload(agentsPayload('bogus')), /reasoning_effort/i);
});

ok('import: null and absent are both accepted (nullable + optional)', () => {
  assert.equal(parseImportPayload(agentsPayload(null)).kind, 'agents');
  assert.equal(
    parseImportPayload({
      version: 1,
      kind: 'agents',
      exported_at: new Date().toISOString(),
      agents: [{ id: 'a1', name: 'A', system_prompt: 'p' }],
    }).kind,
    'agents',
  );
});

ok('persistence never clamps: a level the current model lacks is still stored', () => {
  const out = parseImportPayload(agentsPayload('max'));
  if (out.kind !== 'agents') throw new Error('unreachable');
  assert.equal(out.agents[0].reasoning_effort, 'max');
  // …and the clamp happens later, at send time.
  assert.equal(planReasoning(graded(['low', 'high'], true), { enabled: true, level: 'max' }).level, 'high');
});

console.log(`reasoning enforcement tests passed (${checks} checks)`);
