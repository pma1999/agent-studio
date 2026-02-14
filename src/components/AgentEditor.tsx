import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, Loader2, Zap, Globe, Brain, Wrench, Plug, Braces, ExternalLink } from 'lucide-react';
import { useStore } from '../stores/store';
import { agentsApi, modelsApi, toolsApi, mcpServersApi } from '../api/client';
import { Modal } from './ui/Modal';
import { Input } from './ui/Input';
import { TextArea } from './ui/TextArea';
import { Slider } from './ui/Slider';
import { Button } from './ui/Button';
import type { AgentFormData, OpenRouterModel, ReasoningEffort, Tool, McpServer } from '../types';

const EMOJI_OPTIONS = [
  '🤖', '✨', '🧠', '💡', '🎯', '🔮', '⚡', '🌟', '🎨', '📝',
  '🔬', '🎭', '🌊', '🔥', '💎', '🦊', '🐉', '🧙', '👾', '🎪',
  '🏛️', '📚', '🔧', '🎵', '🌙', '☕', '🎲', '🧩', '🛡️', '🗡️',
];

const DEFAULT_FORM: AgentFormData = {
  name: '',
  description: '',
  emoji: '🤖',
  system_prompt: '',
  provider: 'openrouter',
  base_url: 'https://openrouter.ai/api/v1',
  model: 'openrouter/auto',
  temperature: 0.7,
  max_tokens: 4096,
  web_search_enabled: false,
  reasoning_enabled: false,
  reasoning_effort: null,
  reasoning_max_tokens: null,
  tool_ids: [],
  mcp_server_ids: [],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  structured_output_enabled: false,
  structured_output_schema: null,
  response_healing_enabled: false,
};

const EFFORT_LEVELS: { value: ReasoningEffort; label: string; desc: string }[] = [
  { value: 'minimal', label: 'Minimal', desc: '~10% tokens' },
  { value: 'low', label: 'Low', desc: '~20% tokens' },
  { value: 'medium', label: 'Medium', desc: '~50% tokens' },
  { value: 'high', label: 'High', desc: '~80% tokens' },
  { value: 'xhigh', label: 'Max', desc: '~95% tokens' },
];

// Extract author from model ID like "openai/gpt-4o" -> "openai"
function getModelAuthor(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.substring(0, slash) : 'other';
}

// Format price per million tokens
function formatPrice(pricePerToken: string): string {
  const p = parseFloat(pricePerToken);
  if (isNaN(p) || p === 0) return 'Free';
  const perMillion = p * 1_000_000;
  if (perMillion < 0.01) return '<$0.01/M';
  if (perMillion >= 100) return `$${perMillion.toFixed(0)}/M`;
  return `$${perMillion.toFixed(2)}/M`;
}

// Format context length
function formatContext(ctx: number): string {
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
  return String(ctx);
}

function OpenRouterModelPicker({
  selectedModel,
  onSelect,
}: {
  selectedModel: string;
  onSelect: (modelId: string) => void;
}) {
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    modelsApi.openrouter()
      .then((res) => {
        if (!cancelled) {
          setModels(res.data || []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load models');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.description && m.description.toLowerCase().includes(q))
    );
  }, [models, search]);

  // Group by author
  const grouped = useMemo(() => {
    const groups: Record<string, OpenRouterModel[]> = {};
    for (const m of filtered) {
      const author = getModelAuthor(m.id);
      if (!groups[author]) groups[author] = [];
      groups[author].push(m);
    }
    // Sort groups by count (most models first), but put popular ones at top
    const priority = ['openai', 'anthropic', 'google', 'meta-llama', 'mistralai', 'deepseek'];
    return Object.entries(groups).sort(([a], [b]) => {
      const ai = priority.indexOf(a);
      const bi = priority.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: '32px',
        color: 'var(--text-muted)',
        fontSize: '0.8125rem',
      }}>
        <Loader2 size={16} className="animate-pulse" style={{ animation: 'pulse 1.5s ease-in-out infinite' }} />
        Loading models...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        padding: '12px',
        background: 'rgba(201, 107, 107, 0.1)',
        border: '1px solid rgba(201, 107, 107, 0.2)',
        borderRadius: 'var(--radius-sm)',
        fontSize: '0.8125rem',
        color: 'var(--error)',
      }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Search */}
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
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search 300+ models..."
          style={{
            width: '100%',
            padding: '8px 10px 8px 30px',
            fontSize: '0.8125rem',
            fontFamily: 'var(--font-body)',
            background: 'var(--bg-base)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            outline: 'none',
            transition: 'border-color var(--transition-fast)',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#8b5cf6'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
        />
      </div>

      {/* Selected model display */}
      {selectedModel && (
        <div style={{
          padding: '6px 10px',
          background: 'rgba(139, 92, 246, 0.1)',
          border: '1px solid rgba(139, 92, 246, 0.25)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '0.75rem',
          fontFamily: 'var(--font-mono)',
          color: '#a78bfa',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <Zap size={11} />
          {selectedModel}
        </div>
      )}

      {/* Model list */}
      <div style={{
        maxHeight: '240px',
        overflowY: 'auto',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-base)',
      }}>
        {grouped.length === 0 ? (
          <div style={{
            padding: '24px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.8125rem',
          }}>
            No models found
          </div>
        ) : (
          grouped.map(([author, authorModels]) => (
            <div key={author}>
              {/* Author header */}
              <div style={{
                padding: '6px 10px',
                fontSize: '0.6875rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                background: 'var(--bg-surface)',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}>
                {author} ({authorModels.length})
              </div>
              {/* Author's models */}
              {authorModels.map((m) => {
                const isSelected = m.id === selectedModel;
                return (
                  <button
                    key={m.id}
                    onClick={() => onSelect(m.id)}
                    style={{
                      display: 'flex',
                      width: '100%',
                      padding: '8px 10px',
                      border: 'none',
                      borderBottom: '1px solid var(--border)',
                      background: isSelected ? 'rgba(139, 92, 246, 0.12)' : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'background var(--transition-fast)',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'var(--bg-hover)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: '0.8125rem',
                        color: isSelected ? '#a78bfa' : 'var(--text-primary)',
                        fontWeight: isSelected ? 500 : 400,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {m.name}
                      </div>
                      <div style={{
                        fontSize: '0.6875rem',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {m.id}
                      </div>
                    </div>
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      flexShrink: 0,
                      gap: '1px',
                    }}>
                      <span style={{
                        fontSize: '0.625rem',
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                      }}>
                        {formatContext(m.context_length)} ctx
                      </span>
                      <span style={{
                        fontSize: '0.625rem',
                        color: m.pricing.prompt === '0' ? 'var(--success)' : 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                      }}>
                        {formatPrice(m.pricing.prompt)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function AgentEditor() {
  const {
    agentEditorOpen,
    setAgentEditorOpen,
    editingAgent,
    setEditingAgent,
    loadAgents,
  } = useStore();

  const [form, setForm] = useState<AgentFormData>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [allMcpServers, setAllMcpServers] = useState<McpServer[]>([]);

  useEffect(() => {
    if (editingAgent) {
      setForm({
        name: editingAgent.name,
        description: editingAgent.description,
        emoji: editingAgent.emoji,
        system_prompt: editingAgent.system_prompt,
        provider: editingAgent.provider || 'openrouter',
        base_url: editingAgent.base_url,
        model: editingAgent.model,
        temperature: editingAgent.temperature,
        max_tokens: editingAgent.max_tokens,
        web_search_enabled: !!editingAgent.web_search_enabled,
        reasoning_enabled: !!editingAgent.reasoning_enabled,
        reasoning_effort: editingAgent.reasoning_effort || null,
        reasoning_max_tokens: editingAgent.reasoning_max_tokens || null,
        tool_ids: editingAgent.tool_ids ?? [],
        mcp_server_ids: editingAgent.mcp_server_ids ?? [],
        tool_choice: (editingAgent as { tool_choice?: string }).tool_choice === 'none' ? 'none' : 'auto',
        parallel_tool_calls: (editingAgent as { parallel_tool_calls?: number }).parallel_tool_calls === 0 ? false : true,
        structured_output_enabled: !!(editingAgent as { structured_output_enabled?: number }).structured_output_enabled,
        structured_output_schema: (editingAgent as { structured_output_schema?: string | null }).structured_output_schema ?? null,
        response_healing_enabled: !!(editingAgent as { response_healing_enabled?: number }).response_healing_enabled,
      });
    } else {
      setForm(DEFAULT_FORM);
    }
    setError('');
  }, [editingAgent, agentEditorOpen]);

  useEffect(() => {
    if (agentEditorOpen) {
      toolsApi.list().then(setAllTools).catch(() => setAllTools([]));
      mcpServersApi.list().then(setAllMcpServers).catch(() => setAllMcpServers([]));
    }
  }, [agentEditorOpen]);

  const handleClose = () => {
    setAgentEditorOpen(false);
    setEditingAgent(null);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError('Agent name is required');
      return;
    }
    if (!form.system_prompt.trim()) {
      setError('System prompt is required');
      return;
    }
    if (form.structured_output_enabled) {
      const raw = form.structured_output_schema?.trim();
      if (!raw) {
        setError('Structured output is enabled but schema is empty. Add a JSON schema or disable it.');
        return;
      }
      try {
        const parsed = JSON.parse(raw) as {
          type?: string;
          json_schema?: { name?: string; schema?: unknown };
          name?: string;
          schema?: unknown;
        };
        const config = parsed.type === 'json_schema' && parsed.json_schema
          ? parsed.json_schema
          : { name: parsed.name, schema: parsed.schema };
        const schema = config.schema as Record<string, unknown> | undefined;
        if (!config.name || !schema || typeof schema !== 'object' || schema.type !== 'object') {
          setError('Schema must include "name" and "schema" with type "object". You can paste the short form { "name", "strict", "schema" } or the full API form { "type": "json_schema", "json_schema": { ... } }.');
          return;
        }
      } catch {
        setError('Structured output schema is invalid JSON.');
        return;
      }
    }

    setSaving(true);
    setError('');

    try {
      if (editingAgent) {
        await agentsApi.update(editingAgent.id, form);
      } else {
        await agentsApi.create(form);
      }
      await loadAgents();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  };

  const updateField = <K extends keyof AgentFormData>(key: K, value: AgentFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <Modal
      isOpen={agentEditorOpen}
      onClose={handleClose}
      title={editingAgent ? 'Edit Agent' : 'Create New Agent'}
      maxWidth="640px"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {error && (
          <div style={{
            padding: '10px 14px',
            background: 'rgba(201, 107, 107, 0.1)',
            border: '1px solid rgba(201, 107, 107, 0.2)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--error)',
            fontSize: '0.8125rem',
          }}>
            {error}
          </div>
        )}

        {/* Emoji Picker */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{
            fontSize: '0.8125rem',
            fontWeight: 500,
            color: 'var(--text-secondary)',
            letterSpacing: '0.02em',
          }}>
            Avatar
          </label>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
          }}>
            {EMOJI_OPTIONS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => updateField('emoji', emoji)}
                style={{
                  width: '38px',
                  height: '38px',
                  fontSize: '1.25rem',
                  border: form.emoji === emoji ? '2px solid var(--accent)' : '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  background: form.emoji === emoji ? 'var(--accent-muted)' : 'var(--bg-surface)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  if (form.emoji !== emoji) {
                    e.currentTarget.style.background = 'var(--bg-hover)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (form.emoji !== emoji) {
                    e.currentTarget.style.background = 'var(--bg-surface)';
                  }
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>

        <Input
          label="Name"
          value={form.name}
          onChange={(e) => updateField('name', e.target.value)}
          placeholder="e.g. Creative Writer, Code Reviewer..."
        />

        <Input
          label="Description"
          value={form.description}
          onChange={(e) => updateField('description', e.target.value)}
          placeholder="Brief description of what this agent does"
        />

        <TextArea
          label="System Prompt"
          value={form.system_prompt}
          onChange={(e) => updateField('system_prompt', e.target.value)}
          placeholder="You are a helpful assistant that..."
          style={{ minHeight: '160px', fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
        />

        {/* Model Configuration */}
        <div style={{
          padding: '16px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}>
          <div style={{
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>
            Model
          </div>

          <OpenRouterModelPicker
                selectedModel={form.model}
                onSelect={(modelId) => updateField('model', modelId)}
              />

              {/* Web Search Toggle */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 12px',
                background: form.web_search_enabled ? 'rgba(139, 92, 246, 0.06)' : 'var(--bg-base)',
                border: `1px solid ${form.web_search_enabled ? 'rgba(139, 92, 246, 0.2)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
                onClick={() => {
                  const nextEnabled = !form.web_search_enabled;
                  updateField('web_search_enabled', nextEnabled);
                  const webSearchTool = allTools.find((t) => t.name === 'web_search');
                  if (webSearchTool) {
                    const ids = form.tool_ids ?? [];
                    if (nextEnabled) updateField('tool_ids', ids.includes(webSearchTool.id) ? ids : [...ids, webSearchTool.id]);
                    else updateField('tool_ids', ids.filter((id) => id !== webSearchTool.id));
                  }
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Globe size={14} style={{ color: form.web_search_enabled ? '#a78bfa' : 'var(--text-muted)' }} />
                  <div>
                    <div style={{
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      color: form.web_search_enabled ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}>
                      Web Search
                    </div>
                    <div style={{
                      fontSize: '0.6875rem',
                      color: 'var(--text-muted)',
                    }}>
                      Allow this agent to search the web for real-time information
                    </div>
                  </div>
                </div>
                {/* Toggle switch */}
                <div style={{
                  width: '36px',
                  height: '20px',
                  borderRadius: '10px',
                  background: form.web_search_enabled ? '#8b5cf6' : 'var(--bg-elevated)',
                  border: `1px solid ${form.web_search_enabled ? '#8b5cf6' : 'var(--border)'}`,
                  position: 'relative',
                  transition: 'all 0.2s ease',
                  flexShrink: 0,
                }}>
                  <div style={{
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    background: form.web_search_enabled ? '#ffffff' : 'var(--text-muted)',
                    position: 'absolute',
                    top: '1px',
                    left: form.web_search_enabled ? '17px' : '1px',
                    transition: 'all 0.2s ease',
                  }} />
                </div>
              </div>

              {/* Tools (assign which tools this agent can use) */}
              {allTools.length > 0 && (
                <div style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '10px 12px',
                    background: 'var(--bg-elevated)',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                    color: 'var(--text-secondary)',
                  }}>
                    <Wrench size={14} />
                    Tools
                  </div>
                  <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {allTools.map((tool) => {
                      const checked = (form.tool_ids ?? []).includes(tool.id);
                      return (
                        <label
                          key={tool.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            cursor: 'pointer',
                            fontSize: '0.8125rem',
                            color: 'var(--text-primary)',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const ids = form.tool_ids ?? [];
                              if (checked) updateField('tool_ids', ids.filter((id) => id !== tool.id));
                              else updateField('tool_ids', [...ids, tool.id]);
                              if (tool.name === 'web_search') updateField('web_search_enabled', !checked);
                            }}
                            style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                          />
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{tool.name}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{tool.type}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* MCP Servers (assign which MCP servers this agent uses) */}
              {allMcpServers.length > 0 && (
                <div style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '10px 12px',
                    background: 'var(--bg-elevated)',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                    color: 'var(--text-secondary)',
                  }}>
                    <Plug size={14} />
                    MCP Servers
                  </div>
                  <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {allMcpServers.map((mcp) => {
                      const checked = (form.mcp_server_ids ?? []).includes(mcp.id);
                      return (
                        <label
                          key={mcp.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            cursor: 'pointer',
                            fontSize: '0.8125rem',
                            color: 'var(--text-primary)',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const ids = form.mcp_server_ids ?? [];
                              if (checked) updateField('mcp_server_ids', ids.filter((id) => id !== mcp.id));
                              else updateField('mcp_server_ids', [...ids, mcp.id]);
                            }}
                            style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                          />
                          <span style={{ fontWeight: 500 }}>{mcp.name}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{mcp.transport}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Tool choice & parallel tool calls (OpenRouter, when agent has tools) */}
              {((form.tool_ids?.length ?? 0) > 0 || (form.mcp_server_ids?.length ?? 0) > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Tool choice</label>
                    <select
                      value={form.tool_choice ?? 'auto'}
                      onChange={(e) => updateField('tool_choice', e.target.value as 'auto' | 'none')}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        color: 'var(--text-primary)',
                        fontSize: '0.875rem',
                      }}
                    >
                      <option value="auto">Auto — model decides when to call tools</option>
                      <option value="none">None — disable tool calls for this request</option>
                    </select>
                  </div>
                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    cursor: 'pointer',
                    fontSize: '0.8125rem',
                    color: 'var(--text-primary)',
                  }}>
                    <input
                      type="checkbox"
                      checked={form.parallel_tool_calls !== false}
                      onChange={(e) => updateField('parallel_tool_calls', e.target.checked)}
                      style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                    />
                    Allow parallel tool calls
                  </label>
                </div>
              )}

              {/* Reasoning / Thinking Configuration */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0',
                border: `1px solid ${form.reasoning_enabled ? 'rgba(212, 160, 48, 0.25)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                transition: 'all 0.2s ease',
              }}>
                {/* Reasoning toggle header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    background: form.reasoning_enabled ? 'rgba(212, 160, 48, 0.06)' : 'var(--bg-base)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => updateField('reasoning_enabled', !form.reasoning_enabled)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Brain size={14} style={{ color: form.reasoning_enabled ? '#d4a030' : 'var(--text-muted)' }} />
                    <div>
                      <div style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: form.reasoning_enabled ? 'var(--text-primary)' : 'var(--text-secondary)',
                      }}>
                        Reasoning / Thinking
                      </div>
                      <div style={{
                        fontSize: '0.6875rem',
                        color: 'var(--text-muted)',
                      }}>
                        Enable step-by-step reasoning for deeper, more accurate responses
                      </div>
                    </div>
                  </div>
                  {/* Toggle switch */}
                  <div style={{
                    width: '36px',
                    height: '20px',
                    borderRadius: '10px',
                    background: form.reasoning_enabled ? '#d4a030' : 'var(--bg-elevated)',
                    border: `1px solid ${form.reasoning_enabled ? '#d4a030' : 'var(--border)'}`,
                    position: 'relative',
                    transition: 'all 0.2s ease',
                    flexShrink: 0,
                  }}>
                    <div style={{
                      width: '16px',
                      height: '16px',
                      borderRadius: '50%',
                      background: form.reasoning_enabled ? '#ffffff' : 'var(--text-muted)',
                      position: 'absolute',
                      top: '1px',
                      left: form.reasoning_enabled ? '17px' : '1px',
                      transition: 'all 0.2s ease',
                    }} />
                  </div>
                </div>

                {/* Expanded reasoning settings */}
                {form.reasoning_enabled && (
                  <div style={{
                    padding: '12px',
                    borderTop: '1px solid var(--border)',
                    background: 'var(--bg-base)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}>
                    {/* Effort Level */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{
                        fontSize: '0.6875rem',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}>
                        Effort Level
                      </label>
                      <div style={{
                        display: 'flex',
                        gap: '0',
                        background: 'var(--bg-surface)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        padding: '2px',
                      }}>
                        {EFFORT_LEVELS.map((level) => {
                          const isActive = form.reasoning_effort === level.value;
                          return (
                            <button
                              key={level.value}
                              onClick={() => updateField('reasoning_effort', level.value)}
                              title={level.desc}
                              style={{
                                flex: 1,
                                padding: '6px 4px',
                                fontSize: '0.6875rem',
                                fontWeight: isActive ? 600 : 400,
                                fontFamily: 'var(--font-body)',
                                border: 'none',
                                borderRadius: 'calc(var(--radius-sm) - 2px)',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                                background: isActive ? 'rgba(212, 160, 48, 0.2)' : 'transparent',
                                color: isActive ? '#d4a030' : 'var(--text-muted)',
                                letterSpacing: '0.01em',
                              }}
                            >
                              {level.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Max Tokens for Reasoning (optional) */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{
                        fontSize: '0.6875rem',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}>
                        Reasoning Budget
                        <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: '0' }}>(optional)</span>
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <input
                          type="number"
                          value={form.reasoning_max_tokens || ''}
                          onChange={(e) => {
                            const v = parseInt(e.target.value);
                            updateField('reasoning_max_tokens', isNaN(v) ? null : v);
                          }}
                          placeholder="Auto (from effort)"
                          min={1024}
                          max={128000}
                          style={{
                            flex: 1,
                            padding: '7px 10px',
                            fontSize: '0.8125rem',
                            fontFamily: 'var(--font-mono)',
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--text-primary)',
                            outline: 'none',
                            transition: 'border-color var(--transition-fast)',
                          }}
                          onFocus={(e) => { e.currentTarget.style.borderColor = '#d4a030'; }}
                          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                        />
                        <span style={{
                          fontSize: '0.6875rem',
                          color: 'var(--text-muted)',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}>
                          tokens
                        </span>
                      </div>
                      <span style={{
                        fontSize: '0.625rem',
                        color: 'var(--text-muted)',
                        lineHeight: 1.4,
                      }}>
                        Override the effort level with an exact token budget (1,024 - 128,000). Leave empty to use the effort level.
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Structured Output (OpenRouter JSON Schema + Response Healing) */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0,
                border: `1px solid ${form.structured_output_enabled ? 'rgba(99, 102, 241, 0.25)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                transition: 'all 0.2s ease',
              }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    background: form.structured_output_enabled ? 'rgba(99, 102, 241, 0.06)' : 'var(--bg-base)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => updateField('structured_output_enabled', !form.structured_output_enabled)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Braces size={14} style={{ color: form.structured_output_enabled ? '#6366f1' : 'var(--text-muted)' }} />
                    <div>
                      <div style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: form.structured_output_enabled ? 'var(--text-primary)' : 'var(--text-secondary)',
                      }}>
                        Enforce JSON Schema
                      </div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                        Type-safe structured responses (OpenRouter)
                      </div>
                    </div>
                  </div>
                  <div style={{
                    width: '36px',
                    height: '20px',
                    borderRadius: '10px',
                    background: form.structured_output_enabled ? '#6366f1' : 'var(--bg-elevated)',
                    border: `1px solid ${form.structured_output_enabled ? '#6366f1' : 'var(--border)'}`,
                    position: 'relative',
                    transition: 'all 0.2s ease',
                    flexShrink: 0,
                  }}>
                    <div style={{
                      width: '16px',
                      height: '16px',
                      borderRadius: '50%',
                      background: form.structured_output_enabled ? '#ffffff' : 'var(--text-muted)',
                      position: 'absolute',
                      top: '1px',
                      left: form.structured_output_enabled ? '17px' : '1px',
                      transition: 'all 0.2s ease',
                    }} />
                  </div>
                </div>
                {form.structured_output_enabled && (
                  <div style={{
                    padding: '12px',
                    borderTop: '1px solid var(--border)',
                    background: 'var(--bg-base)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{
                        fontSize: '0.6875rem',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}>
                        Schema (OpenRouter)
                      </label>
                      <textarea
                        value={form.structured_output_schema ?? ''}
                        onChange={(e) => updateField('structured_output_schema', e.target.value || null)}
                        placeholder={'{\n  "name": "myResponse",\n  "strict": true,\n  "schema": {\n    "type": "object",\n    "properties": { "key": { "type": "string" } },\n    "required": ["key"],\n    "additionalProperties": false\n  }\n}'}
                        rows={10}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-mono)',
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          color: 'var(--text-primary)',
                          outline: 'none',
                          resize: 'vertical',
                          transition: 'border-color var(--transition-fast)',
                        }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#6366f1'; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                      />
                      <p style={{
                        fontSize: '0.6875rem',
                        color: 'var(--text-muted)',
                        lineHeight: 1.45,
                        margin: 0,
                      }}>
                        Required: <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 2 }}>name</code> and <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 2 }}>schema</code> with <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 2 }}>type: &quot;object&quot;</code>. Use <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 2 }}>strict: true</code> (recommended).{' '}
                        <a
                          href="https://openrouter.ai/docs/guides/features/structured-outputs"
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#6366f1', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2 }}
                        >
                          Docs <ExternalLink size={10} />
                        </a>
                      </p>
                    </div>
                    <label style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                      cursor: 'pointer',
                      fontSize: '0.8125rem',
                      color: 'var(--text-primary)',
                    }}>
                      <input
                        type="checkbox"
                        checked={form.response_healing_enabled ?? false}
                        onChange={(e) => updateField('response_healing_enabled', e.target.checked)}
                        style={{ width: '16px', height: '16px', marginTop: 2, accentColor: '#6366f1' }}
                      />
                      <span>
                        <strong>Response Healing</strong> — Repair malformed JSON; uses non-streaming for this request.{' '}
                        <a
                          href="https://openrouter.ai/docs/guides/features/plugins/response-healing"
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#6366f1', textDecoration: 'none' }}
                        >
                          Learn more
                        </a>
                      </span>
                    </label>
                    <p style={{
                      fontSize: '0.6875rem',
                      color: 'var(--text-muted)',
                      lineHeight: 1.45,
                      margin: 0,
                      padding: '6px 0 0',
                      borderTop: '1px solid var(--border)',
                      marginTop: 8,
                    }}>
                      With <strong>PDF attachments</strong>, many models do not return strict JSON and may output plain text instead. Use text-only messages when you need guaranteed structured output.
                    </p>
                  </div>
                )}
              </div>

          <Slider
            label="Temperature"
            value={form.temperature}
            onChange={(v) => updateField('temperature', Math.round(v * 100) / 100)}
            min={0}
            max={2}
            step={0.05}
          />

          <div>
            <Input
              label="Max Tokens"
              type="number"
              value={String(form.max_tokens)}
              onChange={(e) => updateField('max_tokens', parseInt(e.target.value) || 8192)}
              style={{ fontSize: '0.8125rem', fontFamily: 'var(--font-mono)' }}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="agent-editor-actions">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            {editingAgent ? 'Save Changes' : 'Create Agent'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
