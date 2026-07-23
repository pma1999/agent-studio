import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Check, Laptop, Loader2, ShieldAlert, WifiOff } from 'lucide-react';
import { agentPairingApi, type PairedDevice, type PairingCodeResponse } from '../api/client';
import { Button } from './ui/Button';

const DEVICE_POLL_MS = 5_000;
const COUNTDOWN_TICK_MS = 1_000;

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Unknown';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** A single active pairing code plus the moment it was issued, so a real-time
 *  countdown / depleting progress bar can be derived without re-fetching. */
interface ActiveCode extends PairingCodeResponse {
  issuedAt: number;
}

export function AgentPairingPanel() {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  const [activeCode, setActiveCode] = useState<ActiveCode | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [unpairingId, setUnpairingId] = useState<string | null>(null);
  const [unpairError, setUnpairError] = useState<string | null>(null);

  const loadDevices = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setDevicesLoading(true);
    try {
      const rows = await agentPairingApi.listPairings();
      // "Currently paired" excludes revoked rows — the API keeps them for history,
      // but a revoked pairing is no longer a device the user needs to manage here.
      setDevices(rows.filter((d) => !d.revoked_at));
      setDevicesError(null);
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : 'Failed to load paired devices');
    } finally {
      if (!opts?.silent) setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDevices();
    const t = window.setInterval(() => loadDevices({ silent: true }), DEVICE_POLL_MS);
    return () => window.clearInterval(t);
  }, [loadDevices]);

  // Live countdown tick for the active pairing code
  useEffect(() => {
    if (!activeCode) return;
    const t = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(t);
  }, [activeCode]);

  const handleGenerate = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await agentPairingApi.createPairingCode();
      setActiveCode({ ...res, issuedAt: Date.now() });
      setNow(Date.now());
      setCopied(false);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate a pairing code');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = () => {
    if (!activeCode) return;
    navigator.clipboard.writeText(activeCode.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleUnpair = async (device: PairedDevice) => {
    const confirmed = window.confirm(
      `Unpair "${device.device_name}"? It will immediately lose access to run commands on this machine — you'd need to pair it again with a new code to reconnect it.`
    );
    if (!confirmed) return;
    setUnpairingId(device.id);
    setUnpairError(null);
    try {
      await agentPairingApi.unpair(device.id);
      await loadDevices({ silent: true });
    } catch (err) {
      setUnpairError(err instanceof Error ? err.message : 'Failed to unpair device');
    } finally {
      setUnpairingId(null);
    }
  };

  const ttlMs = activeCode ? new Date(activeCode.expires_at).getTime() - activeCode.issuedAt : 0;
  const remainingMs = activeCode ? new Date(activeCode.expires_at).getTime() - now : 0;
  const expired = !!activeCode && remainingMs <= 0;
  const remainingFraction = ttlMs > 0 ? Math.max(0, Math.min(1, remainingMs / ttlMs)) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
          background: 'var(--accent-soft)', border: '1px solid var(--border-accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)',
        }}>
          <Laptop size={15} />
        </div>
        <h4 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Local Agent
        </h4>
      </div>

      <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.6 }}>
        Pair your own Windows machine so agents can use the run_command tool's "local"
        backend — real files, installed tools, and state that persists between calls, not
        an ephemeral sandbox.
      </p>

      <div style={{
        display: 'flex', gap: '9px', padding: '10px 12px',
        background: 'var(--state-warning-soft)', border: '1px solid rgb(var(--amber-rgb) / 0.3)',
        borderRadius: 'var(--radius-sm)',
      }}>
        <ShieldAlert size={15} style={{ color: 'var(--state-warning)', flexShrink: 0, marginTop: '1px' }} />
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
          A paired agent can do anything your own Windows account can do on this machine —
          that's the real security model, not a simplification. Commands default to a
          workspace folder and a small set of especially destructive commands are blocked
          or need your confirmation at the keyboard, but this is a seatbelt, not a sandbox:
          it does not stop a determined bad prompt. Only pair a machine you trust, and you
          can unpair it here at any time.
        </p>
      </div>

      {!activeCode || expired ? (
        <div>
          <Button variant="primary" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Generating…' : expired ? 'Generate a new code' : 'Generate pairing code'}
          </Button>
          {expired && (
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
              That code expired before it was used. Generate a new one when you're ready to pair.
            </p>
          )}
          {generateError && (
            <p style={{ fontSize: '0.75rem', color: 'var(--error)', margin: '6px 0 0' }}>{generateError}</p>
          )}
        </div>
      ) : (
        <div style={{
          padding: '14px 16px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-accent)',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <span className="agent-pairing-code">
              {activeCode.code.match(/.{1,4}/g)?.join(' ') || activeCode.code}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              aria-label={copied ? 'Copied' : 'Copy pairing code'}
              icon={copied ? <Check size={13} /> : <Copy size={13} />}
              style={{ flexShrink: 0 }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>

          <div className="agent-pairing-countdown-track">
            <div
              className="agent-pairing-countdown-fill"
              style={{ width: `${remainingFraction * 100}%` }}
            />
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0, fontFamily: 'var(--font-mono)' }}>
            Expires in {formatCountdown(remainingMs)} — single use
          </p>

          <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
            Open the Agent Studio Local Agent app on the machine you want to pair, and enter
            this code when it prompts you.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
            Paired devices
          </span>
          {devicesLoading && <Loader2 size={13} className="tool-call-spin" style={{ color: 'var(--text-muted)' }} />}
        </div>

        {devicesError && (
          <p style={{ fontSize: '0.75rem', color: 'var(--error)', margin: 0 }}>{devicesError}</p>
        )}
        {unpairError && (
          <p style={{ fontSize: '0.75rem', color: 'var(--error)', margin: 0 }}>{unpairError}</p>
        )}

        {!devicesLoading && devices.length === 0 && !devicesError && (
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: 0, fontStyle: 'italic' }}>
            No devices paired yet. Generate a code above to pair your first machine.
          </p>
        )}

        {devices.map((device) => (
          <div
            key={device.id}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
              padding: '10px 12px', background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {device.device_name}
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                Paired {formatDate(device.created_at)} · Last seen {formatRelativeTime(device.last_seen_at)}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px',
                  fontSize: '0.7rem', fontFamily: 'var(--font-mono)',
                  color: device.connected ? 'var(--state-success)' : 'var(--text-muted)',
                }}
              >
                {device.connected ? (
                  <span className="agent-pairing-connected-dot" />
                ) : (
                  <WifiOff size={12} />
                )}
                {device.connected ? 'Connected' : 'Not connected'}
              </span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => handleUnpair(device)}
                disabled={unpairingId === device.id}
              >
                {unpairingId === device.id ? 'Unpairing…' : 'Unpair'}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
