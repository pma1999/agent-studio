/**
 * Task t1-catalog: fundación de datos (shared + proxy + tests).
 *
 * Comportamiento real del módulo canónico `shared/reasoningEfforts.ts` y del
 * mapper del proxy `server/routes/models.ts` (matriz de plan.md § Cross-task
 * interfaces + brief de la task). Estilo `node:assert` + helper `ok`, como
 * `scripts/test-llamacpp-chat-gates.ts`.
 *
 * Señal esperada: rojo antes del cambio (símbolos inexistentes), verde tras
 * implementar. Offline-safe, db-free (importa el router pero no sirve nada).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REASONING_EFFORT_ORDER,
  isReasoningEffort,
  filterSupportedEfforts,
  clampReasoningEffort,
  lookupSupportedEfforts,
} from '../shared/reasoningEfforts.js';
import {
  mapOpenRouterCatalogEntry,
  getCachedOpenRouterSupportedEfforts,
} from '../server/routes/models.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// Orden canónico congelado + vocabulario
// ---------------------------------------------------------------------------
ok('REASONING_EFFORT_ORDER es [minimal,low,medium,high,xhigh,max]', () => {
  assert.deepEqual([...REASONING_EFFORT_ORDER], ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!([...REASONING_EFFORT_ORDER] as string[]).includes('ultra'), "'ultra' no existe en el orden");
});

ok("isReasoningEffort acepta la unión + 'none', rechaza 'ultra' y basura", () => {
  for (const v of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none']) {
    assert.equal(isReasoningEffort(v), true, v);
  }
  for (const v of ['ultra', 'ULTRA', 'Max', '', 'auto', 123, null, undefined, {}, []]) {
    assert.equal(isReasoningEffort(v), false, JSON.stringify(v));
  }
});

// ---------------------------------------------------------------------------
// filterSupportedEfforts
// ---------------------------------------------------------------------------
ok("filterSupportedEfforts(['max','high']) -> ['high','max'] (orden canónico)", () => {
  assert.deepEqual(filterSupportedEfforts(['max', 'high']), ['high', 'max']);
});

ok('filterSupportedEfforts(null/undefined) -> null; ([]) -> []', () => {
  assert.equal(filterSupportedEfforts(null), null);
  assert.equal(filterSupportedEfforts(undefined), null);
  assert.deepEqual(filterSupportedEfforts([]), []);
});

ok("filterSupportedEfforts descarta basura y 'ultra' nunca aparece", () => {
  assert.deepEqual(filterSupportedEfforts(['ultra', 'high', 'bogus', '']), ['high']);
  assert.deepEqual(filterSupportedEfforts(['ultra']), []);
  const out = filterSupportedEfforts(['max', 'ultra', 'xhigh', 'nope'])!;
  assert.ok(!out.includes('ultra' as never), "'ultra' filtrado");
  assert.deepEqual(out, ['xhigh', 'max']);
});

ok('filterSupportedEfforts deduplica y devuelve copia nueva', () => {
  const input = ['high', 'high', 'max'];
  const out = filterSupportedEfforts(input)!;
  assert.deepEqual(out, ['high', 'max']);
  assert.notStrictEqual(out, input);
});

// ---------------------------------------------------------------------------
// clampReasoningEffort
// ---------------------------------------------------------------------------
ok("clampReasoningEffort: passthrough 'none'/null", () => {
  assert.equal(clampReasoningEffort('none', ['high', 'max']), 'none');
  assert.equal(clampReasoningEffort('none', null), 'none');
  assert.equal(clampReasoningEffort(null, ['high', 'max']), null);
  assert.equal(clampReasoningEffort(null, null), null);
});

ok('clampReasoningEffort: lista desconocida -> requested tal cual', () => {
  assert.equal(clampReasoningEffort('max', null), 'max');
  assert.equal(clampReasoningEffort('max', undefined), 'max');
  assert.equal(clampReasoningEffort('high', null), 'high');
});

ok("clampReasoningEffort: [] + 'high' -> null (omitir effort)", () => {
  assert.equal(clampReasoningEffort('high', []), null);
});

ok("clampReasoningEffort: 'max' vs ['minimal','low'] -> 'low' (nearest-lower)", () => {
  assert.equal(clampReasoningEffort('max', ['minimal', 'low']), 'low');
});

ok("clampReasoningEffort: 'minimal' vs ['high','max'] -> 'high' (nearest-higher)", () => {
  assert.equal(clampReasoningEffort('minimal', ['high', 'max']), 'high');
});

ok('clampReasoningEffort: valor soportado -> tal cual', () => {
  assert.equal(clampReasoningEffort('high', ['high', 'max']), 'high');
  assert.equal(clampReasoningEffort('low', ['minimal', 'low', 'medium']), 'low');
});

ok("clampReasoningEffort: basura 'ultra' vs lista con 'medium' -> 'medium'", () => {
  assert.equal(clampReasoningEffort('ultra', ['low', 'medium', 'high']), 'medium');
});

ok('clampReasoningEffort: basura vs lista sin medium -> central floor determinista', () => {
  assert.equal(clampReasoningEffort('ultra', ['high', 'max']), 'high');
  assert.equal(clampReasoningEffort('bogus', ['max']), 'max');
  assert.equal(clampReasoningEffort('ultra', ['minimal', 'low', 'high', 'max']), 'low');
  // Determinista: misma entrada, misma salida.
  assert.equal(
    clampReasoningEffort('ultra', ['minimal', 'low', 'high', 'max']),
    clampReasoningEffort('ultra', ['max', 'minimal', 'high', 'low']),
  );
});

// ---------------------------------------------------------------------------
// lookupSupportedEfforts
// ---------------------------------------------------------------------------
const ENTRIES = [
  { id: 'author/full', reasoning: { supported_efforts: ['high', 'max'] } },
  { id: 'author/empty-reasoning' },
  { id: 'author/null-reasoning', reasoning: null },
  { id: 'author/no-list', reasoning: {} },
];

ok("lookupSupportedEfforts: 'deepseek:x'/'codex:y'/'llamacpp:z' -> null", () => {
  assert.equal(lookupSupportedEfforts(ENTRIES, 'deepseek:x'), null);
  assert.equal(lookupSupportedEfforts(ENTRIES, 'codex:y'), null);
  assert.equal(lookupSupportedEfforts(ENTRIES, 'llamacpp:z'), null);
});

ok("lookupSupportedEfforts: 'openrouter/auto' -> null", () => {
  assert.equal(lookupSupportedEfforts(ENTRIES, 'openrouter/auto'), null);
});

ok('lookupSupportedEfforts: ausente o sin lista -> null', () => {
  assert.equal(lookupSupportedEfforts(ENTRIES, 'author/missing'), null);
  assert.equal(lookupSupportedEfforts(ENTRIES, 'author/empty-reasoning'), null);
  assert.equal(lookupSupportedEfforts(ENTRIES, 'author/null-reasoning'), null);
  assert.equal(lookupSupportedEfforts(ENTRIES, 'author/no-list'), null);
  assert.equal(lookupSupportedEfforts([], 'author/full'), null);
});

ok('lookupSupportedEfforts: presente -> copia verbatim', () => {
  const out = lookupSupportedEfforts(ENTRIES, 'author/full')!;
  assert.deepEqual(out, ['high', 'max']);
  assert.notStrictEqual(out, ENTRIES[0].reasoning.supported_efforts);
});

// ---------------------------------------------------------------------------
// mapOpenRouterCatalogEntry (proxy puro)
// ---------------------------------------------------------------------------
ok('mapOpenRouterCatalogEntry: con reasoning completo -> passthrough', () => {
  const out = mapOpenRouterCatalogEntry({
    id: 'author/full',
    name: 'Full',
    description: 'd',
    context_length: 128,
    pricing: { prompt: '1', completion: '2' },
    reasoning: { supported_efforts: ['high', 'max'], mandatory: false, default_effort: 'high' },
    canonical_slug: 'extra-no-mapeado',
  });
  assert.equal(out.id, 'author/full');
  assert.equal(out.name, 'Full');
  assert.equal(out.description, 'd');
  assert.equal(out.context_length, 128);
  assert.deepEqual(out.pricing, { prompt: '1', completion: '2' });
  assert.deepEqual(out.reasoning, {
    supported_efforts: ['high', 'max'],
    mandatory: false,
    default_effort: 'high',
  });
  assert.ok(!('canonical_slug' in out), 'no filtra campos extra al proxy');
});

ok('mapOpenRouterCatalogEntry: sin reasoning -> null; resto idéntico al mapper actual', () => {
  const out = mapOpenRouterCatalogEntry({
    id: 'author/plain',
    name: 'Plain',
    pricing: {},
  });
  assert.deepEqual(out, {
    id: 'author/plain',
    name: 'Plain',
    description: '',
    context_length: 0,
    pricing: { prompt: '0', completion: '0' },
    reasoning: null,
  });
});

// ---------------------------------------------------------------------------
// getCachedOpenRouterSupportedEfforts (caché vacía: sin fetch, null)
// ---------------------------------------------------------------------------
ok('getCachedOpenRouterSupportedEfforts: caché vacía -> null sin fetch nuevo', () => {
  // Módulo recién importado: modelsCache arranca vacía.
  assert.equal(getCachedOpenRouterSupportedEfforts('author/full'), null);
  assert.equal(getCachedOpenRouterSupportedEfforts('openrouter/auto'), null);
  assert.equal(getCachedOpenRouterSupportedEfforts('deepseek:x'), null);
  // Síncrono por construcción: no hay fetch que esperar.
  assert.doesNotMatch(getCachedOpenRouterSupportedEfforts.toString(), /fetch\(/);
});

// ---------------------------------------------------------------------------
// Gates de wiring: TTL 5-min y stale-fallback intactos
// ---------------------------------------------------------------------------
ok('proxy: TTL 5-min y stale-fallback intactos en server/routes/models.ts', () => {
  const src = readFileSync(resolve(process.cwd(), 'server/routes/models.ts'), 'utf8');
  assert.match(src, /const CACHE_TTL = 5 \* 60 \* 1000;/);
  assert.match(src, /Return stale cache if available/);
  assert.match(src, /from '\.\.\/\.\.\/shared\/reasoningEfforts\.js'/);
});

console.log(`\n${checks} checks passed`);
