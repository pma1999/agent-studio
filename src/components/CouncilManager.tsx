import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Plus, Building2, Pencil, Trash2, MessageSquare, Cpu, GitMerge, Sparkles } from 'lucide-react';
import { useStore } from '../stores/store';
import { useIsMobile } from '../utils/breakpoints';
import { councilsApi } from '../api/client';
import { Button } from './ui/Button';
import { EmptyState } from './EmptyState';
import { ModelAvatar, getModelDisplayName } from './council/ModelAvatar';

export function CouncilManager() {
  const {
    councilMembers,
    councilMembersLoading,
    loadCouncilMembers,
    setCouncilEditorOpen,
    setEditingCouncil,
    setCurrentView,
  } = useStore();

  // Load list when entering the councils view
  useEffect(() => {
    loadCouncilMembers();
  }, [loadCouncilMembers]);

  const handleCreateCouncil = () => {
    setEditingCouncil(null);
    setCouncilEditorOpen(true);
  };

  const handleEditCouncil = (e: React.MouseEvent, council: typeof councilMembers[0]) => {
    e.stopPropagation();
    setEditingCouncil(council);
    setCouncilEditorOpen(true);
  };

  const handleDeleteCouncil = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this council configuration?')) return;
    try {
      await councilsApi.delete(id);
      await loadCouncilMembers();
    } catch (err) {
      console.error('Failed to delete council:', err);
    }
  };

  const handleSelectCouncil = () => {
    // Navigate to chat view where user can use the council
    setCurrentView('chat');
  };

  const isMobile = useIsMobile();

  if (councilMembersLoading && councilMembers.length === 0) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--text-muted)',
      }}>
        <div className="animate-pulse">Loading councils...</div>
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
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              marginBottom: '12px',
            }}
          >
            <div style={{
              width: 52,
              height: 52,
              borderRadius: 'var(--radius-md)',
              background: 'var(--council-bg)',
              border: '1px solid var(--council-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#c9956b',
            }}>
              <Building2 size={26} />
            </div>
            <motion.h1
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'var(--heading-1-size)',
                fontWeight: 500,
                color: '#e2b886',
                letterSpacing: '0.02em',
              }}
            >
              Model Councils
            </motion.h1>
          </motion.div>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.938rem',
              maxWidth: '600px',
              lineHeight: 1.6,
            }}
          >
            Create deliberative chambers of AI experts that analyze in parallel and synthesize consensus responses
          </motion.p>
        </div>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.15 }}
        >
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={handleCreateCouncil}
            style={isMobile ? { alignSelf: 'flex-start' } : {
              background: 'rgba(201, 149, 107, 0.15)',
              borderColor: 'var(--council-border)',
              color: '#c9956b',
            }}
          >
            New Council
          </Button>
        </motion.div>
      </div>

      {/* Council Grid */}
      {councilMembers.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <EmptyState
            icon={<Building2 size={40} style={{ color: '#c9956b' }} />}
            title="No councils configured"
            description="Create your first deliberative chamber to run multi-model analysis and synthesis."
            action={
              <Button
                variant="primary"
                icon={<Plus size={16} />}
                onClick={handleCreateCouncil}
                style={{
                  background: 'rgba(201, 149, 107, 0.15)',
                  borderColor: 'var(--council-border)',
                  color: '#c9956b',
                }}
              >
                Create your first council
              </Button>
            }
          />
        </motion.div>
      ) : (
        <div className="agent-list-grid">
          {councilMembers.map((council, i) => (
            <motion.div
              key={council.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
              onClick={handleSelectCouncil}
              style={{
                background: 'var(--bg-surface)',
                border: `1px solid ${'var(--border)'}`,
                borderRadius: 'var(--radius-lg)',
                padding: isMobile ? '16px' : '24px',
                cursor: 'pointer',
                transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
                position: 'relative',
                overflow: 'hidden',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--council-border)';
                e.currentTarget.style.boxShadow = '0 0 30px rgba(201, 149, 107, 0.1)';
                e.currentTarget.style.transform = 'translateY(-3px)';
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
                background: 'linear-gradient(90deg, #c9956b, #e2b886)',
                opacity: 0.9,
              }} />

              {/* Glow effect on hover */}
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: '100px',
                background: 'linear-gradient(180deg, rgba(201, 149, 107, 0.05) 0%, transparent 100%)',
                pointerEvents: 'none',
              }} />

              {/* Icon + Name */}
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
                  background: 'var(--council-bg)',
                  border: '1px solid var(--council-border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '1.5rem',
                  flexShrink: 0,
                  color: '#c9956b',
                }}>
                  <Building2 size={24} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '1.2rem',
                    fontWeight: 600,
                    color: '#e2b886',
                    marginBottom: '2px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {council.name}
                  </h3>
                  <div style={{
                    fontSize: '0.75rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}>
                    <GitMerge size={12} style={{ color: '#c9956b' }} />
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {getModelDisplayName(council.synthesizer_model)}
                    </span>
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
                {council.description || `${council.member_models.length} expert models deliberating in parallel`}
              </p>

              {/* Member Models Preview */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                marginBottom: '16px',
              }}>
                {/* Stats Row */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: 'var(--council-bg)',
                    padding: '4px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--council-border)',
                    color: '#c9956b',
                  }}>
                    <Cpu size={12} />
                    <span>{council.member_models.length} members</span>
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: 'var(--bg-elevated)',
                    padding: '4px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                  }}>
                    <Sparkles size={12} style={{ color: '#c9956b' }} />
                    <span>Synthesis</span>
                  </div>
                  {council.tool_ids?.length > 0 && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      background: 'var(--bg-elevated)',
                      padding: '4px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border)',
                    }}>
                      <span>{council.tool_ids.length} tools</span>
                    </div>
                  )}
                </div>

                {/* Model Avatars Row */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  flexWrap: 'wrap',
                }}>
                  {council.member_models.slice(0, 5).map((model, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        background: 'var(--bg-elevated)',
                        padding: '3px 8px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <ModelAvatar modelId={model} size="xs" />
                      <span style={{
                        fontSize: '0.6875rem',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-secondary)',
                      }}>
                        {getModelDisplayName(model).slice(0, 12)}
                        {getModelDisplayName(model).length > 12 ? '...' : ''}
                      </span>
                    </div>
                  ))}
                  {council.member_models.length > 5 && (
                    <span style={{
                      fontSize: '0.6875rem',
                      color: '#c9956b',
                      padding: '3px 8px',
                      background: 'var(--council-bg)',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--council-border)',
                    }}>
                      +{council.member_models.length - 5} more
                    </span>
                  )}
                </div>
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
                    handleSelectCouncil();
                  }}
                  style={{
                    background: 'rgba(201, 149, 107, 0.15)',
                    borderColor: 'var(--council-border)',
                    color: '#c9956b',
                  }}
                >
                  Use Council
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Pencil size={14} />}
                  onClick={(e) => handleEditCouncil(e, council)}
                  style={{
                    color: 'var(--text-muted)',
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  onClick={(e) => handleDeleteCouncil(e, council.id)}
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
