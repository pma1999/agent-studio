import React, { useState, useRef, useEffect } from 'react';
import { Trash2, Search } from 'lucide-react';
import { useStore } from '../stores/store';
import { useIsMobile } from '../utils/breakpoints';
import { SWIPE_DISMISS_OFFSET, SWIPE_DISMISS_VELOCITY } from '../utils/gestures';
import { conversationsApi } from '../api/client';

/** Furthest a row can be pulled left (px) — just past the delete threshold for a tactile stop. */
const MAX_SWIPE = SWIPE_DISMISS_OFFSET + 12;

/** Horizontal distance (px) past which a move counts as an intentional swipe. */
const SWIPE_INTENT_DELTA = 10;

type SwipeGesture = {
  id: string;
  el: HTMLButtonElement | null;
  startX: number;
  startY: number;
  startTime: number;
  /** null = undecided, true = horizontal (we own it), false = vertical (browser scrolls). */
  horizontal: boolean | null;
};

export function ConversationList() {
  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    setCurrentView,
    setSidebarMobileOpen,
    loadConversations,
    loadMessages,
    agents,
    generalChatSettings,
  } = useStore();
  const isMobile = useIsMobile();
  const [query, setQuery] = useState('');

  // Active swipe gesture (one at a time, by definition of a touch).
  const gestureRef = useRef<SwipeGesture | null>(null);
  // Set after a swipe so the row's onClick (open) doesn't fire post-drag.
  const suppressClick = useRef(false);

  const listRef = useRef<HTMLDivElement>(null);
  const [canScrollMore, setCanScrollMore] = useState(false);

  const agentFor = (agentId?: string | null) =>
    agentId ? agents.find((a) => a.id === agentId) : undefined;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? conversations.filter((c) => {
        const ag = agentFor(c.agent_id);
        return (
          c.title.toLowerCase().includes(q) ||
          (ag ? ag.name.toLowerCase().includes(q) : 'general'.includes(q))
        );
      })
    : conversations;

  const handleSelectConversation = async (id: string) => {
    setActiveConversationId(id);
    setCurrentView('chat');
    if (isMobile) setSidebarMobileOpen(false);
    await loadMessages(id);
  };

  const deleteConversation = async (id: string) => {
    try {
      await conversationsApi.delete(id);
      if (activeConversationId === id) {
        setActiveConversationId(null);
      }
      await loadConversations();
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  };

  const handleDeleteConversation = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    void deleteConversation(id);
  };

  const showSearch = conversations.length > 5;

  // Keep the bottom fade hint in sync whenever the list content resizes.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setCanScrollMore(el.scrollHeight - el.clientHeight > 24 && el.scrollTop + el.clientHeight < el.scrollHeight - 24);
  }, [conversations.length, query, isMobile]);

  const updateScrollHint = (el: HTMLDivElement) => {
    setCanScrollMore(el.scrollHeight - el.clientHeight > 24 && el.scrollTop + el.clientHeight < el.scrollHeight - 24);
  };

  // --- Lightweight swipe-to-delete (replaces framer-motion drag per row).
  // `touch-action: pan-y` (see index.css) lets the browser own vertical
  // scrolling with native momentum; we only ever follow horizontal intent.
  const handleTouchStart = (id: string) => (e: React.TouchEvent<HTMLButtonElement>) => {
    const t = e.touches[0];
    gestureRef.current = {
      id,
      el: e.currentTarget,
      startX: t.clientX,
      startY: t.clientY,
      startTime: e.timeStamp,
      horizontal: null,
    };
  };

  const handleTouchMove = (id: string) => (e: React.TouchEvent<HTMLButtonElement>) => {
    const g = gestureRef.current;
    if (!g || g.id !== id) return;
    const t = e.touches[0];
    const dx = t.clientX - g.startX;
    const dy = t.clientY - g.startY;

    // Decide intent once the gesture clearly leans one way. Vertical
    // gestures are handed back to the browser (no preventDefault, no state).
    if (g.horizontal === null) {
      if (Math.abs(dx) < SWIPE_INTENT_DELTA && Math.abs(dy) < SWIPE_INTENT_DELTA) return;
      g.horizontal = Math.abs(dx) > Math.abs(dy);
      if (!g.horizontal) return;
      g.el?.classList.add('recents-item-dragging');
      g.el?.style.setProperty('will-change', 'transform');
    }
    if (!g.horizontal) return;

    // Follow the finger, leftward only. Applied straight to the DOM so the
    // gesture never triggers React re-renders (keeps the scroll smooth).
    const x = Math.max(-MAX_SWIPE, Math.min(0, dx));
    if (g.el) g.el.style.transform = `translateX(${x}px)`;
  };

  const endSwipe = (id: string, e: React.TouchEvent<HTMLButtonElement>) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g || g.id !== id) return;

    g.el?.classList.remove('recents-item-dragging');
    g.el?.style.removeProperty('will-change');

    // Tap or vertical scroll: nothing to settle.
    if (g.horizontal === null || g.horizontal === false) return;

    // touchcancel can fire without a changed touch (browser takes over the
    // gesture, e.g. system edge swipe); bail out and let the row spring back.
    const t = e.changedTouches[0];
    if (!t) {
      if (g.el) g.el.style.transform = '';
      return;
    }
    const dx = t.clientX - g.startX;
    const dt = Math.max(16, e.timeStamp - g.startTime); // ms
    const vx = (dx / dt) * 1000; // px/s

    if (g.el) g.el.style.transform = ''; // spring back via CSS transition

    if (dx < -SWIPE_DISMISS_OFFSET || vx < -SWIPE_DISMISS_VELOCITY) {
      suppressClick.current = true;
      void deleteConversation(id);
    } else if (Math.abs(dx) > 6) {
      suppressClick.current = true;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0, position: 'relative' }}>
      {showSearch && (
        <div className="recents-search">
          <Search size={14} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search conversations"
          />
        </div>
      )}

      <div
        className="recents-list"
        ref={listRef}
        onScroll={(e) => updateScrollHint(e.currentTarget)}
      >
        {conversations.length === 0 ? (
          <div className="recents-empty">
            No conversations yet.
            <br />
            Start a new chat to begin.
          </div>
        ) : filtered.length === 0 ? (
          <div className="recents-empty">No chats match “{query}”.</div>
        ) : (
          filtered.map((conv, index) => {
            const ag = agentFor(conv.agent_id);
            const label = ag ? ag.name : 'General';
            const emoji = ag ? ag.emoji || '🤖' : generalChatSettings?.emoji || '💬';
            const active = activeConversationId === conv.id;
            return (
              <button
                key={conv.id}
                type="button"
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  handleSelectConversation(conv.id);
                }}
                onTouchStart={isMobile ? handleTouchStart(conv.id) : undefined}
                onTouchMove={isMobile ? handleTouchMove(conv.id) : undefined}
                onTouchEnd={isMobile ? (e) => endSwipe(conv.id, e) : undefined}
                onTouchCancel={isMobile ? (e) => endSwipe(conv.id, e) : undefined}
                className={`recents-item ${active ? 'recents-item-active' : ''}`}
                style={{ ['--item-index' as string]: Math.min(index, 8) }}
                title={`${conv.title} · ${label}`}
              >
                <span className="recents-item-avatar" aria-hidden="true">{emoji}</span>
                <span className="recents-item-main">
                  <span className="recents-item-title">{conv.title}</span>
                  <span className="recents-item-meta">{label}</span>
                </span>
                <span
                  onClick={(e) => handleDeleteConversation(e, conv.id)}
                  role="button"
                  tabIndex={-1}
                  className="conv-delete-btn"
                  title="Delete conversation"
                  aria-label="Delete conversation"
                >
                  <Trash2 size={12} />
                </span>
              </button>
            );
          })
        )}
      </div>

      {isMobile && (
        <div
          className="recents-fade"
          style={{ opacity: canScrollMore ? 1 : 0 }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
