import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, Plus, X, ChevronDown, ChevronUp, Wrench, Server, Sparkles, Cpu, GitMerge } from 'lucide-react';
import { useStore } from '../stores/store';
import { councilsApi, toolsApi, mcpServersApi } from '../api/client';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { TextArea } from './ui/TextArea';
import { Modal } from './ui/Modal';
import { ModelSelectorCore } from './ModelSelectorCore';
import { ProviderRoutingSelector } from './ProviderRoutingSelector';
import { useOpenRouterModels } from '../hooks/useOpenRouterModels';
import type { CouncilMember, ProviderRoutingConfig } from '../types';

const DEFAULT_SYNTHESIS_TEMPLATE = `You are a synthesis expert. Your task is to analyze multiple AI model responses to the same query and create a unified, comprehensive answer.

## Original Query
"""{{user_query}}"""

## Input Responses
You will receive responses from {{member_count}} different AI models:

{{member_responses}}

## Your Task
1. **Analyze all responses** for:
   - Areas of agreement (consensus)
   - Areas of disagreement or different perspectives
   - Unique insights from individual models
   - Factual discrepancies that need resolution

2. **Synthesize a unified response** that:
   - Presents the most accurate and complete answer
   - Acknowledges different perspectives where relevant
   - Resolves contradictions using your best judgment
   - Maintains a professional, helpful tone
   - Cites which models contributed key insights when relevant

3. **Structure your response** with:
   - A clear, direct answer to the query
   - Supporting details and context
   - Any important caveats or limitations

## Response Guidelines
- Be concise but thorough
- Do not simply concatenate responses
- Do not present conflicting information without resolution
- When models disagree, explain the different viewpoints and provide your synthesized conclusion
- Use markdown formatting for readability`;

interface CouncilFormData {
  name: string;
  description: string;
  member_models: string[];
  member_provider_routing: Record<string, ProviderRoutingConfig>;
  synthesizer_model: string;
  synthesizer_provider_routing: ProviderRoutingConfig | null;
  synthesis_prompt_template: string;
  auto_expand_responses: boolean;
  show_member_responses: boolean;
  tool_ids: string[];
  mcp_server_ids: string[];
}

export function CouncilEditor() {
  const {
    councilEditorOpen,
    setCouncilEditorOpen,
    editingCouncil,
    setEditingCouncil,
    loadCouncilMembers,
  } = useStore();

  const [form, setForm] = useState<CouncilFormData>({
    name: '',
    description: '',
    member_models: [],
    member_provider_routing: {},
    synthesizer_model: '',
    synthesizer_provider_routing: null,
    synthesis_prompt_template: '',
    auto_expand_responses: false,
    show_member_responses: true,
    tool_ids: [],
    mcp_server_ids: [],
  });

  const [errors, setErrors] = useState<Partial<Record<keyof CouncilFormData, string>>>({});
  const [saving, setSaving] = useState(false);
  const [availableTools, setAvailableTools] = useState<{ id: string; name: string; description: string }[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<{ id: string; name: string }[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const { models: availableModels, loading: loadingModels } = useOpenRouterModels({ enabled: councilEditorOpen });

  // Load available data
  useEffect(() => {
    if (!councilEditorOpen) return;

    const loadData = async () => {
      try {
        const [toolsRes, mcpRes] = await Promise.all([
          toolsApi.list(),
          mcpServersApi.list(),
        ]);
        setAvailableTools(toolsRes.map(t => ({ id: t.id, name: t.name, description: t.description })));
        setAvailableMcpServers(mcpRes.map(m => ({ id: m.id, name: m.name })));
      } catch (err) {
        console.error('Failed to load available data:', err);
      }
    };

    loadData();
  }, [councilEditorOpen]);

  // Initialize form when editing
  useEffect(() => {
    if (editingCouncil) {
      setForm({
        name: editingCouncil.name,
        description: editingCouncil.description || '',
        member_models: editingCouncil.member_models,
        member_provider_routing: editingCouncil.member_provider_routing || {},
        synthesizer_model: editingCouncil.synthesizer_model,
        synthesizer_provider_routing: editingCouncil.synthesizer_provider_routing ?? null,
        synthesis_prompt_template: editingCouncil.synthesis_prompt_template || '',
        auto_expand_responses: editingCouncil.auto_expand_responses,
        show_member_responses: editingCouncil.show_member_responses,
        tool_ids: editingCouncil.tool_ids || [],
        mcp_server_ids: editingCouncil.mcp_server_ids || [],
      });
    } else {
      setForm({
        name: '',
        description: '',
        member_models: [],
        member_provider_routing: {},
        synthesizer_model: '',
        synthesizer_provider_routing: null,
        synthesis_prompt_template: '',
        auto_expand_responses: false,
        show_member_responses: true,
        tool_ids: [],
        mcp_server_ids: [],
      });
    }
    setErrors({});
    setShowAdvanced(false);
  }, [editingCouncil, councilEditorOpen]);

  const availableModelMap = useMemo(() => {
    return new Map(availableModels.map((model) => [model.id, model]));
  }, [availableModels]);

  const validate = (): boolean => {
    const newErrors: Partial<Record<keyof CouncilFormData, string>> = {};

    if (!form.name.trim()) {
      newErrors.name = 'Name is required';
    }

    if (form.member_models.length < 2) {
      newErrors.member_models = 'At least 2 member models are required';
    }

    if (!form.synthesizer_model) {
      newErrors.synthesizer_model = 'Synthesizer model is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        member_models: form.member_models,
        member_provider_routing: form.member_provider_routing,
        synthesizer_model: form.synthesizer_model,
        synthesizer_provider_routing: form.synthesizer_provider_routing,
        synthesis_prompt_template: form.synthesis_prompt_template.trim() || undefined,
        auto_expand_responses: form.auto_expand_responses,
        show_member_responses: form.show_member_responses,
        tool_ids: form.tool_ids,
        mcp_server_ids: form.mcp_server_ids,
      };

      if (editingCouncil) {
        await councilsApi.update(editingCouncil.id, payload);
      } else {
        await councilsApi.create(payload);
      }

      await loadCouncilMembers();
      handleClose();
    } catch (err) {
      console.error('Failed to save council:', err);
      alert(err instanceof Error ? err.message : 'Failed to save council');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setCouncilEditorOpen(false);
    setEditingCouncil(null);
  };

  const toggleModel = (modelId: string) => {
    setForm(prev => {
      const exists = prev.member_models.includes(modelId);
      if (exists) {
        const { [modelId]: _removed, ...member_provider_routing } = prev.member_provider_routing;
        return { ...prev, member_models: prev.member_models.filter(m => m !== modelId), member_provider_routing };
      }
      if (prev.member_models.length >= 10) {
        return prev; // Max 10 models
      }
      return { ...prev, member_models: [...prev.member_models, modelId] };
    });
  };

  const handleAddMemberModel = (modelId: string | null) => {
    if (!modelId) return;
    setForm((prev) => {
      if (prev.member_models.includes(modelId) || prev.member_models.length >= 10) return prev;
      return { ...prev, member_models: [...prev.member_models, modelId] };
    });
  };

  const updateMemberProviderRouting = (modelId: string, routing: ProviderRoutingConfig | null) => {
    setForm((prev) => {
      const nextRouting = { ...prev.member_provider_routing };
      if (routing) nextRouting[modelId] = routing;
      else delete nextRouting[modelId];
      return { ...prev, member_provider_routing: nextRouting };
    });
  };

  const toggleTool = (toolId: string) => {
    setForm(prev => {
      const exists = prev.tool_ids.includes(toolId);
      if (exists) {
        return { ...prev, tool_ids: prev.tool_ids.filter(t => t !== toolId) };
      }
      return { ...prev, tool_ids: [...prev.tool_ids, toolId] };
    });
  };

  const toggleMcpServer = (serverId: string) => {
    setForm(prev => {
      const exists = prev.mcp_server_ids.includes(serverId);
      if (exists) {
        return { ...prev, mcp_server_ids: prev.mcp_server_ids.filter(s => s !== serverId) };
      }
      return { ...prev, mcp_server_ids: [...prev.mcp_server_ids, serverId] };
    });
  };

  return (
    <Modal
      isOpen={councilEditorOpen}
      onClose={handleClose}
      title={editingCouncil ? 'Edit Council' : 'Create New Council'}
      maxWidth="720px"
    >
      <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {/* Basic Info */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>
            Basic Information
          </div>

          <Input
            label="Name *"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g., Diverse Analysis Council"
            error={errors.name}
          />

          <TextArea
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="What is this council for? (optional)"
            rows={2}
          />
        </div>

        {/* Member Models */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{
              fontSize: '0.8125rem',
              fontWeight: 600,
              color: 'var(--text-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}>
              <Cpu size={14} />
              Member Models *
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                ({form.member_models.length} selected)
              </span>
            </div>
            {form.member_models.length > 0 && (
              <button
                onClick={() => setForm({ ...form, member_models: [] })}
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Clear all
              </button>
            )}
          </div>

          {errors.member_models && (
            <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>{errors.member_models}</div>
          )}

          {/* Selected Models Chips */}
          {form.member_models.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {form.member_models.map((modelId) => {
                const model = availableModelMap.get(modelId);
                return (
                  <div
                    key={modelId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 8px',
                      background: 'rgba(74, 168, 125, 0.1)',
                      border: '1px solid rgba(74, 168, 125, 0.2)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.75rem',
                      color: '#4aa87d',
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {model?.name?.slice(0, 32) || modelId.slice(0, 32)}
                    </span>
                    <ProviderRoutingSelector
                      modelId={modelId}
                      value={form.member_provider_routing[modelId] ?? null}
                      onChange={(routing) => updateMemberProviderRouting(modelId, routing)}
                      compact
                    />
                    <button
                      onClick={() => toggleModel(modelId)}
                      style={{
                        display: 'flex',
                        padding: '2px',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'inherit',
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <ModelSelectorCore
            value={null}
            onChange={handleAddMemberModel}
            variant="council"
            disabled={loadingModels || form.member_models.length >= 10}
            label={form.member_models.length >= 10 ? 'Maximum 10 models selected' : 'Add member model'}
          />

          <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
            Select 2-10 models. These models will process your queries in parallel.
          </div>
        </div>

        {/* Synthesizer Model */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <GitMerge size={14} />
            Synthesizer Model *
          </div>

          {errors.synthesizer_model && (
            <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>{errors.synthesizer_model}</div>
          )}

          <ModelSelectorCore
            value={form.synthesizer_model || null}
            onChange={(modelId) => setForm({
              ...form,
              synthesizer_model: modelId ?? '',
              synthesizer_provider_routing: null,
            })}
            variant="council"
            disabled={loadingModels}
            label="Synthesizer model"
          />
          <ProviderRoutingSelector
            modelId={form.synthesizer_model || null}
            value={form.synthesizer_provider_routing}
            onChange={(routing) => setForm({ ...form, synthesizer_provider_routing: routing })}
            disabled={!form.synthesizer_model}
          />

          <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
            This model will synthesize all member responses into a unified answer.
          </div>
        </div>

        {/* Advanced Options */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{
              width: '100%',
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'var(--bg-surface)',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-primary)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Sparkles size={16} style={{ color: 'var(--accent)' }} />
              <span style={{ fontWeight: 500 }}>Advanced Options</span>
            </div>
            {showAdvanced ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>

          <AnimatePresence>
            {showAdvanced && (
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: 'auto' }}
                exit={{ height: 0 }}
                style={{ overflow: 'hidden' }}
              >
                <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  {/* Synthesis Prompt Template */}
                  <div>
                    <div style={{
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      color: 'var(--text-secondary)',
                      marginBottom: '8px',
                    }}>
                      Synthesis Prompt Template
                    </div>
                    <TextArea
                      value={form.synthesis_prompt_template}
                      onChange={(e) => setForm({ ...form, synthesis_prompt_template: e.target.value })}
                      placeholder={DEFAULT_SYNTHESIS_TEMPLATE}
                      rows={6}
                    />
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      Use {'{{user_query}}'}, {'{{member_count}}'}, and {'{{member_responses}}'} as placeholders.
                      Leave empty to use default.
                    </div>
                  </div>

                  {/* Tools */}
                  {availableTools.length > 0 && (
                    <div>
                      <div style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: 'var(--text-secondary)',
                        marginBottom: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}>
                        <Wrench size={14} />
                        Available Tools
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                          ({form.tool_ids.length} selected)
                        </span>
                      </div>
                      <div style={{
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                        maxHeight: '150px',
                        overflowY: 'auto',
                        padding: '8px',
                      }}>
                        {availableTools.map((tool) => (
                          <label
                            key={tool.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              padding: '6px',
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={form.tool_ids.includes(tool.id)}
                              onChange={() => toggleTool(tool.id)}
                            />
                            <div>
                              <div style={{ fontSize: '0.8125rem', color: 'var(--text-primary)' }}>
                                {tool.name}
                              </div>
                              <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                {tool.description.slice(0, 60)}...
                              </div>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* MCP Servers */}
                  {availableMcpServers.length > 0 && (
                    <div>
                      <div style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: 'var(--text-secondary)',
                        marginBottom: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}>
                        <Server size={14} />
                        MCP Servers
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                          ({form.mcp_server_ids.length} selected)
                        </span>
                      </div>
                      <div style={{
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                        maxHeight: '120px',
                        overflowY: 'auto',
                        padding: '8px',
                      }}>
                        {availableMcpServers.map((server) => (
                          <label
                            key={server.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              padding: '6px',
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={form.mcp_server_ids.includes(server.id)}
                              onChange={() => toggleMcpServer(server.id)}
                            />
                            <span style={{ fontSize: '0.8125rem', color: 'var(--text-primary)' }}>
                              {server.name}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Display Options */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{
                      fontSize: '0.8125rem',
                      fontWeight: 500,
                      color: 'var(--text-secondary)',
                    }}>
                      Display Options
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={form.show_member_responses}
                        onChange={(e) => setForm({ ...form, show_member_responses: e.target.checked })}
                      />
                      <span style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                        Show member responses after synthesis
                      </span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={form.auto_expand_responses}
                        onChange={(e) => setForm({ ...form, auto_expand_responses: e.target.checked })}
                      />
                      <span style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                        Auto-expand member responses
                      </span>
                    </label>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '8px' }}>
          <Button variant="ghost" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            {editingCouncil ? 'Save Changes' : 'Create Council'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
