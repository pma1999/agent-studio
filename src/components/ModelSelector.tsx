import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Search, Loader2, Cpu, ChevronDown, Sparkles, Clock, Star, Check, X, Building2 } from 'lucide-react';
import { modelsApi } from '../api/client';
import { useStore } from '../stores/store';
import { conversationsApi } from '../api/client';
import type { OpenRouterModel } from '../types';

interface ModelSelectorProps {
  agentModel: string;
  conversationId: string | null;
}

interface RecentModel {
  id: string;
  name: string;
  usedAt: number;
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

// Format author name nicely
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
    'nvidia': 'NVIDIA',
    'x-ai': 'xAI',
  };
  return displayNames[author] || author.charAt(0).toUpperCase() + author.slice(1);
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

const STORAGE_KEY = 'modelSelector.recent';
const MAX_RECENT = 5;

export function ModelSelector({ agentModel, conversationId }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [recentModels, setRecentModels] = useState<RecentModel[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['openai', 'anthropic']));
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { conversationModelOverrides, setConversationModelOverride, conversations, loadConversations } = useStore();

  // Load recent models from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setRecentModels(JSON.parse(stored));
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  // Save recent model
  const saveRecentModel = useCallback((modelId: string, modelName: string) => {
    setRecentModels((prev) => {
      const filtered = prev.filter((m) => m.id !== modelId);
      const updated = [{ id: modelId, name: modelName, usedAt: Date.now() }, ...filtered].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // Ignore storage errors
      }
      return updated;
    });
  }, []);

  // Get current conversation's model override
  const conversation = useMemo(() =>
    conversations.find((c) => c.id === conversationId),
    [conversations, conversationId]
  );

  // Priority: 1. Store override, 2. Conversation model from DB, 3. Agent model
  const effectiveModel = useMemo(() => {
    if (conversationId && conversationModelOverrides[conversationId] !== undefined) {
      return conversationModelOverrides[conversationId] || agentModel;
    }
    return conversation?.model || agentModel;
  }, [conversationId, conversationModelOverrides, conversation, agentModel]);

  const effectiveModelName = useMemo(() => {
    const model = models.find((m) => m.id === effectiveModel);
    return model?.name || formatModelId(effectiveModel);
  }, [effectiveModel, models]);

  // Load models when dropdown opens
  useEffect(() => {
    if (!isOpen) return;

    // Focus search input when opening
    setTimeout(() => searchInputRef.current?.focus(), 50);

    if (models.length === 0) {
      let cancelled = false;
      setLoading(true);
      modelsApi.openrouter()
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
      return () => { cancelled = true; };
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
    const priority = ['openai', 'anthropic', 'google', 'meta-llama', 'mistralai', 'deepseek', 'microsoft', 'amazon', 'cohere', 'x-ai'];
    return Object.entries(groups).sort(([a], [b]) => {
      const ai = priority.indexOf(a);
      const bi = priority.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [filteredModels]);

  const toggleGroup = useCallback((author: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(author)) {
        next.delete(author);
      } else {
        next.add(author);
      }
      return next;
    });
  }, []);

  const handleSelectModel = useCallback(async (modelId: string | null, modelName?: string) => {
    if (!conversationId) return;

    // Update local state immediately for responsive UI
    setConversationModelOverride(conversationId, modelId);

    // Persist to database
    try {
      await conversationsApi.updateModel(conversationId, modelId);
      await loadConversations();
      if (modelId && modelName) {
        saveRecentModel(modelId, modelName);
      }
    } catch (err) {
      console.error('Failed to update conversation model:', err);
    }

    setIsOpen(false);
    setSearch('');
  }, [conversationId, setConversationModelOverride, loadConversations, saveRecentModel]);

  const isUsingAgentDefault = !conversation?.model && !conversationModelOverrides[conversationId || ''];
  const currentAuthor = getModelAuthor(effectiveModel);
  const authorColor = getAuthorColor(currentAuthor);

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Select AI model for this conversation"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px 4px 8px',
          fontSize: '0.75rem',
          fontFamily: 'var(--font-mono)',
          color: isUsingAgentDefault ? 'var(--text-muted)' : 'var(--text-primary)',
          background: isOpen ? 'var(--bg-surface)' : 'transparent',
          border: `1px solid ${isOpen ? 'var(--border)' : 'transparent'}`,
          borderRadius: 'var(--radius-md)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          maxWidth: '200px',
        }}
        onMouseEnter={(e) => {
          if (!isOpen) {
            e.currentTarget.style.background = 'var(--bg-surface)';
            e.currentTarget.style.borderColor = 'var(--border)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isOpen) {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'transparent';
          }
        }}
      >
        {/* Provider indicator dot */}
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: authorColor,
            flexShrink: 0,
            boxShadow: `0 0 4px ${authorColor}40`,
          }}
        />
        <span
          style={{
            maxWidth: '120px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: isUsingAgentDefault ? 400 : 500,
          }}
        >
          {effectiveModelName}
        </span>
        <ChevronDown
          size={12}
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s ease',
            opacity: 0.6,
            flexShrink: 0,
          }}
        />
      </button>

      {isOpen && (
        <div
          role="listbox"
          aria-label="Available AI models"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            minWidth: '360px',
            maxWidth: '90vw',
            maxHeight: '480px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-light)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 20px 50px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.05)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            animation: 'modelSelectorEnter 0.15s ease-out',
          }}
        >
          <style>{`
            @keyframes modelSelectorEnter {
              from {
                opacity: 0;
                transform: translateY(-8px) scale(0.98);
              }
              to {
                opacity: 1;
                transform: translateY(0) scale(1);
              }
            }
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>

          {/* Header */}
          <div
            style={{
              padding: '14px 16px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Sparkles size={16} style={{ color: 'var(--accent)', opacity: 0.8 }} />
              <span
                style={{
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                Model
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
              <X size={16} />
            </button>
          </div>

          {/* Search */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ position: 'relative' }}>
              <Search
                size={14}
                style={{
                  position: 'absolute',
                  left: '12px',
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
                style={{
                  width: '100%',
                  padding: '8px 12px 8px 36px',
                  fontSize: '0.875rem',
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
                  padding: '40px',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                }}
              >
                <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
                <div style={{ fontSize: '0.875rem' }}>Loading models...</div>
              </div>
            ) : (
              <>
                {/* Agent Default Option */}
                {!search && (
                  <button
                    onClick={() => handleSelectModel(null)}
                    role="option"
                    aria-selected={isUsingAgentDefault}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      width: '100%',
                      padding: '12px 16px',
                      textAlign: 'left',
                      background: isUsingAgentDefault ? 'rgba(139, 92, 246, 0.08)' : 'transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      color: 'var(--text-primary)',
                      fontSize: '0.875rem',
                      transition: 'background 0.1s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!isUsingAgentDefault) e.currentTarget.style.background = 'var(--bg-surface)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isUsingAgentDefault) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <Cpu size={18} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: isUsingAgentDefault ? 600 : 500, marginBottom: '2px' }}>
                        Agent Default
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          fontFamily: 'var(--font-mono)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatModelId(agentModel)}
                      </div>
                    </div>
                    {isUsingAgentDefault && (
                      <Check size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    )}
                  </button>
                )}

                {/* Recent Models */}
                {!search && recentModels.length > 0 && (
                  <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
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
                        gap: '6px',
                      }}
                    >
                      <Clock size={12} />
                      Recent
                    </div>
                    {recentModels.map((recent) => {
                      const isSelected = effectiveModel === recent.id;
                      const model = models.find((m) => m.id === recent.id);
                      const author = getModelAuthor(recent.id);
                      return (
                        <button
                          key={recent.id}
                          onClick={() => handleSelectModel(recent.id, recent.name)}
                          role="option"
                          aria-selected={isSelected}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            width: '100%',
                            padding: '8px 16px',
                            textAlign: 'left',
                            background: isSelected ? 'rgba(139, 92, 246, 0.08)' : 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: 'var(--text-primary)',
                            fontSize: '0.875rem',
                            transition: 'background 0.1s ease',
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected) e.currentTarget.style.background = 'var(--bg-surface)';
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected) e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <span
                            style={{
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              background: getAuthorColor(author),
                              flexShrink: 0,
                            }}
                          />
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {recent.name}
                          </span>
                          {isSelected && <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Models by Provider */}
                <div style={{ padding: '8px 0' }}>
                  {groupedModels.length === 0 ? (
                    <div
                      style={{
                        padding: '24px',
                        textAlign: 'center',
                        color: 'var(--text-muted)',
                        fontSize: '0.875rem',
                      }}
                    >
                      No models found
                    </div>
                  ) : (
                    groupedModels.map(([author, authorModels]) => {
                      const isExpanded = expandedGroups.has(author);
                      const hasSelection = authorModels.some((m) => m.id === effectiveModel);

                      return (
                        <div key={author}>
                          <button
                            onClick={() => toggleGroup(author)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              width: '100%',
                              padding: '10px 16px',
                              textAlign: 'left',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              color: hasSelection ? 'var(--text-primary)' : 'var(--text-muted)',
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: '0.06em',
                              transition: 'color 0.15s ease',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.color = 'var(--text-primary)';
                            }}
                            onMouseLeave={(e) => {
                              if (!hasSelection) e.currentTarget.style.color = 'var(--text-muted)';
                            }}
                          >
                            <Building2 size={14} />
                            <span style={{ flex: 1 }}>{formatAuthor(author)}</span>
                            <span
                              style={{
                                fontSize: '0.6875rem',
                                color: 'var(--text-muted)',
                                fontWeight: 400,
                              }}
                            >
                              {authorModels.length}
                            </span>
                            <ChevronDown
                              size={14}
                              style={{
                                transform: isExpanded ? 'rotate(180deg)' : 'none',
                                transition: 'transform 0.2s ease',
                              }}
                            />
                          </button>

                          {isExpanded && (
                            <div style={{ padding: '4px 0' }}>
                              {authorModels.map((model) => {
                                const isSelected = effectiveModel === model.id;
                                return (
                                  <button
                                    key={model.id}
                                    onClick={() => handleSelectModel(model.id, model.name)}
                                    role="option"
                                    aria-selected={isSelected}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '10px',
                                      width: '100%',
                                      padding: '8px 16px 8px 32px',
                                      textAlign: 'left',
                                      background: isSelected ? 'rgba(139, 92, 246, 0.08)' : 'transparent',
                                      border: 'none',
                                      cursor: 'pointer',
                                      color: 'var(--text-primary)',
                                      fontSize: '0.875rem',
                                      transition: 'background 0.1s ease',
                                    }}
                                    onMouseEnter={(e) => {
                                      if (!isSelected) e.currentTarget.style.background = 'var(--bg-surface)';
                                    }}
                                    onMouseLeave={(e) => {
                                      if (!isSelected) e.currentTarget.style.background = 'transparent';
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
                                      <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
