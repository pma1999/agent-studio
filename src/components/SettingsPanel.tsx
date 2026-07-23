import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, ExternalLink, Zap, Coins, BarChart3, Loader2, Globe, KeyRound, Database, MessageSquare, Brain, Check, ChevronDown, Sparkles, Lightbulb, SlidersHorizontal, Wrench, Plug, Link, Box } from 'lucide-react';
import { useStore } from '../stores/store';
import { settingsApi, toolsApi, mcpServersApi, deepseekApi } from '../api/client';
import type { ProviderRoutingConfig, ReasoningEffort, Tool, McpServer } from '../types';
import { DEEPSEEK_ACCENT } from '../utils/providers';
import { Modal } from './ui/Modal';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { ModelSelectorCore } from './ModelSelectorCore';
import { ProviderRoutingSelector } from './ProviderRoutingSelector';
import { PremiumToggle } from './ui/PremiumToggle';
import { PremiumEmojiPicker } from './ui/PremiumEmojiPicker';
import { PremiumSelect } from './ui/PremiumSelect';
import { ExportImportButtons } from './ExportImportButtons';
import {
  generateCodeVerifier,
  generateState,
  createSHA256CodeChallenge,
  buildAuthUrl,
  PKCE_STORAGE_KEY,
} from '../utils/openrouterPkce';

function formatCredits(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'Unlimited';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getCreditsColor(remaining: number | null): string {
  if (remaining === null) return 'var(--success)';
  if (remaining > 5) return 'var(--success)';
  if (remaining > 1) return '#f59e0b'; // orange/amber
  return 'var(--error)';
}

function ProviderKeySection({
  providerName,
  providerIcon,
  accentColor,
  settingKey,
  localKey,
  setLocalKey,
  savedKey,
  setSavedKey,
  placeholder,
  helpText,
  helpUrl,
  helpLabel,
  endpoints,
  onTest,
}: {
  providerName: string;
  providerIcon: React.ReactNode;
  accentColor: string;
  settingKey: string;
  localKey: string;
  setLocalKey: (v: string) => void;
  savedKey: string;
  setSavedKey: (v: string) => void;
  placeholder: string;
  helpText: string;
  helpUrl: string;
  helpLabel: string;
  endpoints?: { name: string; url: string; models: string; default?: boolean }[];
  /** Optional live validation; when provided, replaces the generic health-ping test. */
  onTest?: () => Promise<{ ok: boolean; message: string }>;
}) {
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  // A masked value (contains '****') means the input still shows the saved key unchanged;
  // never write it back as the real key.
  const isMasked = (v: string) => v.includes('****');

  const handleSave = async () => {
    if (!localKey || isMasked(localKey)) return;
    setSaving(true);
    try {
      const data = await settingsApi.set(settingKey, localKey);
      setSavedKey((data as { value?: string }).value ?? localKey);
      setSaving(false);
    } catch (err) {
      console.error(`Failed to save ${providerName} API key:`, err);
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!localKey && !savedKey) {
      setTestResult('error');
      setTestMessage('Please enter an API key first');
      return;
    }

    if (localKey && localKey !== savedKey && !isMasked(localKey)) {
      await handleSave();
    }

    setTestResult('testing');
    setTestMessage('Testing connection...');

    try {
      if (onTest) {
        const result = await onTest();
        setTestResult(result.ok ? 'success' : 'error');
        setTestMessage(result.message);
        return;
      }
      const res = await fetch('/api/health');
      if (res.ok) {
        setTestResult('success');
        setTestMessage(`Backend running. ${providerName} API key saved. Start chatting to test the connection!`);
      } else {
        setTestResult('error');
        setTestMessage('Backend health check failed');
      }
    } catch {
      setTestResult('error');
      setTestMessage('Could not reach backend server');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: 'var(--radius-sm)',
          background: `${accentColor}18`,
          border: `1px solid ${accentColor}30`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: accentColor,
        }}>
          {providerIcon}
        </div>
        <h4 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.1rem',
          fontWeight: 500,
          color: 'var(--text-primary)',
        }}>
          {providerName}
        </h4>
      </div>

      <p style={{
        fontSize: '0.8125rem',
        color: 'var(--text-muted)',
        lineHeight: 1.6,
      }}>
        {helpText}{' '}
        <a
          href={helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: accentColor,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '3px',
          }}
        >
          {helpLabel} <ExternalLink size={11} />
        </a>
      </p>

      <Input
        label="API Key"
        type="password"
        value={localKey}
        onChange={(e) => {
          setLocalKey(e.target.value);
          setTestResult('idle');
        }}
        placeholder={placeholder}
        style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
      />

      <div className="settings-provider-actions">
        <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
          Save Key
        </Button>
        <Button variant="secondary" size="sm" onClick={handleTest} loading={testResult === 'testing'}>
          Test Connection
        </Button>
      </div>

      {testResult !== 'idle' && testResult !== 'testing' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 14px',
          background: testResult === 'success'
            ? 'rgba(122, 184, 143, 0.1)'
            : 'rgba(201, 107, 107, 0.1)',
          border: `1px solid ${testResult === 'success'
            ? 'rgba(122, 184, 143, 0.2)'
            : 'rgba(201, 107, 107, 0.2)'}`,
          borderRadius: 'var(--radius-sm)',
          fontSize: '0.8125rem',
          color: testResult === 'success' ? 'var(--success)' : 'var(--error)',
        }}>
          {testResult === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {testMessage}
        </div>
      )}

      {endpoints && endpoints.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {endpoints.map((ep) => (
            <div
              key={ep.name}
              style={{
                padding: '10px 12px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                <span style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                  {ep.name}
                </span>
                {ep.default && (
                  <span style={{
                    fontSize: '0.5625rem',
                    padding: '1px 5px',
                    background: `${accentColor}18`,
                    color: accentColor,
                    borderRadius: '4px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}>
                    Default
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.6875rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginBottom: '2px' }}>
                {ep.url}
              </div>
              <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                Models: {ep.models}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const OPENROUTER_ACCENT = '#8b5cf6';
const AUTO_CONVERSATION_TITLES_SETTING_KEY = 'auto_conversation_titles_enabled';
const E2B_ALLOW_INTERNET_SETTING_KEY = 'e2b_allow_internet';
const E2B_ACCENT = 'var(--state-warning)';

/** DeepSeek direct-provider API key section. Reuses ProviderKeySection with live key validation. */
function DeepSeekSection() {
  const { deepSeekApiKey, setDeepSeekApiKey } = useStore();
  const [localKey, setLocalKey] = useState('');

  const hasSavedKey = !!deepSeekApiKey;

  const handleTest = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const result = await deepseekApi.validate();
      if (result.ok) {
        const balance = result.balance != null
          ? ` Balance: ${result.balance} ${result.currency ?? ''}`.trimEnd()
          : '';
        return { ok: true, message: `DeepSeek key is valid.${balance}` };
      }
      return { ok: false, message: result.error || 'DeepSeek key is invalid' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Could not reach DeepSeek' };
    }
  };

  return (
    <ProviderKeySection
      providerName="DeepSeek (Direct)"
      providerIcon={<Brain size={15} />}
      accentColor={DEEPSEEK_ACCENT}
      settingKey="deepseek_api_key"
      localKey={localKey}
      setLocalKey={setLocalKey}
      savedKey={deepSeekApiKey}
      setSavedKey={setDeepSeekApiKey}
      placeholder={hasSavedKey ? `Saved: ${deepSeekApiKey} — enter a new key to replace` : 'sk-...'}
      helpText="Use DeepSeek models directly with your own DeepSeek API key — billed by DeepSeek, not OpenRouter. Create one at"
      helpUrl="https://platform.deepseek.com/api_keys"
      helpLabel="DeepSeek Platform"
      onTest={handleTest}
    />
  );
}

/** General Chat Settings section - Premium UI */
function GeneralChatSettingsSection() {
  const {
    generalChatSettings,
    loadGeneralChatSettings,
    saveGeneralChatSettings,
    generalChatSettingsLoading,
  } = useStore();

  const [saving, setSaving] = useState(false);

  // Local state for editing
  const [localModel, setLocalModel] = useState('openrouter/auto');
  const [localProviderRouting, setLocalProviderRouting] = useState<ProviderRoutingConfig | null>(null);
  const [localSystemPrompt, setLocalSystemPrompt] = useState('');
  const [localReasoningEnabled, setLocalReasoningEnabled] = useState(false);
  const [localReasoningEffort, setLocalReasoningEffort] = useState<ReasoningEffort>('medium');
  const [localEmoji, setLocalEmoji] = useState('💬');
  const [localToolIds, setLocalToolIds] = useState<string[]>([]);
  const [localMcpServerIds, setLocalMcpServerIds] = useState<string[]>([]);
  const [localToolChoice, setLocalToolChoice] = useState<'auto' | 'none'>('auto');
  const [localParallelToolCalls, setLocalParallelToolCalls] = useState(true);
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [allMcpServers, setAllMcpServers] = useState<McpServer[]>([]);

  // Load settings on mount
  useEffect(() => {
    loadGeneralChatSettings();
  }, [loadGeneralChatSettings]);

  // Load tools and MCP servers when general settings are available
  useEffect(() => {
    if (generalChatSettings) {
      toolsApi.list().then(setAllTools).catch(() => setAllTools([]));
      mcpServersApi.list().then(setAllMcpServers).catch(() => setAllMcpServers([]));
    }
  }, [generalChatSettings]);

  // Update local state when settings load
  useEffect(() => {
    if (generalChatSettings) {
      setLocalModel(generalChatSettings.model);
      setLocalProviderRouting(generalChatSettings.provider_routing ?? null);
      setLocalSystemPrompt(generalChatSettings.system_prompt);
      setLocalReasoningEnabled(generalChatSettings.reasoning_enabled || false);
      setLocalReasoningEffort(generalChatSettings.reasoning_effort || 'medium');
      setLocalEmoji(generalChatSettings.emoji || '💬');
      setLocalToolIds(generalChatSettings.tool_ids ?? []);
      setLocalMcpServerIds(generalChatSettings.mcp_server_ids ?? []);
      setLocalToolChoice(generalChatSettings.tool_choice ?? 'auto');
      setLocalParallelToolCalls((generalChatSettings.parallel_tool_calls ?? 1) !== 0);
    }
  }, [generalChatSettings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveGeneralChatSettings({
        model: localModel,
        provider_routing: localProviderRouting,
        system_prompt: localSystemPrompt,
        reasoning_enabled: localReasoningEnabled,
        reasoning_effort: localReasoningEffort,
        emoji: localEmoji,
        tool_ids: localToolIds,
        mcp_server_ids: localMcpServerIds,
        tool_choice: localToolChoice,
        parallel_tool_calls: localParallelToolCalls ? 1 : 0,
      });
    } finally {
      setSaving(false);
    }
  };

  const hasToolMcpChanges = generalChatSettings && (
    JSON.stringify([...(generalChatSettings.tool_ids ?? [])].sort()) !== JSON.stringify([...localToolIds].sort()) ||
    JSON.stringify([...(generalChatSettings.mcp_server_ids ?? [])].sort()) !== JSON.stringify([...localMcpServerIds].sort()) ||
    (generalChatSettings.tool_choice ?? 'auto') !== localToolChoice ||
    ((generalChatSettings.parallel_tool_calls ?? 1) !== 0) !== localParallelToolCalls
  );

  const hasChanges = generalChatSettings && (
    localModel !== generalChatSettings.model ||
    JSON.stringify(localProviderRouting) !== JSON.stringify(generalChatSettings.provider_routing ?? null) ||
    localSystemPrompt !== generalChatSettings.system_prompt ||
    localReasoningEnabled !== (generalChatSettings.reasoning_enabled || false) ||
    localReasoningEffort !== (generalChatSettings.reasoning_effort || 'medium') ||
    localEmoji !== (generalChatSettings.emoji || '💬') ||
    !!hasToolMcpChanges
  );

  const reasoningEffortOptions = [
    { value: 'minimal', label: 'Minimal', description: 'Fastest responses' },
    { value: 'low', label: 'Low', description: 'Quick reasoning' },
    { value: 'medium', label: 'Medium', description: 'Balanced' },
    { value: 'high', label: 'High', description: 'Deep analysis' },
    { value: 'xhigh', label: 'Maximum', description: 'Best quality' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          style={{
            width: '40px',
            height: '40px',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            boxShadow: '0 4px 14px rgb(var(--copper-rgb) / 0.4)',
          }}
        >
          <MessageSquare size={20} />
        </motion.div>
        <div>
          <h4 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.125rem',
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: 0,
            letterSpacing: '-0.01em',
          }}>
            General Chat
          </h4>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
            Default settings for conversations without agents
          </p>
        </div>
      </div>

      {/* Model Selector - Premium */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <label style={{
          fontSize: '0.6875rem',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}>
          Default Model
        </label>
        <ModelSelectorCore
          variant="settings"
          value={localModel}
          onChange={(id) => {
            setLocalModel(id ?? 'openrouter/auto');
            setLocalProviderRouting(null);
          }}
          label=""
        />
        <ProviderRoutingSelector
          modelId={localModel}
          value={localProviderRouting}
          onChange={setLocalProviderRouting}
          disabled={localModel === 'openrouter/auto'}
        />
      </div>

      {/* Emoji and System Prompt Row */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
        {/* Emoji Picker */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{
            fontSize: '0.6875rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}>
            Icon
          </label>
          <PremiumEmojiPicker
            value={localEmoji}
            onChange={setLocalEmoji}
          />
        </div>

        {/* System Prompt */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{
            fontSize: '0.6875rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}>
            System Instructions
          </label>
          <div style={{ position: 'relative' }}>
            <textarea
              value={localSystemPrompt}
              onChange={(e) => setLocalSystemPrompt(e.target.value)}
              placeholder="You are a helpful AI assistant..."
              rows={3}
              style={{
                width: '100%',
                padding: '12px 14px',
                paddingLeft: '44px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-primary)',
                fontSize: '0.875rem',
                fontFamily: 'var(--font-body)',
                resize: 'vertical',
                lineHeight: 1.6,
                transition: 'all 0.2s ease',
              }}
            />
            <Lightbulb
              size={18}
              style={{
                position: 'absolute',
                left: '14px',
                top: '14px',
                color: 'var(--text-muted)',
                opacity: 0.6,
              }}
            />
          </div>
        </div>
      </div>

      {/* Reasoning Section */}
      <div style={{
        padding: '16px',
        background: 'var(--bg-surface)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
          <PremiumToggle
            checked={localReasoningEnabled}
            onChange={setLocalReasoningEnabled}
            label="Enable Extended Thinking"
            description="Show the model's reasoning process before the final response"
            size="md"
            color="var(--accent)"
          />
        </div>

        <AnimatePresence>
          {localReasoningEnabled && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              style={{ overflow: 'hidden' }}
            >
              <div style={{
                marginTop: '16px',
                paddingTop: '16px',
                borderTop: '1px solid var(--border)',
              }}>
                <label style={{
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  marginBottom: '8px',
                  display: 'block',
                }}>
                  Thinking Depth
                </label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {reasoningEffortOptions.map((option) => (
                    <motion.button
                      key={option.value}
                      onClick={() => setLocalReasoningEffort(option.value as any)}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      style={{
                        padding: '8px 14px',
                        borderRadius: 'var(--radius-md)',
                        border: `1.5px solid ${localReasoningEffort === option.value ? 'var(--accent)' : 'var(--border)'}`,
                        background: localReasoningEffort === option.value
                          ? 'var(--accent-soft)'
                          : 'var(--bg-elevated)',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{
                        fontSize: '0.8125rem',
                        fontWeight: localReasoningEffort === option.value ? 600 : 500,
                        color: localReasoningEffort === option.value ? 'var(--accent)' : 'var(--text-primary)',
                        textTransform: 'capitalize',
                      }}>
                        {option.label}
                      </div>
                      <div style={{
                        fontSize: '0.6875rem',
                        color: 'var(--text-muted)',
                        marginTop: '2px',
                      }}>
                        {option.description}
                      </div>
                    </motion.button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Tools (assign which tools General Chat can use) */}
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
              const checked = localToolIds.includes(tool.id);
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
                      if (checked) setLocalToolIds(localToolIds.filter((id) => id !== tool.id));
                      else setLocalToolIds([...localToolIds, tool.id]);
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

      {/* MCP Servers (assign which MCP servers General Chat uses) */}
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
              const checked = localMcpServerIds.includes(mcp.id);
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
                      if (checked) setLocalMcpServerIds(localMcpServerIds.filter((id) => id !== mcp.id));
                      else setLocalMcpServerIds([...localMcpServerIds, mcp.id]);
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

      {/* Tool choice & parallel tool calls (when General Chat has tools or MCP) */}
      {(localToolIds.length > 0 || localMcpServerIds.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Tool choice</label>
            <select
              value={localToolChoice}
              onChange={(e) => setLocalToolChoice(e.target.value as 'auto' | 'none')}
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
              checked={localParallelToolCalls}
              onChange={(e) => setLocalParallelToolCalls(e.target.checked)}
              style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
            />
            Allow parallel tool calls
          </label>
        </div>
      )}

      {/* Save Button */}
      <motion.div
        initial={false}
        animate={{ opacity: hasChanges ? 1 : 0.7 }}
        style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}
      >
        {hasChanges && (
          <motion.button
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            onClick={() => {
              if (generalChatSettings) {
                setLocalModel(generalChatSettings.model);
                setLocalProviderRouting(generalChatSettings.provider_routing ?? null);
                setLocalSystemPrompt(generalChatSettings.system_prompt);
                setLocalReasoningEnabled(generalChatSettings.reasoning_enabled || false);
                setLocalReasoningEffort(generalChatSettings.reasoning_effort || 'medium');
                setLocalEmoji(generalChatSettings.emoji || '💬');
                setLocalToolIds(generalChatSettings.tool_ids ?? []);
                setLocalMcpServerIds(generalChatSettings.mcp_server_ids ?? []);
                setLocalToolChoice(generalChatSettings.tool_choice ?? 'auto');
                setLocalParallelToolCalls((generalChatSettings.parallel_tool_calls ?? 1) !== 0);
              }
            }}
            style={{
              padding: '10px 18px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Reset
          </motion.button>
        )}
        <motion.button
          onClick={handleSave}
          disabled={!hasChanges || saving || generalChatSettingsLoading}
          whileHover={hasChanges ? { scale: 1.02 } : {}}
          whileTap={hasChanges ? { scale: 0.98 } : {}}
          style={{
            padding: '10px 24px',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: hasChanges
              ? 'var(--accent)'
              : 'var(--bg-elevated)',
            color: hasChanges ? '#fff' : 'var(--text-muted)',
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: hasChanges ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            boxShadow: hasChanges ? '0 4px 14px rgb(var(--copper-rgb) / 0.4)' : 'none',
            transition: 'all 0.2s ease',
          }}
        >
          {saving ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Saving...
            </>
          ) : hasChanges ? (
            <>
              <Sparkles size={16} />
              Save Changes
            </>
          ) : (
            <>
              <CheckCircle size={16} />
              Up to Date
            </>
          )}
        </motion.button>
      </motion.div>
    </div>
  );
}

/** OpenRouter section: OAuth PKCE "Connect" CTA + manual API key. */
function OpenRouterSection() {
  const {
    openRouterApiKey,
    setOpenRouterApiKey,
    openRouterOAuthSuccess,
    setOpenRouterOAuthSuccess,
    openRouterOAuthError,
    setOpenRouterOAuthError,
    autoConversationTitlesEnabled,
    setAutoConversationTitlesEnabled,
  } = useStore();
  const [localORKey, setLocalORKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showManualKey, setShowManualKey] = useState(false);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleSaveState, setTitleSaveState] = useState<'idle' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setLocalORKey(openRouterApiKey);
  }, [openRouterApiKey]);

  const handleStartOAuth = async () => {
    setOauthStarting(true);
    try {
      const codeVerifier = generateCodeVerifier();
      const state = generateState();
      const codeChallenge = await createSHA256CodeChallenge(codeVerifier);
      sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify({ code_verifier: codeVerifier, state }));
      const callbackUrl = window.location.origin + '/';
      window.location.href = buildAuthUrl({ callbackUrl, codeChallenge, state });
    } catch (err) {
      console.error('OAuth start failed:', err);
      setOpenRouterOAuthError('Could not start sign-in. Please try again.');
      setOauthStarting(false);
    }
  };

  const handleSaveKey = async () => {
    setSaving(true);
    try {
      await settingsApi.set('openrouter_api_key', localORKey);
      setOpenRouterApiKey(localORKey);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!localORKey) {
      setTestResult('error');
      setTestMessage('Please enter an API key first');
      return;
    }
    if (localORKey !== openRouterApiKey) await handleSaveKey();
    setTestResult('testing');
    setTestMessage('Testing connection...');
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        setTestResult('success');
        setTestMessage('Backend running. OpenRouter API key saved. Start chatting to test!');
      } else {
        setTestResult('error');
        setTestMessage('Backend health check failed');
      }
    } catch {
      setTestResult('error');
      setTestMessage('Could not reach backend server');
    }
  };

  const isConnected = !!openRouterApiKey;
  const titleStatus = titleSaving
    ? 'Saving...'
    : titleSaveState === 'error'
      ? 'Save failed'
      : !isConnected && autoConversationTitlesEnabled
        ? 'Waiting for key'
        : autoConversationTitlesEnabled
          ? 'On'
          : 'Off';

  const handleTitleToggle = async (enabled: boolean) => {
    if (!isConnected || titleSaving) return;
    const previous = autoConversationTitlesEnabled;
    setAutoConversationTitlesEnabled(enabled);
    setTitleSaving(true);
    setTitleSaveState('idle');
    try {
      await settingsApi.set(AUTO_CONVERSATION_TITLES_SETTING_KEY, String(enabled));
      setTitleSaveState('saved');
      window.setTimeout(() => setTitleSaveState('idle'), 1600);
    } catch (err) {
      console.error('Failed to save automatic conversation titles setting:', err);
      setAutoConversationTitlesEnabled(previous);
      setTitleSaveState('error');
    } finally {
      setTitleSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
          background: `${OPENROUTER_ACCENT}18`, border: `1px solid ${OPENROUTER_ACCENT}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: OPENROUTER_ACCENT,
        }}>
          <Zap size={15} />
        </div>
        <h4 style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', fontWeight: 500, color: 'var(--text-primary)' }}>
          OpenRouter
        </h4>
      </div>

      <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        Access 300+ models from OpenAI, Anthropic, Google, Meta, and more.{' '}
        <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: OPENROUTER_ACCENT, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
          OpenRouter <ExternalLink size={11} />
        </a>
      </p>

      {/* OAuth Connect CTA */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Button
          variant="primary"
          size="md"
          onClick={handleStartOAuth}
          loading={oauthStarting}
          style={{
            background: OPENROUTER_ACCENT,
            color: '#fff',
            fontWeight: 600,
            padding: '12px 20px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
        >
          <KeyRound size={18} />
          Connect with OpenRouter
        </Button>
        {isConnected && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <CheckCircle size={14} /> Connected
            </span>
            <Button variant="secondary" size="sm" onClick={handleStartOAuth} loading={oauthStarting}>
              Reconnect
            </Button>
            <button
              type="button"
              onClick={() => setShowManualKey((v) => !v)}
              style={{
                background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8125rem',
              }}
            >
              {showManualKey ? 'Hide API key' : 'Use a different key'}
            </button>
          </div>
        )}
      </div>

      {/* OAuth success / error from callback */}
      <AnimatePresence mode="wait">
        {openRouterOAuthSuccess && (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '12px 14px',
              background: 'rgba(122, 184, 143, 0.12)',
              border: '1px solid rgba(122, 184, 143, 0.25)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem',
              color: 'var(--success)',
            }}
          >
            <CheckCircle size={16} />
            <span>You’re connected. Your OpenRouter key is saved and ready to use.</span>
            <button
              type="button"
              onClick={() => setOpenRouterOAuthSuccess(false)}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.8 }}
              aria-label="Dismiss"
            >
              ×
            </button>
          </motion.div>
        )}
        {openRouterOAuthError && (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '12px 14px',
              background: 'rgba(201, 107, 107, 0.1)',
              border: '1px solid rgba(201, 107, 107, 0.2)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem',
              color: 'var(--error)',
            }}
          >
            <AlertCircle size={16} />
            <span>{openRouterOAuthError}</span>
            <button
              type="button"
              onClick={() => setOpenRouterOAuthError(null)}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.8 }}
              aria-label="Dismiss"
            >
              ×
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Manual API key (always show if no key, or when "Use a different key" toggled) */}
      {(showManualKey || !isConnected) && (
        <>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
            Or enter your API key manually
          </div>
          <Input
            label="API Key"
            type="password"
            value={localORKey}
            onChange={(e) => { setLocalORKey(e.target.value); setTestResult('idle'); }}
            placeholder="sk-or-xxxxxxxxxxxxxxxx..."
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
          />
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <Button variant="primary" size="sm" onClick={handleSaveKey} loading={saving}>
              Save Key
            </Button>
            <Button variant="secondary" size="sm" onClick={handleTest} loading={testResult === 'testing'}>
              Test Connection
            </Button>
          </div>
          {testResult !== 'idle' && testResult !== 'testing' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '10px 14px',
              background: testResult === 'success' ? 'rgba(122, 184, 143, 0.1)' : 'rgba(201, 107, 107, 0.1)',
              border: `1px solid ${testResult === 'success' ? 'rgba(122, 184, 143, 0.2)' : 'rgba(201, 107, 107, 0.2)'}`,
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.8125rem',
              color: testResult === 'success' ? 'var(--success)' : 'var(--error)',
            }}>
              {testResult === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
              {testMessage}
            </div>
          )}
        </>
      )}

      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        style={{
          padding: '12px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '12px',
          opacity: isConnected ? 1 : 0.72,
        }}
      >
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: 'var(--radius-sm)',
          background: `${OPENROUTER_ACCENT}14`,
          border: `1px solid ${OPENROUTER_ACCENT}28`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: OPENROUTER_ACCENT,
          flexShrink: 0,
        }}>
          <Sparkles size={15} />
        </div>
        <div style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
        }}>
          <PremiumToggle
            checked={autoConversationTitlesEnabled}
            onChange={handleTitleToggle}
            disabled={!isConnected || titleSaving}
            label={
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                minWidth: 0,
                flexWrap: 'wrap',
              }}>
                <span>AI conversation titles</span>
                <span style={{
                  fontSize: '0.6875rem',
                  lineHeight: 1,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  color: titleSaveState === 'error'
                    ? 'var(--error)'
                    : autoConversationTitlesEnabled
                      ? OPENROUTER_ACCENT
                      : 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                }}>
                  {titleSaveState === 'saved' ? 'Saved' : titleStatus}
                </span>
              </span>
            }
            description={isConnected
              ? 'Name new conversations after the first message using openrouter/free.'
              : 'Connect OpenRouter to enable automatic titles.'}
            size="sm"
            color={OPENROUTER_ACCENT}
          />
        </div>
      </motion.div>

      <div style={{ padding: '10px 12px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
          <span style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-primary)' }}>OpenRouter API</span>
          <span style={{ fontSize: '0.5625rem', padding: '1px 5px', background: `${OPENROUTER_ACCENT}18`, color: OPENROUTER_ACCENT, borderRadius: '4px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Default</span>
        </div>
        <div style={{ fontSize: '0.6875rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginBottom: '2px' }}>https://openrouter.ai/api/v1</div>
        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Models: 300+ (OpenAI, Anthropic, Google, Meta...)</div>
      </div>
    </div>
  );
}

// Credits Dashboard component
function CreditsDashboard() {
  const { credits, creditsLoading, loadCredits, openRouterApiKey } = useStore();

  useEffect(() => {
    if (openRouterApiKey) {
      loadCredits();
    }
  }, [openRouterApiKey, loadCredits]);

  if (!openRouterApiKey) return null;

  if (creditsLoading) {
    return (
      <div style={{
        padding: '16px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        color: 'var(--text-muted)',
        fontSize: '0.8125rem',
      }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        Loading credits...
      </div>
    );
  }

  if (!credits) return null;

  const creditsColor = getCreditsColor(credits.limit_remaining);

  return (
    <div style={{
      padding: '16px',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <Coins size={15} style={{ color: 'var(--accent)' }} />
        <span style={{
          fontSize: '0.8125rem',
          fontWeight: 600,
          color: 'var(--text-primary)',
        }}>
          OpenRouter Credits
        </span>
        <button
          onClick={() => loadCredits()}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: '0.6875rem',
            fontFamily: 'var(--font-mono)',
            padding: '2px 6px',
            borderRadius: '4px',
            transition: 'color 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          Refresh
        </button>
      </div>

      {/* Main balance */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
      }}>
        <span style={{
          fontSize: '1.5rem',
          fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          color: creditsColor,
        }}>
          {formatCredits(credits.limit_remaining)}
        </span>
        <span style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
        }}>
          remaining
        </span>
      </div>

      {/* Stats grid */}
      <div className="settings-credits-grid">
        <div style={{
          padding: '8px',
          background: 'var(--bg-base)',
          borderRadius: 'var(--radius-sm)',
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: '0.6875rem',
            color: 'var(--text-muted)',
            marginBottom: '2px',
          }}>
            Today
          </div>
          <div style={{
            fontSize: '0.8125rem',
            fontFamily: 'var(--font-mono)',
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}>
            {formatCredits(credits.usage_daily)}
          </div>
        </div>
        <div style={{
          padding: '8px',
          background: 'var(--bg-base)',
          borderRadius: 'var(--radius-sm)',
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: '0.6875rem',
            color: 'var(--text-muted)',
            marginBottom: '2px',
          }}>
            This Month
          </div>
          <div style={{
            fontSize: '0.8125rem',
            fontFamily: 'var(--font-mono)',
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}>
            {formatCredits(credits.usage_monthly)}
          </div>
        </div>
        <div style={{
          padding: '8px',
          background: 'var(--bg-base)',
          borderRadius: 'var(--radius-sm)',
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: '0.6875rem',
            color: 'var(--text-muted)',
            marginBottom: '2px',
          }}>
            Tier
          </div>
          <div style={{
            fontSize: '0.8125rem',
            fontWeight: 500,
            color: credits.is_free_tier ? 'var(--text-muted)' : 'var(--success)',
          }}>
            {credits.is_free_tier ? 'Free' : 'Paid'}
          </div>
        </div>
      </div>
    </div>
  );
}

// Usage Stats component
function UsageStatsSection() {
  const { usageStats, usageStatsLoading, loadUsageStats } = useStore();

  useEffect(() => {
    loadUsageStats();
  }, [loadUsageStats]);

  if (usageStatsLoading && !usageStats) return null;
  if (!usageStats || usageStats.total_messages === 0) return null;

  return (
    <div style={{
      padding: '16px',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <BarChart3 size={15} style={{ color: 'var(--accent)' }} />
        <span style={{
          fontSize: '0.8125rem',
          fontWeight: 600,
          color: 'var(--text-primary)',
        }}>
          Local Usage Statistics
        </span>
      </div>

      <div className="settings-usage-grid">
        <div style={{
          padding: '10px',
          background: 'var(--bg-base)',
          borderRadius: 'var(--radius-sm)',
        }}>
          <div style={{
            fontSize: '0.6875rem',
            color: 'var(--text-muted)',
            marginBottom: '3px',
          }}>
            Total Cost
          </div>
          <div style={{
            fontSize: '1rem',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}>
            {usageStats.total_cost > 0 ? `$${usageStats.total_cost.toFixed(4)}` : '$0.00'}
          </div>
        </div>
        <div style={{
          padding: '10px',
          background: 'var(--bg-base)',
          borderRadius: 'var(--radius-sm)',
        }}>
          <div style={{
            fontSize: '0.6875rem',
            color: 'var(--text-muted)',
            marginBottom: '3px',
          }}>
            Messages
          </div>
          <div style={{
            fontSize: '1rem',
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}>
            {usageStats.total_messages.toLocaleString()}
          </div>
        </div>
        <div style={{
          padding: '10px',
          background: 'var(--bg-base)',
          borderRadius: 'var(--radius-sm)',
        }}>
          <div style={{
            fontSize: '0.6875rem',
            color: 'var(--text-muted)',
            marginBottom: '3px',
          }}>
            Prompt Tokens
          </div>
          <div style={{
            fontSize: '0.875rem',
            fontFamily: 'var(--font-mono)',
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}>
            {formatTokenCount(usageStats.total_prompt_tokens)}
          </div>
        </div>
        <div style={{
          padding: '10px',
          background: 'var(--bg-base)',
          borderRadius: 'var(--radius-sm)',
        }}>
          <div style={{
            fontSize: '0.6875rem',
            color: 'var(--text-muted)',
            marginBottom: '3px',
          }}>
            Completion Tokens
          </div>
          <div style={{
            fontSize: '0.875rem',
            fontFamily: 'var(--font-mono)',
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}>
            {formatTokenCount(usageStats.total_completion_tokens)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const { settingsOpen, setSettingsOpen, openRouterApiKey, openRouterOAuthSuccess, openRouterOAuthError, setOpenRouterOAuthSuccess, setOpenRouterOAuthError, loadAgents } = useStore();
  const [searchApiKey, setSearchApiKey] = useState('');
  const [searchProvider, setSearchProvider] = useState('exa');
  const [searchSaving, setSearchSaving] = useState(false);
  const [jinaApiKey, setJinaApiKey] = useState('');
  const [jinaSaving, setJinaSaving] = useState(false);
  const [e2bApiKey, setE2bApiKey] = useState('');
  const [e2bSaving, setE2bSaving] = useState(false);
  const [e2bAllowInternet, setE2bAllowInternet] = useState(false);
  const [e2bInternetSaving, setE2bInternetSaving] = useState(false);
  const [e2bInternetSaveState, setE2bInternetSaveState] = useState<'idle' | 'saved' | 'error'>('idle');

  useEffect(() => {
    if (settingsOpen) {
      settingsApi.getAll().then((s) => {
        setSearchApiKey(s.search_api_key || '');
        setSearchProvider(s.search_provider || 'exa');
        setJinaApiKey(s.jina_api_key || '');
        setE2bApiKey(s.e2b_api_key || '');
        setE2bAllowInternet(s.e2b_allow_internet === 'true');
      }).catch(() => {});
    }
  }, [settingsOpen]);

  const saveSearchSettings = async () => {
    setSearchSaving(true);
    try {
      await settingsApi.set('search_api_key', searchApiKey);
      await settingsApi.set('search_provider', searchProvider);
    } finally {
      setSearchSaving(false);
    }
  };

  const saveJinaSettings = async () => {
    setJinaSaving(true);
    try {
      await settingsApi.set('jina_api_key', jinaApiKey);
    } finally {
      setJinaSaving(false);
    }
  };

  const saveE2bApiKey = async () => {
    // An unedited masked value (contains '****') means the field still shows the saved
    // key unchanged — never write it back as the real key, or it would overwrite the
    // stored key with the mask itself. Empty string still passes, so clearing works.
    if (e2bApiKey.includes('****')) return;
    setE2bSaving(true);
    try {
      await settingsApi.set('e2b_api_key', e2bApiKey);
    } finally {
      setE2bSaving(false);
    }
  };

  const handleE2bInternetToggle = async (enabled: boolean) => {
    if (e2bInternetSaving) return;
    const previous = e2bAllowInternet;
    setE2bAllowInternet(enabled);
    setE2bInternetSaving(true);
    setE2bInternetSaveState('idle');
    try {
      await settingsApi.set(E2B_ALLOW_INTERNET_SETTING_KEY, String(enabled));
      setE2bInternetSaveState('saved');
      window.setTimeout(() => setE2bInternetSaveState('idle'), 1600);
    } catch (err) {
      console.error('Failed to save E2B internet access setting:', err);
      setE2bAllowInternet(previous);
      setE2bInternetSaveState('error');
    } finally {
      setE2bInternetSaving(false);
    }
  };

  const handleClose = () => {
    setSettingsOpen(false);
    setOpenRouterOAuthSuccess(false);
    setOpenRouterOAuthError(null);
  };

  return (
    <Modal
      isOpen={settingsOpen}
      onClose={handleClose}
      title="Settings"
      maxWidth="560px"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        <OpenRouterSection />

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--border)' }} />

        {/* DeepSeek (Direct) */}
        <DeepSeekSection />

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--border)' }} />

        {/* General Chat Settings */}
        <GeneralChatSettingsSection />

        {/* OpenRouter Credits Dashboard */}
        <CreditsDashboard />

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--border)' }} />

        {/* Web Search (for Tools) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-soft)', border: '1px solid var(--border-accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)',
            }}>
              <Globe size={15} />
            </div>
            <h4 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              Web Search (for Tools)
            </h4>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0 }}>
            When agents use the web_search tool, results come from this provider. Set an API key to enable it.
          </p>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 140px' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '4px' }}>Provider</label>
              <select
                value={searchProvider}
                onChange={(e) => setSearchProvider(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '0.875rem',
                }}
              >
                <option value="exa">Exa</option>
                <option value="brave">Brave Search</option>
                <option value="tavily">Tavily</option>
              </select>
            </div>
            <div style={{ flex: '2 1 200px' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '4px' }}>API Key</label>
              <Input
                type="password"
                value={searchApiKey}
                onChange={(e) => setSearchApiKey(e.target.value)}
                placeholder="Optional — leave blank to disable web search tool"
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <Button variant="primary" onClick={saveSearchSettings} disabled={searchSaving}>
            {searchSaving ? 'Saving…' : 'Save search settings'}
          </Button>
        </div>

        {/* Web Fetch (Jina Reader) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
              background: 'var(--state-success-soft)', border: '1px solid rgb(var(--green-rgb) / 0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--state-success)',
            }}>
              <Link size={15} />
            </div>
            <h4 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              Web Fetch (Jina Reader)
            </h4>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0 }}>
            When agents use the web_fetch tool, URLs are converted to markdown/text via Jina Reader. Optional: set a Jina API key for higher rate limits.
          </p>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '4px' }}>Jina API Key</label>
            <Input
              type="password"
              value={jinaApiKey}
              onChange={(e) => setJinaApiKey(e.target.value)}
              placeholder="Optional — leave blank for default limits"
              style={{ width: '100%' }}
            />
          </div>
          <Button variant="primary" onClick={saveJinaSettings} disabled={jinaSaving}>
            {jinaSaving ? 'Saving…' : 'Save Jina settings'}
          </Button>
        </div>

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--border)' }} />

        {/* Cloud Sandbox (E2B) — for the run_command tool's "sandbox" backend */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
              background: 'var(--state-warning-soft)', border: '1px solid rgb(var(--amber-rgb) / 0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: E2B_ACCENT,
            }}>
              <Box size={15} />
            </div>
            <h4 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              Cloud Sandbox (E2B)
            </h4>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
            When an agent's run_command tool uses the "sandbox" backend, the command runs in an
            isolated cloud VM from E2B — not on your machine, and not billed to Agent Studio. It's
            billed to your own E2B account, so a key is required before the sandbox backend works
            at all; without one, only a paired local machine can run commands.{' '}
            <a
              href="https://e2b.dev"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: E2B_ACCENT, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
            >
              Get a key at e2b.dev <ExternalLink size={11} />
            </a>
          </p>
          <div style={{ flex: '1 1 200px' }}>
            <Input
              label="E2B API Key"
              type="password"
              value={e2bApiKey}
              onChange={(e) => setE2bApiKey(e.target.value)}
              placeholder="Required for the sandbox backend — leave blank to disable it"
              style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
            />
          </div>
          <Button variant="primary" onClick={saveE2bApiKey} disabled={e2bSaving}>
            {e2bSaving ? 'Saving…' : 'Save E2B key'}
          </Button>

          <div style={{
            padding: '12px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            marginTop: '4px',
          }}>
            <PremiumToggle
              checked={e2bAllowInternet}
              onChange={handleE2bInternetToggle}
              disabled={e2bInternetSaving}
              size="sm"
              color={E2B_ACCENT}
              label={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span>Allow sandbox internet access</span>
                  <span style={{
                    fontSize: '0.6875rem',
                    lineHeight: 1,
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    color: e2bInternetSaveState === 'error'
                      ? 'var(--error)'
                      : e2bAllowInternet
                        ? E2B_ACCENT
                        : 'var(--text-muted)',
                    whiteSpace: 'nowrap',
                  }}>
                    {e2bInternetSaving ? 'Saving...' : e2bInternetSaveState === 'saved' ? 'Saved' : e2bAllowInternet ? 'On' : 'Off'}
                  </span>
                </span>
              }
              description="Off by default. Turning this on lets code running in the sandbox reach the open internet — for example to install packages or call an API. Private network ranges stay blocked automatically, whether this is on or off. The sandbox's cloud metadata endpoint cannot be fully blocked by this setting — Agent Studio makes a best-effort attempt to close it from inside the sandbox, but this is not a guarantee."
            />
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--border)' }} />

        {/* Usage Statistics */}
        <UsageStatsSection />

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--border)' }} />

        {/* Data backup — Export / Import all */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
              background: 'var(--accent-glow)', border: '1px solid var(--border-accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)',
            }}>
              <Database size={15} />
            </div>
            <h4 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              Data backup
            </h4>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0 }}>
            Export or import all your agents, tools, and MCP servers in one JSON file. Use this to back up your workspace or move data between instances.
          </p>
          <ExportImportButtons
            kind="all"
            label="All data"
            onAfterImport={loadAgents}
            variant="stacked"
          />
        </div>

        {/* Footer note */}
        <p style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          lineHeight: 1.6,
          fontStyle: 'italic',
        }}>
          API keys are stored locally and never leave your machine. Each agent uses a model chosen in the agent editor (OpenRouter).
        </p>
      </div>
    </Modal>
  );
}
