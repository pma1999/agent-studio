import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Plug, Pencil, Trash2, Globe, Terminal, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { mcpServersApi } from '../api/client';
import type { McpServer, McpTransport, McpConfigUrl, McpConfigStdio } from '../types';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { ExportImportButtons } from './ExportImportButtons';
import { useIsMobile } from '../utils/breakpoints';

function configSummary(server: McpServer): string {
  const c = server.config;
  if (!c) return '—';
  if ('url' in c && c.url) return c.url;
  if ('command' in c && c.command) {
    const args = (c as McpConfigStdio).args;
    const argStr = Array.isArray(args) && args.length ? ` ${args.join(' ')}` : '';
    return `${c.command}${argStr}`;
  }
  return '—';
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
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);
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
    setForm({ name: '', transport: 'url', url: '', command: '', argsStr: '' });
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
    if (c) {
      if ('url' in c) url = c.url || '';
      if ('command' in c) {
        command = (c as McpConfigStdio).command || '';
        const args = (c as McpConfigStdio).args;
        argsStr = Array.isArray(args) ? args.join(' ') : '';
      }
    }
    setForm({
      name: server.name,
      transport: server.transport,
      url,
      command,
      argsStr,
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
      config = { url };
    } else {
      const command = form.command.trim();
      if (!command) {
        setSubmitError('Command is required for local (stdio) transport');
        return;
      }
      const args = form.argsStr.trim() ? form.argsStr.trim().split(/\s+/).filter(Boolean) : undefined;
      config = { command, args };
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
        setTestResult({ id, ok: true, message: `Connected. ${result.tools.length} tool(s) available.` });
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
              background: server.transport === 'url' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(139, 92, 246, 0.12)',
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              {testResult?.id === server.id && (
                <span style={{ fontSize: '0.75rem', color: testResult.ok ? 'var(--success)' : 'var(--error)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                  {testResult.message}
                </span>
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
              maxWidth: '480px',
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
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Name</label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="My MCP server"
                />
              </div>
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Type</label>
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
                  <option value="url">URL</option>
                  <option value="stdio">Local (stdio)</option>
                </select>
              </div>
              {form.transport === 'url' ? (
                <div style={{ marginBottom: '14px' }}>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>URL</label>
                  <Input
                    value={form.url}
                    onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                    placeholder="https://example.com/mcp"
                  />
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Command</label>
                    <Input
                      value={form.command}
                      onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                      placeholder="npx or node"
                    />
                  </div>
                  <div style={{ marginBottom: '14px' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Arguments (space-separated)</label>
                    <Input
                      value={form.argsStr}
                      onChange={(e) => setForm((f) => ({ ...f, argsStr: e.target.value }))}
                      placeholder="-y @modelcontextprotocol/server-filesystem /path"
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
