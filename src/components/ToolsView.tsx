import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Wrench, Pencil, Trash2, Globe, Zap, Code } from 'lucide-react';
import { toolsApi, type ToolCreatePayload } from '../api/client';
import type { Tool } from '../types';
import { Button } from './ui/Button';
import { ExportImportButtons } from './ExportImportButtons';
import { useIsMobile } from '../utils/breakpoints';

const BUILTIN_OPTIONS = [
  { value: 'web_search', label: 'Web Search', desc: 'Search the web (requires API key in Settings)' },
  { value: 'get_current_time', label: 'Current Time', desc: 'Get current date/time in ISO format' },
  { value: 'web_fetch', label: 'Web Fetch', desc: 'Fetch URL content as markdown/text via Jina Reader (optional API key in Settings)' },
  { value: 'run_command', label: 'Run Command', desc: 'Execute shell commands via a paired local machine or cloud sandbox' },
  { value: 'read_file', label: 'Read File', desc: 'Read a file from a paired local machine, with line numbers' },
  { value: 'write_file', label: 'Write File', desc: 'Create or overwrite a file on a paired local machine' },
  { value: 'edit_file', label: 'Edit File', desc: 'Replace an exact text match in a file on a paired local machine' },
  { value: 'delete_file', label: 'Delete File', desc: 'Delete a file or directory on a paired local machine' },
  { value: 'list_directory', label: 'List Directory', desc: 'List the contents of a directory on a paired local machine' },
];

const PARAM_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'array', label: 'Array (of strings)' },
] as const;

type ParamRow = {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description: string;
  required: boolean;
  default?: string;
  enum?: string; // comma-separated
};

function buildSchemaFromSimpleParams(rows: ParamRow[]): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const row of rows) {
    if (!row.name.trim()) continue;
    const key = row.name.trim().replace(/\s+/g, '_');
    const prop: Record<string, unknown> = {
      type: row.type,
      description: row.description.trim() || undefined,
    };
    if (row.type === 'array') {
      prop.items = { type: 'string' };
    }
    if (row.enum?.trim()) {
      prop.enum = row.enum.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (row.default?.trim() !== undefined && row.default.trim() !== '') {
      if (row.type === 'number' || row.type === 'integer') {
        const n = row.type === 'integer' ? parseInt(row.default.trim(), 10) : parseFloat(row.default.trim());
        if (!Number.isNaN(n)) prop.default = n;
      } else if (row.type === 'boolean') {
        prop.default = row.default.trim().toLowerCase() === 'true';
      } else {
        prop.default = row.default.trim();
      }
    }
    properties[key] = prop;
    if (row.required) required.push(key);
  }
  return { type: 'object', properties, required };
}

function parseSchemaToSimpleParams(schema: Record<string, unknown>): ParamRow[] | null {
  if (schema.type !== 'object') return null;
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props || typeof props !== 'object') return [];
  const required = (schema.required as string[] | undefined) || [];
  const rows: ParamRow[] = [];
  for (const [key, val] of Object.entries(props)) {
    const v = val as Record<string, unknown> | undefined;
    if (!v || typeof v.type !== 'string') continue;
    const type = (['string', 'number', 'integer', 'boolean', 'array'].includes(v.type as string) ? v.type : 'string') as ParamRow['type'];
    let defaultStr = '';
    if (v.default !== undefined) {
      if (typeof v.default === 'string') defaultStr = v.default;
      else defaultStr = String(v.default);
    }
    let enumStr = '';
    if (Array.isArray(v.enum)) enumStr = (v.enum as string[]).join(', ');
    rows.push({
      name: key,
      type,
      description: (v.description as string) || '',
      required: required.includes(key),
      default: defaultStr,
      enum: enumStr,
    });
  }
  return rows;
}

export function ToolsView() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<Tool | null>(null);
  const [form, setForm] = useState({
    name: '',
    description: '',
    type: 'http' as 'builtin' | 'http',
    builtin_name: 'web_search',
    parameters_schema: { type: 'object' as const, properties: {} as Record<string, unknown>, required: [] as string[] },
    config_url: '',
    config_method: 'GET' as 'GET' | 'POST',
  });
  const [schemaJson, setSchemaJson] = useState('{\n  "type": "object",\n  "properties": {},\n  "required": []\n}');
  const [paramMode, setParamMode] = useState<'simple' | 'advanced'>('simple');
  const [simpleParams, setSimpleParams] = useState<ParamRow[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const loadTools = async () => {
    setLoading(true);
    try {
      const list = await toolsApi.list();
      setTools(list);
    } catch (err) {
      console.error('Failed to load tools:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTools();
  }, []);

  const openCreate = () => {
    setEditingTool(null);
    setForm({
      name: '',
      description: '',
      type: 'http',
      builtin_name: 'web_search',
      parameters_schema: { type: 'object', properties: {}, required: [] },
      config_url: '',
      config_method: 'GET',
    });
    setSchemaJson('{\n  "type": "object",\n  "properties": {},\n  "required": []\n}');
    setParamMode('simple');
    setSimpleParams([]);
    setSubmitError(null);
    setEditorOpen(true);
  };

  const openEdit = (tool: Tool) => {
    setEditingTool(tool);
    const schema = tool.parameters_schema as Record<string, unknown> | undefined;
    const normalized: { type: 'object'; properties: Record<string, unknown>; required: string[] } =
      schema && typeof schema === 'object' && (schema as { type?: string }).type === 'object'
        ? { type: 'object', properties: (schema as { properties?: Record<string, unknown> }).properties || {}, required: (schema as { required?: string[] }).required || [] }
        : { type: 'object', properties: {}, required: [] };
    setForm({
      name: tool.name,
      description: tool.description,
      type: tool.type as 'builtin' | 'http',
      builtin_name: tool.name,
      parameters_schema: normalized,
      config_url: (tool.config as { url?: string })?.url || '',
      config_method: ((tool.config as { method?: string })?.method as 'GET' | 'POST') || 'GET',
    });
    setSchemaJson(JSON.stringify(tool.parameters_schema || { type: 'object', properties: {}, required: [] }, null, 2));
    const parsed = parseSchemaToSimpleParams(normalized);
    setParamMode(parsed ? 'simple' : 'advanced');
    setSimpleParams(parsed || []);
    setSubmitError(null);
    setEditorOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    let schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
    if (paramMode === 'simple') {
      schema = buildSchemaFromSimpleParams(simpleParams);
    } else {
      try {
        const parsed = JSON.parse(schemaJson) as Record<string, unknown>;
        if (parsed.type !== 'object') {
          setSubmitError('Schema must have type "object"');
          return;
        }
        schema = {
          type: 'object',
          properties: (parsed.properties as Record<string, unknown>) || {},
          required: (parsed.required as string[]) || [],
        };
      } catch {
        setSubmitError('Invalid JSON in parameters schema');
        return;
      }
    }

    const payload: ToolCreatePayload = {
      name: form.type === 'builtin' ? form.builtin_name : form.name.trim().replace(/\s+/g, '_').toLowerCase(),
      description: form.description.trim(),
      parameters_schema: schema,
      type: form.type,
    };
    if (form.type === 'http') {
      if (!form.config_url.trim()) {
        setSubmitError('URL is required for HTTP tools');
        return;
      }
      payload.config = { url: form.config_url.trim(), method: form.config_method };
    } else {
      payload.config = form.builtin_name === 'web_search' ? { provider: 'exa' } : undefined;
    }

    try {
      if (editingTool) {
        await toolsApi.update(editingTool.id, {
          description: payload.description,
          parameters_schema: payload.parameters_schema,
          config: payload.config ?? undefined,
        });
      } else {
        await toolsApi.create(payload);
      }
      await loadTools();
      setEditorOpen(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to save tool');
    }
  };

  const handleDelete = async (tool: Tool) => {
    if (!confirm(`Remove tool "${tool.name}"? It will be unassigned from all agents.`)) return;
    try {
      await toolsApi.delete(tool.id);
      await loadTools();
    } catch (err) {
      console.error('Failed to delete tool:', err);
    }
  };

  if (loading && tools.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
        Loading tools...
      </div>
    );
  }

  return (
    <div style={{
      padding: 'var(--content-padding-y) var(--content-padding-x)',
      overflowY: 'auto',
      height: '100%',
    }}>
      <div style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'flex-end',
        justifyContent: 'space-between',
        marginBottom: 'var(--section-gap)',
        gap: isMobile ? '16px' : 0,
      }}>
        <div>
          <motion.h1
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--heading-1-size)',
              fontWeight: 500,
              color: 'var(--text-primary)',
              marginBottom: '6px',
            }}
          >
            Tools
          </motion.h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: 0 }}>
            Define tools that agents can use. Assign them in the agent editor.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <ExportImportButtons kind="tools" label="Tools" onAfterImport={loadTools} variant="inline" />
          <Button onClick={openCreate} icon={<Plus size={16} />}>
            New tool
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {tools.map((tool, i) => (
          <motion.div
            key={tool.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '14px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
            }}
          >
            <div style={{
              width: '40px',
              height: '40px',
              borderRadius: 'var(--radius-sm)',
              background: tool.type === 'builtin' ? 'var(--accent-soft)' : 'var(--state-success-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              {tool.type === 'builtin' ? (
                <Globe size={18} style={{ color: 'var(--accent)' }} />
              ) : (
                <Zap size={18} style={{ color: 'var(--success)' }} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>
                {tool.name}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tool.description}
              </div>
              <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {tool.type}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
              {tool.type !== 'builtin' || (tool.name !== 'web_search' && tool.name !== 'get_current_time' && tool.name !== 'web_fetch' && tool.name !== 'run_command' && tool.name !== 'read_file' && tool.name !== 'write_file' && tool.name !== 'edit_file' && tool.name !== 'delete_file' && tool.name !== 'list_directory') ? (
                <>
                  <button
                    type="button"
                    onClick={() => openEdit(tool)}
                    style={{
                      padding: '8px',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                    title="Edit"
                  >
                    <Pencil size={16} />
                  </button>
                  {tool.type === 'http' && (
                    <button
                      type="button"
                      onClick={() => handleDelete(tool)}
                      style={{
                        padding: '8px',
                        background: 'transparent',
                        border: 'none',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                      title="Delete"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => openEdit(tool)}
                  style={{
                    padding: '8px',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                  title="Edit (description and parameters)"
                >
                  <Pencil size={16} />
                </button>
              )}
            </div>
          </motion.div>
        ))}
      </div>

      {tools.length === 0 && !loading && (
        <div style={{
          textAlign: 'center',
          padding: '48px 24px',
          color: 'var(--text-muted)',
          fontSize: '0.9rem',
        }}>
          <Wrench size={40} style={{ marginBottom: '12px', opacity: 0.5 }} />
          <p>No tools yet. Built-in tools (e.g. Web Search) appear after first run.</p>
          <Button onClick={openCreate} icon={<Plus size={16} />} style={{ marginTop: '16px' }}>
            Create a tool
          </Button>
        </div>
      )}

      {editorOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '24px',
          }}
          onClick={() => setEditorOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              padding: '24px',
              maxWidth: '480px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', marginBottom: '16px', color: 'var(--text-primary)' }}>
              {editingTool ? 'Edit tool' : 'New tool'}
            </h2>
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Type</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as 'builtin' | 'http' }))}
                  disabled={!!editingTool}
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
                  <option value="builtin">Built-in</option>
                  <option value="http">HTTP</option>
                </select>
              </div>
              {form.type === 'builtin' ? (
                <div style={{ marginBottom: '14px' }}>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Built-in tool</label>
                  <select
                    value={form.builtin_name}
                    onChange={(e) => setForm((f) => ({ ...f, builtin_name: e.target.value }))}
                    disabled={!!editingTool}
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
                    {BUILTIN_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>{BUILTIN_OPTIONS.find((o) => o.value === form.builtin_name)?.desc}</p>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Name (snake_case)</label>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. fetch_weather"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        color: 'var(--text-primary)',
                        fontSize: '0.875rem',
                      }}
                    />
                  </div>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>URL</label>
                    <input
                      type="url"
                      value={form.config_url}
                      onChange={(e) => setForm((f) => ({ ...f, config_url: e.target.value }))}
                      placeholder="https://api.example.com/..."
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated)',
                        color: 'var(--text-primary)',
                        fontSize: '0.875rem',
                      }}
                    />
                  </div>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Method</label>
                    <select
                      value={form.config_method}
                      onChange={(e) => setForm((f) => ({ ...f, config_method: e.target.value as 'GET' | 'POST' }))}
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
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </select>
                  </div>
                </>
              )}
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  rows={3}
                  placeholder="When the model should use this tool..."
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                    fontSize: '0.875rem',
                    resize: 'vertical',
                  }}
                />
              </div>
              <div style={{ marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Parameters</label>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      type="button"
                      onClick={() => {
                        setParamMode('simple');
                        try {
                          const parsed = JSON.parse(schemaJson);
                          const rows = parseSchemaToSimpleParams(parsed);
                          if (rows) setSimpleParams(rows);
                        } catch {
                          setSimpleParams([]);
                        }
                      }}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-sm)',
                        border: `1px solid ${paramMode === 'simple' ? 'var(--accent)' : 'var(--border)'}`,
                        background: paramMode === 'simple' ? 'var(--accent-soft)' : 'var(--bg-elevated)',
                        color: paramMode === 'simple' ? 'var(--accent)' : 'var(--text-secondary)',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        fontWeight: 500,
                      }}
                    >
                      Simple
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setParamMode('advanced');
                        setSchemaJson(JSON.stringify(buildSchemaFromSimpleParams(simpleParams), null, 2));
                      }}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-sm)',
                        border: `1px solid ${paramMode === 'advanced' ? 'var(--accent)' : 'var(--border)'}`,
                        background: paramMode === 'advanced' ? 'var(--accent-soft)' : 'var(--bg-elevated)',
                        color: paramMode === 'advanced' ? 'var(--accent)' : 'var(--text-secondary)',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                    >
                      <Code size={12} />
                      Advanced (JSON)
                    </button>
                  </div>
                </div>
                {paramMode === 'simple' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {simpleParams.map((row, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: '12px',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--bg-elevated)',
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr auto',
                          gap: '8px',
                          alignItems: 'start',
                        }}
                      >
                        <input
                          type="text"
                          placeholder="name (e.g. query)"
                          value={row.name}
                          onChange={(e) => setSimpleParams((p) => p.map((r, i) => i === idx ? { ...r, name: e.target.value } : r))}
                          style={{
                            padding: '6px 8px',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border)',
                            background: 'var(--bg-base)',
                            color: 'var(--text-primary)',
                            fontSize: '0.8rem',
                            fontFamily: 'var(--font-mono)',
                          }}
                        />
                        <select
                          value={row.type}
                          onChange={(e) => setSimpleParams((p) => p.map((r, i) => i === idx ? { ...r, type: e.target.value as ParamRow['type'] } : r))}
                          style={{
                            padding: '6px 8px',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border)',
                            background: 'var(--bg-base)',
                            color: 'var(--text-primary)',
                            fontSize: '0.8rem',
                          }}
                        >
                          {PARAM_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => setSimpleParams((p) => p.filter((_, i) => i !== idx))}
                          style={{
                            padding: '6px 8px',
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                          }}
                          title="Remove"
                        >
                          <Trash2 size={14} />
                        </button>
                        <input
                          type="text"
                          placeholder="Description (for the model)"
                          value={row.description}
                          onChange={(e) => setSimpleParams((p) => p.map((r, i) => i === idx ? { ...r, description: e.target.value } : r))}
                          style={{
                            gridColumn: '1 / -1',
                            padding: '6px 8px',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border)',
                            background: 'var(--bg-base)',
                            color: 'var(--text-primary)',
                            fontSize: '0.8rem',
                          }}
                        />
                        <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                          <input
                            type="checkbox"
                            checked={row.required}
                            onChange={(e) => setSimpleParams((p) => p.map((r, i) => i === idx ? { ...r, required: e.target.checked } : r))}
                            style={{ width: '14px', height: '14px', accentColor: 'var(--accent)' }}
                          />
                          Required
                        </label>
                        <input
                          type="text"
                          placeholder="Default (optional)"
                          value={row.default ?? ''}
                          onChange={(e) => setSimpleParams((p) => p.map((r, i) => i === idx ? { ...r, default: e.target.value } : r))}
                          style={{
                            padding: '6px 8px',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border)',
                            background: 'var(--bg-base)',
                            color: 'var(--text-primary)',
                            fontSize: '0.8rem',
                          }}
                        />
                        <input
                          type="text"
                          placeholder="Enum: value1, value2 (optional)"
                          value={row.enum ?? ''}
                          onChange={(e) => setSimpleParams((p) => p.map((r, i) => i === idx ? { ...r, enum: e.target.value } : r))}
                          style={{
                            padding: '6px 8px',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border)',
                            background: 'var(--bg-base)',
                            color: 'var(--text-primary)',
                            fontSize: '0.8rem',
                          }}
                        />
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="secondary"
                      icon={<Plus size={14} />}
                      onClick={() => setSimpleParams((p) => [...p, { name: '', type: 'string', description: '', required: false }])}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      Add parameter
                    </Button>
                  </div>
                ) : (
                  <textarea
                    value={schemaJson}
                    onChange={(e) => setSchemaJson(e.target.value)}
                    rows={8}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border)',
                      background: 'var(--bg-elevated)',
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.8rem',
                      resize: 'vertical',
                    }}
                  />
                )}
              </div>
              {submitError && (
                <div style={{ marginBottom: '12px', padding: '8px 12px', background: 'var(--error-muted)', borderRadius: 'var(--radius-sm)', color: 'var(--error)', fontSize: '0.8rem' }}>
                  {submitError}
                </div>
              )}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <Button type="button" variant="secondary" onClick={() => setEditorOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary">{editingTool ? 'Save' : 'Create'}</Button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}
