import React from 'react';
import { motion } from 'framer-motion';
import { MessageSquare, Trash2, Plus } from 'lucide-react';
import { useStore } from '../stores/store';
import { useIsMobile } from '../utils/breakpoints';
import { conversationsApi } from '../api/client';
import { useChat } from '../hooks/useChat';

export function ConversationList() {
  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    setCurrentView,
    setSidebarMobileOpen,
    loadConversations,
    loadMessages,
    selectedAgentId,
    agents,
  } = useStore();
  const isMobile = useIsMobile();
  const { startNewChat } = useChat();

  const agent = agents.find((a) => a.id === selectedAgentId);
  const agentConversations = selectedAgentId
    ? conversations.filter((c) => c.agent_id === selectedAgentId)
    : conversations;

  const handleSelectConversation = async (id: string) => {
    setActiveConversationId(id);
    setCurrentView('chat');
    if (isMobile) setSidebarMobileOpen(false);
    await loadMessages(id);
  };

  const handleDeleteConversation = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await conversationsApi.delete(id);
      if (activeConversationId === id) {
        setActiveConversationId(null);
      }
      await loadConversations(selectedAgentId || undefined);
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  };

  const handleNewChat = () => {
    if (selectedAgentId) {
      startNewChat(selectedAgentId);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      flex: 1,
      overflowY: 'auto',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        marginBottom: '8px',
      }}>
        <span style={{
          fontSize: '0.6875rem',
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}>
          {agent ? `${agent.emoji} ${agent.name}` : 'Conversations'}
        </span>
        {selectedAgentId && (
          <button
            onClick={handleNewChat}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '24px',
              height: '24px',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)',
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
              e.currentTarget.style.color = 'var(--accent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-muted)';
            }}
            title="New chat"
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {/* Conversation Items */}
      {agentConversations.length === 0 ? (
        <div style={{
          padding: '16px 12px',
          color: 'var(--text-muted)',
          fontSize: '0.8125rem',
          textAlign: 'center',
        }}>
          No conversations yet
        </div>
      ) : (
        agentConversations.map((conv, i) => (
          <motion.button
            key={conv.id}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2, delay: i * 0.03 }}
            onClick={() => handleSelectConversation(conv.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '10px 12px',
              background: activeConversationId === conv.id ? 'var(--accent-muted)' : 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              color: activeConversationId === conv.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: '0.8125rem',
              textAlign: 'left',
              width: '100%',
              fontFamily: 'var(--font-body)',
              transition: 'all var(--transition-fast)',
              borderLeft: activeConversationId === conv.id ? '2px solid var(--accent)' : '2px solid transparent',
            }}
            onMouseEnter={(e) => {
              if (activeConversationId !== conv.id) {
                e.currentTarget.style.background = 'var(--bg-hover)';
                e.currentTarget.style.color = 'var(--text-primary)';
              }
            }}
            onMouseLeave={(e) => {
              if (activeConversationId !== conv.id) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--text-secondary)';
              }
            }}
          >
            <MessageSquare size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
            <span style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}>
              {conv.title}
            </span>
            <span
              onClick={(e) => handleDeleteConversation(e as any, conv.id)}
              role="button"
              tabIndex={-1}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                height: '20px',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                borderRadius: '4px',
                flexShrink: 0,
                opacity: 0,
                transition: 'all var(--transition-fast)',
              }}
              className="conv-delete-btn"
              title="Delete conversation"
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--error)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-muted)';
              }}
            >
              <Trash2 size={12} />
            </span>
          </motion.button>
        ))
      )}
    </div>
  );
}
