import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Search,
  Loader2,
  Cpu,
  ChevronDown,
  Sparkles,
  Clock,
  Star,
  Check,
  X,
  Building2,
  Zap,
  Eye,
  Brain,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import {
  getModelAuthor,
  formatModelId,
  formatAuthor,
  getAuthorColor,
  getProviderMeta,
  formatContext,
  formatPrice,
  PROVIDER_PRIORITY,
} from '../utils/modelUtils';
import type { OpenRouterModel as OpenRouterModelType } from '../types';
import { useOpenRouterModels } from '../hooks/useOpenRouterModels';
import { useDeepSeekModels } from '../hooks/useDeepSeekModels';
import { useFavoriteModels } from '../hooks/useFavoriteModels';
import { useRecentModels } from '../hooks/useRecentModels';
import { useIsMobile } from '../utils/breakpoints';
import { DEEPSEEK_DIRECT_GROUP } from '../utils/providers';

const ICON_MAP = { sparkles: Sparkles, zap: Zap, eye: Eye, brain: Brain };

function ProviderIcon({ name, size = 14 }: { name: 'sparkles' | 'zap' | 'eye' | 'brain'; size?: number }) {
  const Icon = ICON_MAP[name];
  return Icon ? <Icon size={size} /> : <Sparkles size={size} />;
}

export type ModelSelectorVariant = 'conversation' | 'message' | 'settings' | 'agent' | 'council';

export interface ModelSelectorCoreProps {
  value: string | null;
  onChange: (modelId: string | null) => void;
  variant: ModelSelectorVariant;
  agentModel?: string;
  conversationModel?: string | null;
  disabled?: boolean;
  compact?: boolean;
  label?: string;
  /** Dropdown opens below (default) or above the trigger */
  placement?: 'below' | 'above';
  /** For conversation: aria-label */
  ariaLabel?: string;
}

const AUTO_OPTION: OpenRouterModelType = {
  id: 'openrouter/auto',
  name: 'Auto (Best for prompt)',
  description: 'OpenRouter automatically selects the best model',
  context_length: 128000,
  pricing: { prompt: '0', completion: '0' },
};

export function ModelSelectorCore({
  value,
  onChange,
  variant,
  agentModel = 'openrouter/auto',
  conversationModel = null,
  disabled = false,
  compact = false,
  label,
  placement = 'below',
  ariaLabel = 'Select AI model',
}: ModelSelectorCoreProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set([DEEPSEEK_DIRECT_GROUP, 'openai', 'anthropic']));
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const { models: openRouterModels, loading } = useOpenRouterModels();
  const { models: deepSeekModels } = useDeepSeekModels();
  const { favorites, toggleFavorite } = useFavoriteModels();
  const { recent, addRecent } = useRecentModels();

  // DeepSeek-direct models lead the list so their group sorts to the top.
  const rawModels = useMemo(
    () => [...deepSeekModels, ...openRouterModels],
    [deepSeekModels, openRouterModels]
  );

  const models = useMemo(() => {
    if (variant === 'settings' || variant === 'agent') {
      return [AUTO_OPTION, ...rawModels.filter((m) => m.id !== 'openrouter/auto')];
    }
    return rawModels;
  }, [rawModels, variant]);

  const effectiveModel = value ?? conversationModel ?? agentModel;
  const effectiveModelName = useMemo(() => {
    if (value === null && (variant === 'conversation' || variant === 'message')) {
      return conversationModel
        ? formatModelId(conversationModel)
        : formatModelId(agentModel);
    }
    const m = models.find((x) => x.id === effectiveModel);
    return m?.name ?? formatModelId(effectiveModel);
  }, [value, effectiveModel, conversationModel, agentModel, models, variant]);

  const isUsingDefault =
    (variant === 'conversation' || variant === 'message') && value === null;
  const currentAuthor = getModelAuthor(effectiveModel);
  const authorColor = getAuthorColor(currentAuthor);
  const providerMeta = getProviderMeta(currentAuthor);

  const filteredModels = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.description && m.description.toLowerCase().includes(q))
    );
  }, [models, search]);

  type GroupKey =
    | 'Favorites'
    | 'Recommended'
    | 'AgentDefault'
    | 'Recent'
    | 'Premium'
    | 'Standard'
    | 'Economy'
    | string;

  const grouped = useMemo(() => {
    const showDefault =
      (variant === 'conversation' || variant === 'message') && !search.trim();
    const showRecent =
      (variant === 'conversation' || variant === 'message' || variant === 'agent' || variant === 'council') &&
      !search.trim() &&
      recent.length > 0;
    const showTiers = variant === 'settings';

    const groups: Record<GroupKey, OpenRouterModelType[]> = {};
    if (showTiers) {
      groups['Recommended'] = [];
      groups['Favorites'] = [];
      groups['Premium'] = [];
      groups['Standard'] = [];
      groups['Economy'] = [];
    }

    if (!showTiers) {
      if (showDefault) groups['AgentDefault'] = [];
      if (showRecent) groups['Recent'] = [];
      groups['Favorites'] = [];
    }

    for (const model of filteredModels) {
      if (model.id === 'openrouter/auto') {
        if (showTiers) groups['Recommended'].push(model);
        continue;
      }
      if (favorites.includes(model.id)) {
        groups['Favorites'].push(model);
        continue;
      }
      if (showTiers) {
        const meta = getProviderMeta(getModelAuthor(model.id));
        if (meta.tier === 'premium') groups['Premium'].push(model);
        else if (meta.tier === 'standard') groups['Standard'].push(model);
        else groups['Economy'].push(model);
        continue;
      }
      const author = getModelAuthor(model.id);
      if (!groups[author]) groups[author] = [];
      groups[author].push(model);
    }

    if (showTiers) {
      return Object.fromEntries(
        Object.entries(groups).filter(([, v]) => v.length > 0)
      );
    }

    const priorityOrder: GroupKey[] = ['AgentDefault', 'Recent', 'Favorites', ...PROVIDER_PRIORITY];
    const sorted: [string, OpenRouterModelType[]][] = [];
    const seen = new Set<string>();
    for (const key of priorityOrder) {
      if (key === 'AgentDefault' && groups['AgentDefault']) {
        sorted.push(['AgentDefault', []]);
        continue;
      }
      if (key === 'Recent' && groups['Recent']) {
        const recentModels = recent
          .map((r) => models.find((m) => m.id === r.id))
          .filter(Boolean) as OpenRouterModelType[];
        if (recentModels.length) sorted.push(['Recent', recentModels]);
        continue;
      }
      if (key === 'Favorites' && groups['Favorites']?.length) {
        sorted.push(['Favorites', groups['Favorites']]);
        seen.add('Favorites');
        continue;
      }
      if (groups[key] && !seen.has(key)) {
        seen.add(key);
        sorted.push([key, groups[key]]);
      }
    }
    const rest = Object.entries(groups).filter(
      ([k]) => !['AgentDefault', 'Recent', 'Favorites', ...PROVIDER_PRIORITY].includes(k)
    );
    return Object.fromEntries([...sorted, ...rest]);
  }, [filteredModels, favorites, recent, models, variant, search]);

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (modelId: string | null, modelName?: string) => {
      onChange(modelId);
      if (modelId && modelName) addRecent(modelId, modelName);
      setIsOpen(false);
      setSearch('');
    },
    [onChange, addRecent]
  );

  const handleToggleFavorite = useCallback(
    (e: React.MouseEvent, modelId: string) => {
      e.stopPropagation();
      toggleFavorite(modelId);
    },
    [toggleFavorite]
  );

  useEffect(() => {
    if (!isOpen) return;
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, [isOpen]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    // On mobile the dropdown is portaled out of dropdownRef and dismissed via
    // the scrim, so the document-level outside-click handler must not run.
    if (isOpen && !isMobile) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, isMobile]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isOpen) return;
      if (e.key === 'Escape') setIsOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const isSettings = variant === 'settings';
  const isPanelVariant = variant === 'settings' || variant === 'council';
  const isMessage = variant === 'message';

  const triggerMinHeight = compact ? 32 : isMobile ? 44 : isPanelVariant ? 56 : undefined;

  const triggerButton = (
    <motion.button
      type="button"
      onClick={() => !disabled && !loading && setIsOpen(!isOpen)}
      disabled={disabled || (isPanelVariant && loading)}
      aria-expanded={isOpen}
      aria-haspopup="listbox"
      aria-label={ariaLabel}
      whileHover={disabled || (isPanelVariant && loading) ? {} : { backgroundColor: 'var(--bg-surface)' }}
      whileTap={disabled || (isPanelVariant && loading) ? {} : { scale: 0.98 }}
      transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: compact ? '4px' : isPanelVariant ? '12px' : '6px',
        padding: compact
          ? '0 10px'
          : isPanelVariant
            ? '12px 16px'
            : '4px 10px 4px 8px',
        minHeight: triggerMinHeight,
        height: compact ? 32 : undefined,
        width: isPanelVariant ? '100%' : undefined,
        maxWidth: isPanelVariant ? undefined : compact ? 140 : isMobile ? 180 : 200,
        fontSize: compact ? '0.75rem' : isPanelVariant ? '0.9375rem' : '0.75rem',
        fontFamily: isPanelVariant ? 'var(--font-body)' : 'var(--font-mono)',
        color: isUsingDefault && !isPanelVariant ? 'var(--text-muted)' : 'var(--text-primary)',
        background:
          disabled || (isPanelVariant && loading)
            ? 'var(--bg-surface)'
            : isOpen
              ? 'var(--bg-surface)'
              : isPanelVariant
                ? 'var(--bg-elevated)'
                : 'transparent',
        border: `1px solid ${
          isOpen && isPanelVariant ? 'var(--accent)' : isOpen ? 'var(--border)' : 'transparent'
        }`,
        borderRadius: 'var(--radius-md)',
        cursor: disabled || (isPanelVariant && loading) ? 'not-allowed' : 'pointer',
        transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
        outline: 'none',
        boxShadow: isOpen && isPanelVariant ? '0 0 0 3px var(--accent-muted)' : 'none',
        textAlign: isPanelVariant ? 'left' : undefined,
      }}
      onFocus={(e) => {
        if (isOpen) return;
        e.currentTarget.style.borderColor = 'var(--border)';
      }}
      onBlur={(e) => {
        if (!isOpen) e.currentTarget.style.borderColor = 'transparent';
      }}
    >
      {isPanelVariant ? (
        <>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 'var(--radius-md)',
              background: `${providerMeta.color}15`,
              border: `1px solid ${providerMeta.color}30`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: providerMeta.color,
              flexShrink: 0,
            }}
          >
            <ProviderIcon name={providerMeta.iconName} size={16} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {effectiveModelName || 'Select model...'}
            </div>
            {effectiveModel && effectiveModel !== 'openrouter/auto' && (
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 2,
                }}
              >
                <span style={{ color: providerMeta.color, fontWeight: 500 }}>
                  {providerMeta.name}
                </span>
                <span>·</span>
                <span>{formatContext(models.find((m) => m.id === effectiveModel)?.context_length ?? 0)} ctx</span>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: authorColor,
              flexShrink: 0,
              boxShadow: `0 0 4px ${authorColor}40`,
            }}
          />
          <span
            style={{
              maxWidth: compact ? 80 : 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: isUsingDefault ? 400 : 500,
            }}
          >
            {isMessage && value === null ? 'Default' : effectiveModelName}
          </span>
        </>
      )}
      <motion.div
        animate={{ rotate: isOpen ? 180 : 0 }}
        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        style={{ opacity: 0.6, flexShrink: 0, display: 'flex' }}
      >
        <ChevronDown size={compact ? 12 : isSettings ? 18 : 12} />
      </motion.div>
    </motion.button>
  );

  const dropdownStyle: React.CSSProperties = isMobile
    ? {
        // Mobile: full-width bottom sheet (portaled to body — see render below).
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
        left: 0,
        right: isSettings ? 0 : undefined,
        minWidth: isSettings ? undefined : 360,
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
        ...(placement === 'above'
          ? { bottom: 'calc(100% + 8px)' }
          : { top: 'calc(100% + 6px)' }),
      };

  return (
    <div ref={dropdownRef} className="model-selector-core" style={{ position: 'relative' }}>
      {label && (
        <label
          style={{
            display: 'block',
            fontSize: '0.75rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            marginBottom: 8,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </label>
      )}
      {triggerButton}

      {((dropdownTree: React.ReactNode) =>
        isMobile
          ? createPortal(
              <>
                <AnimatePresence>
                  {isOpen && (
                    <motion.div
                      key="ms-scrim"
                      className="sheet-scrim"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      onClick={() => setIsOpen(false)}
                    />
                  )}
                </AnimatePresence>
                {dropdownTree}
              </>,
              document.body
            )
          : dropdownTree)(
        <AnimatePresence>
          {isOpen && (
            <motion.div
              role="listbox"
              aria-label="Available AI models"
              initial={isMobile ? { y: '100%' } : { opacity: 0, y: placement === 'above' ? 8 : -8, scale: 0.98 }}
              animate={isMobile ? { y: 0 } : { opacity: 1, y: 0, scale: 1 }}
              exit={isMobile ? { y: '100%' } : { opacity: 0, y: placement === 'above' ? 8 : -8, scale: 0.98 }}
              transition={{ duration: isMobile ? 0.3 : 0.2, ease: isMobile ? [0.32, 0.72, 0, 1] : [0.4, 0, 0.2, 1] }}
              style={dropdownStyle}
            >
            <div
              style={{
                padding: '14px 16px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Sparkles size={16} style={{ color: 'var(--accent)', opacity: 0.8 }} />
                <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {isMessage ? 'Model for this message' : 'Model'}
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

            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ position: 'relative' }}>
                <Search
                  size={14}
                  style={{
                    position: 'absolute',
                    left: 12,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-muted)',
                    pointerEvents: 'none',
                  }}
                />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search models..."
                  aria-label="Search models"
                  className="model-selector-search"
                  style={{
                    width: '100%',
                    padding: '10px 12px 10px 36px',
                    fontSize: '0.875rem',
                    fontFamily: 'var(--font-body)',
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                    transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
                  }}
                />
              </div>
            </div>

            <div style={{ flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
              {loading ? (
                <div
                  style={{
                    padding: 40,
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                  }}
                >
                  <Loader2
                    size={24}
                    style={{ animation: 'spin 1s linear infinite', margin: '0 auto 12px' }}
                  />
                  <div style={{ fontSize: '0.875rem' }}>Loading models...</div>
                </div>
              ) : (
                <>
                  {(variant === 'conversation' || variant === 'message') && !search && (
                    <button
                      type="button"
                      onClick={() => handleSelect(null)}
                      role="option"
                      aria-selected={isUsingDefault}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        width: '100%',
                        padding: '12px 16px',
                        textAlign: 'left',
                        background: isUsingDefault ? 'var(--accent-muted)' : 'transparent',
                        border: 'none',
                        borderBottom: '1px solid var(--border)',
                        cursor: 'pointer',
                        color: 'var(--text-primary)',
                        fontSize: '0.875rem',
                        transition: 'background var(--transition-fast)',
                      }}
                      onMouseEnter={(e) => {
                        if (!isUsingDefault) e.currentTarget.style.background = 'var(--bg-hover)';
                      }}
                      onMouseLeave={(e) => {
                        if (!isUsingDefault) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <Cpu size={18} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: isUsingDefault ? 600 : 500 }}>
                          {variant === 'conversation' ? 'Agent Default' : 'Use Default'}
                        </div>
                        <div
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            fontFamily: isPanelVariant ? 'var(--font-body)' : 'var(--font-mono)',
                          }}
                        >
                          {conversationModel
                            ? formatModelId(conversationModel)
                            : formatModelId(agentModel)}
                        </div>
                      </div>
                      {isUsingDefault && <Check size={16} style={{ color: 'var(--accent)' }} />}
                    </button>
                  )}

                  {Object.entries(grouped).map(([groupKey, groupModels]) => {
                    if (groupKey === 'AgentDefault') return null;
                    if (groupKey === 'Recent') {
                      return (
                        <div
                          key="Recent"
                          style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}
                        >
                          <div
                            style={{
                              padding: '0 16px 8px',
                              fontSize: '0.6875rem',
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: '0.08em',
                              color: 'var(--text-muted)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <Clock size={12} />
                            Recent
                          </div>
                          {groupModels.map((model) => {
                            const isSelected = effectiveModel === model.id;
                            const author = getModelAuthor(model.id);
                            return (
                              <button
                                key={model.id}
                                type="button"
                                onClick={() => handleSelect(model.id, model.name)}
                                role="option"
                                aria-selected={isSelected}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  width: '100%',
                                  padding: '8px 16px',
                                  textAlign: 'left',
                                  background: isSelected ? 'var(--accent-muted)' : 'transparent',
                                  border: 'none',
                                  cursor: 'pointer',
                                  color: 'var(--text-primary)',
                                  fontSize: '0.875rem',
                                  transition: 'background var(--transition-fast)',
                                }}
                                onMouseEnter={(e) => {
                                  if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover)';
                                }}
                                onMouseLeave={(e) => {
                                  if (!isSelected) e.currentTarget.style.background = 'transparent';
                                }}
                              >
                                <span
                                  style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: '50%',
                                    background: getAuthorColor(author),
                                    flexShrink: 0,
                                  }}
                                />
                                <span
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {model.name}
                                </span>
                                {isSelected && (
                                  <Check size={14} style={{ color: 'var(--accent)' }} />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      );
                    }

                    const isFavoritesGroup = groupKey === 'Favorites';
                    const isTierGroup = ['Recommended', 'Premium', 'Standard', 'Economy'].includes(
                      groupKey
                    );

                    return (
                      <div key={groupKey}>
                        {isTierGroup ? (
                          <div
                            style={{
                              padding: '8px 16px',
                              fontSize: '0.6875rem',
                              fontWeight: 600,
                              color: 'var(--text-muted)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.08em',
                              background: 'var(--bg-surface)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            {groupKey}
                            {isFavoritesGroup && (
                              <Star size={10} style={{ display: 'inline' }} />
                            )}
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              !isTierGroup && !isFavoritesGroup
                                ? toggleGroup(groupKey)
                                : undefined
                            }
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              width: '100%',
                              padding: '10px 16px',
                              textAlign: 'left',
                              background: 'transparent',
                              border: 'none',
                              cursor: isFavoritesGroup ? 'default' : 'pointer',
                              color: 'var(--text-muted)',
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: '0.06em',
                            }}
                          >
                            {isFavoritesGroup && <Star size={12} style={{ display: 'inline' }} />}
                            {!isFavoritesGroup && !isTierGroup && (
                              <Building2 size={14} />
                            )}
                            <span style={{ flex: 1 }}>
                              {groupKey === 'Favorites'
                                ? 'Favorites'
                                : groupKey === 'Recommended'
                                  ? 'Recommended'
                                  : formatAuthor(groupKey)}
                            </span>
                            {!isFavoritesGroup && !isTierGroup && (
                              <>
                                <span style={{ fontSize: '0.6875rem', fontWeight: 400 }}>
                                  {groupModels.length}
                                </span>
                                <ChevronDown
                                  size={14}
                                  style={{
                                    transform: expandedGroups.has(groupKey)
                                      ? 'rotate(180deg)'
                                      : 'none',
                                  }}
                                />
                              </>
                            )}
                          </button>
                        )}

                        {(isTierGroup || isFavoritesGroup || expandedGroups.has(groupKey)) && (
                          <div style={{ padding: '4px 0' }}>
                            {groupModels.map((model) => {
                              const isSelected = effectiveModel === model.id;
                              const isFavorite = favorites.includes(model.id);
                              const meta = getProviderMeta(getModelAuthor(model.id));
                              return (
                                <button
                                  key={model.id}
                                  type="button"
                                  onClick={() => handleSelect(model.id, model.name)}
                                  role="option"
                                  aria-selected={isSelected}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: isSettings ? 12 : 10,
                                    width: '100%',
                                    padding: isSettings ? '12px 16px' : '8px 16px 8px 32px',
                                    textAlign: 'left',
                                    background: isSelected
                                      ? 'var(--accent-muted)'
                                      : 'transparent',
                                    border: 'none',
                                    borderLeft:
                                      isSettings && isSelected
                                        ? '3px solid var(--accent)'
                                        : 'none',
                                    cursor: 'pointer',
                                    color: 'var(--text-primary)',
                                    fontSize: '0.875rem',
                                    transition: 'background var(--transition-fast)',
                                  }}
                                  onMouseEnter={(e) => {
                                    if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover)';
                                  }}
                                  onMouseLeave={(e) => {
                                    if (!isSelected) e.currentTarget.style.background = 'transparent';
                                  }}
                                >
                                  {isSettings && (
                                    <div
                                      style={{
                                        width: 32,
                                        height: 32,
                                        borderRadius: 'var(--radius-sm)',
                                        background: `${meta.color}15`,
                                        border: `1px solid ${meta.color}30`,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        color: meta.color,
                                        flexShrink: 0,
                                      }}
                                    >
                                      <ProviderIcon name={meta.iconName} size={14} />
                                    </div>
                                  )}
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        marginBottom: isSettings ? 3 : 0,
                                      }}
                                    >
                                      <span
                                        style={{
                                          fontWeight: isSelected ? 600 : 500,
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          whiteSpace: 'nowrap',
                                        }}
                                      >
                                        {model.name}
                                      </span>
                                      {model.id === 'openrouter/auto' && (
                                        <Sparkles size={12} style={{ color: 'var(--accent)' }} />
                                      )}
                                    </div>
                                    {isSettings && model.id !== 'openrouter/auto' && (
                                      <div
                                        style={{
                                          fontSize: '0.75rem',
                                          color: 'var(--text-muted)',
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 8,
                                        }}
                                      >
                                        <span style={{ color: meta.color }}>{meta.name}</span>
                                        <span>·</span>
                                        <span>{formatContext(model.context_length)}</span>
                                        <span>·</span>
                                        <span>{formatPrice(model.pricing.prompt)}</span>
                                      </div>
                                    )}
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    {model.id !== 'openrouter/auto' && (
                                      <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          handleToggleFavorite(e, model.id);
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            toggleFavorite(model.id);
                                          }
                                        }}
                                        style={{
                                          padding: 8,
                                          margin: -4,
                                          background: 'transparent',
                                          border: 'none',
                                          borderRadius: 'var(--radius-sm)',
                                          cursor: 'pointer',
                                          color: isFavorite ? 'var(--accent)' : 'var(--text-muted)',
                                          opacity: isFavorite ? 1 : 0.5,
                                          transition: 'color var(--transition-fast), opacity var(--transition-fast)',
                                        }}
                                        title={
                                          isFavorite
                                            ? 'Remove from favorites'
                                            : 'Add to favorites'
                                        }
                                      >
                                        <Star
                                          size={16}
                                          fill={isFavorite ? 'currentColor' : 'none'}
                                        />
                                      </span>
                                    )}
                                    {isSelected && (
                                      <Check size={18} style={{ color: 'var(--accent)' }} />
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </motion.div>
          )}
        </AnimatePresence>
      )}

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .model-selector-search:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-muted);
        }
        .model-selector-search::placeholder {
          color: var(--text-muted);
        }
        .model-selector-core button:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}
