/**
 * The one table of thinking-level labels and descriptions, plus the copy
 * derived from a model's reasoning capability. Every surface that shows
 * thinking controls reads from here.
 */
import {
  planReasoning,
  topReasoningLevel,
  type ReasoningAdjustment,
  type ReasoningCapability,
  type ReasoningLevel,
} from '../../../shared/models/reasoning';

export interface ReasoningLevelCopy {
  label: string;
  /** Fits a six-segment row in narrow popovers. */
  short: string;
  description: string;
}

export const REASONING_LEVEL_COPY: Record<ReasoningLevel, ReasoningLevelCopy> = {
  minimal: { label: 'Minimal', short: 'Min', description: 'Answers almost straight away.' },
  low: { label: 'Low', short: 'Low', description: 'Light thinking for quick answers.' },
  medium: { label: 'Medium', short: 'Med', description: 'Balanced depth for everyday work.' },
  high: { label: 'High', short: 'High', description: 'Works carefully through hard problems.' },
  xhigh: { label: 'Extra high', short: 'XHigh', description: 'Very deep thinking for complex tasks.' },
  max: { label: 'Max', short: 'Max', description: 'The deepest thinking this model offers.' },
};

export function levelLabel(level: string | null | undefined): string {
  return level && level in REASONING_LEVEL_COPY ? REASONING_LEVEL_COPY[level as ReasoningLevel].label : 'Default';
}

/** Host copy when published (Codex), else ours. */
export function levelDescription(capability: ReasoningCapability, level: ReasoningLevel): string {
  return capability.levelDescriptions?.[level] ?? REASONING_LEVEL_COPY[level].description;
}

/** One-word capability summary for model lists ("Up to Max", "Always on", "On/off"). */
export function capabilitySummary(capability: ReasoningCapability | null | undefined): string | null {
  if (!capability || capability.status === 'unknown') return null;
  if (!capability.supported) return null;
  const top = topReasoningLevel(capability);
  if (top) return `Up to ${REASONING_LEVEL_COPY[top].label}`;
  return capability.canDisable ? 'On/off' : 'Always on';
}

/** User-facing note for what a plan changed, or null when nothing did. */
export function adjustmentNote(adjustments: readonly ReasoningAdjustment[], modelName: string): string | null {
  for (const adjustment of adjustments) {
    switch (adjustment.kind) {
      case 'level-clamped':
        return `${levelLabel(adjustment.from)} isn't available on ${modelName}. Using ${levelLabel(adjustment.to)}.`;
      case 'level-dropped':
        return `${modelName} has no thinking levels. It uses its own depth.`;
      case 'forced-on':
        return `${modelName} can't turn thinking off.`;
      case 'budget-clamped':
        return `Budget adjusted to ${adjustment.to.toLocaleString()} tokens, the range ${modelName} accepts.`;
      default:
        break;
    }
  }
  return null;
}

/** Composer trigger text: what will actually be sent. */
export function triggerLabel(capability: ReasoningCapability | null, request: { enabled: boolean; level?: string | null }): string {
  if (!capability) return 'Thinking';
  if (!capability.supported) return 'No thinking';
  const plan = planReasoning(capability, request);
  if (!plan.enabled) return 'Off';
  if (plan.level) return REASONING_LEVEL_COPY[plan.level].label;
  if (capability.status === 'known' && capability.levels.length === 0 && !capability.canDisable) return 'Always on';
  if (capability.defaultLevel) return REASONING_LEVEL_COPY[capability.defaultLevel].label;
  return 'On';
}
