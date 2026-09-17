/**
 * Thinking control rendered entirely from a model's reasoning capability:
 * the switch appears only when the model can turn thinking off, the depth
 * ladder lists only the levels the model offers, the budget field appears
 * only where the host accepts one. Used by the composer (desktop popover and
 * mobile sheet), the agent editor and the general chat settings.
 */
import { useId, useMemo, useRef, type KeyboardEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  planReasoning,
  type ReasoningCapability,
  type ReasoningLevel,
} from '../../../shared/models/reasoning';
import { REASONING_EFFORT_ORDER } from '../../../shared/reasoningEfforts';
import { REASONING_LEVEL_COPY, adjustmentNote, levelDescription } from './reasoningCopy';

export interface ReasoningValue {
  enabled: boolean;
  level: string | null;
  budget: number | null;
}

interface ReasoningControlProps {
  /** Null while the catalog loads. */
  capability: ReasoningCapability | null;
  value: ReasoningValue;
  onChange: (next: ReasoningValue) => void;
  modelName: string;
  /** Host name for gateway-level vocabularies ("Arnict accepts these levels…"). */
  providerLabel?: string;
  /** `compact`: popovers and sheets. `full`: settings forms with level descriptions. */
  variant?: 'compact' | 'full';
  className?: string;
}

const RANK: Record<ReasoningLevel, number> = Object.fromEntries(
  REASONING_EFFORT_ORDER.map((level, index) => [level, index + 1]),
) as Record<ReasoningLevel, number>;

export function ReasoningControl({
  capability,
  value,
  onChange,
  modelName,
  providerLabel,
  variant = 'compact',
  className,
}: ReasoningControlProps) {
  const titleId = useId();
  const plan = useMemo(
    () => (capability ? planReasoning(capability, { enabled: value.enabled, level: value.level, budget: value.budget }) : null),
    [capability, value.enabled, value.level, value.budget],
  );
  const rootClass = ['reasoning-control', `reasoning-control--${variant}`, className].filter(Boolean).join(' ');

  if (!capability || !plan) {
    return (
      <div className={rootClass} aria-busy="true">
        <div className="reasoning-control__header">
          <span className="reasoning-control__title">Thinking</span>
          <span className="reasoning-skeleton reasoning-skeleton--switch" />
        </div>
        <div className="reasoning-skeleton reasoning-skeleton--ladder" />
      </div>
    );
  }

  if (!capability.supported) {
    return (
      <div className={rootClass}>
        <div className="reasoning-control__header">
          <span className="reasoning-control__title">Thinking</span>
        </div>
        <p className="reasoning-control__note">{modelName} answers directly. It has no thinking mode.</p>
      </div>
    );
  }

  const known = capability.status === 'known';
  const alwaysOn = known && !capability.canDisable;
  const on = plan.enabled;
  // Selected rung: what will be sent, else the model's default.
  const selected: ReasoningLevel | null = plan.level ?? capability.defaultLevel;
  // "Always on" already says what forced-on means; notes cover everything else.
  const note = known ? adjustmentNote(plan.adjustments.filter((a) => a.kind !== 'forced-on'), modelName) : null;
  const vocabularyNote = capability.levelsSource === 'host' && capability.levels.length > 0
    ? `${providerLabel ?? 'This provider'} accepts these levels; the model may treat some alike.`
    : capability.status === 'unknown'
      ? `${modelName} doesn't publish its thinking levels.`
      : null;

  const setLevel = (level: ReasoningLevel) => onChange({ ...value, enabled: true, level });

  return (
    <div className={rootClass} role="group" aria-labelledby={titleId}>
      <div className="reasoning-control__header">
        <span className="reasoning-control__title" id={titleId}>Thinking</span>
        {alwaysOn ? (
          <span className="reasoning-control__badge">Always on</span>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={on ? 'Turn thinking off' : 'Turn thinking on'}
            className={`reasoning-switch${on ? ' is-on' : ''}`}
            onClick={() => onChange({ ...value, enabled: !on })}
          >
            <span className="reasoning-switch__knob" />
          </button>
        )}
      </div>

      {on && capability.levels.length > 0 && (
        <DepthLadder
          levels={capability.levels}
          selected={selected}
          defaultLevel={capability.defaultLevel}
          onSelect={setLevel}
          variant={variant}
          labelledBy={titleId}
        />
      )}

      {on && selected && capability.levels.includes(selected) && (
        <p className="reasoning-control__description">{levelDescription(capability, selected)}</p>
      )}

      {on && capability.budget && (
        <BudgetField
          budget={capability.budget}
          value={value.budget}
          onChange={(budget) => onChange({ ...value, budget })}
        />
      )}

      {!on && known && capability.canDisable && (
        <p className="reasoning-control__description">{modelName} answers without thinking first.</p>
      )}

      {(note || vocabularyNote) && (
        <p className="reasoning-control__note" role="status">{note ?? vocabularyNote}</p>
      )}
    </div>
  );
}

interface DepthLadderProps {
  levels: ReasoningLevel[];
  selected: ReasoningLevel | null;
  defaultLevel: ReasoningLevel | null;
  onSelect: (level: ReasoningLevel) => void;
  variant: 'compact' | 'full';
  labelledBy: string;
}

/**
 * Depth ladder: one rung per level the model offers, each with a bar whose
 * height encodes its canonical depth, so "High" reads as high even when the
 * model only offers two rungs. The selection indicator slides between rungs.
 */
function DepthLadder({ levels, selected, defaultLevel, onSelect, variant, labelledBy }: DepthLadderProps) {
  const reduceMotion = useReducedMotion();
  const indicatorId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusIndex = selected ? Math.max(levels.indexOf(selected), 0) : 0;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = refs.current.findIndex((el) => el === document.activeElement);
    const from = current >= 0 ? current : focusIndex;
    let next = from;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(from + 1, levels.length - 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(from - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = levels.length - 1;
    else return;
    event.preventDefault();
    refs.current[next]?.focus();
    onSelect(levels[next]);
  };

  return (
    <div
      className="reasoning-ladder"
      role="radiogroup"
      data-rungs={levels.length}
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}
    >
      {levels.map((level, index) => {
        const isSelected = level === selected;
        const copy = REASONING_LEVEL_COPY[level];
        return (
          <button
            key={level}
            ref={(el) => { refs.current[index] = el; }}
            type="button"
            role="radio"
            aria-checked={isSelected}
            tabIndex={index === focusIndex ? 0 : -1}
            className={`reasoning-rung${isSelected ? ' is-selected' : ''}`}
            onClick={() => onSelect(level)}
            title={level === defaultLevel ? `${copy.label} (model default)` : copy.label}
          >
            {isSelected && (
              <motion.span
                layoutId={indicatorId}
                className="reasoning-rung__indicator"
                transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 38 }}
              />
            )}
            <span className="reasoning-rung__bar" aria-hidden="true">
              <span style={{ height: `${(RANK[level] / REASONING_EFFORT_ORDER.length) * 100}%` }} />
            </span>
            <span className="reasoning-rung__label">
              {levels.length > 4 ? copy.short : copy.label}
            </span>
            {level === defaultLevel && <span className="reasoning-rung__default" aria-label="model default" />}
          </button>
        );
      })}
    </div>
  );
}

interface BudgetFieldProps {
  budget: { min: number | null; max: number | null };
  value: number | null;
  onChange: (budget: number | null) => void;
}

function BudgetField({ budget, value, onChange }: BudgetFieldProps) {
  const inputId = useId();
  const hint = budget.min !== null && budget.max !== null
    ? `${budget.min.toLocaleString()}–${budget.max.toLocaleString()} tokens`
    : budget.max !== null
      ? `Up to ${budget.max.toLocaleString()} tokens`
      : budget.min !== null
        ? `At least ${budget.min.toLocaleString()} tokens`
        : 'Tokens';
  return (
    <div className="reasoning-budget">
      <label htmlFor={inputId} className="reasoning-budget__label">Thinking budget</label>
      <input
        id={inputId}
        type="number"
        inputMode="numeric"
        className="reasoning-budget__input"
        min={budget.min ?? 1}
        max={budget.max ?? undefined}
        step={512}
        placeholder="Model default"
        value={value ?? ''}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10);
          onChange(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
        }}
      />
      <span className="reasoning-budget__hint">{hint}</span>
    </div>
  );
}
