/**
 * Reasoning capability descriptor + the single planning rule shared by the UI,
 * the chat route and the council.
 *
 * A `ReasoningCapability` describes what a concrete model *on a concrete host
 * wire* lets the caller control: whether it thinks at all, whether thinking can
 * be switched off, which graded levels exist and whether a token budget is
 * accepted. Provider adapters build it from each host's own metadata; nothing
 * downstream branches on the provider to decide what to render or send.
 *
 * Vocabulary and ordering stay owned by `shared/reasoningEfforts.ts` (frozen
 * contract); this module composes it. Zero dependencies outside `shared/`.
 */
import { REASONING_EFFORT_ORDER, clampReasoningEffort, filterSupportedEfforts } from '../reasoningEfforts.js';

/** A graded reasoning level (never `'none'`: switching off is the toggle). */
export type ReasoningLevel = (typeof REASONING_EFFORT_ORDER)[number];

/** How "off" travels on the host wire when the model can be switched off. */
export type ReasoningDisableVia = 'toggle' | 'none-effort';

/**
 * Where the level list comes from.
 * - `model`: the host publishes this model's own levels.
 * - `host`: the host accepts this vocabulary for every model (gateway or chat
 *   template); the model may treat some levels alike.
 * - `unknown`: nothing published; the UI fails open.
 */
export type ReasoningLevelsSource = 'model' | 'host' | 'unknown';

export interface ReasoningBudget {
  min: number | null;
  max: number | null;
}

export interface ReasoningCapability {
  /** `unknown` = no metadata; callers fail open (every level + switch). */
  status: 'known' | 'unknown';
  /** False when the model does not think at all. */
  supported: boolean;
  /** True when thinking can be switched off on this host wire. */
  canDisable: boolean;
  /** Wire used to switch off; null when `canDisable` is false or unknown. */
  disableVia: ReasoningDisableVia | null;
  /** Graded levels in canonical order; `[]` = no graded control. */
  levels: ReasoningLevel[];
  /** Host default for the switch, when published. */
  defaultEnabled: boolean | null;
  /** Host default level, when published and part of `levels`. */
  defaultLevel: ReasoningLevel | null;
  /** Token budget accepted by the host, when it has a reasoning-budget field. */
  budget: ReasoningBudget | null;
  /** Official per-level copy from the host, when published. */
  levelDescriptions: Partial<Record<ReasoningLevel, string>> | null;
  levelsSource: ReasoningLevelsSource;
}

const LEVEL_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_ORDER);

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && LEVEL_SET.has(value);
}

/** Canonical, deduplicated levels from any upstream list (drops `none` and garbage). */
export function normalizeLevels(values: readonly unknown[] | null | undefined): ReasoningLevel[] {
  const strings = (values ?? []).filter((v): v is string => typeof v === 'string');
  return (filterSupportedEfforts(strings) ?? []).filter(isReasoningLevel);
}

/** The model does not think. */
export function noReasoning(): ReasoningCapability {
  return {
    status: 'known',
    supported: false,
    canDisable: false,
    disableVia: null,
    levels: [],
    defaultEnabled: null,
    defaultLevel: null,
    budget: null,
    levelDescriptions: null,
    levelsSource: 'model',
  };
}

/** Nothing is published for this model: fail open. */
export function unknownReasoning(): ReasoningCapability {
  return {
    status: 'unknown',
    supported: true,
    canDisable: true,
    disableVia: null,
    levels: [...REASONING_EFFORT_ORDER],
    defaultEnabled: null,
    defaultLevel: null,
    budget: null,
    levelDescriptions: null,
    levelsSource: 'unknown',
  };
}

/**
 * Controls a host wire can express. A model's published option only becomes
 * part of the capability when its host wire can actually carry it.
 */
export interface ReasoningWireSupport {
  /** A dedicated on/off field (e.g. `thinking.type`, `reasoning.enabled`). */
  toggle: boolean;
  /** `effort: 'none'` switches thinking off. */
  noneEffort: boolean;
  /** A graded effort field. */
  effort: boolean;
  /** A reasoning token budget field. */
  budget: boolean;
}

/** Published controls, independent of any host wire. */
export interface PublishedReasoningControls {
  toggle: boolean;
  /** Raw effort values as published (may include `none`); null = none published. */
  effortValues: readonly unknown[] | null;
  budget: ReasoningBudget | null;
  defaultEnabled?: boolean | null;
  defaultLevel?: unknown;
  levelDescriptions?: Partial<Record<ReasoningLevel, string>> | null;
  levelsSource?: Exclude<ReasoningLevelsSource, 'unknown'>;
}

/** Builds a known, supported capability from published controls and wire support. */
export function capabilityFromControls(
  controls: PublishedReasoningControls,
  wire: ReasoningWireSupport,
): ReasoningCapability {
  const hasNone = (controls.effortValues ?? []).includes('none');
  const toggleUsable = controls.toggle && wire.toggle;
  const noneUsable = hasNone && wire.noneEffort;
  const canDisable = toggleUsable || noneUsable;
  const levels = wire.effort ? normalizeLevels(controls.effortValues) : [];
  const defaultLevel = isReasoningLevel(controls.defaultLevel) && levels.includes(controls.defaultLevel)
    ? controls.defaultLevel
    : null;
  const descriptions = controls.levelDescriptions
    ? Object.fromEntries(
        Object.entries(controls.levelDescriptions).filter(([level]) => levels.includes(level as ReasoningLevel)),
      ) as Partial<Record<ReasoningLevel, string>>
    : null;
  return {
    status: 'known',
    supported: true,
    canDisable,
    disableVia: toggleUsable ? 'toggle' : noneUsable ? 'none-effort' : null,
    levels,
    defaultEnabled: canDisable ? (controls.defaultEnabled ?? null) : true,
    defaultLevel,
    budget: wire.budget ? controls.budget : null,
    levelDescriptions: descriptions && Object.keys(descriptions).length > 0 ? descriptions : null,
    levelsSource: controls.levelsSource ?? 'model',
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface ReasoningRequest {
  enabled: boolean;
  /** Requested level; `'none'` means off. Garbage is tolerated. */
  level?: string | null;
  /** Requested token budget; non-positive values mean "not set". */
  budget?: number | null;
}

export type ReasoningAdjustment =
  | { kind: 'forced-on' }
  | { kind: 'forced-off' }
  | { kind: 'level-clamped'; from: string; to: ReasoningLevel }
  | { kind: 'level-dropped'; from: string }
  | { kind: 'budget-clamped'; from: number; to: number }
  | { kind: 'budget-dropped'; from: number };

export interface ReasoningPlan {
  enabled: boolean;
  /** Level to send; null = send no level (host default applies). */
  level: ReasoningLevel | null;
  /** Budget to send; null = send no budget. */
  budget: number | null;
  /** Everything that differs from the request, for logs and UI notes. */
  adjustments: ReasoningAdjustment[];
}

function positiveBudget(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * The one rule deciding what is actually sent for a request on a model.
 *
 * - Unknown capability → passthrough (fail open), with garbage levels dropped.
 * - Model without reasoning → off.
 * - Off on a model that cannot be switched off → on at its lowest level.
 * - Level outside the model's list → nearest supported below, else above.
 * - Budget outside the host's range → clamped; no budget field → dropped.
 */
export function planReasoning(capability: ReasoningCapability, request: ReasoningRequest): ReasoningPlan {
  const adjustments: ReasoningAdjustment[] = [];
  const requestedOff = !request.enabled || request.level === 'none';
  const requestedLevel = request.level != null && request.level !== 'none' ? request.level : null;
  const requestedBudget = positiveBudget(request.budget);

  if (capability.status === 'unknown') {
    if (requestedOff) return { enabled: false, level: null, budget: null, adjustments };
    return {
      enabled: true,
      level: isReasoningLevel(requestedLevel) ? requestedLevel : null,
      budget: requestedBudget,
      adjustments,
    };
  }

  if (!capability.supported) {
    if (!requestedOff) adjustments.push({ kind: 'forced-off' });
    return { enabled: false, level: null, budget: null, adjustments };
  }

  const forcedOn = requestedOff && !capability.canDisable;
  if (requestedOff && !forcedOn) return { enabled: false, level: null, budget: null, adjustments };
  if (forcedOn) adjustments.push({ kind: 'forced-on' });

  let level: ReasoningLevel | null = null;
  if (forcedOn) {
    // The caller asked for off: spend as little as the model allows.
    level = capability.levels[0] ?? null;
  } else if (requestedLevel !== null && capability.levels.length > 0) {
    const clamped = clampReasoningEffort(requestedLevel, capability.levels);
    level = isReasoningLevel(clamped) ? clamped : null;
    if (level !== null && level !== requestedLevel) {
      adjustments.push({ kind: 'level-clamped', from: requestedLevel, to: level });
    }
  } else if (requestedLevel !== null) {
    adjustments.push({ kind: 'level-dropped', from: requestedLevel });
  }

  let budget: number | null = null;
  if (requestedBudget !== null) {
    if (capability.budget) {
      const min = capability.budget.min ?? 1;
      const max = capability.budget.max ?? Number.POSITIVE_INFINITY;
      budget = Math.min(Math.max(requestedBudget, min), max);
      if (budget !== requestedBudget) {
        adjustments.push({ kind: 'budget-clamped', from: requestedBudget, to: budget });
      }
    } else {
      adjustments.push({ kind: 'budget-dropped', from: requestedBudget });
    }
  }

  return { enabled: true, level, budget, adjustments };
}

/** Highest graded level, for compact capability hints. */
export function topReasoningLevel(capability: ReasoningCapability): ReasoningLevel | null {
  return capability.levels.length > 0 ? capability.levels[capability.levels.length - 1] : null;
}

/** One-line log form of a plan's adjustments (empty string when none). */
export function describeAdjustments(adjustments: readonly ReasoningAdjustment[]): string {
  return adjustments
    .map((a) => {
      switch (a.kind) {
        case 'forced-on': return 'forced on (model cannot disable thinking)';
        case 'forced-off': return 'forced off (model does not think)';
        case 'level-clamped': return `level ${a.from}→${a.to}`;
        case 'level-dropped': return `level ${a.from} dropped (no graded control)`;
        case 'budget-clamped': return `budget ${a.from}→${a.to}`;
        case 'budget-dropped': return `budget ${a.from} dropped (no budget field)`;
      }
    })
    .join(', ');
}
