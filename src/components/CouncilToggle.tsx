import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { Building2, Users, Plus, ChevronDown, Settings } from 'lucide-react';
import { useStore } from '../stores/store';
import { useIsMobile } from '../utils/breakpoints';
import { ModelAvatar, getModelDisplayName } from './council/ModelAvatar';
import type { CouncilConfig, CouncilMember } from '../types';

interface CouncilToggleProps {
  disabled?: boolean;
  placement?: 'above' | 'below';
}

export function CouncilToggle({ disabled, placement = 'above' }: CouncilToggleProps) {
  const {
    councilEnabled,
    toggleCouncil,
    selectedCouncilId,
    setSelectedCouncilId,
    councilConfig,
    setCouncilConfig,
    councilMembers,
    councilMembersLoading,
    loadCouncilMembers,
    setCouncilEditorOpen,
    setEditingCouncil,
    setCurrentView,
  } = useStore();

  const [showSelector, setShowSelector] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showSelector) {
      loadCouncilMembers();
    }
  }, [showSelector, loadCouncilMembers]);

  // Close popover when clicking outside
  useEffect(() => {
    if (!showSelector) return;
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setShowSelector(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSelector]);

  const handleToggle = () => {
    if (disabled) return;
    if (!councilEnabled) {
      // If enabling, show selector to choose council
      setShowSelector(true);
    } else {
      // If disabling, just toggle off
      toggleCouncil();
      setSelectedCouncilId(null);
      setCouncilConfig(null);
    }
  };

  const handleSelectCouncil = (id: string, config: CouncilConfig) => {
    setSelectedCouncilId(id);
    setCouncilConfig(config);
    if (!councilEnabled) {
      toggleCouncil();
    }
    setShowSelector(false);
  };

  const handleSelectQuickConfig = (models: string[]) => {
    const config: CouncilConfig = {
      member_models: models,
      synthesizer_model: 'anthropic/claude-3.5-sonnet',
    };
    setSelectedCouncilId(null);
    setCouncilConfig(config);
    if (!councilEnabled) {
      toggleCouncil();
    }
    setShowSelector(false);
  };

  const handleCreateNew = () => {
    setShowSelector(false);
    setEditingCouncil(null);
    setCouncilEditorOpen(true);
  };

  const handleManageCouncils = () => {
    setShowSelector(false);
    setCurrentView('councils');
  };

  const selectedCouncilName = selectedCouncilId
    ? councilMembers.find((m) => m.id === selectedCouncilId)?.name
    : councilConfig
      ? `${councilConfig.member_models.length} models`
      : null;

  const isMobile = useIsMobile();
  const popoverStyle = placement === 'above'
    ? { bottom: 'calc(100% + 8px)' }
    : { top: 'calc(100% + 8px)' };

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={councilEnabled ? `Council: ${selectedCouncilName || 'Custom'}` : 'Enable council'}
        aria-expanded={showSelector}
        onClick={handleToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          if (councilEnabled) {
            setShowSelector(true);
          }
        }}
        title={councilEnabled ? `Council: ${selectedCouncilName || 'Custom'}` : 'Enable council (multi-model synthesis)'}
        disabled={disabled}
        style={{
          height: '32px',
          padding: '0 12px',
          borderRadius: 'var(--radius-md)',
          background: councilEnabled ? 'var(--council-bg)' : 'var(--bg-surface)',
          border: `1px solid ${councilEnabled ? 'var(--council-border)' : 'var(--border)'}`,
          color: councilEnabled ? '#c9956b' : 'var(--text-muted)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          transition: 'all 0.2s ease',
          position: 'relative',
          fontSize: '0.75rem',
          fontWeight: 500,
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          if (!councilEnabled) {
            e.currentTarget.style.background = 'var(--bg-hover)';
            e.currentTarget.style.borderColor = 'var(--council-border)';
          } else {
            e.currentTarget.style.background = 'var(--council-bg-hover)';
            e.currentTarget.style.boxShadow = '0 0 16px rgba(201, 149, 107, 0.15)';
          }
        }}
        onMouseLeave={(e) => {
          if (!councilEnabled) {
            e.currentTarget.style.background = 'var(--bg-surface)';
            e.currentTarget.style.borderColor = 'var(--border)';
          } else {
            e.currentTarget.style.background = 'var(--council-bg)';
            e.currentTarget.style.boxShadow = 'none';
          }
        }}
      >
        <Building2 size={14} />
        <span className="toolbar-button-text">
          {councilEnabled ? (selectedCouncilName || `${councilConfig?.member_models.length || '?'} models`) : 'Council'}
        </span>
        {councilEnabled && (
          <div style={{
            position: 'absolute',
            top: '4px',
            right: '4px',
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: '#c9956b',
            boxShadow: '0 0 8px rgba(201, 149, 107, 0.8)',
            animation: 'councilPulse 2s ease-in-out infinite',
          }} />
        )}
      </button>

      {/* Selector Popover — desktop popover; mobile portaled bottom sheet */}
      {((tree: React.ReactNode) =>
        isMobile
          ? createPortal(
              <>
                <AnimatePresence>
                  {showSelector && (
                    <motion.div
                      key="ct-scrim"
                      className="sheet-scrim"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      onClick={() => setShowSelector(false)}
                    />
                  )}
                </AnimatePresence>
                {tree}
              </>,
              document.body
            )
          : tree)(
        <AnimatePresence>
          {showSelector && (
            <CouncilSelectorPopover
              ref={popoverRef}
              asSheet={isMobile}
              style={
                isMobile
                  ? { position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1101 }
                  : { position: 'absolute', left: '0', zIndex: 100, ...popoverStyle }
              }
              members={councilMembers}
              loading={councilMembersLoading}
              onSelectCouncil={handleSelectCouncil}
              onSelectQuickConfig={handleSelectQuickConfig}
              onCreateNew={handleCreateNew}
              onManageCouncils={handleManageCouncils}
              onClose={() => setShowSelector(false)}
            />
          )}
        </AnimatePresence>
      )}
    </div>
  );
}

interface CouncilSelectorPopoverProps {
  style: React.CSSProperties;
  members: CouncilMember[];
  loading: boolean;
  onSelectCouncil: (id: string, config: CouncilConfig) => void;
  onSelectQuickConfig: (models: string[]) => void;
  onCreateNew: () => void;
  onManageCouncils: () => void;
  onClose: () => void;
  asSheet?: boolean;
}

const CouncilSelectorPopover = React.forwardRef<HTMLDivElement, CouncilSelectorPopoverProps>(function CouncilSelectorPopover({
  style,
  members,
  loading,
  onSelectCouncil,
  onSelectQuickConfig,
  onCreateNew,
  onManageCouncils,
  onClose,
  asSheet,
}, ref) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const quickConfigs = [
    {
      id: 'quick-3',
      name: 'Triple Analysis',
      description: 'Claude + GPT + Gemini',
      models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-pro-1.5'],
    },
    {
      id: 'quick-4',
      name: 'Diverse Council',
      description: 'Claude + GPT + Gemini + Llama',
      models: [
        'anthropic/claude-3.5-sonnet',
        'openai/gpt-4o',
        'google/gemini-pro-1.5',
        'meta-llama/llama-3.1-70b-instruct',
      ],
    },
  ];

  return (
    <motion.div
      ref={ref}
      initial={asSheet ? { y: '100%' } : { opacity: 0, y: 8, scale: 0.96 }}
      animate={asSheet ? { y: 0 } : { opacity: 1, y: 0, scale: 1 }}
      exit={asSheet ? { y: '100%' } : { opacity: 0, y: 8, scale: 0.96 }}
      transition={{ duration: asSheet ? 0.3 : 0.15, ease: asSheet ? [0.32, 0.72, 0, 1] : undefined }}
      style={{
        width: asSheet ? '100%' : '340px',
        maxWidth: asSheet ? '100%' : 'calc(100vw - 24px)',
        maxHeight: asSheet ? '85dvh' : undefined,
        background: 'var(--bg-elevated)',
        border: asSheet ? 'none' : '1px solid var(--border-light)',
        borderTop: asSheet ? '1px solid var(--border-light)' : undefined,
        borderRadius: asSheet ? 'var(--radius-lg) var(--radius-lg) 0 0' : 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        overflowY: asSheet ? 'auto' : 'hidden',
        overflowX: 'hidden',
        WebkitOverflowScrolling: 'touch',
        overscrollBehavior: 'contain',
        paddingBottom: asSheet ? 'env(safe-area-inset-bottom)' : undefined,
        ...style,
      }}
    >
      {/* Header */}
      <div style={{
        padding: '16px',
        borderBottom: '1px solid var(--council-border)',
        background: 'var(--council-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}>
          <div style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--council-bg-hover)',
            border: '1px solid var(--council-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#c9956b',
          }}>
            <Building2 size={16} />
          </div>
          <div>
            <span style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1rem',
              fontWeight: 500,
              color: '#e2b886',
              display: 'block',
            }}>
              Model Council
            </span>
            <span style={{
              fontSize: '0.6875rem',
              color: 'var(--text-muted)',
            }}>
              Multi-expert deliberation
            </span>
          </div>
        </div>
      </div>

      <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
        {/* Quick Configs */}
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{
            fontSize: '0.625rem',
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: '8px',
          }}>
            Quick Select
          </div>

          {quickConfigs.map((config) => (
            <button
              key={config.id}
              onClick={() => onSelectQuickConfig(config.models)}
              style={{
                width: '100%',
                padding: '12px',
                marginBottom: '8px',
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                textAlign: 'left',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--council-border)';
                e.currentTarget.style.background = 'var(--council-bg)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border)';
                e.currentTarget.style.background = 'var(--bg-base)';
              }}
            >
              <span style={{
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: '#c9956b',
              }}>
                {config.name}
              </span>
              <span style={{
                fontSize: '0.6875rem',
                color: 'var(--text-muted)',
              }}>
                {config.description} · {config.models.length} models
              </span>
            </button>
          ))}
        </div>

        {/* Saved Councils */}
        <div style={{ padding: '10px 14px' }}>
          <div style={{
            fontSize: '0.625rem',
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: '8px',
          }}>
            Your Councils
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Loading...</span>
            </div>
          ) : members.length === 0 ? (
            <div style={{
              textAlign: 'center',
              padding: '16px',
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
            }}>
              No saved councils.
            </div>
          ) : (
            members.map((member) => (
              <div
                key={member.id}
                style={{
                  marginBottom: '6px',
                  border: `1px solid ${expandedId === member.id ? 'var(--council-border)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                  transition: 'border-color 0.2s ease',
                }}
              >
                <button
                  onClick={() =>
                    onSelectCouncil(member.id, {
                      member_models: member.member_models,
                      synthesizer_model: member.synthesizer_model,
                      synthesis_prompt_template: member.synthesis_prompt_template || undefined,
                      show_member_responses: member.show_member_responses,
                      tool_ids: member.tool_ids ?? [],
                      mcp_server_ids: member.mcp_server_ids ?? [],
                    })
                  }
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    background: expandedId === member.id ? 'var(--council-bg)' : 'var(--bg-base)',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    transition: 'background 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--council-bg)';
                  }}
                  onMouseLeave={(e) => {
                    if (expandedId !== member.id) {
                      e.currentTarget.style.background = 'var(--bg-base)';
                    }
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                    <span style={{
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      color: expandedId === member.id ? '#c9956b' : 'var(--text-primary)',
                      transition: 'color 0.2s ease',
                    }}>
                      {member.name}
                    </span>
                    {member.description && (
                      <span style={{
                        fontSize: '0.6875rem',
                        color: 'var(--text-muted)',
                      }}>
                        {member.description}
                      </span>
                    )}
                    <span style={{
                      fontSize: '0.625rem',
                      color: expandedId === member.id ? '#c9956b' : 'var(--text-secondary)',
                      transition: 'color 0.2s ease',
                    }}>
                      {member.member_models.length} models · {member.synthesizer_model.split('/')[1] || member.synthesizer_model}
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedId(expandedId === member.id ? null : member.id);
                    }}
                    style={{
                      padding: '4px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: expandedId === member.id ? '#c9956b' : 'var(--text-muted)',
                      transform: expandedId === member.id ? 'rotate(180deg)' : 'none',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <ChevronDown size={14} />
                  </button>
                </button>

                <AnimatePresence>
                  {expandedId === member.id && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div style={{
                        padding: '10px 12px',
                        background: 'var(--bg-surface)',
                        borderTop: '1px solid var(--council-border)',
                      }}>
                        <div style={{
                          fontSize: '0.625rem',
                          fontWeight: 600,
                          color: '#c9956b',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          marginBottom: '6px',
                        }}>
                          Member Models
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {member.member_models.map((model, i) => (
                            <div
                              key={i}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                fontSize: '0.6875rem',
                                color: 'var(--text-secondary)',
                                padding: '3px 0',
                              }}
                            >
                              <ModelAvatar modelId={model} size="xs" />
                              <span>{getModelDisplayName(model)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))
          )}
        </div>

        {/* Footer Actions */}
        <div style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          gap: '8px',
          background: 'var(--council-bg)',
        }}>
          <button
            onClick={onCreateNew}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '8px 12px',
              background: 'rgba(201, 149, 107, 0.15)',
              border: '1px solid var(--council-border)',
              borderRadius: 'var(--radius-sm)',
              color: '#c9956b',
              fontSize: '0.8125rem',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(201, 149, 107, 0.25)';
              e.currentTarget.style.borderColor = 'var(--council-border-strong)';
              e.currentTarget.style.boxShadow = '0 0 12px rgba(201, 149, 107, 0.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(201, 149, 107, 0.15)';
              e.currentTarget.style.borderColor = 'var(--council-border)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <Plus size={14} />
            New Council
          </button>
          <button
            onClick={onManageCouncils}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '8px 12px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: '0.8125rem',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--council-bg)';
              e.currentTarget.style.borderColor = 'var(--council-border)';
              e.currentTarget.style.color = '#c9956b';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--bg-base)';
              e.currentTarget.style.borderColor = 'var(--border)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <Settings size={14} />
            Manage
          </button>
        </div>
      </div>
    </motion.div>
  );
});