import React, { useState, useRef } from 'react';
import { motion, type PanInfo } from 'framer-motion';
import { Trash2, Search } from 'lucide-react';
import { useStore } from '../stores/store';
import { useIsMobile, usePrefersReducedMotion } from '../utils/breakpoints';
import { shouldDismiss } from '../utils/gestures';
import { conversationsApi } from '../api/client';

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
  const prefersReducedMotion = usePrefersReducedMotion();
  const [query, setQuery] = useState('');

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

  // Set after a swipe so the row's onClick (open) doesn't fire post-drag.
  const suppressClick = useRef(false);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0 }}>
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

      <div className="recents-list">
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
              <motion.button
                key={conv.id}
                type="button"
                initial={prefersReducedMotion ? false : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: prefersReducedMotion ? 0 : 0.2, delay: prefersReducedMotion ? 0 : Math.min(index, 8) * 0.02 }}
                {...(isMobile && !prefersReducedMotion
                  ? {
                      drag: 'x' as const,
                      dragConstraints: { left: 0, right: 0 },
                      dragElastic: { left: 0.6, right: 0 },
                      dragDirectionLock: true,
                      onDragEnd: (_e: unknown, info: PanInfo) => {
                        if (shouldDismiss(info, 'x', -1)) {
                          suppressClick.current = true;
                          void deleteConversation(conv.id);
                        } else if (Math.abs(info.offset.x) > 6) {
                          suppressClick.current = true;
                        }
                      },
                    }
                  : {})}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  handleSelectConversation(conv.id);
                }}
                className={`recents-item ${active ? 'recents-item-active' : ''}`}
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
              </motion.button>
            );
          })
        )}
      </div>
    </div>
  );
}
