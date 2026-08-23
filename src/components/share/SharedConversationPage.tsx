import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ExternalLink, FileUp, Globe, Link2Off, Loader2, Paperclip } from 'lucide-react';
import { MarkdownContent } from '../MarkdownContent';
import { EmptyState } from '../EmptyState';
import { sharesApi } from '../../api/client';
// Same source T3 re-exports (type-only; erased before bundling).
import type { ShareSnapshot, SharedMessage } from '../../api/client';
// Shared FMT8-02 predicate: provider-controlled citation hrefs must be absolute http/https.
import { isSafeHttpUrl } from '../../utils/url';

type LoadPhase =
  | { phase: 'loading' }
  // GC8: one uniform state for revoked / never-existed / garbage tokens and
  // network errors alike — never branch on the error's shape or message.
  | { phase: 'unavailable' }
  | { phase: 'ready'; snapshot: ShareSnapshot };

/**
 * Defensive date rendering (FMT1-05): `shared_at` is ISO-8601 today, but any
 * timestamp we display must tolerate other shapes. Returns null when the
 * value cannot be parsed so callers can omit the date instead of "Invalid Date".
 */
function formatSharedDate(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ---------- Annotation rendering (mirrors MessageBubble's owner-side view) ----------

interface SharedCitation {
  url: string;
  title?: string;
}

/** Display-friendly domain from a URL; falls back to the raw value (same as MessageBubble). */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Extracts the two renderable annotation kinds from a snapshot message.
 * The D6 contract types `annotations` as `unknown[] | null`, so every entry is
 * probed defensively and malformed items are skipped: URL citations dedupe by
 * url (first occurrence wins) exactly like MessageBubble's dedupeAnnotations,
 * and file annotations contribute only non-empty `file.name` strings.
 */
function collectShareAnnotations(annotations: unknown[] | null): {
  citations: SharedCitation[];
  documentNames: string[];
} {
  const citations: SharedCitation[] = [];
  const seenUrls = new Set<string>();
  const documentNames: string[] = [];

  for (const raw of annotations ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const ann = raw as Record<string, unknown>;

    // Web citation (url/title) — href must survive isSafeHttpUrl (FMT8-01)
    if (typeof ann.url === 'string' && isSafeHttpUrl(ann.url)) {
      if (!seenUrls.has(ann.url)) {
        seenUrls.add(ann.url);
        citations.push({
          url: ann.url,
          title: typeof ann.title === 'string' && ann.title !== '' ? ann.title : undefined,
        });
      }
    }

    // File/document annotation ({ type:'file', file:{ name } })
    if (
      ann.type === 'file' &&
      ann.file &&
      typeof ann.file === 'object' &&
      typeof (ann.file as Record<string, unknown>).name === 'string'
    ) {
      const name = (ann.file as Record<string, unknown>).name as string;
      if (name.trim() !== '') documentNames.push(name);
    }
  }

  return { citations, documentNames };
}

/**
 * Public, anonymous, read-only rendering of a share snapshot fetched by token.
 * Routed at `/s/<token>` by App when parseClientPath returns `{ kind:'share' }`.
 *
 * Fidelity guard: message order comes straight from the server snapshot array —
 * no client-side sorting. Assistant content goes through the UNMODIFIED
 * MarkdownContent (no rehype-raw / dangerouslySetInnerHTML anywhere, GC5);
 * user content renders as whitespace-preserving plain text.
 */
export function SharedConversationPage({ token }: { token: string }) {
  const [state, setState] = useState<LoadPhase>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    sharesApi
      .resolvePublic(token)
      .then((snapshot) => {
        if (!cancelled) setState({ phase: 'ready', snapshot });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  let body: React.ReactNode;
  if (state.phase === 'loading') {
    body = (
      <div className="shared-center">
        <div className="shared-loading" role="status">
          <Loader2 size={18} />
          <span>Loading conversation…</span>
        </div>
      </div>
    );
  } else if (state.phase === 'unavailable') {
    body = (
      <div className="shared-center">
        <EmptyState
          icon={<Link2Off size={30} />}
          title="Link unavailable"
          description="This link is no longer available or never existed."
        />
      </div>
    );
  } else {
    const { snapshot } = state;
    const sharedDate = formatSharedDate(snapshot.shared_at);
    const showAgentBadge = Boolean(snapshot.agent_name || snapshot.agent_emoji);
    body = (
      <motion.main
        className="shared-scroll"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
      >
        <div className="shared-container">
          <header className="shared-header">
            <h1 className="shared-title">
              {snapshot.conversation_title || 'Conversation'}
            </h1>
            {showAgentBadge && (
              <div className="shared-agent-badge">
                {snapshot.agent_emoji && (
                  <span className="shared-agent-emoji">{snapshot.agent_emoji}</span>
                )}
                {snapshot.agent_name && <span>{snapshot.agent_name}</span>}
              </div>
            )}
            <p className="shared-meta">
              Read-only snapshot{sharedDate ? ` · shared ${sharedDate}` : ''}
            </p>
          </header>
          {/* Server order is authoritative — render snapshot.messages as-is. */}
          <div className="shared-messages">
            {snapshot.messages.map((m) => (
              <SharedMessageRow key={m.id} message={m} />
            ))}
          </div>
        </div>
      </motion.main>
    );
  }

  return (
    <div className="shared-page">
      <header className="shared-topbar">
        <span className="shared-topbar-mark" aria-hidden="true" />
        <span className="shared-topbar-name">Agent Studio</span>
      </header>
      {body}
    </div>
  );
}

/** One transcript row. Attachments render as filename chips; entries with an
 *  empty filename are skipped defensively (FMT1-01 already drops them
 *  server-side — this keeps rendering safe regardless). */
function SharedMessageRow({ message }: { message: SharedMessage }) {
  const isUser = message.role === 'user';
  const attachments = (message.attachments ?? []).filter(
    (a) => typeof a?.filename === 'string' && a.filename.trim() !== ''
  );
  // Faithful rendering (D6): assistant messages surface web citations and
  // document usage exactly like the owner's own view in MessageBubble.
  const { citations, documentNames } = isUser
    ? { citations: [], documentNames: [] }
    : collectShareAnnotations(message.annotations);

  return (
    <div
      className={`shared-message ${isUser ? 'shared-message-user' : 'shared-message-assistant'}`}
    >
      {isUser ? (
        <div className="shared-bubble-user">
          <div className="shared-user-text">{message.content}</div>
        </div>
      ) : (
        <>
          {message.model && (
            <div className="shared-model-caption">{message.model}</div>
          )}
          <MarkdownContent content={message.content} />
          {citations.length > 0 && (
            <div className="shared-sources">
              <div className="shared-sources-label">
                <Globe size={11} />
                Sources
              </div>
              <div className="shared-sources-list">
                {citations.map((c, i) => (
                  <a
                    key={`${c.url}-${i}`}
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="message-citation-link"
                  >
                    <span style={{ flexShrink: 0, opacity: 0.7 }}>[{i + 1}]</span>
                    {c.title || extractDomain(c.url)}
                    <ExternalLink size={9} style={{ flexShrink: 0, opacity: 0.6 }} />
                  </a>
                ))}
              </div>
            </div>
          )}
          {documentNames.length > 0 && (
            <div className="shared-docs-used">
              <FileUp size={12} style={{ flexShrink: 0 }} />
              <span>Document(s) used: {documentNames.join(', ')}</span>
            </div>
          )}
        </>
      )}
      {attachments.length > 0 && (
        <div className="shared-attachments">
          {attachments.map((a, i) => (
            <span key={`${i}-${a.filename}`} className="shared-attachment-chip">
              <Paperclip size={11} />
              {a.filename}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
