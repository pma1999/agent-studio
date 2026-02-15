import React, { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, Zap, Eye, Brain, Coins, Clock, Check, ChevronDown, Search, Star } from 'lucide-react';
import type { OpenRouterModel } from '../types';

interface PremiumModelSelectorProps {
  models: OpenRouterModel[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  loading?: boolean;
}

// Provider metadata for visual enhancement
const PROVIDER_META: Record<string, {
  name: string;
  color: string;
  icon: React.ReactNode;
  tier: 'premium' | 'standard' | 'economy';
}> = {
  'anthropic': {
    name: 'Anthropic',
    color: '#d4a574',
    icon: <Brain size={14} />,
    tier: 'premium'
  },
  'openai': {
    name: 'OpenAI',
    color: '#7ab88f',
    icon: <Sparkles size={14} />,
    tier: 'premium'
  },
  'google': {
    name: 'Google',
    color: '#8ba4d4',
    icon: <Zap size={14} />,
    tier: 'premium'
  },
  'meta': {
    name: 'Meta',
    color: '#a78bfa',
    icon: <Eye size={14} />,
    tier: 'standard'
  },
  'mistral': {
    name: 'Mistral',
    color: '#f59e0b',
    icon: <Zap size={14} />,
    tier: 'standard'
  },
  'cohere': {
    name: 'Cohere',
    color: '#ec4899',
    icon: <Brain size={14} />,
    tier: 'standard'
  },
};

function getProviderFromModelId(modelId: string): string {
  const parts = modelId.split('/');
  if (parts.length > 1) return parts[0];
  if (modelId.includes('claude')) return 'anthropic';
  if (modelId.includes('gpt')) return 'openai';
  if (modelId.includes('gemini')) return 'google';
  return 'other';
}

function formatPrice(priceStr: string): string {
  const price = parseFloat(priceStr);
  if (isNaN(price) || price === 0) return 'Free';
  if (price < 0.000001) return '<$0.001/M';
  return `$${(price * 1000000).toFixed(2)}/M`;
}

function formatContext(length: number): string {
  if (length >= 1000000) return `${(length / 1000000).toFixed(1)}M`;
  if (length >= 1000) return `${(length / 1000).toFixed(0)}K`;
  return String(length);
}

export function PremiumModelSelector({
  models,
  value,
  onChange,
  label = 'Model',
  disabled = false,
  loading = false,
}: PremiumModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => {
    const saved = localStorage.getItem('agent-studio:favorite-models');
    return saved ? JSON.parse(saved) : [];
  });

  // Add auto option
  const allOptions = useMemo(() => {
    const autoOption: OpenRouterModel = {
      id: 'openrouter/auto',
      name: 'Auto (Best for prompt)',
      description: 'OpenRouter automatically selects the best model',
      context_length: 128000,
      pricing: { prompt: '0', completion: '0' },
    };
    return [autoOption, ...models];
  }, [models]);

  // Filter models
  const filteredModels = useMemo(() => {
    if (!searchQuery) return allOptions;
    const query = searchQuery.toLowerCase();
    return allOptions.filter((m) =>
      m.name.toLowerCase().includes(query) ||
      m.id.toLowerCase().includes(query) ||
      getProviderFromModelId(m.id).toLowerCase().includes(query)
    );
  }, [allOptions, searchQuery]);

  // Group by category
  const groupedModels = useMemo(() => {
    const groups: Record<string, OpenRouterModel[]> = {
      'Favorites': [],
      'Recommended': [],
      'Premium': [],
      'Standard': [],
      'Economy': [],
    };

    filteredModels.forEach((model) => {
      if (model.id === 'openrouter/auto') {
        groups['Recommended'].push(model);
        return;
      }

      if (favorites.includes(model.id)) {
        groups['Favorites'].push(model);
        return;
      }

      const provider = getProviderFromModelId(model.id);
      const meta = PROVIDER_META[provider];
      const tier = meta?.tier || 'economy';

      if (tier === 'premium' && !groups['Favorites'].includes(model)) {
        groups['Premium'].push(model);
      } else if (tier === 'standard') {
        groups['Standard'].push(model);
      } else {
        groups['Economy'].push(model);
      }
    });

    // Remove empty groups
    return Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length > 0));
  }, [filteredModels, favorites]);

  const selectedModel = allOptions.find((m) => m.id === value);
  const selectedProvider = selectedModel ? getProviderFromModelId(selectedModel.id) : '';
  const selectedMeta = PROVIDER_META[selectedProvider];

  const toggleFavorite = (e: React.MouseEvent, modelId: string) => {
    e.stopPropagation();
    const newFavorites = favorites.includes(modelId)
      ? favorites.filter((id) => id !== modelId)
      : [...favorites, modelId];
    setFavorites(newFavorites);
    localStorage.setItem('agent-studio:favorite-models', JSON.stringify(newFavorites));
  };

  return (
    <div style={{ position: 'relative' }}>
      {label && (
        <label
          style={{
            display: 'block',
            fontSize: '0.75rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            marginBottom: '8px',
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </label>
      )}

      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled || loading}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '12px 16px',
          background: disabled ? 'var(--bg-surface)' : 'var(--bg-elevated)',
          border: `1px solid ${isOpen ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-md)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s ease',
          outline: 'none',
          boxShadow: isOpen ? '0 0 0 3px var(--accent-muted)' : 'none',
        }}
      >
        {/* Provider Icon */}
        <div
          style={{
            width: '36px',
            height: '36px',
            borderRadius: 'var(--radius-md)',
            background: selectedMeta?.color
              ? `${selectedMeta.color}15`
              : 'var(--accent-muted)',
            border: `1px solid ${selectedMeta?.color
              ? `${selectedMeta.color}30`
              : 'var(--border-accent)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: selectedMeta?.color || 'var(--accent)',
            flexShrink: 0,
          }}
        >
          {selectedMeta?.icon || <Sparkles size={16} />}
        </div>

        {/* Model Info */}
        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <div
            style={{
              fontSize: '0.9375rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {selectedModel?.name || 'Select model...'}
          </div>
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginTop: '2px',
            }}
          >
            {selectedProvider && (
              <span
                style={{
                  color: selectedMeta?.color || 'var(--text-muted)',
                  fontWeight: 500,
                }}
              >
                {selectedMeta?.name || selectedProvider}
              </span>
            )}
            {selectedModel && selectedModel.id !== 'openrouter/auto' && (
              <>
                <span>·</span>
                <span>{formatContext(selectedModel.context_length)} ctx</span>
              </>
            )}
          </div>
        </div>

        {/* Dropdown Arrow */}
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          style={{ color: 'var(--text-muted)', flexShrink: 0 }}
        >
          <ChevronDown size={18} />
        </motion.div>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 0,
            right: 0,
            maxHeight: '420px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-light)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 1000,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Search */}
          <div
            style={{
              padding: '12px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 14px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <Search size={16} style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models..."
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  fontSize: '0.875rem',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-body)',
                }}
                autoFocus
              />
            </div>
          </div>

          {/* Model List */}
          <div style={{ overflow: 'auto', flex: 1 }}>
            {filteredModels.length === 0 ? (
              <div
                style={{
                  padding: '32px',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                }}
              >
                No models found
              </div>
            ) : (
              Object.entries(groupedModels).map(([category, categoryModels]) => (
                <div key={category}>
                  <div
                    style={{
                      padding: '8px 16px',
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      color: 'var(--text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      background: 'var(--bg-surface)',
                    }}
                  >
                    {category}
                    {category === 'Favorites' && <Star size={10} style={{ marginLeft: '6px', display: 'inline' }} />}
                  </div>
                  {categoryModels.map((model) => {
                    const provider = getProviderFromModelId(model.id);
                    const meta = PROVIDER_META[provider];
                    const isSelected = model.id === value;
                    const isFavorite = favorites.includes(model.id);

                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => {
                          onChange(model.id);
                          setIsOpen(false);
                          setSearchQuery('');
                        }}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '12px 16px',
                          background: isSelected ? 'var(--accent-muted)' : 'transparent',
                          border: 'none',
                          borderLeft: `3px solid ${isSelected ? 'var(--accent)' : 'transparent'}`,
                          cursor: 'pointer',
                          textAlign: 'left',
                          transition: 'all 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) {
                            e.currentTarget.style.background = 'var(--bg-hover)';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) {
                            e.currentTarget.style.background = 'transparent';
                          }
                        }}
                      >
                        {/* Provider Icon */}
                        <div
                          style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: 'var(--radius-sm)',
                            background: meta?.color
                              ? `${meta.color}15`
                              : 'var(--bg-hover)',
                            border: `1px solid ${meta?.color
                              ? `${meta.color}30`
                              : 'var(--border)'}`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: meta?.color || 'var(--text-muted)',
                            flexShrink: 0,
                          }}
                        >
                          {meta?.icon || <Sparkles size={14} />}
                        </div>

                        {/* Model Info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              marginBottom: '3px',
                            }}
                          >
                            <span
                              style={{
                                fontSize: '0.875rem',
                                fontWeight: isSelected ? 600 : 500,
                                color: 'var(--text-primary)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {model.name}
                            </span>
                            {model.id === 'openrouter/auto' && (
                              <Sparkles size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--text-muted)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                            }}
                          >
                            <span style={{ color: meta?.color }}>{meta?.name || provider}</span>
                            {model.id !== 'openrouter/auto' && (
                              <>
                                <span>·</span>
                                <span>{formatContext(model.context_length)}</span>
                                <span>·</span>
                                <span>{formatPrice(model.pricing.prompt)}</span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {model.id !== 'openrouter/auto' && (
                            <button
                              type="button"
                              onClick={(e) => toggleFavorite(e, model.id)}
                              style={{
                                padding: '4px',
                                background: 'transparent',
                                border: 'none',
                                borderRadius: 'var(--radius-sm)',
                                cursor: 'pointer',
                                color: isFavorite ? 'var(--accent)' : 'var(--text-muted)',
                                opacity: isFavorite ? 1 : 0.5,
                                transition: 'all 0.15s ease',
                              }}
                              title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                            >
                              <Star size={16} fill={isFavorite ? 'currentColor' : 'none'} />
                            </button>
                          )}
                          {isSelected && (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              style={{ color: 'var(--accent)' }}
                            >
                              <Check size={18} />
                            </motion.div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </motion.div>
      )}

      {/* Click outside handler */}
      {isOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 999,
          }}
          onClick={() => {
            setIsOpen(false);
            setSearchQuery('');
          }}
        />
      )}
    </div>
  );
}
