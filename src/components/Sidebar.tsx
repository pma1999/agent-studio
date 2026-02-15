import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, MessageSquare, Wrench, Plug, Settings, ChevronLeft, ChevronRight, Coins, X, LogOut, Plus } from 'lucide-react';
import { useStore } from '../stores/store';
import { useChat } from '../hooks/useChat';
import { useIsMobile } from '../utils/breakpoints';
import { ConversationList } from './ConversationList';

const navItems = [
  { id: 'chat' as const, label: 'Chat', icon: MessageSquare },
  { id: 'agents' as const, label: 'Agents', icon: Bot },
  { id: 'tools' as const, label: 'Tools', icon: Wrench },
  { id: 'mcp' as const, label: 'MCP', icon: Plug },
];

const TOUCH_MIN_HEIGHT = 44;

export function Sidebar() {
  const {
    user,
    logout,
    currentView,
    setCurrentView,
    setSettingsOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarMobileOpen,
    setSidebarMobileOpen,
    selectedAgentId,
    credits,
    openRouterApiKey,
    loadCredits,
    conversations,
    activeConversationId,
    setSelectedAgentId,
    setActiveConversationId,
    generalChatSettings,
  } = useStore();
  const { startGeneralChat } = useChat();
  const isMobile = useIsMobile();

  // Load credits on mount if OpenRouter key exists
  useEffect(() => {
    if (openRouterApiKey && !credits) {
      loadCredits();
    }
  }, [openRouterApiKey, credits, loadCredits]);

  // Close mobile drawer when view changes (e.g. after selecting conversation)
  useEffect(() => {
    if (isMobile) {
      setSidebarMobileOpen(false);
    }
  }, [currentView, isMobile, setSidebarMobileOpen]);

  const navClick = (view: 'agents' | 'chat' | 'tools' | 'mcp') => {
    setCurrentView(view);
    if (isMobile) setSidebarMobileOpen(false);
  };

  const drawerTransform = isMobile && !sidebarMobileOpen ? 'translateX(-100%)' : 'translateX(0)';
  const showExpanded = isMobile || !sidebarCollapsed;

  return (
    <>
      <AnimatePresence>
        {isMobile && sidebarMobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setSidebarMobileOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.5)',
              zIndex: 899,
              backdropFilter: 'blur(2px)',
            }}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>
      <motion.aside
        initial={false}
        animate={{
          width: isMobile ? undefined : (sidebarCollapsed ? 56 : 280),
          transform: drawerTransform,
        }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        style={{
          height: '100%',
          width: isMobile ? 'min(280px, 85vw)' : undefined,
          background: 'var(--bg-base)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flexShrink: 0,
          position: isMobile ? 'fixed' : 'relative',
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: isMobile ? 900 : undefined,
          transform: drawerTransform,
          ...(isMobile ? { boxShadow: 'var(--shadow-lg)' } : {}),
        }}
      >
      {/* Logo / Brand */}
      <div style={{
        padding: showExpanded ? '20px 20px' : '20px 12px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        minHeight: '65px',
      }}>
        <div style={{
          width: '32px',
          height: '32px',
          borderRadius: 'var(--radius-sm)',
          background: 'linear-gradient(135deg, var(--accent), var(--accent-hover))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <span style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.15rem',
            fontWeight: 700,
            color: 'var(--text-inverse)',
          }}>A</span>
        </div>
        {showExpanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.2rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
              whiteSpace: 'nowrap',
            }}>
              Agent Studio
            </div>
            <div style={{
              fontSize: '0.6875rem',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap',
            }}>
              personal workspace
            </div>
          </motion.div>
        )}
      </div>

      {/* Navigation */}
      <div style={{
        padding: '12px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}>
        {navItems.map((item) => {
          const isActive = currentView === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => navClick(item.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 12px',
                minHeight: TOUCH_MIN_HEIGHT,
                background: isActive ? 'var(--accent-muted)' : 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: '0.875rem',
                fontWeight: isActive ? 500 : 400,
                fontFamily: 'var(--font-body)',
                transition: 'all var(--transition-fast)',
                width: '100%',
                justifyContent: showExpanded ? 'flex-start' : 'center',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'var(--bg-hover)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--text-secondary)';
                }
              }}
              title={showExpanded ? undefined : item.label}
            >
              <Icon size={18} />
              {showExpanded && <span>{item.label}</span>}
            </button>
          );
        })}
      </div>

      {/* Conversations list (when expanded) */}
      {showExpanded && (
        <>
          <div style={{
            height: '1px',
            background: 'var(--border)',
            margin: '4px 12px',
          }} />

          {/* New Chat Button */}
          <div style={{ padding: '8px 12px' }}>
            <motion.button
              onClick={() => startGeneralChat()}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '12px 16px',
                background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(139, 92, 246, 0.4)',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {/* Shine effect */}
              <div style={{
                position: 'absolute',
                top: 0,
                left: '-100%',
                width: '100%',
                height: '100%',
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
                animation: 'shine 3s infinite',
              }} />
              <Plus size={18} />
              New Chat
            </motion.button>
          </div>

          {/* Conversations */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px 8px',
          }}>
            <ConversationList />
          </div>
        </>
      )}

      {/* Spacer when collapsed */}
      {!showExpanded && <div style={{ flex: 1 }} />}

      {/* Bottom actions */}
      <div style={{
        padding: '12px 8px',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}>
        {/* Credits indicator */}
        {credits && credits.limit_remaining !== null && showExpanded && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 12px',
              marginBottom: '4px',
              fontSize: '0.6875rem',
              fontFamily: 'var(--font-mono)',
              color: credits.limit_remaining > 5
                ? 'var(--text-muted)'
                : credits.limit_remaining > 1
                  ? '#f59e0b'
                  : 'var(--error)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
            }}
          >
            <Coins size={12} />
            <span>Credits: ${credits.limit_remaining.toFixed(2)}</span>
          </div>
        )}
        {credits && credits.limit_remaining !== null && !showExpanded && (
          <div
            title={`Credits: $${credits.limit_remaining.toFixed(2)}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '8px',
              marginBottom: '4px',
              color: credits.limit_remaining > 5
                ? 'var(--text-muted)'
                : credits.limit_remaining > 1
                  ? '#f59e0b'
                  : 'var(--error)',
            }}
          >
            <Coins size={16} />
          </div>
        )}

        {user && showExpanded && (
          <div style={{
            padding: '6px 12px',
            marginBottom: '4px',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }} title={user.email}>
            {user.email}
          </div>
        )}
        {user && user.email !== 'local@localhost' && (
        <button
          onClick={() => logout()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            minHeight: TOUCH_MIN_HEIGHT,
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            fontFamily: 'var(--font-body)',
            transition: 'all var(--transition-fast)',
            width: '100%',
            justifyContent: showExpanded ? 'flex-start' : 'center',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-hover)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-muted)';
          }}
          title={showExpanded ? undefined : 'Sign out'}
        >
          <LogOut size={18} />
          {showExpanded && <span>Sign out</span>}
        </button>
        )}
        <button
          onClick={() => setSettingsOpen(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            minHeight: TOUCH_MIN_HEIGHT,
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            fontFamily: 'var(--font-body)',
            transition: 'all var(--transition-fast)',
            width: '100%',
            justifyContent: showExpanded ? 'flex-start' : 'center',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-hover)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-muted)';
          }}
          title={showExpanded ? undefined : 'Settings'}
        >
          <Settings size={18} />
          {showExpanded && <span>Settings</span>}
        </button>

        <button
          onClick={() => isMobile ? setSidebarMobileOpen(false) : setSidebarCollapsed(!sidebarCollapsed)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            minHeight: TOUCH_MIN_HEIGHT,
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            fontFamily: 'var(--font-body)',
            transition: 'all var(--transition-fast)',
            width: '100%',
            justifyContent: showExpanded ? 'flex-start' : 'center',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-hover)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-muted)';
          }}
          title={isMobile ? 'Close' : (sidebarCollapsed ? 'Expand' : 'Collapse')}
        >
          {isMobile ? <X size={18} /> : (sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />)}
          {showExpanded && <span>{isMobile ? 'Close' : 'Collapse'}</span>}
        </button>
      </div>
    </motion.aside>
    </>
  );
}
