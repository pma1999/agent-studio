import React from 'react';
import { motion } from 'framer-motion';
import { Plus, Bot, Pencil, Trash2, MessageSquare } from 'lucide-react';
import { useStore } from '../stores/store';
import { useIsMobile } from '../utils/breakpoints';
import { agentsApi } from '../api/client';
import { useChat } from '../hooks/useChat';
import { Button } from './ui/Button';
import { EmptyState } from './EmptyState';

export function AgentList() {
  const {
    agents,
    agentsLoading,
    loadAgents,
    setAgentEditorOpen,
    setEditingAgent,
    setSelectedAgentId,
    loadConversations,
  } = useStore();
  const { startNewChat } = useChat();

  const handleCreateAgent = () => {
    setEditingAgent(null);
    setAgentEditorOpen(true);
  };

  const handleEditAgent = (e: React.MouseEvent, agent: typeof agents[0]) => {
    e.stopPropagation();
    setEditingAgent(agent);
    setAgentEditorOpen(true);
  };

  const handleDeleteAgent = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this agent and all its conversations?')) return;
    try {
      await agentsApi.delete(id);
      await loadAgents();
    } catch (err) {
      console.error('Failed to delete agent:', err);
    }
  };

  const handleStartChat = async (agentId: string) => {
    setSelectedAgentId(agentId);
    await loadConversations(agentId);
    await startNewChat(agentId);
  };

  const handleSelectAgent = async (agentId: string) => {
    setSelectedAgentId(agentId);
    await loadConversations(agentId);
  };

  const isMobile = useIsMobile();

  if (agentsLoading && agents.length === 0) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--text-muted)',
      }}>
        <div className="animate-pulse">Loading agents...</div>
      </div>
    );
  }

  return (
    <div style={{
      padding: 'var(--content-padding-y) var(--content-padding-x)',
      overflowY: 'auto',
      height: '100%',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'flex-end',
        justifyContent: 'space-between',
        marginBottom: 'var(--section-gap)',
        gap: isMobile ? '16px' : 0,
      }}>
        <div>
          <motion.h1
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--heading-1-size)',
              fontWeight: 500,
              color: 'var(--text-primary)',
              marginBottom: '6px',
            }}
          >
            Your Agents
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.938rem',
            }}
          >
            Create and manage AI agents with custom personalities and instructions
          </motion.p>
        </div>
        <Button
          variant="primary"
          icon={<Plus size={16} />}
          onClick={handleCreateAgent}
          style={isMobile ? { alignSelf: 'flex-start' } : undefined}
        >
          New Agent
        </Button>
      </div>

      {/* Agent Grid */}
      {agents.length === 0 ? (
        <EmptyState
          icon={<Bot size={32} />}
          title="No agents yet"
          description="Create your first AI agent with custom system instructions to get started."
          action={
            <Button variant="primary" icon={<Plus size={16} />} onClick={handleCreateAgent}>
              Create your first agent
            </Button>
          }
        />
      ) : (
        <div className="agent-list-grid">
          {agents.map((agent, i) => (
            <motion.div
              key={agent.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              onClick={() => handleSelectAgent(agent.id)}
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)',
                padding: isMobile ? '16px' : '24px',
                cursor: 'pointer',
                transition: 'all var(--transition-base)',
                position: 'relative',
                overflow: 'hidden',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-accent)';
                e.currentTarget.style.boxShadow = 'var(--shadow-glow)';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border)';
                e.currentTarget.style.boxShadow = 'none';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              {/* Accent gradient at top */}
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: '3px',
                background: 'linear-gradient(90deg, #8b5cf6, #a78bfa)',
                opacity: 0.6,
              }} />

              {/* Emoji + Name */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                marginBottom: '14px',
              }}>
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--accent-glow)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '1.5rem',
                  flexShrink: 0,
                }}>
                  {agent.emoji}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '1.2rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: '2px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {agent.name}
                  </h3>
                  <div style={{
                    fontSize: '0.75rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}>
                    {agent.model} · T={agent.temperature}
                  </div>
                </div>
              </div>

              {/* Description */}
              <p style={{
                fontSize: '0.8475rem',
                color: 'var(--text-secondary)',
                lineHeight: 1.6,
                marginBottom: '16px',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                minHeight: '2.7em',
              }}>
                {agent.description || 'No description'}
              </p>

              {/* System prompt preview */}
              <div style={{
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)',
                background: 'var(--bg-elevated)',
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                marginBottom: '16px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                border: '1px solid var(--border)',
              }}>
                {agent.system_prompt}
              </div>

              {/* Actions */}
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px',
              }}>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<MessageSquare size={14} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStartChat(agent.id);
                  }}
                >
                  Chat
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Pencil size={14} />}
                  onClick={(e) => handleEditAgent(e, agent)}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  onClick={(e) => handleDeleteAgent(e, agent.id)}
                  style={{ color: 'var(--text-muted)' }}
                />
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
