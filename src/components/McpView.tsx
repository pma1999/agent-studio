import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Plug, Pencil, Trash2, Globe, Terminal, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { mcpServersApi } from '../api/client';
import type { McpServer, McpTransport, McpConfigUrl, McpConfigStdio } from '../types';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { ExportImportButtons } from './ExportImportButtons';
import { useIsMobile } from '../utils/breakpoints';

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '4px',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontSize: '0.8rem',
  fontFamily: 'var(--font-mono, monospace)',
  resize: 'vertical',
  boxSizing: 'border-box',
};

function configSummary(server: McpServer): string {
  const c = server.config;
  if (!c) return '—';
  if ('url' in c && c.url) {
    const headerCount = (c as McpConfigUrl).headers
      ? Object.keys((c as McpConfigUrl).headers!).length
      : 0;
    return c.url + (headerCount ? ` (+${headerCount} header${headerCount > 1 ? 's' : ''})` : '');
  }
  if ('command' in c && c.command) {
    const cfg = c as McpConfigStdio;
    const argStr = Array.isArray(cfg.args) && cfg.args.length ? ` ${cfg.args.join(' ')}` : '';
    const envCount = cfg.env ? Object.keys(cfg.env).length : 0;
    const cwdStr = cfg.cwd ? ` [cwd: ${cfg.cwd}]` : '';
    return `${c.command}${argStr}${cwdStr}${envCount ? ` (+${envCount} env var${envCount > 1 ? 's' : ''})` : ''}`;
  }
  return '—';
}

interface TestResultState {
  id: string;
  ok: boolean;
  message: string;
  toolNames?: string[];
}

export function McpView() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [form, setForm] = useState({
    name: '',
    transport: 'url' as McpTransport,
    url: '',
    command: '',
    argsStr: '',
    headersStr: '',
    envStr: '',
    cwd: '',
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResultState | null>(null);
  const isMobile = useIsMobile();

  const loadServers = async () => {
    setLoading(true);
    try {
      const list = await mcpServersApi.list();
      setServers(list);
    } catch (err) {
      console.error('Failed to load MCP servers:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadServers();
  }, []);

  const openCreate = () => {
    setEditingServer(null);
    setForm({ name: '', transport: 'url', url: '', command: '', argsStr: '', headersStr: '', envStr: '', cwd: '' });
    setSubmitError(null);
    setTestResult(null);
    setEditorOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setEditingServer(server);
    const c = server.config;
    let url = '';
    let command = '';
    let argsStr = '';
    let headersStr = '';
    let envStr = '';
    let cwd = '';
    if (c) {
      if ('url' in c) {
        url = c.url || '';
        if ((c as McpConfigUrl).headers) {
          headersStr = Object.entries((c as McpConfigUrl).headers!)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');
        }
      }
      if ('command' in c) {
        command = (c as McpConfigStdio).command || '';
        const args = (c as McpConfigStdio).args;
        argsStr = Array.isArray(args) ? args.join(' ') : '';
        if ((c as McpConfigStdio).env) {
          envStr = Object.entries((c as McpConfigStdio).env!)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');
        }
        cwd = (c as McpConfigStdio).cwd || '';
      }
    }
    setForm({
      name: server.name,
      transport: server.transport,
      url,
      command,
      argsStr,
      headersStr,
      envStr,
      cwd,
    });
    setSubmitError(null);
    setTestResult(null);
    setEditorOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const name = form.name.trim();
    if (!name) {
      setSubmitError('Name is required');
      return;
    }
    let config: McpConfigUrl | McpConfigStdio;
    if (form.transport === 'url') {
      const url = form.url.trim();
      if (!url) {
        setSubmitError('URL is required for URL transport');
        return;
      }
      const headers: Record<string, string> = {};
      if (form.headersStr.trim()) {
        for (const line of form.headersStr.trim().split('\n')) {
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0) {
            headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
          }
        }
      }
      config = {
        url,
        ...(Object.keys(headers).length > 0 && { headers }),
      };
    } else {
      const command = form.command.trim();
      if (!command) {
        setSubmitError('Command is required for local (stdio) transport');
        return;
      }
      const args = form.argsStr.trim() ? form.argsStr.trim().split(/\s+/).filter(Boolean) : undefined;
      const env: Record<string, string> = {};
      if (form.envStr.trim()) {
        for (const line of form.envStr.trim().split('\n')) {
          const eqIdx = line.indexOf('=');
          if (eqIdx > 0) {
            env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
          }
        }
      }
      config = {
        command,
        args,
        ...(Object.keys(env).length > 0 && { env }),
        ...(form.cwd.trim() && { cwd: form.cwd.trim() }),
      };
    }

    try {
      if (editingServer) {
        await mcpServersApi.update(editingServer.id, { name, transport: form.transport, config });
      } else {
        await mcpServersApi.create({ name, transport: form.transport, config });
      }
      await loadServers();
      setEditorOpen(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await mcpServersApi.test(id);
      if (result.ok && result.tools) {
        const toolNames = result.tools.map(t => t.name);
        setTestResult({
          id,
          ok: true,
          message: `Connected. ${result.tools.length} tool(s) available.`,
          toolNames,
        });
      } else {
        setTestResult({ id, ok: false, message: result.error || 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ id, ok: false, message: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (server: McpServer) => {
    if (!confirm(`Remove MCP server "${server.name}"? It will be unassigned from all agents.`)) return;
    try {
      await mcpServersApi.delete(server.id);
      await loadServers();
    } catch (err) {
      console.error('Failed to delete MCP server:', err);
    }
  };

  if (loading && servers.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
        Loading MCP servers...
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
            MCP Servers
          </motion.h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: 0 }}>
            Connect Model Context Protocol servers by URL or local command. Assign them to agents in the agent editor.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <ExportImportButtons kind="mcp_servers" label="MCP servers" onAfterImport={loadServers} variant="inline" />
          <Button onClick={openCreate} icon={<Plus size={16} />}>
            Add MCP server
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {servers.map((server, i) => (
          <motion.div
            key={server.id}
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
              background: server.transport === 'url' ? 'var(--state-success-soft)' : 'var(--accent-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              {server.transport === 'url' ? (
                <Globe size={18} style={{ color: 'var(--success)' }} />
              ) : (
                <Terminal size={18} style={{ color: 'var(--accent)' }} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                {server.name}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {configSummary(server)}
              </div>
              <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {server.transport}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {testResult?.id === server.id && (
                <div style={{ fontSize: '0.75rem', color: testResult.ok ? 'var(--success)' : 'var(--error)', maxWidth: '260px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {testResult.ok ? <CheckCircle size={14} style={{ flexShrink: 0 }} /> : <XCircle size={14} style={{ flexShrink: 0 }} />}
                    {testResult.message}
                  </div>
                  {testResult.toolNames && testResult.toolNames.length > 0 && (
                    <div style={{ marginTop: '4px', fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                      {testResult.toolNames.join(', ')}
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => handleTest(server.id)}
                disabled={testingId !== null}
                style={{
                  padding: '8px',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-muted)',
                  cursor: testingId !== null ? 'not-allowed' : 'pointer',
                }}
                title="Test connection"
              >
                {testingId === server.id ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
              </button>
              <button
                type="button"
                onClick={() => openEdit(server)}
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
              <button
                type="button"
                onClick={() => handleDelete(server)}
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
            </div>
          </motion.div>
        ))}
      </div>

      {servers.length === 0 && !loading && (
        <div style={{
          textAlign: 'center',
          padding: '48px 24px',
          color: 'var(--text-muted)',
          fontSize: '0.9rem',
        }}>
          <Plug size={40} style={{ marginBottom: '12px', opacity: 0.5 }} />
          <p>No MCP servers yet. Add a server by URL or local command to expose its tools to agents.</p>
          <Button onClick={openCreate} icon={<Plus size={16} />} style={{ marginTop: '16px' }}>
            Add MCP server
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
              maxWidth: '520px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', marginBottom: '16px', color: 'var(--text-primary)' }}>
              {editingServer ? 'Edit MCP server' : 'Add MCP server'}
            </h2>
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: '14px' }}>
                <label style={labelStyle}>Name</label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="My MCP server"
                />
              </div>
              <div style={{ marginBottom: '14px' }}>
                <label style={labelStyle}>Type</label>
                <select
                  value={form.transport}
                  onChange={(e) => setForm((f) => ({ ...f, transport: e.target.value as McpTransport }))}
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
                  <option value="url">URL (remote)</option>
                  <option value="stdio">Local (stdio)</option>
                </select>
              </div>
              {form.transport === 'url' ? (
                <>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={labelStyle}>URL</label>
                    <Input
                      value={form.url}
                      onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                      placeholder="https://example.com/mcp"
                    />
                  </div>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={labelStyle}>Headers <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional, one per line: Key: Value)</span></label>
                    <textarea
                      value={form.headersStr}
                      onChange={(e) => setForm((f) => ({ ...f, headersStr: e.target.value }))}
                      placeholder={'Authorization: Bearer your-token\nX-Custom-Header: value'}
                      rows={3}
                      style={textareaStyle}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={labelStyle}>Command</label>
                    <Input
                      value={form.command}
                      onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                      placeholder="npx or node"
                    />
                  </div>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={labelStyle}>Arguments <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(space-separated)</span></label>
                    <Input
                      value={form.argsStr}
                      onChange={(e) => setForm((f) => ({ ...f, argsStr: e.target.value }))}
                      placeholder="-y @modelcontextprotocol/server-filesystem /path"
                    />
                  </div>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={labelStyle}>Environment Variables <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional, one per line: KEY=value)</span></label>
                    <textarea
                      value={form.envStr}
                      onChange={(e) => setForm((f) => ({ ...f, envStr: e.target.value }))}
                      placeholder={'GITHUB_TOKEN=ghp_xxxxxxxxxxxx\nAPI_KEY=sk-xxxxxxxxxxxx'}
                      rows={3}
                      style={textareaStyle}
                    />
                  </div>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={labelStyle}>Working Directory <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span></label>
                    <Input
                      value={form.cwd}
                      onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))}
                      placeholder="/home/user/project"
                    />
                  </div>
                </>
              )}
              {submitError && (
                <p style={{ fontSize: '0.8rem', color: 'var(--error)', marginBottom: '12px' }}>{submitError}</p>
              )}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '20px' }}>
                <Button type="button" variant="secondary" onClick={() => setEditorOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit">
                  {editingServer ? 'Save' : 'Add'}
                </Button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}
