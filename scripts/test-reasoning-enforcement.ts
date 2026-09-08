/**
 * Task t2-enforce: validación y clamp en el backend (chat/agents/import).
 *
 * Gates de wiring por grep (patrón S14/S15) + comportamiento de la rama
 * (lista conocida vs null vs []) y del schema de import. Los asserts vivos
 * de clamp ya viven en scripts/test-reasoning-effort.ts (T1); aquí solo se
 * re-simula la rama para fijar el contrato send-vs-persist.
 *
 * Señal esperada: rojo sin los cambios (wiring ausente), verde con ellos.
 * Offline-safe, db-free (no sirve ningún router, solo lee fuentes e importa
 * funciones puras + el schema zod).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clampReasoningEffort } from '../shared/reasoningEfforts.js';
import { parseImportPayload } from '../server/schemas/exportImport.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

const chatSrc = readFileSync(resolve(process.cwd(), 'server/routes/chat.ts'), 'utf8');
const agentsSrc = readFileSync(resolve(process.cwd(), 'server/routes/agents.ts'), 'utf8');
const schemaSrc = readFileSync(resolve(process.cwd(), 'server/schemas/exportImport.ts'), 'utf8');

// ---------------------------------------------------------------------------
// Wiring: chat.ts — clamp pre-flight con fail-open
// ---------------------------------------------------------------------------
ok('chat.ts importa getCachedOpenRouterSupportedEfforts desde ./models.js', () => {
  assert.match(chatSrc, /getCachedOpenRouterSupportedEfforts/);
  assert.match(chatSrc, /from '\.\/models\.js'/);
});

ok('chat.ts llama clampReasoningEffort (import shared con sufijo .js)', () => {
  assert.match(chatSrc, /clampReasoningEffort/);
  assert.match(chatSrc, /from '\.\.\/\.\.\/shared\/reasoningEfforts\.js'/);
});

ok('chat.ts loguea el clamp con el formato fijado', () => {
  assert.ok(
    chatSrc.includes('[chat] Reasoning effort clamped: requested='),
    'falta el log de clamp con el formato fijado',
  );
  assert.match(chatSrc, /applied=/);
  assert.match(chatSrc, /model=/);
});

ok('chat.ts clamped solo para provider openrouter (resto intacto)', () => {
  assert.match(chatSrc, /provider\.id === 'openrouter'/);
});

// ---------------------------------------------------------------------------
// Wiring: agents.ts — whitelist de unión con 400
// ---------------------------------------------------------------------------
ok('agents.ts referencia isReasoningEffort + mensaje 400 de unión', () => {
  assert.match(agentsSrc, /isReasoningEffort/);
  assert.ok(
    agentsSrc.includes('reasoning_effort must be one of'),
    'falta el mensaje 400 reasoning_effort must be one of ...',
  );
});

// ---------------------------------------------------------------------------
// Wiring: exportImport.ts — enum de la unión, nullable+optional
// ---------------------------------------------------------------------------
ok('exportImport.ts contiene el enum con los 7 valores', () => {
  assert.match(schemaSrc, /z\.enum\(\[/);
  for (const v of ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']) {
    assert.ok(schemaSrc.includes(`'${v}'`), `falta '${v}' en el enum`);
  }
  assert.match(schemaSrc, /reasoning_effort: z\.enum/);
});

// ---------------------------------------------------------------------------
// Comportamiento: rama del send (simulada vía clampReasoningEffort)
// ---------------------------------------------------------------------------
ok('send: lista conocida restringida -> clamped al soportado', () => {
  assert.equal(clampReasoningEffort('max', ['minimal', 'low']), 'low');
});

ok('send: caché fría (null) -> fail-open, requested tal cual', () => {
  assert.equal(clampReasoningEffort('max', null), 'max');
  assert.equal(clampReasoningEffort('max', undefined), 'max');
});

ok("send: supported_efforts [] + effort con valor -> null (bare {enabled:true})", () => {
  assert.equal(clampReasoningEffort('high', []), null);
});

ok("send: 'none' passthrough siempre", () => {
  assert.equal(clampReasoningEffort('none', ['high', 'max']), 'none');
  assert.equal(clampReasoningEffort('none', []), 'none');
  assert.equal(clampReasoningEffort('none', null), 'none');
});

// ---------------------------------------------------------------------------
// Comportamiento: schema de import (unión estricta, resto intacto)
// ---------------------------------------------------------------------------
function agentsPayload(effort: unknown): unknown {
  return {
    version: 1,
    kind: 'agents',
    exported_at: new Date().toISOString(),
    agents: [{ id: 'a1', name: 'A', system_prompt: 'p', reasoning_effort: effort }],
  };
}

ok('import: reasoning_effort válido de la unión se acepta', () => {
  const out = parseImportPayload(agentsPayload('high'));
  assert.equal(out.kind, 'agents');
  if (out.kind !== 'agents') throw new Error('unreachable');
  assert.equal(out.agents[0].reasoning_effort, 'high');
  // Resto del payload intacto: campos del agente preservados + defaults aplicados.
  assert.equal(out.agents[0].name, 'A');
  assert.equal(out.agents[0].system_prompt, 'p');
  assert.equal(out.agents[0].model, 'openrouter/auto');
});

ok('import: reasoning_effort fuera de la unión se rechaza', () => {
  assert.throws(() => parseImportPayload(agentsPayload('ultra')), /reasoning_effort/i);
  assert.throws(() => parseImportPayload(agentsPayload('bogus')), /reasoning_effort/i);
});

ok('import: null/ausente se acepta (nullable+optional)', () => {
  const withNull = parseImportPayload(agentsPayload(null));
  assert.equal(withNull.kind, 'agents');
  const omitted = parseImportPayload({
    version: 1,
    kind: 'agents',
    exported_at: new Date().toISOString(),
    agents: [{ id: 'a1', name: 'A', system_prompt: 'p' }],
  });
  assert.equal(omitted.kind, 'agents');
});

console.log(`\n${checks} checks passed`);
