import { useEffect, useState } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { sharesApi } from '../api/client';
import { sharePath } from '../utils/url';

interface ShareDialogProps {
  isOpen: boolean;
  conversationId: string;
  onClose: () => void;
}

/**
 * Dialog states (GC9): loading / not-shared / active / revoked-feedback, with
 * errors surfaced inline. The raw token lives only in this component's state
 * for as long as the dialog holds it (GC6) — it is never persisted or logged.
 */
type Phase = 'loading' | 'not-shared' | 'active' | 'revoked';

const NOT_SHARED_COPY =
  'Creates a read-only snapshot of this conversation as it is right now. Anyone with the link can view it; later messages are not included.';
const ROTATE_NOTE = 'Replacing the link makes the old link stop working.';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * FMT1-05: share `created_at` may arrive in SQLite UTC format
 * ("YYYY-MM-DD HH:MM:SS") while other timestamps are ISO. Normalize the SQLite
 * shape to ISO-UTC before parsing; anything unparseable returns null so the UI
 * omits the date instead of rendering garbage.
 */
export function formatShareCreatedAt(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ShareDialog({ isOpen, conversationId, onClose }: ShareDialogProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  // Load (or reload) status each time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    // Reset transient state — including any token held from a previous open,
    // so the raw token never outlives the dialog session that created it (GC6).
    setPhase('loading');
    setToken(null);
    setCreatedAt(null);
    setBusy(false);
    setError(null);
    setCopied(false);
    setConfirmingRevoke(false);

    let cancelled = false;
    sharesApi
      .getStatus(conversationId)
      .then((res) => {
        if (cancelled) return;
        if (res.status === 'active') {
          setPhase('active');
          setCreatedAt(res.share.created_at);
        } else {
          setPhase('not-shared');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorMessage(err, 'Failed to load share status.'));
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, conversationId]);

  // Revoked feedback lingers briefly so it is actually read, then the dialog
  // falls back to the not-shared view (offering a fresh "Create link").
  useEffect(() => {
    if (phase !== 'revoked') return;
    const timer = setTimeout(() => {
      setCreatedAt(null);
      setPhase('not-shared');
    }, 2500);
    return () => clearTimeout(timer);
  }, [phase]);

  const shareUrl = token ? `${window.location.origin}${sharePath(token)}` : null;

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await sharesApi.create(conversationId);
      setToken(res.token);
      setCreatedAt(res.created_at);
      setConfirmingRevoke(false);
      setCopied(false);
      setPhase('active');
    } catch (err: unknown) {
      setError(errorMessage(err, 'Failed to create link.'));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await sharesApi.revoke(conversationId);
      // Drop the raw token immediately; revoked links must not resolve anywhere.
      setToken(null);
      setConfirmingRevoke(false);
      setPhase('revoked');
    } catch (err: unknown) {
      setError(errorMessage(err, 'Failed to revoke link.'));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the link stays visible inline for manual copy.
    }
  };

  const createdAtLabel = createdAt === null ? null : formatShareCreatedAt(createdAt);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Share conversation">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {phase === 'loading' && (
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Checking share status…
          </p>
        )}

        {error !== null && (
          <p role="alert" style={{ margin: 0, fontSize: '0.875rem', color: 'var(--state-danger)' }}>
            {error}
          </p>
        )}

        {phase === 'not-shared' && (
          <>
            <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.55, color: 'var(--text-secondary)' }}>
              {NOT_SHARED_COPY}
            </p>
            <div>
              <Button variant="primary" loading={busy} onClick={handleCreate}>
                Create link
              </Button>
            </div>
          </>
        )}

        {phase === 'active' && (
          <>
            {shareUrl ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  className="field-input"
                  readOnly
                  value={shareUrl}
                  aria-label="Share link"
                  onClick={(e) => e.currentTarget.select()}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <Button variant="secondary" onClick={handleCopy}>
                  {copied ? 'Copied ✓' : 'Copy'}
                </Button>
              </div>
            ) : (
              // Status says a share exists but this dialog session has no raw
              // token (the API returns it exactly once). Replace to get a fresh one.
              <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                This conversation has an active share link. The full URL is only shown right after
                creating or replacing it.
              </p>
            )}
            {createdAtLabel && (
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Created {createdAtLabel}
              </p>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
              <Button variant="secondary" loading={busy} onClick={handleCreate}>
                Replace link
              </Button>
              {!confirmingRevoke ? (
                <Button variant="danger" disabled={busy} onClick={() => setConfirmingRevoke(true)}>
                  Revoke link
                </Button>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                  Revoke this link? Anyone with it will lose access.
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmingRevoke(false)}>
                    Cancel
                  </Button>
                  <Button variant="danger" size="sm" loading={busy} onClick={handleRevoke}>
                    Yes, revoke
                  </Button>
                </span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>{ROTATE_NOTE}</p>
          </>
        )}

        {phase === 'revoked' && (
          <p role="status" style={{ margin: 0, fontSize: '0.9rem', color: 'var(--state-success)' }}>
            Link revoked. Existing links no longer work.
          </p>
        )}
      </div>
    </Modal>
  );
}
