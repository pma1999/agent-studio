import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, ExternalLink, Zap, Coins, BarChart3, Loader2, Globe, KeyRound } from 'lucide-react';
import { useStore } from '../stores/store';
import { settingsApi } from '../api/client';
import { Modal } from './ui/Modal';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
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
}) {
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const handleSave = async () => {
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
    if (!localKey) {
      setTestResult('error');
      setTestMessage('Please enter an API key first');
      return;
    }

    if (localKey !== savedKey) {
      await handleSave();
    }

    setTestResult('testing');
    setTestMessage('Testing connection...');

    try {
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

/** OpenRouter section: OAuth PKCE "Connect" CTA + manual API key. */
function OpenRouterSection() {
  const {
    openRouterApiKey,
    setOpenRouterApiKey,
    openRouterOAuthSuccess,
    setOpenRouterOAuthSuccess,
    openRouterOAuthError,
    setOpenRouterOAuthError,
  } = useStore();
  const [localORKey, setLocalORKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showManualKey, setShowManualKey] = useState(false);
  const [oauthStarting, setOauthStarting] = useState(false);

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
        <Coins size={15} style={{ color: '#8b5cf6' }} />
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
  const { settingsOpen, setSettingsOpen, openRouterApiKey, openRouterOAuthSuccess, openRouterOAuthError, setOpenRouterOAuthSuccess, setOpenRouterOAuthError } = useStore();
  const [searchApiKey, setSearchApiKey] = useState('');
  const [searchProvider, setSearchProvider] = useState('exa');
  const [searchSaving, setSearchSaving] = useState(false);

  useEffect(() => {
    if (settingsOpen) {
      settingsApi.getAll().then((s) => {
        setSearchApiKey(s.search_api_key || '');
        setSearchProvider(s.search_provider || 'exa');
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

        {/* OpenRouter Credits Dashboard */}
        <CreditsDashboard />

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--border)' }} />

        {/* Web Search (for Tools) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
              background: 'rgba(139, 92, 246, 0.15)', border: '1px solid rgba(139, 92, 246, 0.3)',
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

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--border)' }} />

        {/* Usage Statistics */}
        <UsageStatsSection />

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
