import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ChevronDown, Search, Loader2, Cpu, Zap, Check, X, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { modelsApi } from '../api/client';
import type { OpenRouterModel } from '../types';

interface MessageModelSelectorProps {
  agentModel: string;
  conversationModel?: string | null;
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
  compact?: boolean;
}

// Extract author from model ID
function getModelAuthor(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.substring(0, slash) : 'other';
}

// Format model ID for display
function formatModelId(modelId: string): string {
  const parts = modelId.split('/');
  if (parts.length > 1) return parts[parts.length - 1];
  return modelId;
}

// Get color for author badge
function getAuthorColor(author: string): string {
  const colors: Record<string, string> = {
    'openai': '#10a37f',
    'anthropic': '#d97757',
    'google': '#4285f4',
    'meta-llama': '#0081fb',
    'mistralai': '#f97316',
    'deepseek': '#4f46e5',
    'microsoft': '#00a4ef',
    'amazon': '#ff9900',
    'cohere': '#ff6b6b',
  };
  return colors[author] || 'var(--text-muted)';
}

// Format author name
function formatAuthor(author: string): string {
  const displayNames: Record<string, string> = {
    'openai': 'OpenAI',
    'anthropic': 'Anthropic',
    'google': 'Google',
    'meta-llama': 'Meta',
    'mistralai': 'Mistral',
    'deepseek': 'DeepSeek',
    'microsoft': 'Microsoft',
    'amazon': 'Amazon',
    'cohere': 'Cohere',
    '01-ai': '01.AI',
    'x-ai': 'xAI',
  };
  return displayNames[author] || author.charAt(0).toUpperCase() + author.slice(1);
}

export function MessageModelSelector({
  agentModel,
  conversationModel,
  value,
  onChange,
  disabled = false,
  compact = false,
}: MessageModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Compute effective model (what will actually be used)
  const effectiveModel = useMemo(() => {
    if (value !== undefined && value !== null) return value;
    if (conversationModel) return conversationModel;
    return agentModel;
  }, [value, conversationModel, agentModel]);

  // Check if using per-message override
  const isPerMessageOverride = value !== null && value !== undefined;

  // Get model info
  const effectiveModelData = useMemo(() => {
    return models.find((m) => m.id === effectiveModel);
  }, [effectiveModel, models]);

  const currentAuthor = getModelAuthor(effectiveModel);
  const authorColor = getAuthorColor(currentAuthor);

  // Load models when dropdown opens
  useEffect(() => {
    if (!isOpen) return;

    // Focus search input when opening
    setTimeout(() => searchInputRef.current?.focus(), 50);

    if (models.length === 0) {
      let cancelled = false;
      setLoading(true);
      modelsApi
        .openrouter()
        .then((res) => {
          if (!cancelled) {
            setModels(res.data || []);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            console.error('Failed to load models:', err);
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }
  }, [isOpen, models.length]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Filter models by search
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

  // Group by author/provider
  const groupedModels = useMemo(() => {
    const groups: Record<string, OpenRouterModel[]> = {};
    for (const m of filteredModels) {
      const author = getModelAuthor(m.id);
      if (!groups[author]) groups[author] = [];
      groups[author].push(m);
    }
    const priority = ['openai', 'anthropic', 'google', 'meta-llama', 'mistralai', 'deepseek'];
    return Object.entries(groups).sort(([a], [b]) => {
      const ai = priority.indexOf(a);
      const bi = priority.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [filteredModels]);

  const handleSelectModel = useCallback(
    (modelId: string | null) => {
      onChange(modelId);
      setIsOpen(false);
      setSearch('');
    },
    [onChange]
  );

  // Determine what to show in the button
  const buttonLabel = useMemo(() => {
    if (isPerMessageOverride) {
      return formatModelId(value!);
    }
    if (conversationModel) {
      return formatModelId(conversationModel);
    }
    return 'Default';
  }, [isPerMessageOverride, value, conversationModel]);

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <motion.button
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        whileHover={disabled ? {} : { scale: 1.02 }}
        whileTap={disabled ? {} : { scale: 0.98 }}
        title={
          isPerMessageOverride
            ? `Using ${value} for this message only`
            : conversationModel
              ? `Using conversation default: ${conversationModel}`
              : `Using agent default: ${agentModel}`
        }
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: compact ? '4px' : '6px',
          padding: compact ? '0 10px' : '8px 12px',
          height: compact ? '32px' : 'auto',
          fontSize: compact ? '0.75rem' : '0.8125rem',
          fontFamily: 'var(--font-mono)',
          color: isPerMessageOverride ? 'var(--accent)' : 'var(--text-muted)',
          background: isPerMessageOverride
            ? 'rgba(139, 92, 246, 0.08)'
            : isOpen
              ? 'var(--bg-surface)'
              : 'var(--bg-surface)',
          border: `1px solid ${
            isPerMessageOverride
              ? 'rgba(139, 92, 246, 0.3)'
              : 'var(--border)'
          }`,
          borderRadius: 'var(--radius-md)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          boxShadow: isPerMessageOverride ? '0 0 12px rgba(139, 92, 246, 0.1)' : 'none',
        }}
      >
        {isPerMessageOverride ? (
          <Zap size={compact ? 12 : 14} style={{ color: 'var(--accent)' }} />
        ) : (
          <Cpu size={compact ? 12 : 14} />
        )}
        <span
          style={{
            maxWidth: compact ? '80px' : '100px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: isPerMessageOverride ? 600 : 500,
          }}
        >
          {buttonLabel}
        </span>
        <ChevronDown
          size={compact ? 12 : 14}
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s ease',
            opacity: 0.6,
          }}
        />
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 8px)',
              left: 0,
              minWidth: '320px',
              maxWidth: '90vw',
              maxHeight: '420px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-light)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.05)',
              zIndex: 1000,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: '12px 14px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Sparkles size={14} style={{ color: 'var(--accent)', opacity: 0.8 }} />
                <span
                  style={{
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                  }}
                >
                  Model for this message
                </span>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  padding: '4px',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--bg-surface)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--text-muted)';
                }}
              >
                <X size={14} />
              </button>
            </div>

            {/* Search */}
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ position: 'relative' }}>
                <Search
                  size={14}
                  style={{
                    position: 'absolute',
                    left: '10px',
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
                  style={{
                    width: '100%',
                    padding: '6px 10px 6px 32px',
                    fontSize: '0.8125rem',
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-primary)',
                    outline: 'none',
                    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = 'var(--accent)';
                    e.currentTarget.style.boxShadow = '0 0 0 3px rgba(139, 92, 246, 0.1)';
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                />
              </div>
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              {loading ? (
                <div
                  style={{
                    padding: '32px',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                  }}
                >
                  <Loader2
                    size={20}
                    style={{
                      animation: 'spin 1s linear infinite',
                      margin: '0 auto 8px',
                    }}
                  />
                  <div style={{ fontSize: '0.8125rem' }}>Loading models...</div>
                </div>
              ) : (
                <>
                  {/* Use default option */}
                  <button
                    onClick={() => handleSelectModel(null)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      width: '100%',
                      padding: '10px 14px',
                      textAlign: 'left',
                      background: !isPerMessageOverride
                        ? 'rgba(139, 92, 246, 0.08)'
                        : 'transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      color: 'var(--text-primary)',
                      fontSize: '0.8125rem',
                      transition: 'background 0.1s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (isPerMessageOverride)
                        e.currentTarget.style.background = 'var(--bg-surface)';
                    }}
                    onMouseLeave={(e) => {
                      if (isPerMessageOverride)
                        e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <Cpu size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: !isPerMessageOverride ? 600 : 500 }}>
                        Use Default
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {conversationModel
                          ? formatModelId(conversationModel)
                          : formatModelId(agentModel)}
                      </div>
                    </div>
                    {!isPerMessageOverride && (
                      <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    )}
                  </button>

                  {/* Quick picks - Popular models */}
                  {!search && (
                    <div
                      style={{
                        padding: '10px 14px',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div
                        style={{
                          fontSize: '0.625rem',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '0.08em',
                          color: 'var(--text-muted)',
                          marginBottom: '8px',
                        }}
                      >
                        Quick Picks
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '6px',
                        }}
                      >
                        {[
                          'openai/gpt-4o',
                          'anthropic/claude-3-5-sonnet-20241022',
                          'anthropic/claude-3-opus-20240229',
                          'google/gemini-2.0-flash-exp',
                        ]
                          .map((id) => {
                            const model = models.find((m) => m.id === id);
                            if (!model) return null;
                            const isSelected = value === id;
                            const author = getModelAuthor(id);
                            return (
                              <button
                                key={id}
                                onClick={() => handleSelectModel(id)}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  padding: '4px 10px',
                                  fontSize: '0.75rem',
                                  background: isSelected
                                    ? 'rgba(139, 92, 246, 0.15)'
                                    : 'var(--bg-base)',
                                  border: `1px solid ${
                                    isSelected ? 'var(--accent)' : 'var(--border)'
                                  }`,
                                  borderRadius: 'var(--radius-sm)',
                                  color: isSelected
                                    ? 'var(--accent)'
                                    : 'var(--text-primary)',
                                  cursor: 'pointer',
                                  transition: 'all 0.15s ease',
                                }}
                                onMouseEnter={(e) => {
                                  if (!isSelected) {
                                    e.currentTarget.style.borderColor = 'var(--border-light)';
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (!isSelected) {
                                    e.currentTarget.style.borderColor = 'var(--border)';
                                  }
                                }}
                              >
                                <span
                                  style={{
                                    width: '5px',
                                    height: '5px',
                                    borderRadius: '50%',
                                    background: getAuthorColor(author),
                                  }}
                                />
                                {formatModelId(id)}
                              </button>
                            );
                          })
                          .filter(Boolean)}
                      </div>
                    </div>
                  )}

                  {/* Models list */}
                  <div style={{ padding: '6px 0' }}>
                    {groupedModels.length === 0 ? (
                      <div
                        style={{
                          padding: '20px',
                          textAlign: 'center',
                          color: 'var(--text-muted)',
                          fontSize: '0.8125rem',
                        }}
                      >
                        No models found
                      </div>
                    ) : (
                      groupedModels.map(([author, authorModels]) => (
                        <div key={author}>
                          <div
                            style={{
                              padding: '6px 14px',
                              fontSize: '0.625rem',
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: '0.08em',
                              color: 'var(--text-muted)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            <span
                              style={{
                                width: '5px',
                                height: '5px',
                                borderRadius: '50%',
                                background: getAuthorColor(author),
                              }}
                            />
                            {formatAuthor(author)}
                          </div>
                          {authorModels.map((model) => {
                            const isSelected = value === model.id;
                            return (
                              <button
                                key={model.id}
                                onClick={() => handleSelectModel(model.id)}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '8px',
                                  width: '100%',
                                  padding: '7px 14px',
                                  textAlign: 'left',
                                  background: isSelected
                                    ? 'rgba(139, 92, 246, 0.08)'
                                    : 'transparent',
                                  border: 'none',
                                  cursor: 'pointer',
                                  color: 'var(--text-primary)',
                                  fontSize: '0.8125rem',
                                  transition: 'background 0.1s ease',
                                }}
                                onMouseEnter={(e) => {
                                  if (!isSelected)
                                    e.currentTarget.style.background = 'var(--bg-surface)';
                                }}
                                onMouseLeave={(e) => {
                                  if (!isSelected)
                                    e.currentTarget.style.background = 'transparent';
                                }}
                              >
                                <span
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    fontWeight: isSelected ? 500 : 400,
                                  }}
                                >
                                  {model.name}
                                </span>
                                {isSelected && (
                                  <Check
                                    size={14}
                                    style={{
                                      color: 'var(--accent)',
                                      flexShrink: 0,
                                    }}
                                  />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
