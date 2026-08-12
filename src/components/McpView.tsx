import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  Globe,
  Laptop,
  Loader2,
  LockKeyhole,
  Pencil,
  Plug,
  Plus,
  ShieldCheck,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { mcpServersApi, type McpServerTestResult } from '../api/client';
import {
  type McpConfigStdio,
  type McpConfigUrl,
  type McpServer,
  type McpTransport,
  type McpUrlAuth,
} from '../types';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { ExportImportButtons } from './ExportImportButtons';
import { useIsMobile } from '../utils/breakpoints';

/** Returned by the API instead of stored credentials; sending it back on an
 * update preserves the server-side value without exposing it to the browser. */
const MCP_SECRET_PLACEHOLDER = '__AGENT_STUDIO_SECRET__';

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '5px',
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
  lineHeight: 1.5,
  resize: 'vertical',
  boxSizing: 'border-box',
};

const checkboxStyle: React.CSSProperties = {
  width: '16px',
  height: '16px',
  margin: '2px 0 0',
  accentColor: 'var(--accent)',
  flexShrink: 0,
};

type AuthType = 'none' | McpUrlAuth['type'];

interface EditorForm {
  name: string;
  transport: McpTransport;
  url: string;
  headersJson: string;
  allowPrivateNetwork: boolean;
  allowInsecureHttp: boolean;
  authType: AuthType;
  bearerToken: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  expectedIssuer: string;
  command: string;
  argsJson: string;
  envJson: string;
  cwd: string;
}

const EMPTY_FORM: EditorForm = {
  name: '',
  transport: 'url',
  url: '',
  headersJson: '',
  allowPrivateNetwork: false,
  allowInsecureHttp: false,
  authType: 'none',
  bearerToken: '',
  clientId: '',
  clientSecret: '',
  scope: '',
  expectedIssuer: '',
  command: '',
  argsJson: '[]',
  envJson: '',
  cwd: '',
};

const PLAYWRIGHT_PRESET = {
  command: 'npx',
  argsJson: JSON.stringify(['-y', '@playwright/mcp@latest', '--browser', 'chrome'], null, 2),
};

function recordToJson(value?: Record<string, string>): string {
  return value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : '';
}

function parseStringRecord(text: string, label: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const entries = Object.entries(parsed);
  if (!entries.every(([, value]) => typeof value === 'string')) {
    throw new Error(`${label} values must all be strings.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseArguments(text: string): string[] {
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Arguments must be a valid JSON array.');
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('Arguments must be a JSON array containing only strings.');
  }
  return parsed;
}

function canonicalJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text.trim();
  }
}

function invocationSignature(form: EditorForm): string {
  return JSON.stringify({
    transport: form.transport,
    command: form.command.trim(),
    args: canonicalJson(form.argsJson),
    env: canonicalJson(form.envJson),
    cwd: form.cwd.trim(),
  });
}

function safeUrlLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}

function configSummary(server: McpServer): string {
  const config = server.config;
  if (!config) return 'Configuration unavailable';
  if ('url' in config) {
    const headerCount = Object.keys(config.headers ?? {}).length;
    const auth = config.auth ? ` · ${config.auth.type === 'bearer' ? 'bearer auth' : 'OAuth client'}` : '';
    return `${safeUrlLabel(config.url)}${headerCount ? ` · ${headerCount} private header${headerCount === 1 ? '' : 's'}` : ''}${auth}`;
  }
  const argumentCount = config.args?.length ?? 0;
  const envCount = Object.keys(config.env ?? {}).length;
  return `${config.command}${argumentCount ? ` · ${argumentCount} arg${argumentCount === 1 ? '' : 's'}` : ''}${envCount ? ` · ${envCount} private env var${envCount === 1 ? '' : 's'}` : ''}`;
}

function capabilityNames(capabilities: McpServerTestResult['capabilities']): string[] {
  if (!capabilities) return [];
  return Object.entries(capabilities)
    .filter(([, value]) => value !== false && value !== undefined && value !== null)
    .map(([name]) => name);
}

function transportLabel(transport: McpTransport): string {
  if (transport === 'relay') return 'Local agent · PC';
  if (transport === 'stdio') return 'Application host · stdio';
  return 'Remote · URL';
}

function DiagnosticPanel({ result }: { result: McpServerTestResult }) {
  if (!result.ok) {
    return (
      <div role="status" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', color: 'var(--error)', fontSize: '0.78rem' }}>
        <XCircle size={15} style={{ marginTop: '1px', flexShrink: 0 }} />
        <span>{result.error || 'Connection failed.'}</span>
      </div>
    );
  }

  const counts = {
    tools: result.counts?.tools ?? result.tools?.length,
    resources: result.counts?.resources,
    templates: result.counts?.resourceTemplates,
    prompts: result.counts?.prompts,
  };
  const capabilities = capabilityNames(result.capabilities);
  const serverName = result.serverInfo?.name;
  const serverVersion = result.serverInfo?.version;

  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--success)', fontSize: '0.78rem', fontWeight: 600 }}>
        <CheckCircle size={15} />
        Connected and negotiated successfully
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px 18px', margin: 0 }}>
        {[
          ['Transport', result.transport],
          ['Protocol era', result.protocolEra],
          ['Protocol version', result.protocolVersion],
          ['Server', serverName],
          ['Server version', serverVersion],
        ].map(([label, value]) => value ? (
          <div key={label}>
            <dt style={{ fontSize: '0.67rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.045em' }}>{label}</dt>
            <dd style={{ margin: '3px 0 0', color: 'var(--text-primary)', fontSize: '0.78rem', overflowWrap: 'anywhere' }}>{value}</dd>
          </div>
        ) : null)}
      </dl>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
        {Object.entries(counts).map(([label, count]) => typeof count === 'number' ? (
          <span key={label} style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{count}</strong> {label}
          </span>
        ) : null)}
        {capabilities.length > 0 && (
          <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
            Capabilities: {capabilities.join(', ')}
          </span>
        )}
      </div>
      {result.tools && result.tools.length > 0 && (
        <details style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Inspect advertised tools</summary>
          <div style={{ marginTop: '6px', lineHeight: 1.55 }}>{result.tools.map((tool) => tool.name).join(', ')}</div>
        </details>
      )}
    </div>
  );
}

function RiskToggle({
  id,
  checked,
  onChange,
  title,
  description,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label htmlFor={id} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} style={checkboxStyle} />
      <span>
        <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{ display: 'block', marginTop: '2px', fontSize: '0.72rem', lineHeight: 1.45, color: 'var(--text-muted)' }}>{description}</span>
      </span>
    </label>
  );
}

export function McpView() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [form, setForm] = useState<EditorForm>(EMPTY_FORM);
  const [originalLocalSignature, setOriginalLocalSignature] = useState<string | null>(null);
  const [existingLocalApproval, setExistingLocalApproval] = useState(false);
  const [localApprovalConfirmed, setLocalApprovalConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, McpServerTestResult>>({});
  const isMobile = useIsMobile();

  const isLocal = form.transport === 'stdio' || form.transport === 'relay';
  const currentLocalSignature = useMemo(() => invocationSignature(form), [form]);
  const invocationChanged = originalLocalSignature !== null && currentLocalSignature !== originalLocalSignature;
  const localApprovalRequired = isLocal && (!existingLocalApproval || invocationChanged);

  const loadServers = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setServers(await mcpServersApi.list());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load MCP servers.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadServers();
  }, []);

  useEffect(() => {
    if (!editorOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) setEditorOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editorOpen, submitting]);

  const openCreate = () => {
    setEditingServer(null);
    setForm({ ...EMPTY_FORM });
    setOriginalLocalSignature(null);
    setExistingLocalApproval(false);
    setLocalApprovalConfirmed(false);
    setSubmitError(null);
    setEditorOpen(true);
  };

  const openEdit = (server: McpServer) => {
    const config = server.config;
    const next: EditorForm = {
      ...EMPTY_FORM,
      name: server.name,
      transport: server.transport,
    };
    let approved = false;
    if (config && 'url' in config) {
      next.url = config.url;
      next.headersJson = recordToJson(config.headers);
      next.allowPrivateNetwork = config.allowPrivateNetwork === true;
      next.allowInsecureHttp = config.allowInsecureHttp === true;
      if (config.auth?.type === 'bearer') {
        next.authType = 'bearer';
        next.bearerToken = config.auth.token;
      } else if (config.auth?.type === 'client_credentials') {
        next.authType = 'client_credentials';
        next.clientId = config.auth.clientId;
        next.clientSecret = config.auth.clientSecret;
        next.scope = config.auth.scope ?? '';
        next.expectedIssuer = config.auth.expectedIssuer;
      }
    } else if (config && 'command' in config) {
      next.command = config.command;
      next.argsJson = JSON.stringify(config.args ?? [], null, 2);
      next.envJson = recordToJson(config.env);
      next.cwd = config.cwd ?? '';
      approved = Boolean(config.executionApproval);
    }
    setEditingServer(server);
    setForm(next);
    setOriginalLocalSignature(server.transport === 'url' ? null : invocationSignature(next));
    setExistingLocalApproval(approved);
    setLocalApprovalConfirmed(false);
    setSubmitError(null);
    setEditorOpen(true);
  };

  const updateInvocation = (patch: Partial<EditorForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setLocalApprovalConfirmed(false);
  };

  const selectTransport = (transport: McpTransport) => {
    setForm((current) => ({ ...current, transport }));
    setLocalApprovalConfirmed(false);
  };

  const selectAuthType = (authType: AuthType) => {
    setForm((current) => ({
      ...current,
      authType,
      ...(authType !== current.authType ? { bearerToken: '', clientSecret: '' } : {}),
    }));
  };

  const applyPlaywrightPreset = () => updateInvocation(PLAYWRIGHT_PRESET);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitError(null);
    const name = form.name.trim();
    if (!name) {
      setSubmitError('Name is required.');
      return;
    }

    let config: McpConfigUrl | McpConfigStdio;
    try {
      if (form.transport === 'url') {
        if (!form.url.trim()) throw new Error('URL is required.');
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(form.url.trim());
        } catch {
          throw new Error('Enter a valid absolute URL.');
        }
        if (parsedUrl.protocol === 'http:' && !form.allowInsecureHttp) {
          throw new Error('Clear-text HTTP requires explicit approval below.');
        }
        const headers = parseStringRecord(form.headersJson, 'Headers');
        let auth: McpUrlAuth | undefined;
        if (form.authType === 'bearer') {
          if (!form.bearerToken) throw new Error('Bearer token is required.');
          auth = { type: 'bearer', token: form.bearerToken };
        } else if (form.authType === 'client_credentials') {
          if (!form.clientId.trim() || !form.clientSecret || !form.expectedIssuer.trim()) {
            throw new Error('Client ID, client secret, and authorization issuer are required.');
          }
          auth = {
            type: 'client_credentials',
            clientId: form.clientId.trim(),
            clientSecret: form.clientSecret,
            expectedIssuer: form.expectedIssuer.trim(),
            ...(form.scope.trim() ? { scope: form.scope.trim() } : {}),
          };
        }
        config = {
          url: parsedUrl.href,
          ...(headers && { headers }),
          ...(form.allowPrivateNetwork && { allowPrivateNetwork: true }),
          ...(form.allowInsecureHttp && { allowInsecureHttp: true }),
          ...(auth && { auth }),
        };
      } else {
        const command = form.command.trim();
        if (!command) throw new Error('Command is required.');
        const args = parseArguments(form.argsJson);
        const env = parseStringRecord(form.envJson, 'Environment variables');
        if (localApprovalRequired && !localApprovalConfirmed) {
          throw new Error('Confirm the exact local invocation before saving.');
        }
        config = {
          command,
          ...(args.length > 0 && { args }),
          ...(env && { env }),
          ...(form.cwd.trim() && { cwd: form.cwd.trim() }),
        };
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Invalid configuration.');
      return;
    }

    setSubmitting(true);
    try {
      const approval = isLocal && localApprovalRequired && localApprovalConfirmed
        ? { local_execution_approved: true as const }
        : {};
      if (editingServer) {
        await mcpServersApi.update(editingServer.id, {
          name,
          transport: form.transport,
          config,
          ...approval,
        });
      } else {
        await mcpServersApi.create({
          name,
          transport: form.transport,
          config,
          ...approval,
        });
      }
      await loadServers();
      setEditorOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not save this MCP server.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResults((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      const result = await mcpServersApi.test(id);
      setTestResults((current) => ({ ...current, [id]: result }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [id]: { ok: false, error: error instanceof Error ? error.message : 'Connection test failed.' },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (server: McpServer) => {
    if (!window.confirm(`Remove MCP server “${server.name}”? It will be unassigned from every agent.`)) return;
    try {
      await mcpServersApi.delete(server.id);
      await loadServers();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not remove the MCP server.');
    }
  };

  if (loading && servers.length === 0) {
    return (
      <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '9px', color: 'var(--text-muted)' }}>
        <Loader2 size={17} className="animate-spin" /> Loading MCP servers…
      </div>
    );
  }

  return (
    <div style={{ padding: 'var(--content-padding-y) var(--content-padding-x)', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'flex-end', justifyContent: 'space-between', marginBottom: 'var(--section-gap)', gap: '16px' }}>
        <div style={{ maxWidth: '720px' }}>
          <motion.h1
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--heading-1-size)', fontWeight: 500, color: 'var(--text-primary)', margin: '0 0 6px' }}
          >
            MCP Servers
          </motion.h1>
          <p style={{ fontSize: '0.875rem', lineHeight: 1.5, color: 'var(--text-muted)', margin: 0 }}>
            Connect trusted capabilities, inspect protocol negotiation, then assign them to agents.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <ExportImportButtons kind="mcp_servers" label="MCP servers" onAfterImport={loadServers} variant="inline" />
          <Button variant="primary" onClick={openCreate} icon={<Plus size={16} />}>Add server</Button>
        </div>
      </div>

      {loadError && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--error)', fontSize: '0.8rem', marginBottom: '14px' }}>
          <XCircle size={15} /> {loadError}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border)' }}>
        {servers.map((server, index) => {
          const testResult = testResults[server.id];
          const localApproved = server.config && 'command' in server.config && Boolean(server.config.executionApproval);
          return (
            <motion.section
              key={server.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.025 }}
              style={{ borderBottom: '1px solid var(--border)', padding: '16px 2px' }}
              aria-labelledby={`mcp-server-${server.id}`}
            >
              <div style={{ display: 'flex', alignItems: isMobile ? 'flex-start' : 'center', flexDirection: isMobile ? 'column' : 'row', gap: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '13px', flex: 1, minWidth: 0, width: isMobile ? '100%' : undefined }}>
                  <div style={{ width: '36px', height: '36px', display: 'grid', placeItems: 'center', color: server.transport === 'url' ? 'var(--success)' : 'var(--accent)', flexShrink: 0 }}>
                    {server.transport === 'url' ? <Globe size={19} /> : server.transport === 'relay' ? <Laptop size={19} /> : <Terminal size={19} />}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span id={`mcp-server-${server.id}`} style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{server.name}</span>
                      {server.requires_agent && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: server.agent_connected ? 'var(--success)' : '#d97706', fontSize: '0.69rem', fontWeight: 600 }}>
                          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor' }} />
                          {server.agent_connected ? 'PC connected' : 'PC offline'}
                        </span>
                      )}
                      {server.transport !== 'url' && (
                        <span style={{ color: localApproved ? 'var(--success)' : '#d97706', fontSize: '0.69rem', fontWeight: 600 }}>
                          {localApproved ? 'Invocation approved' : 'Approval required'}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isMobile ? 'normal' : 'nowrap' }}>{configSummary(server)}</div>
                    <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.045em' }}>{transportLabel(server.transport)}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: isMobile ? '49px' : 0 }}>
                  <button type="button" onClick={() => void handleTest(server.id)} disabled={testingId !== null} aria-label={`Test ${server.name}`} title="Test connection" style={{ padding: '8px', background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', cursor: testingId !== null ? 'not-allowed' : 'pointer' }}>
                    {testingId === server.id ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
                  </button>
                  <button type="button" onClick={() => openEdit(server)} aria-label={`Edit ${server.name}`} title="Edit" style={{ padding: '8px', background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', cursor: 'pointer' }}><Pencil size={16} /></button>
                  <button type="button" onClick={() => void handleDelete(server)} aria-label={`Delete ${server.name}`} title="Delete" style={{ padding: '8px', background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', cursor: 'pointer' }}><Trash2 size={16} /></button>
                </div>
              </div>
              {testResult && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} style={{ margin: '14px 0 0 49px', paddingTop: '13px', borderTop: '1px solid var(--border)' }}>
                  <DiagnosticPanel result={testResult} />
                </motion.div>
              )}
            </motion.section>
          );
        })}
      </div>

      {servers.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: '54px 24px', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
          <Plug size={34} style={{ marginBottom: '12px', opacity: 0.45 }} />
          <p style={{ margin: '0 auto', maxWidth: '430px', lineHeight: 1.5 }}>No MCP servers configured. Add a trusted remote endpoint or an explicitly approved local command.</p>
          <Button variant="primary" onClick={openCreate} icon={<Plus size={16} />} style={{ marginTop: '18px' }}>Add server</Button>
        </div>
      )}

      {editorOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: isMobile ? '12px' : '24px' }}
          onClick={() => !submitting && setEditorOpen(false)}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-editor-title"
            initial={{ opacity: 0, scale: 0.985, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            onClick={(event) => event.stopPropagation()}
            style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: isMobile ? '20px' : '26px', maxWidth: '680px', width: '100%', maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 24px 70px rgba(0,0,0,0.28)' }}
          >
            <div style={{ marginBottom: '20px' }}>
              <h2 id="mcp-editor-title" style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 500, margin: '0 0 5px', color: 'var(--text-primary)' }}>{editingServer ? 'Edit MCP server' : 'Add MCP server'}</h2>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.78rem', lineHeight: 1.45 }}>Credentials are stored server-side and return here only as protected placeholders.</p>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: '14px', marginBottom: '20px' }}>
                <div>
                  <label htmlFor="mcp-name" style={labelStyle}>Name</label>
                  <Input id="mcp-name" autoFocus value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Company knowledge" />
                </div>
                <div>
                  <label htmlFor="mcp-transport" style={labelStyle}>Transport</label>
                  <select id="mcp-transport" value={form.transport} onChange={(event) => selectTransport(event.target.value as McpTransport)} style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '0.875rem' }}>
                    <option value="url">Remote URL</option>
                    <option value="stdio">Application host (stdio)</option>
                    <option value="relay">This PC (local agent)</option>
                  </select>
                </div>
              </div>

              {form.transport === 'url' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                  <section aria-labelledby="mcp-endpoint-heading">
                    <h3 id="mcp-endpoint-heading" style={{ fontSize: '0.8rem', color: 'var(--text-primary)', margin: '0 0 10px', fontWeight: 600 }}>Endpoint</h3>
                    <label htmlFor="mcp-url" style={labelStyle}>MCP URL</label>
                    <Input id="mcp-url" type="url" value={form.url} onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/mcp" />
                  </section>

                  <section aria-labelledby="mcp-auth-heading" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}><LockKeyhole size={15} style={{ color: 'var(--text-muted)' }} /><h3 id="mcp-auth-heading" style={{ fontSize: '0.8rem', color: 'var(--text-primary)', margin: 0, fontWeight: 600 }}>Authentication</h3></div>
                    <label htmlFor="mcp-auth-type" style={labelStyle}>Method</label>
                    <select id="mcp-auth-type" value={form.authType} onChange={(event) => selectAuthType(event.target.value as AuthType)} style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '0.875rem', marginBottom: form.authType === 'none' ? 0 : '12px' }}>
                      <option value="none">No managed authentication</option>
                      <option value="bearer">Bearer token</option>
                      <option value="client_credentials">OAuth client credentials</option>
                    </select>
                    {form.authType === 'bearer' && (
                      <div>
                        <label htmlFor="mcp-bearer-token" style={labelStyle}>Bearer token</label>
                        <Input id="mcp-bearer-token" type="password" autoComplete="new-password" value={form.bearerToken} onChange={(event) => setForm((current) => ({ ...current, bearerToken: event.target.value }))} placeholder="Enter token" />
                      </div>
                    )}
                    {form.authType === 'client_credentials' && (
                      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '12px' }}>
                        <div><label htmlFor="mcp-client-id" style={labelStyle}>Client ID</label><Input id="mcp-client-id" value={form.clientId} onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))} /></div>
                        <div><label htmlFor="mcp-client-secret" style={labelStyle}>Client secret</label><Input id="mcp-client-secret" type="password" autoComplete="new-password" value={form.clientSecret} onChange={(event) => setForm((current) => ({ ...current, clientSecret: event.target.value }))} /></div>
                        <div><label htmlFor="mcp-auth-issuer" style={labelStyle}>Authorization issuer</label><Input id="mcp-auth-issuer" type="url" value={form.expectedIssuer} onChange={(event) => setForm((current) => ({ ...current, expectedIssuer: event.target.value }))} placeholder="https://auth.example.com/" /></div>
                        <div><label htmlFor="mcp-auth-scope" style={labelStyle}>Scope <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span></label><Input id="mcp-auth-scope" value={form.scope} onChange={(event) => setForm((current) => ({ ...current, scope: event.target.value }))} /></div>
                      </div>
                    )}
                  </section>

                  <section aria-labelledby="mcp-headers-heading" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
                    <h3 id="mcp-headers-heading" style={{ fontSize: '0.8rem', color: 'var(--text-primary)', margin: '0 0 4px', fontWeight: 600 }}>Additional headers</h3>
                    <p style={{ fontSize: '0.71rem', lineHeight: 1.45, color: 'var(--text-muted)', margin: '0 0 8px' }}>JSON object. Saved values use a protected placeholder; leave it unchanged to keep the secret.</p>
                    <textarea aria-label="Additional headers as JSON" value={form.headersJson} onChange={(event) => setForm((current) => ({ ...current, headersJson: event.target.value }))} placeholder={'{\n  "X-Workspace": "team-a"\n}'} rows={4} spellCheck={false} style={textareaStyle} />
                  </section>

                  <section aria-labelledby="mcp-network-heading" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}><ShieldCheck size={15} style={{ color: 'var(--text-muted)' }} /><h3 id="mcp-network-heading" style={{ fontSize: '0.8rem', color: 'var(--text-primary)', margin: 0, fontWeight: 600 }}>Network trust</h3></div>
                    <RiskToggle id="mcp-private-network" checked={form.allowPrivateNetwork} onChange={(allowPrivateNetwork) => setForm((current) => ({ ...current, allowPrivateNetwork }))} title="Allow private-network destinations" description="Permits loopback, private, and link-local addresses. Enable only for a server you control." />
                    <RiskToggle id="mcp-insecure-http" checked={form.allowInsecureHttp} onChange={(allowInsecureHttp) => setForm((current) => ({ ...current, allowInsecureHttp }))} title="Allow clear-text HTTP" description="Traffic and credentials may be observed in transit. Use only in a trusted development network." />
                  </section>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '17px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                      {form.transport === 'relay' ? 'This process runs on your PC through the local agent.' : 'This process runs on the application host.'} Saving requires consent tied to the exact invocation.
                    </p>
                    {form.transport === 'relay' && <Button type="button" variant="secondary" size="sm" onClick={applyPlaywrightPreset}>Playwright preset</Button>}
                  </div>

                  <div>
                    <label htmlFor="mcp-command" style={labelStyle}>Executable command</label>
                    <Input id="mcp-command" value={form.command} onChange={(event) => updateInvocation({ command: event.target.value })} placeholder="npx" />
                  </div>
                  <div>
                    <label htmlFor="mcp-args" style={labelStyle}>Arguments <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(JSON array; one exact argument per item)</span></label>
                    <textarea id="mcp-args" value={form.argsJson} onChange={(event) => updateInvocation({ argsJson: event.target.value })} placeholder={'[\n  "-y",\n  "@modelcontextprotocol/server-filesystem",\n  "/path with spaces"\n]'} rows={5} spellCheck={false} style={textareaStyle} />
                  </div>
                  <div>
                    <label htmlFor="mcp-env" style={labelStyle}>Environment variables <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional JSON object)</span></label>
                    <textarea id="mcp-env" value={form.envJson} onChange={(event) => updateInvocation({ envJson: event.target.value })} placeholder={'{\n  "API_KEY": "secret"\n}'} rows={4} spellCheck={false} style={textareaStyle} />
                    <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.45, margin: '5px 0 0' }}>Saved values appear as <code>{MCP_SECRET_PLACEHOLDER}</code>. Keep that value to preserve the existing secret.</p>
                  </div>
                  <div>
                    <label htmlFor="mcp-cwd" style={labelStyle}>Working directory <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span></label>
                    <Input id="mcp-cwd" value={form.cwd} onChange={(event) => updateInvocation({ cwd: event.target.value })} placeholder="/home/user/project" />
                  </div>

                  <section aria-labelledby="mcp-approval-heading" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
                      {localApprovalRequired ? <AlertTriangle size={16} style={{ color: '#d97706' }} /> : <ShieldCheck size={16} style={{ color: 'var(--success)' }} />}
                      <h3 id="mcp-approval-heading" style={{ fontSize: '0.82rem', color: 'var(--text-primary)', margin: 0, fontWeight: 600 }}>Local execution consent</h3>
                    </div>
                    <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', padding: '11px 12px', marginBottom: '11px', fontFamily: 'var(--font-mono, monospace)', fontSize: '0.74rem', lineHeight: 1.5, color: 'var(--text-secondary)', overflowX: 'auto' }}>
                      <div><span style={{ color: 'var(--text-muted)' }}>command </span>{form.command.trim() || '—'}</div>
                      <div><span style={{ color: 'var(--text-muted)' }}>argv </span>{form.argsJson.trim() || '[]'}</div>
                      {form.cwd.trim() && <div><span style={{ color: 'var(--text-muted)' }}>cwd </span>{form.cwd.trim()}</div>}
                    </div>
                    {localApprovalRequired ? (
                      <label htmlFor="mcp-local-approval" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
                        <input id="mcp-local-approval" type="checkbox" checked={localApprovalConfirmed} onChange={(event) => setLocalApprovalConfirmed(event.target.checked)} style={checkboxStyle} />
                        <span style={{ fontSize: '0.77rem', lineHeight: 1.5, color: 'var(--text-secondary)' }}>I approve running this exact command and argument array. Changing the transport, command, arguments, environment, or working directory revokes this approval.</span>
                      </label>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--success)', fontSize: '0.76rem' }}><CheckCircle size={14} /> This exact invocation already has stored approval.</div>
                    )}
                  </section>
                </div>
              )}

              {submitError && <p role="alert" style={{ fontSize: '0.8rem', color: 'var(--error)', margin: '16px 0 0' }}>{submitError}</p>}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '24px' }}>
                <Button type="button" variant="secondary" disabled={submitting} onClick={() => setEditorOpen(false)}>Cancel</Button>
                <Button type="submit" variant="primary" loading={submitting} icon={!submitting ? <ChevronRight size={15} /> : undefined}>{editingServer ? 'Save server' : 'Add server'}</Button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}
