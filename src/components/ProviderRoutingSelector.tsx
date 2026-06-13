import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Loader2, Server, Shuffle, X } from 'lucide-react';
import type { OpenRouterEndpoint, ProviderRoutingConfig } from '../types';
import { useOpenRouterEndpoints } from '../hooks/useOpenRouterEndpoints';
import { formatContext, formatPrice } from '../utils/modelUtils';
import { useIsMobile } from '../utils/breakpoints';
import { isDeepSeekDirectModel } from '../utils/providers';

interface ProviderRoutingSelectorProps {
  modelId: string | null | undefined;
  value: ProviderRoutingConfig | null;
  onChange: (value: ProviderRoutingConfig | null) => void;
  inheritedRouting?: ProviderRoutingConfig | null;
  disabled?: boolean;
  compact?: boolean;
  placement?: 'below' | 'above';
  allowDefault?: boolean;
  label?: string;
}

function routingLabel(config: ProviderRoutingConfig | null | undefined): string {
  if (!config) return 'Default';
  if (config.mode === 'auto') return 'Auto routing';
  return config.provider_slug;
}

function endpointLabel(endpoint: OpenRouterEndpoint): string {
  return endpoint.provider_name || endpoint.tag;
}

export function ProviderRoutingSelector({
  modelId,
  value,
  onChange,
  inheritedRouting,
  disabled = false,
  compact = false,
  placement = 'below',
  allowDefault = false,
  label,
}: ProviderRoutingSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const isDeepSeek = isDeepSeekDirectModel(modelId);
  const isAutoModel = !modelId || modelId === 'openrouter/auto';
  const selectedSlug = value?.mode === 'provider' ? value.provider_slug : null;
  const { endpoints, loading, error } = useOpenRouterEndpoints(modelId, (isOpen || !!selectedSlug) && !isDeepSeek);

  // Provider routing is OpenRouter-only; clear any stale config when a DeepSeek model is selected.
  useEffect(() => {
    if (isDeepSeek && value !== null) onChange(null);
  }, [isDeepSeek, value, onChange]);

  const selectedEndpoint = useMemo(
    () => endpoints.find((endpoint) => endpoint.tag === selectedSlug) || null,
    [endpoints, selectedSlug]
  );

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isOpen && e.key === 'Escape') setIsOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const effectiveDisabled = disabled || isAutoModel;
  const displayLabel = isAutoModel
    ? 'Auto routing'
    : value?.mode === 'provider'
      ? endpointLabel(selectedEndpoint || {
        tag: value.provider_slug,
        name: value.provider_slug,
        provider_name: value.provider_slug,
        context_length: 0,
        max_completion_tokens: null,
        pricing: { prompt: '0', completion: '0' },
        quantization: null,
        supported_parameters: [],
        status: null,
      })
      : !allowDefault && value === null
        ? 'Auto routing'
        : routingLabel(value);
  const autoSelected = value?.mode === 'auto' || (!allowDefault && value === null);

  const selectEndpoint = (endpoint: OpenRouterEndpoint) => {
    onChange({
      mode: 'provider',
      provider_slug: endpoint.tag,
      allow_fallbacks: value?.mode === 'provider' ? value.allow_fallbacks : true,
    });
  };

  const dropdownStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    minWidth: isMobile ? 280 : 360,
    maxWidth: isMobile ? 'calc(100vw - 24px)' : '90vw',
    maxHeight: isMobile ? '70vh' : 420,
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

  if (isDeepSeek) {
    return (
      <div style={{ position: 'relative' }}>
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: compact ? '6px 10px' : '10px 12px',
            fontSize: compact ? '0.75rem' : '0.8125rem',
            color: 'var(--text-muted)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <Server size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
          <span>Direct DeepSeek — provider routing not applicable</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
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
      <motion.button
        type="button"
        disabled={effectiveDisabled}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Select OpenRouter provider routing"
        whileHover={effectiveDisabled ? {} : { backgroundColor: 'var(--bg-surface)' }}
        whileTap={effectiveDisabled ? {} : { scale: 0.98 }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 5 : 8,
          height: compact ? 32 : 44,
          padding: compact ? '0 10px' : '0 12px',
          maxWidth: compact ? 150 : undefined,
          width: compact ? undefined : '100%',
          border: `1px solid ${isOpen ? 'var(--border)' : 'transparent'}`,
          borderRadius: 'var(--radius-md)',
          background: isOpen ? 'var(--bg-surface)' : compact ? 'transparent' : 'var(--bg-elevated)',
          color: effectiveDisabled ? 'var(--text-muted)' : 'var(--text-primary)',
          cursor: effectiveDisabled ? 'not-allowed' : 'pointer',
          fontSize: compact ? '0.75rem' : '0.875rem',
          fontFamily: compact ? 'var(--font-mono)' : 'var(--font-body)',
          transition: 'border-color var(--transition-fast), background var(--transition-fast)',
          opacity: effectiveDisabled ? 0.65 : 1,
        }}
        title={isAutoModel ? 'Provider endpoint selection requires a concrete model' : undefined}
      >
        <Shuffle size={compact ? 12 : 14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayLabel}
        </span>
        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          style={{ display: 'flex', opacity: 0.6, flexShrink: 0 }}
        >
          <ChevronDown size={compact ? 12 : 14} />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {isOpen && !effectiveDisabled && (
          <motion.div
            role="listbox"
            aria-label="OpenRouter provider endpoints"
            initial={{ opacity: 0, y: placement === 'above' ? 8 : -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: placement === 'above' ? 8 : -8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            style={dropdownStyle}
          >
            <div style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Server size={15} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  Provider routing
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Close"
                style={{
                  padding: 7,
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                }}
              >
                <X size={15} />
              </button>
            </div>

            <div style={{ overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
              {allowDefault && (
                <button
                  type="button"
                  role="option"
                  aria-selected={value === null}
                  onClick={() => onChange(null)}
                  style={optionStyle(value === null)}
                >
                  <Shuffle size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: value === null ? 600 : 500 }}>Use default</div>
                    <div style={subTextStyle}>Inherited: {routingLabel(inheritedRouting)}</div>
                  </div>
                  {value === null && <Check size={15} style={{ color: 'var(--accent)' }} />}
                </button>
              )}

              <button
                type="button"
                role="option"
                aria-selected={autoSelected}
                onClick={() => onChange({ mode: 'auto' })}
                style={optionStyle(autoSelected)}
              >
                <Shuffle size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: autoSelected ? 600 : 500 }}>Auto routing</div>
                  <div style={subTextStyle}>Let OpenRouter choose the endpoint</div>
                </div>
                {autoSelected && <Check size={15} style={{ color: 'var(--accent)' }} />}
              </button>

              <div style={{
                padding: '8px 14px',
                fontSize: '0.6875rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                borderTop: '1px solid var(--border)',
              }}>
                Endpoints
              </div>

              {loading ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
                  <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 10px' }} />
                  <div style={{ fontSize: '0.8125rem' }}>Loading endpoints...</div>
                </div>
              ) : error ? (
                <div style={{ padding: '14px 16px', color: 'var(--error)', fontSize: '0.8125rem' }}>
                  {error}
                </div>
              ) : endpoints.length === 0 ? (
                <div style={{ padding: '14px 16px', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                  No endpoints reported for this model.
                </div>
              ) : endpoints.map((endpoint) => {
                const selected = value?.mode === 'provider' && value.provider_slug === endpoint.tag;
                return (
                  <button
                    key={endpoint.tag}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => selectEndpoint(endpoint)}
                    style={optionStyle(selected)}
                  >
                    <Server size={15} style={{ color: selected ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontWeight: selected ? 600 : 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {endpointLabel(endpoint)}
                      </div>
                      <div style={subTextStyle}>
                        {endpoint.tag} · {formatContext(endpoint.context_length)} ctx · {formatPrice(endpoint.pricing.prompt)}
                      </div>
                    </div>
                    {selected && <Check size={15} style={{ color: 'var(--accent)' }} />}
                  </button>
                );
              })}
            </div>

            {value?.mode === 'provider' && (
              <div style={{
                padding: '12px 14px',
                borderTop: '1px solid var(--border)',
                background: 'var(--bg-surface)',
              }}>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  cursor: 'pointer',
                  color: 'var(--text-primary)',
                  fontSize: '0.8125rem',
                }}>
                  <span>Allow fallbacks</span>
                  <span style={{
                    width: 36,
                    height: 20,
                    borderRadius: 10,
                    background: value.allow_fallbacks ? 'var(--accent)' : 'var(--bg-elevated)',
                    border: `1px solid ${value.allow_fallbacks ? 'var(--accent)' : 'var(--border)'}`,
                    position: 'relative',
                    transition: 'all 0.18s ease',
                    flexShrink: 0,
                  }}>
                    <input
                      type="checkbox"
                      checked={value.allow_fallbacks}
                      onChange={(e) => onChange({ ...value, allow_fallbacks: e.target.checked })}
                      style={{ opacity: 0, position: 'absolute', inset: 0, cursor: 'pointer' }}
                    />
                    <span style={{
                      width: 16,
                      height: 16,
                      borderRadius: '50%',
                      background: value.allow_fallbacks ? '#fff' : 'var(--text-muted)',
                      position: 'absolute',
                      top: 1,
                      left: value.allow_fallbacks ? 17 : 1,
                      transition: 'left 0.18s ease',
                    }} />
                  </span>
                </label>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

const subTextStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--text-muted)',
  marginTop: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function optionStyle(selected: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '10px 14px',
    border: 'none',
    borderBottom: '1px solid var(--border)',
    background: selected ? 'var(--accent-muted)' : 'transparent',
    color: 'var(--text-primary)',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: '0.875rem',
    transition: 'background var(--transition-fast)',
  };
}
