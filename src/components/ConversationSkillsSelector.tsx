import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { Layers, Check, X, ChevronDown, RotateCcw, Loader2 } from 'lucide-react';
import { Badge } from './ui/Badge';
import { PremiumToggle } from './ui/PremiumToggle';
import { skillsApi } from '../api/client';
import { useIsMobile, usePrefersReducedMotion } from '../utils/breakpoints';
import type { Skill } from '../types';

interface ConversationSkillsSelectorProps {
  /** Effective (pre-check) skill ids right now — the conversation's own override if active, otherwise the agent's/general chat's current defaults. */
  skillIds: string[];
  /** Whether a conversation-level override is currently saved (gates "Reset to agent defaults"). */
  overrideActive: boolean;
  onApply: (skillIds: string[]) => void;
  onReset: () => void;
  disabled?: boolean;
  compact?: boolean;
}

const DESCRIPTION_TRUNCATE_LENGTH = 100;

function truncateDescription(description: string): string {
  if (description.length <= DESCRIPTION_TRUNCATE_LENGTH) return description;
  return `${description.slice(0, DESCRIPTION_TRUNCATE_LENGTH).trimEnd()}…`;
}

function sortedKey(ids: string[]): string {
  return JSON.stringify([...ids].sort());
}

export function ConversationSkillsSelector({
  skillIds,
  overrideActive,
  onApply,
  onReset,
  disabled = false,
  compact = false,
}: ConversationSkillsSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);
  const [listsLoading, setListsLoading] = useState(false);
  const [draftSkillIds, setDraftSkillIds] = useState<string[]>(skillIds);
  const wrapRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const prefersReducedMotion = usePrefersReducedMotion();

  const effectiveKey = useMemo(() => sortedKey(skillIds), [skillIds]);

  // Seed (or re-seed) the draft from the live effective set whenever the panel is
  // open and that effective set changes. This both discards unapplied edits from
  // a previous open (isOpen transition) and re-syncs the draft when Apply/Reset
  // land while the panel is still open (effectiveKey changes without a close).
  useEffect(() => {
    if (!isOpen) return;
    setDraftSkillIds(skillIds);
    // Intentionally keyed on isOpen + the serialized effective set, not on the
    // skillIds array reference (which churns every parent render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, effectiveKey]);

  // Lazy-fetch the skill catalog once, on first open — the trigger is always
  // mounted but the list is only needed once the panel is opened.
  useEffect(() => {
    if (!isOpen || listsLoaded || listsLoading) return;
    setListsLoading(true);
    skillsApi.list()
      .then((skills) => {
        setAllSkills(skills);
        setListsLoaded(true);
      })
      .catch(() => {
        setAllSkills([]);
      })
      .finally(() => setListsLoading(false));
  }, [isOpen, listsLoaded, listsLoading]);

  const isDirty = sortedKey(draftSkillIds) !== sortedKey(skillIds);

  const totalActive = skillIds.length;

  const toggleSkill = useCallback((id: string) => {
    setDraftSkillIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const handleApply = useCallback(() => {
    onApply(draftSkillIds);
    setIsOpen(false);
  }, [draftSkillIds, onApply]);

  const handleReset = useCallback(() => {
    onReset();
    // Keep the panel open — the seeding effect above re-syncs the draft once the
    // parent's effective set (props) flips back to the agent/general-chat defaults.
  }, [onReset]);

  useEffect(() => {
    if (!isOpen || isMobile) return;
    function handleClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, isMobile]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const triggerButton = (
    <motion.button
      type="button"
      onClick={() => !disabled && setIsOpen((v) => !v)}
      disabled={disabled}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      aria-label="Invoke skills for this conversation"
      whileHover={disabled ? {} : { backgroundColor: 'var(--bg-surface)' }}
      whileTap={disabled ? {} : { scale: 0.98 }}
      transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: compact ? '0 10px' : '4px 10px 4px 8px',
        height: compact ? 32 : undefined,
        fontSize: '0.75rem',
        fontFamily: 'var(--font-mono)',
        color: overrideActive ? 'var(--text-primary)' : 'var(--text-muted)',
        background: disabled ? 'var(--bg-surface)' : isOpen ? 'var(--bg-surface)' : 'transparent',
        border: `1px solid ${isOpen ? 'var(--border)' : 'transparent'}`,
        borderRadius: 'var(--radius-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'border-color var(--transition-fast)',
        outline: 'none',
      }}
    >
      <Layers size={12} style={{ opacity: 0.8, flexShrink: 0 }} />
      <span style={{ fontWeight: overrideActive ? 500 : 400 }}>Skills</span>
      <Badge tone={totalActive > 0 ? 'accent' : 'neutral'} variant={totalActive > 0 ? 'soft' : 'outline'}>
        {totalActive}
      </Badge>
      <motion.div
        animate={{ rotate: isOpen ? 180 : 0 }}
        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        style={{ opacity: 0.6, flexShrink: 0, display: 'flex' }}
      >
        <ChevronDown size={12} />
      </motion.div>
    </motion.button>
  );

  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        maxWidth: '100%',
        maxHeight: '85dvh',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-light)',
        borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 1101,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }
    : {
        position: 'absolute',
        right: 0,
        top: 'calc(100% + 6px)',
        minWidth: 320,
        maxWidth: '90vw',
        maxHeight: 480,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-light)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg), 0 0 0 1px rgba(255,255,255,0.04)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      };

  const entranceMotion = isMobile
    ? prefersReducedMotion
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
      : { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' } }
    : prefersReducedMotion
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
      : { initial: { opacity: 0, y: -8, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -8, scale: 0.98 } };

  const renderSection = (
    icon: React.ReactNode,
    title: string,
    items: { id: string; label: string; description?: string }[],
    draftIds: string[],
    onToggle: (id: string) => void
  ) => (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <div
        style={{
          padding: '10px 12px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: '0.8125rem',
          fontWeight: 600,
          color: 'var(--text-secondary)',
        }}
      >
        {icon}
        {title}
        <span style={{ marginLeft: 'auto', fontSize: '0.6875rem', fontWeight: 400, color: 'var(--text-muted)' }}>
          {draftIds.length} active
        </span>
      </div>
      {items.length === 0 ? (
        <div style={{ padding: '14px 12px', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
          None configured yet.
        </div>
      ) : (
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((item) => (
            <PremiumToggle
              key={item.id}
              checked={draftIds.includes(item.id)}
              onChange={() => !disabled && onToggle(item.id)}
              label={item.label}
              description={item.description}
              size="sm"
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  );

  const panelBody = (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Invoke skills for this conversation"
      initial={entranceMotion.initial}
      animate={entranceMotion.animate}
      exit={entranceMotion.exit}
      transition={{
        duration: prefersReducedMotion ? 0.15 : isMobile ? 0.3 : 0.2,
        ease: isMobile ? [0.32, 0.72, 0, 1] : [0.4, 0, 0.2, 1],
      }}
      style={panelStyle}
    >
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Layers size={16} style={{ color: 'var(--accent)', opacity: 0.8 }} />
          <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            Skills for this conversation
          </span>
        </div>
        <motion.button
          type="button"
          onClick={() => setIsOpen(false)}
          whileHover={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
          whileTap={{ scale: 0.92 }}
          transition={{ duration: 0.15 }}
          style={{
            padding: 8,
            borderRadius: 'var(--radius-sm)',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            minWidth: 36,
            minHeight: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          aria-label="Close"
        >
          <X size={16} />
        </motion.button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch', padding: 16 }}>
        {listsLoading && !listsLoaded ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
            <div style={{ fontSize: '0.875rem' }}>Loading skills...</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {renderSection(
              <Layers size={14} />,
              'Skills',
              allSkills.map((s) => ({ id: s.id, label: s.name, description: truncateDescription(s.description) })),
              draftSkillIds,
              toggleSkill
            )}
          </div>
        )}
      </div>

      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <motion.button
          type="button"
          onClick={handleReset}
          disabled={!overrideActive || disabled}
          whileHover={overrideActive && !disabled ? { scale: 1.02 } : {}}
          whileTap={overrideActive && !disabled ? { scale: 0.98 } : {}}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '9px 14px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: overrideActive && !disabled ? 'var(--text-secondary)' : 'var(--text-muted)',
            fontSize: '0.8125rem',
            fontWeight: 500,
            cursor: overrideActive && !disabled ? 'pointer' : 'not-allowed',
            opacity: overrideActive && !disabled ? 1 : 0.5,
          }}
        >
          <RotateCcw size={13} />
          Reset to agent defaults
        </motion.button>
        <motion.button
          type="button"
          onClick={handleApply}
          disabled={!isDirty || disabled}
          whileHover={isDirty && !disabled ? { scale: 1.02 } : {}}
          whileTap={isDirty && !disabled ? { scale: 0.98 } : {}}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '9px 18px',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: isDirty && !disabled ? 'var(--accent)' : 'var(--bg-surface)',
            color: isDirty && !disabled ? '#fff' : 'var(--text-muted)',
            fontSize: '0.8125rem',
            fontWeight: 600,
            cursor: isDirty && !disabled ? 'pointer' : 'not-allowed',
            boxShadow: isDirty && !disabled ? '0 4px 14px rgb(var(--copper-rgb) / 0.4)' : 'none',
          }}
        >
          <Check size={14} />
          Apply
        </motion.button>
      </div>
    </motion.div>
  );

  return (
    <div ref={wrapRef} className="conv-skills-selector" style={{ position: 'relative' }}>
      {triggerButton}

      {isMobile
        ? createPortal(
            <>
              <AnimatePresence>
                {isOpen && (
                  <motion.div
                    key="conv-skills-scrim"
                    className="sheet-scrim"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
                    onClick={() => setIsOpen(false)}
                  />
                )}
              </AnimatePresence>
              <AnimatePresence>{isOpen && panelBody}</AnimatePresence>
            </>,
            document.body
          )
        : <AnimatePresence>{isOpen && panelBody}</AnimatePresence>}

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .conv-skills-selector button:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}
