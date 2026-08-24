import { useState, useEffect, useCallback } from 'react';
import { Check, X, Minus, Loader2, AlertCircle, Zap, RefreshCw } from 'lucide-react';
import { Button } from './ui/Button';
import { lmstudioApi, type LmStudioComplianceResult } from '../api/client';
import { LMSTUDIO_STATUS_CHANGED_EVENT } from '../utils/providers';

/** Column label for a knob's application channel ('rest' | 'gui' | 'sdk-script'). */
const HOW_LABEL: Record<LmStudioComplianceResult['knobs'][number]['how'], string> = {
  rest: 'REST',
  gui: 'GUI',
  'sdk-script': 'SDK script',
};

/**
 * Live compliance view for ONE currently loaded LM Studio instance (upstream
 * model key, i.e. the namespaced id with the `lmstudio:` prefix stripped).
 *
 * Renders each pinned knob row with met ✓ / unmet ✗ / unknown – state, expected
 * vs actual values, the application channel, and guidance for non-REST knobs,
 * plus an 'Apply load config' action (POST /api/models/lmstudio/load with the
 * ACTIVE profile).
 */
export function LmStudioCompliancePanel({ model, name }: { model: string; name?: string }) {
  const [result, setResult] = useState<LmStudioComplianceResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyMessage, setApplyMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [unloading, setUnloading] = useState(false);

  const loadCompliance = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await lmstudioApi.compliance(model);
      setResult(res);
      setApplyMessage(null);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : 'Failed to check compliance');
    } finally {
      setLoading(false);
    }
  }, [model]);

  useEffect(() => {
    void loadCompliance();
  }, [loadCompliance]);

  const restLoadUnavailable = result?.apiSurface === 'openai-only';

  const handleApply = async () => {
    setApplying(true);
    setApplyMessage(null);
    try {
      await lmstudioApi.load(model);
      setApplyMessage({ ok: true, text: 'Load config applied with the active profile.' });
      // Catalog/compliance may have changed — refresh live consumers.
      window.dispatchEvent(new Event(LMSTUDIO_STATUS_CHANGED_EVENT));
      await loadCompliance();
    } catch (err) {
      setApplyMessage({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to apply load config',
      });
    } finally {
      setApplying(false);
    }
  };

  // §11 manual unload: confirm-free, optimistic local state, fail-soft inline
  // error via the same applyMessage channel as the load action.
  const handleUnload = async () => {
    if (unloading || restLoadUnavailable) return;
    setUnloading(true);
    setApplyMessage({ ok: true, text: 'Unloading model from memory…' }); // optimistic
    try {
      const res = await lmstudioApi.unload(model);
      setApplyMessage({
        ok: true,
        text:
          res.status === 'not-loaded'
            ? 'Model was not loaded.'
            : `Model unloaded from memory (${res.instances_unloaded ?? 0} instance(s)).`,
      });
      // Catalog/loaded-state may have changed — refresh live consumers.
      window.dispatchEvent(new Event(LMSTUDIO_STATUS_CHANGED_EVENT));
      await loadCompliance();
    } catch (err) {
      setApplyMessage({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to unload model',
      });
    } finally {
      setUnloading(false);
    }
  };

  return (
    <div style={{
      padding: '12px 14px',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
          Compliance
          {name ? ` · ${name}` : ''}
        </span>
        {result?.profile?.label && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            profile {result.profile.label}
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void loadCompliance()}
          disabled={loading}
          style={{ marginLeft: 'auto' }}
          aria-label="Re-check compliance"
        >
          <RefreshCw size={12} />
        </Button>
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          Checking compliance...
        </div>
      )}

      {!loading && error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8125rem', color: 'var(--error)' }}>
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {!loading && result && Array.isArray(result.knobs) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {result.knobs.map((knob) => (
            <div
              key={knob.key}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                padding: '8px 10px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {knob.met === true && <Check size={13} style={{ color: 'var(--success)', flexShrink: 0 }} />}
                {knob.met === false && <X size={13} style={{ color: 'var(--error)', flexShrink: 0 }} />}
                {knob.met === null && <Minus size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                <span style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                  {knob.label}
                </span>
                <span style={{
                  marginLeft: 'auto',
                  fontSize: '0.5625rem',
                  padding: '1px 5px',
                  background: 'var(--accent-soft)',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  flexShrink: 0,
                }}>
                  {HOW_LABEL[knob.how] ?? knob.how}
                </span>
              </div>
              <div style={{
                display: 'flex',
                gap: '8px',
                flexWrap: 'wrap',
                paddingLeft: 21,
                fontSize: '0.6875rem',
                fontFamily: 'var(--font-mono)',
                color: knob.met === false ? 'var(--error)' : 'var(--text-muted)',
              }}>
                <span>expected {knob.expected}</span>
                <span>·</span>
                <span>{knob.met === null ? 'actual — (not observable live)' : `actual ${knob.actual ?? '—'}`}</span>
              </div>
              {knob.how !== 'rest' && knob.guidance && (
                <div style={{
                  paddingLeft: 21,
                  fontSize: '0.6875rem',
                  color: 'var(--text-muted)',
                  lineHeight: 1.5,
                }}>
                  {knob.guidance}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          size="sm"
          onClick={handleApply}
          loading={applying}
          disabled={restLoadUnavailable}
        >
          <Zap size={13} />
          Apply load config
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleUnload}
          loading={unloading}
          disabled={restLoadUnavailable}
          aria-label="Unload model from memory"
          title="Unload model from memory"
        >
          Descargar
        </Button>
        {restLoadUnavailable && (
          <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
            REST load unavailable on OpenAI-compat-only servers (≤0.3.x)
          </span>
        )}
        {applyMessage && (
          <span style={{ fontSize: '0.75rem', color: applyMessage.ok ? 'var(--success)' : 'var(--error)' }}>
            {applyMessage.text}
          </span>
        )}
      </div>

      <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.5 }}>
        Knobs marked GUI or SDK script are one-time settings applied inside the LM Studio app —
        REST can only verify them here, never change them.
      </div>
    </div>
  );
}
