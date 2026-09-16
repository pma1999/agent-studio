/**
 * Task T1: módulo compartido de variantes Go + harness unitario.
 *
 * Congela la matriz esfuerzo×modelo de los 28 modelos OpenCode Go
 * (`shared/opencodeGoReasoning.ts`, versión `2026-09-15`) y sus helpers puros
 * de planificación. Vocabulario y clamp siguen siendo propiedad de
 * `shared/reasoningEfforts.ts`; aquí solo se planifica contra la lista del
 * modelo. Estilo `node:assert` + helper `ok`, como
 * `scripts/test-reasoning-effort.ts`.
 *
 * Señal esperada: rojo antes de crear el módulo (símbolos inexistentes),
 * verde después. Offline-safe, db-free.
 */
import assert from 'node:assert/strict';
import {
  OPENCODE_GO_REASONING_MATRIX_VERSION,
  OPENCODE_GO_REASONING_KNOBS,
  GO_MESSAGES_EFFORT_BUDGETS,
  GO_TOGGLE_ONLY_BUDGET_DEFAULT,
  GO_TOGGLE_ONLY_BUDGET_CEIL,
  goReasoningKnobFor,
  planGoReasoningEffort,
  goReasoningFloor,
  goReasoningOff,
  goReasoningNoControl,
  planGoMessagesBudget,
} from '../shared/opencodeGoReasoning.js';

let checks = 0;
function ok(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

// ---------------------------------------------------------------------------
// Versión congelada + forma de la matriz (28 bare ids, sin prefijos)
// ---------------------------------------------------------------------------
ok('MATRIX_VERSION es 2026-09-15', () => {
  assert.equal(OPENCODE_GO_REASONING_MATRIX_VERSION, '2026-09-15');
});

ok('matriz con 28 bare ids, ninguno con prefijo', () => {
  assert.equal(OPENCODE_GO_REASONING_KNOBS.size, 28);
  for (const key of OPENCODE_GO_REASONING_KNOBS.keys()) {
    assert.ok(!key.includes(':'), `bare id sin prefijo: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Matriz congelada por familia (api.json reasoning_options, 2026-09-15)
// ---------------------------------------------------------------------------
ok('chat max: kimi-k3 solo max sin toggle ni budget', () => {
  assert.deepEqual(goReasoningKnobFor('kimi-k3'), {
    effortValues: ['max'],
    canToggle: false,
    budgetMax: null,
  });
});

ok('chat max: glm-5.2 y deepseek-v4-pro [high,max]', () => {
  for (const id of ['glm-5.2', 'deepseek-v4-pro']) {
    assert.deepEqual(goReasoningKnobFor(id), {
      effortValues: ['high', 'max'],
      canToggle: false,
      budgetMax: null,
    });
  }
});

ok('chat max: familia [low,high,max]; solo vision-exp con toggle', () => {
  for (const id of ['glm-5.3', 'glm-5.3-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash']) {
    assert.deepEqual(goReasoningKnobFor(id), {
      effortValues: ['low', 'high', 'max'],
      canToggle: false,
      budgetMax: null,
    });
  }
  assert.deepEqual(goReasoningKnobFor('deepseek-v4-flash-vision-exp'), {
    effortValues: ['low', 'high', 'max'],
    canToggle: true,
    budgetMax: null,
  });
});

ok('chat off: hy3 [none,low,high], hy4-preview [none,high]', () => {
  assert.deepEqual(goReasoningKnobFor('hy3'), {
    effortValues: ['none', 'low', 'high'],
    canToggle: false,
    budgetMax: null,
  });
  assert.deepEqual(goReasoningKnobFor('hy4-preview'), {
    effortValues: ['none', 'high'],
    canToggle: false,
    budgetMax: null,
  });
});

ok('chat toggle-only: longcat-2.0', () => {
  assert.deepEqual(goReasoningKnobFor('longcat-2.0'), {
    effortValues: null,
    canToggle: true,
    budgetMax: null,
  });
});

ok('chat sin control: mimo/kimi-k2.6/kimi-k2.7-code/glm-5.1 con []', () => {
  for (const id of ['mimo-v2.5', 'mimo-v2.5-pro', 'kimi-k2.6', 'kimi-k2.7-code', 'glm-5.1']) {
    assert.deepEqual(goReasoningKnobFor(id), {
      effortValues: [],
      canToggle: false,
      budgetMax: null,
    });
  }
});

ok('messages: minimax-m3 toggle-only; minimax-m2.7/m2.5 sin control', () => {
  assert.deepEqual(goReasoningKnobFor('minimax-m3'), {
    effortValues: null,
    canToggle: true,
    budgetMax: null,
  });
  for (const id of ['minimax-m2.7', 'minimax-m2.5']) {
    assert.deepEqual(goReasoningKnobFor(id), {
      effortValues: [],
      canToggle: false,
      budgetMax: null,
    });
  }
});

ok('messages: qwen con budget (3.6-plus 81920; 3.7 262144)', () => {
  assert.deepEqual(goReasoningKnobFor('qwen3.6-plus'), {
    effortValues: null,
    canToggle: true,
    budgetMax: 81920,
  });
  for (const id of ['qwen3.7-max', 'qwen3.7-plus']) {
    assert.deepEqual(goReasoningKnobFor(id), {
      effortValues: null,
      canToggle: true,
      budgetMax: 262144,
    });
  }
});

ok('messages: qwen3.8 con gradación tope xhigh (max con techo; flash sin techo)', () => {
  assert.deepEqual(goReasoningKnobFor('qwen3.8-max'), {
    effortValues: ['low', 'medium', 'xhigh'],
    canToggle: true,
    budgetMax: 262144,
  });
  assert.deepEqual(goReasoningKnobFor('qwen3.8-flash'), {
    effortValues: ['low', 'medium', 'xhigh'],
    canToggle: true,
    budgetMax: null,
  });
});

ok('responses: luna/grok-4.6/spark con sus topes (grok-4.5 excluido T8/F-04)', () => {
  assert.deepEqual(goReasoningKnobFor('gpt-5.6-luna'), {
    effortValues: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    canToggle: false,
    budgetMax: null,
  });
  assert.deepEqual(goReasoningKnobFor('grok-4.6'), {
    effortValues: ['low', 'medium', 'high', 'xhigh'],
    canToggle: false,
    budgetMax: null,
  });
  // T8/F-04: grok-4.5 excluido — sin knob (fail-closed: ni enviable ni
  // seleccionable; el lookup unknown es teórico, ya no se lista ni persiste).
  assert.equal(goReasoningKnobFor('grok-4.5'), null);
  assert.equal(goReasoningFloor('grok-4.5'), null);
  assert.equal(goReasoningOff('grok-4.5'), null);
  for (const id of ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor']) {
    assert.deepEqual(goReasoningKnobFor(id), {
      effortValues: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      canToggle: false,
      budgetMax: null,
    });
  }
});

// ---------------------------------------------------------------------------
// planGoReasoningEffort: clamp por familia vía clampReasoningEffort
// ---------------------------------------------------------------------------
ok('kimi-k3: todo esfuerzo valuado clampa a max', () => {
  for (const want of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(planGoReasoningEffort('kimi-k3', want), 'max', want);
  }
  assert.equal(planGoReasoningEffort('opencode-go:kimi-k3', 'low'), 'max');
});

ok("spark y grok-4.6: max clampa a xhigh (tope del host, no del peso)", () => {
  assert.equal(planGoReasoningEffort('muse-spark-1.3-contributor', 'max'), 'xhigh');
  assert.equal(planGoReasoningEffort('muse-spark-1.2-contributor', 'max'), 'xhigh');
  assert.equal(planGoReasoningEffort('grok-4.6', 'max'), 'xhigh');
  assert.equal(planGoReasoningEffort('muse-spark-1.3-contributor', 'high'), 'high');
});

ok('luna: max pasa tal cual y none es passthrough del clamp', () => {
  assert.equal(planGoReasoningEffort('gpt-5.6-luna', 'max'), 'max');
  assert.equal(planGoReasoningEffort('gpt-5.6-luna', 'none'), 'none');
});

ok('toggle-only y sin-control devuelven null (nada que planificar)', () => {
  assert.equal(planGoReasoningEffort('longcat-2.0', 'high'), null);
  assert.equal(planGoReasoningEffort('minimax-m3', 'high'), null);
  assert.equal(planGoReasoningEffort('mimo-v2.5', 'high'), null);
  assert.equal(planGoReasoningEffort('minimax-m2.7', 'high'), null);
  assert.equal(planGoReasoningEffort('mimo-v2.5', null), null);
  assert.equal(planGoReasoningEffort('mimo-v2.5', undefined), null);
});

// ---------------------------------------------------------------------------
// Floors y off (§Acceptance)
// ---------------------------------------------------------------------------
ok('goReasoningFloor: mínimo listado excluyendo none', () => {
  assert.equal(goReasoningFloor('kimi-k3'), 'max');
  assert.equal(goReasoningFloor('hy3'), 'low');
  assert.equal(goReasoningFloor('hy4-preview'), 'high');
  assert.equal(goReasoningFloor('muse-spark-1.3-contributor'), 'minimal');
  assert.equal(goReasoningFloor('grok-4.6'), 'low');
  assert.equal(goReasoningFloor('gpt-5.6-luna'), 'low');
  assert.equal(goReasoningFloor('qwen3.8-max'), 'low');
  assert.equal(goReasoningFloor('longcat-2.0'), null);
  assert.equal(goReasoningFloor('mimo-v2.5'), null);
  assert.equal(goReasoningFloor('opencode-go:inexistente'), null);
});

ok('goReasoningOff: none donde listado, si no floor, si no null', () => {
  assert.equal(goReasoningOff('gpt-5.6-luna'), 'none');
  assert.equal(goReasoningOff('hy3'), 'none');
  assert.equal(goReasoningOff('grok-4.6'), 'low');
  assert.equal(goReasoningOff('muse-spark-1.3-contributor'), 'minimal');
  assert.equal(goReasoningOff('hy4-preview'), 'none');
  assert.equal(goReasoningOff('kimi-k3'), 'max');
  assert.equal(goReasoningOff('mimo-v2.5'), null);
  assert.equal(goReasoningOff('minimax-m2.7'), null);
  assert.equal(goReasoningOff('longcat-2.0'), null);
  assert.equal(goReasoningOff('opencode-go:inexistente'), null);
});

// ---------------------------------------------------------------------------
// Budgets messages
// ---------------------------------------------------------------------------
ok('constantes de budget messages', () => {
  assert.deepEqual({ ...GO_MESSAGES_EFFORT_BUDGETS }, {
    minimal: 4096,
    low: 4096,
    medium: 8192,
    high: 16384,
    xhigh: 32768,
    max: 65536,
  });
  assert.equal(GO_TOGGLE_ONLY_BUDGET_DEFAULT, 8192);
  assert.equal(GO_TOGGLE_ONLY_BUDGET_CEIL, 32768);
});

ok('qwen3.6-plus: 100000 clampa al techo 81920', () => {
  assert.equal(planGoMessagesBudget('qwen3.6-plus', { maxTokens: 100000 }), 81920);
  assert.equal(planGoMessagesBudget('opencode-go:qwen3.6-plus', { maxTokens: 100000 }), 81920);
});

ok('qwen3.7: techo 262144', () => {
  assert.equal(planGoMessagesBudget('qwen3.7-max', { maxTokens: 300000 }), 262144);
  assert.equal(planGoMessagesBudget('qwen3.7-plus', { maxTokens: 262144 }), 262144);
});

ok('default por esfuerzo (high -> 16384) sin maxTokens', () => {
  assert.equal(planGoMessagesBudget('qwen3.6-plus', { effort: 'high' }), 16384);
  assert.equal(planGoMessagesBudget('qwen3.7-plus', { effort: 'high' }), 16384);
  assert.equal(planGoMessagesBudget('qwen3.6-plus', {}), 8192);
});

ok('reasoning_max_tokens fuera de rango se clampa, no se rechaza', () => {
  assert.equal(planGoMessagesBudget('qwen3.6-plus', { maxTokens: 10 }), 1024);
  assert.equal(planGoMessagesBudget('qwen3.6-plus', { maxTokens: 0 }), 1024);
  assert.equal(planGoMessagesBudget('qwen3.6-plus', { maxTokens: 4096 }), 4096);
});

ok('sin control o sin budget: null (minimax-m2.7, chat, responses, unknown)', () => {
  assert.equal(planGoMessagesBudget('minimax-m2.7', { effort: 'high' }), null);
  assert.equal(planGoMessagesBudget('minimax-m2.5', { maxTokens: 4096 }), null);
  assert.equal(planGoMessagesBudget('mimo-v2.5', { effort: 'high' }), null);
  assert.equal(planGoMessagesBudget('kimi-k3', { effort: 'high' }), null);
  assert.equal(planGoMessagesBudget('gpt-5.6-luna', { effort: 'high' }), null);
  assert.equal(planGoMessagesBudget('opencode-go:inexistente', { effort: 'high' }), null);
});

ok('toggle-only sin techo declarado usa ceil 32768 y default 8192', () => {
  assert.equal(planGoMessagesBudget('minimax-m3', {}), 8192);
  assert.equal(planGoMessagesBudget('minimax-m3', { maxTokens: 100000 }), 32768);
});

// ---------------------------------------------------------------------------
// Badge y fail-open
// ---------------------------------------------------------------------------
ok('goReasoningNoControl: true solo con []', () => {
  assert.equal(goReasoningNoControl('mimo-v2.5'), true);
  assert.equal(goReasoningNoControl('minimax-m2.7'), true);
  assert.equal(goReasoningNoControl('kimi-k3'), false);
  assert.equal(goReasoningNoControl('longcat-2.0'), false);
  assert.equal(goReasoningNoControl('gpt-5.6-luna'), false);
  assert.equal(goReasoningNoControl('opencode-go:inexistente'), false);
});

ok('fail-open: unknown devuelve null en lookup y passthrough en plan', () => {
  assert.equal(goReasoningKnobFor('opencode-go:inexistente'), null);
  assert.equal(goReasoningKnobFor('openrouter/auto'), null);
  assert.equal(planGoReasoningEffort('opencode-go:inexistente', 'high'), 'high');
  assert.equal(planGoReasoningEffort('opencode-go:inexistente', null), null);
  assert.equal(planGoReasoningEffort('opencode-go:inexistente', undefined), null);
});

ok('strip de opencode-go: resuelve igual que el bare id', () => {
  assert.deepEqual(
    goReasoningKnobFor('opencode-go:grok-4.6'),
    goReasoningKnobFor('grok-4.6'),
  );
  assert.equal(planGoReasoningEffort('opencode-go:grok-4.6', 'max'), 'xhigh');
  assert.equal(goReasoningOff('opencode-go:hy3'), 'none');
});

console.log(`\n${checks} checks passed`);
