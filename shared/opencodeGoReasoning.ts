/**
 * Matriz esfuerzo×modelo de OpenCode Go y planificación pura de reasoning.
 *
 * Congela `api.json opencode-go.reasoning_options` (fetch 2026-09-15) para
 * los 28 modelos Go listables (T8/F-04 excluye grok-4.5 por deprecated e
 * inalcanzable): qué niveles de esfuerzo acepta cada modelo, si solo
 * admite on/off y con qué techo de presupuesto. Los consumidores (server y
 * cliente) regulan contra esta matriz sin re-derivar variantes.
 *
 * El vocabulario y el clamp son propiedad exclusiva de
 * `shared/reasoningEfforts.ts`: este módulo solo planifica (elige qué pedir
 * según la lista del modelo) y nunca redefine orden ni reglas. Cero
 * dependencias por diseño, como `shared/reasoningEfforts.ts`: importable
 * desde el servidor (sufijo `.js`) y desde el cliente (sin sufijo).
 *
 * Convenciones de capacidad:
 * - `effortValues: []` = sin control del llamante (always-on; degradación
 *   honesta con badge, nunca se envía esfuerzo).
 * - `effortValues: null` = toggle-only (on/off sin gradación).
 * - `budgetMax` = techo de presupuesto messages (`budget_tokens`); `null` =
 *   sin presupuesto declarado.
 * - Claves siempre bare id (el strip de `opencode-go:` vive en los helpers,
 *   nunca en el llamador). `unknown` = fail-open (`null` en lookup,
 *   passthrough en planificación).
 */
import { clampReasoningEffort, filterSupportedEfforts } from './reasoningEfforts.js';

/** Fecha del fetch api.json que congela la matriz (pin-update por wave si deriva). */
export const OPENCODE_GO_REASONING_MATRIX_VERSION = '2026-09-15';

/** Capacidad de reasoning de un modelo Go (qué knob ofrece el host). */
export interface GoReasoningKnob {
  effortValues: readonly string[] | null;
  canToggle: boolean;
  budgetMax: number | null;
}

// Matriz congelada por bare id (fuente: receta §Topes, 2026-09-15).
const KNOBS: ReadonlyArray<readonly [string, GoReasoningKnob]> = [
  // Chat, tope max, sin off listado.
  ['kimi-k3', { effortValues: ['max'], canToggle: false, budgetMax: null }],
  ['glm-5.2', { effortValues: ['high', 'max'], canToggle: false, budgetMax: null }],
  ['deepseek-v4-pro', { effortValues: ['high', 'max'], canToggle: false, budgetMax: null }],
  ['glm-5.3', { effortValues: ['low', 'high', 'max'], canToggle: false, budgetMax: null }],
  ['glm-5.3-flash', { effortValues: ['low', 'high', 'max'], canToggle: false, budgetMax: null }],
  ['deepseek-v4-flash', { effortValues: ['low', 'high', 'max'], canToggle: false, budgetMax: null }],
  // Único chat con toggle además de gradación.
  ['deepseek-v4-flash-vision-exp', { effortValues: ['low', 'high', 'max'], canToggle: true, budgetMax: null }],
  ['deepseek-v4.1-flash', { effortValues: ['low', 'high', 'max'], canToggle: false, budgetMax: null }],
  // Chat con off (`none` listado).
  ['hy3', { effortValues: ['none', 'low', 'high'], canToggle: false, budgetMax: null }],
  ['hy4-preview', { effortValues: ['none', 'high'], canToggle: false, budgetMax: null }],
  // Chat toggle-only (on/off sin gradación).
  ['longcat-2.0', { effortValues: null, canToggle: true, budgetMax: null }],
  // Chat sin control (always-on; badge "thinking fijo").
  ['mimo-v2.5', { effortValues: [], canToggle: false, budgetMax: null }],
  ['mimo-v2.5-pro', { effortValues: [], canToggle: false, budgetMax: null }],
  ['kimi-k2.6', { effortValues: [], canToggle: false, budgetMax: null }],
  ['kimi-k2.7-code', { effortValues: [], canToggle: false, budgetMax: null }],
  ['glm-5.1', { effortValues: [], canToggle: false, budgetMax: null }],
  // Messages toggle-only / sin control.
  ['minimax-m3', { effortValues: null, canToggle: true, budgetMax: null }],
  ['minimax-m2.7', { effortValues: [], canToggle: false, budgetMax: null }],
  ['minimax-m2.5', { effortValues: [], canToggle: false, budgetMax: null }],
  // Messages on/off + presupuesto.
  ['qwen3.6-plus', { effortValues: null, canToggle: true, budgetMax: 81920 }],
  ['qwen3.7-max', { effortValues: null, canToggle: true, budgetMax: 262144 }],
  ['qwen3.7-plus', { effortValues: null, canToggle: true, budgetMax: 262144 }],
  // Messages on/off + gradación tope xhigh + presupuesto (flash sin techo declarado).
  ['qwen3.8-max', { effortValues: ['low', 'medium', 'xhigh'], canToggle: true, budgetMax: 262144 }],
  ['qwen3.8-flash', { effortValues: ['low', 'medium', 'xhigh'], canToggle: true, budgetMax: null }],
  // Responses (wire `reasoning:{effort}`).
  ['gpt-5.6-luna', { effortValues: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], canToggle: false, budgetMax: null }],
  ['grok-4.6', { effortValues: ['low', 'medium', 'high', 'xhigh'], canToggle: false, budgetMax: null }],
  // T8/F-04: grok-4.5 excluido (deprecated, K3 `Model is unavailable` ×3) — sin knob.
  ['muse-spark-1.3-contributor', { effortValues: ['minimal', 'low', 'medium', 'high', 'xhigh'], canToggle: false, budgetMax: null }],
  ['muse-spark-1.2-contributor', { effortValues: ['minimal', 'low', 'medium', 'high', 'xhigh'], canToggle: false, budgetMax: null }],
];

/** Matriz congelada por bare id (28 modelos; `null` en lookup = unknown fail-open). */
export const OPENCODE_GO_REASONING_KNOBS: ReadonlyMap<string, GoReasoningKnob> = new Map(KNOBS);

// Quita el namespace del llamador (las claves siempre son bare ids).
function stripGoPrefix(bareOrNamespaced: string): string {
  return bareOrNamespaced.startsWith('opencode-go:')
    ? bareOrNamespaced.slice('opencode-go:'.length)
    : bareOrNamespaced;
}

/**
 * Knob del modelo (`null` = unknown fail-open: el llamador no inventa
 * capacidad y planifica en abierto).
 */
export function goReasoningKnobFor(bareOrNamespaced: string): GoReasoningKnob | null {
  return OPENCODE_GO_REASONING_KNOBS.get(stripGoPrefix(bareOrNamespaced)) ?? null;
}

/**
 * Esfuerzo a pedir al modelo (misma regla que el snippet `planEffort`).
 *
 * - unknown → `want` tal cual (fail-open).
 * - toggle-only o sin control (`[]`) → `null` (nada que graduar).
 * - resto → `clampReasoningEffort` contra la lista del modelo.
 */
export function planGoReasoningEffort(
  bareOrNamespaced: string,
  want: string | null | undefined,
): string | null {
  const knob = goReasoningKnobFor(bareOrNamespaced);
  if (knob === null) return want ?? null;
  if (knob.effortValues === null || knob.effortValues.length === 0) return null;
  return clampReasoningEffort(want, knob.effortValues);
}

/**
 * Mínimo esfuerzo listado excluyendo `none` (restricción honesta máxima
 * disponible; `null` si no hay gradación o el modelo es unknown).
 */
export function goReasoningFloor(bareOrNamespaced: string): string | null {
  const knob = goReasoningKnobFor(bareOrNamespaced);
  if (knob?.effortValues == null) return null;
  const levels = (filterSupportedEfforts(knob.effortValues) ?? []).filter((v) => v !== 'none');
  return levels.length > 0 ? levels[0] : null;
}

/**
 * Esfuerzo que apaga el thinking (`none` donde listado; si no, floor; si no,
 * `null` porque apagar no es un valor de esfuerzo en ese modelo).
 */
export function goReasoningOff(bareOrNamespaced: string): string | null {
  const knob = goReasoningKnobFor(bareOrNamespaced);
  if (knob?.effortValues == null) return null;
  if (knob.effortValues.includes('none')) return 'none';
  return goReasoningFloor(bareOrNamespaced);
}

/** `true` solo si el modelo es sin control (`[]`): badge "thinking fijo". */
export function goReasoningNoControl(bareOrNamespaced: string): boolean {
  const knob = goReasoningKnobFor(bareOrNamespaced);
  return knob !== null && knob.effortValues !== null && knob.effortValues.length === 0;
}

/** Presupuesto messages por defecto según esfuerzo (cuando no hay maxTokens válido). */
export const GO_MESSAGES_EFFORT_BUDGETS: Readonly<Record<string, number>> = {
  minimal: 4096,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
};

/** Default cuando no hay esfuerzo conocido en un knob sin gradación. */
export const GO_TOGGLE_ONLY_BUDGET_DEFAULT = 8192;

/** Techo cuando el knob admite presupuesto pero no declara máximo. */
export const GO_TOGGLE_ONLY_BUDGET_CEIL = 32768;

// Mínimo absoluto de presupuesto (piso Anthropic `budget_tokens`).
const GO_MESSAGES_BUDGET_FLOOR = 1024;

// Clampa un presupuesto al rango aplicable (fuera de rango se clampa, nunca se rechaza).
function clampGoBudget(value: number, ceil: number): number {
  return Math.min(Math.max(Math.floor(value), GO_MESSAGES_BUDGET_FLOOR), ceil);
}

/**
 * Presupuesto messages a pedir (`null` = este modelo no acepta presupuesto:
 * sin control, sin capacidad budget, o unknown).
 *
 * - Con `budgetMax`: `maxTokens` válido se clampa a `[1024, budgetMax]`; si
 *   no, default-por-esfuerzo clampado al mismo rango.
 * - Toggle-only sin máximo declarado: igual con ceil 32768 y default 8192.
 */
export function planGoMessagesBudget(
  bareOrNamespaced: string,
  opts: { effort?: string | null; maxTokens?: number | null },
): number | null {
  const knob = goReasoningKnobFor(bareOrNamespaced);
  if (knob === null) return null;
  if (knob.effortValues !== null && knob.effortValues.length === 0) return null;
  const ceil = knob.budgetMax ?? (knob.canToggle ? GO_TOGGLE_ONLY_BUDGET_CEIL : null);
  if (ceil === null) return null;
  const maxTokens = opts.maxTokens;
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) {
    return clampGoBudget(maxTokens, ceil);
  }
  const fallback = (opts.effort != null ? GO_MESSAGES_EFFORT_BUDGETS[opts.effort] : undefined)
    ?? GO_TOGGLE_ONLY_BUDGET_DEFAULT;
  return clampGoBudget(fallback, ceil);
}
