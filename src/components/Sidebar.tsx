import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, MessageSquare, Wrench, Plug, Settings, ChevronLeft, ChevronRight, ChevronDown, Coins, X, LogOut, Plus, Users, Search } from 'lucide-react';
import { useStore } from '../stores/store';
import { useChat } from '../hooks/useChat';
import { useIsMobile, usePrefersReducedMotion } from '../utils/breakpoints';
import { ConversationList } from './ConversationList';
import { IconButton } from './ui/IconButton';

const navItems = [
  { id: 'chat' as const, label: 'Chat', icon: MessageSquare },
  { id: 'agents' as const, label: 'Agents', icon: Bot },
  { id: 'councils' as const, label: 'Councils', icon: Users },
  { id: 'tools' as const, label: 'Tools', icon: Wrench },
  { id: 'mcp' as const, label: 'MCP', icon: Plug },
];

const TOUCH_MIN_HEIGHT = 44;
const SIDEBAR_COLLAPSED_WIDTH = 56; // matches --sidebar-width-collapsed
const SIDEBAR_EXPANDED_WIDTH = 280; // matches --sidebar-width

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
    agents,
  } = useStore();
  const { startGeneralChat, startNewChat } = useChat();
  const isMobile = useIsMobile();
  const prefersReducedMotion = usePrefersReducedMotion();
  const asideRef = useRef<HTMLElement>(null);
  const previousMobileOpenRef = useRef(sidebarMobileOpen);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agentQuery, setAgentQuery] = useState('');
  const newChatRef = useRef<HTMLDivElement>(null);

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

  // Restore focus to open menu button when closing mobile drawer
  useEffect(() => {
    if (isMobile && previousMobileOpenRef.current && !sidebarMobileOpen) {
      document.getElementById('sidebar-open-menu-btn')?.focus();
    }
    previousMobileOpenRef.current = sidebarMobileOpen;
  }, [isMobile, sidebarMobileOpen]);

  // Lock body scroll when mobile drawer is open
  useEffect(() => {
    if (isMobile && sidebarMobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [isMobile, sidebarMobileOpen]);

  // Focus trap when mobile drawer is open
  useEffect(() => {
    if (!isMobile || !sidebarMobileOpen || !asideRef.current) return;
    const el = asideRef.current;
    const getFocusable = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((node) => node.getAttribute('aria-hidden') !== 'true');
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [isMobile, sidebarMobileOpen]);

  // Close the agent picker whenever the view changes
  useEffect(() => {
    setAgentPickerOpen(false);
  }, [currentView]);

  // Close the agent picker on outside click / Escape
  useEffect(() => {
    if (!agentPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (newChatRef.current && !newChatRef.current.contains(e.target as Node)) {
        setAgentPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAgentPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [agentPickerOpen]);

  const filteredAgents = agentQuery.trim()
    ? agents.filter((a) => a.name.toLowerCase().includes(agentQuery.trim().toLowerCase()))
    : agents;

  const navClick = (view: 'agents' | 'chat' | 'tools' | 'mcp' | 'councils') => {
    setCurrentView(view);
    if (isMobile) setSidebarMobileOpen(false);
  };

  const drawerTransform = isMobile && !sidebarMobileOpen ? 'translateX(-100%)' : 'translateX(0)';
  const showExpanded = isMobile || !sidebarCollapsed;
  const mobilePanelHeaderHeight = 64;

  return (
    <>
      <AnimatePresence>
        {isMobile && sidebarMobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
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
        ref={asideRef}
        role="navigation"
        aria-label="Main navigation"
        className={isMobile ? 'sidebar-drawer-mobile' : undefined}
        initial={false}
        animate={{
          width: isMobile ? undefined : (sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH),
          transform: drawerTransform,
        }}
        transition={{ duration: prefersReducedMotion ? 0 : 0.3, ease: [0.4, 0, 0.2, 1] }}
        style={{
          height: '100%',
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
          paddingLeft: 'env(safe-area-inset-left)',
          ...(isMobile ? { boxShadow: 'var(--shadow-lg)' } : {}),
        }}
      >
      {/* Logo / Brand */}
      <div style={{
        padding: showExpanded ? 'var(--space-lg) var(--space-lg)' : 'var(--space-lg) var(--space-md)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-md)',
        minHeight: isMobile ? `${mobilePanelHeaderHeight}px` : '65px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', minWidth: 0 }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--accent)',
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
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.2, delay: prefersReducedMotion ? 0 : 0.05 }}
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
        {isMobile && (
          <button
            type="button"
            onClick={() => setSidebarMobileOpen(false)}
            className="sidebar-footer-btn"
            style={{ width: 40, minHeight: 40, justifyContent: 'center', flexShrink: 0 }}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Navigation */}
      <div style={{
        padding: isMobile ? 'var(--space-sm) var(--space-sm)' : 'var(--space-md) var(--space-sm)',
        display: 'flex',
        flexDirection: isMobile ? 'row' : 'column',
        overflowX: isMobile ? 'auto' : 'hidden',
        scrollbarWidth: 'none',
        gap: 'var(--space-xs)',
        borderBottom: isMobile ? '1px solid var(--border)' : undefined,
      }}>
        {navItems.map((item, index) => {
          const isActive = currentView === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => navClick(item.id)}
              className={`sidebar-nav-btn ${isActive ? 'sidebar-nav-btn-active' : ''}`}
              style={{
                justifyContent: showExpanded ? 'flex-start' : 'center',
                width: isMobile ? 'auto' : '100%',
                padding: isMobile ? '10px 14px' : undefined,
                flexShrink: 0,
              }}
              title={showExpanded ? undefined : item.label}
              aria-label={showExpanded ? undefined : item.label}
            >
              <Icon size={18} />
              {showExpanded && (
                <motion.span
                  initial={prefersReducedMotion ? false : { opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: prefersReducedMotion ? 0 : 0.2, delay: prefersReducedMotion ? 0 : index * 0.03 }}
                >
                  {item.label}
                </motion.span>
              )}
            </button>
          );
        })}
      </div>

      {/* New chat (collapsed rail) */}
      {!showExpanded && (
        <div style={{ padding: 'var(--space-sm)', display: 'flex', justifyContent: 'center' }}>
          <IconButton
            label="New chat"
            size="lg"
            variant="primary"
            onClick={() => startGeneralChat()}
          >
            <Plus size={18} />
          </IconButton>
        </div>
      )}

      {/* Conversations list (when expanded) */}
      {showExpanded && (
        <>
          {/* New chat — split button (general chat + agent picker) */}
          <motion.div
            ref={newChatRef}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.2, delay: prefersReducedMotion ? 0 : 0.1 }}
            style={{
              padding: isMobile ? 'var(--space-md) var(--space-md) var(--space-sm)' : 'var(--space-sm) var(--space-md)',
              position: 'relative',
            }}
          >
            <div className="new-chat-split">
              <button
                type="button"
                className="new-chat-main"
                onClick={() => {
                  setAgentPickerOpen(false);
                  startGeneralChat();
                }}
              >
                <Plus size={18} />
                New chat
              </button>
              <button
                type="button"
                className="new-chat-caret"
                aria-haspopup="menu"
                aria-expanded={agentPickerOpen}
                aria-label="Start a chat with an agent"
                onClick={() => setAgentPickerOpen((o) => !o)}
              >
                <ChevronDown size={16} />
              </button>
            </div>

            <AnimatePresence>
              {agentPickerOpen && (
                <motion.div
                  className="agent-picker"
                  role="menu"
                  initial={prefersReducedMotion ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  transition={{ duration: prefersReducedMotion ? 0 : 0.16 }}
                >
                  <div className="agent-picker-search">
                    <Search size={14} />
                    <input
                      type="text"
                      value={agentQuery}
                      onChange={(e) => setAgentQuery(e.target.value)}
                      placeholder="Search agents…"
                      aria-label="Search agents"
                      autoFocus
                    />
                  </div>
                  <div className="agent-picker-list">
                    {filteredAgents.length === 0 ? (
                      <div className="agent-picker-empty">
                        {agents.length === 0 ? 'No agents yet' : 'No agents match'}
                      </div>
                    ) : (
                      filteredAgents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          role="menuitem"
                          className="menu-item"
                          onClick={() => {
                            startNewChat(a.id);
                            setAgentPickerOpen(false);
                            setAgentQuery('');
                            if (isMobile) setSidebarMobileOpen(false);
                          }}
                        >
                          <span className="agent-emoji">{a.emoji || '🤖'}</span>
                          <span className="truncate">{a.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item agent-picker-manage"
                    onClick={() => {
                      setCurrentView('agents');
                      setAgentPickerOpen(false);
                      if (isMobile) setSidebarMobileOpen(false);
                    }}
                  >
                    <Bot size={15} />
                    Manage agents
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* Conversations */}
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.2, delay: prefersReducedMotion ? 0 : 0.14 }}
            style={{
            borderTop: '1px solid var(--border)',
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: isMobile ? 'var(--space-md) var(--space-sm) var(--space-sm)' : 'var(--space-sm)',
            }}>
            {isMobile && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 'var(--space-sm)',
                padding: '0 var(--space-sm)',
              }}>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.68rem',
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--accent-hover)',
                }}>
                  Recent activity
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  {conversations.length} chats
                </span>
              </div>
            )}
            <ConversationList />
          </motion.div>
        </>
      )}

      {/* Spacer when collapsed */}
      {!showExpanded && <div style={{ flex: 1 }} />}

      {/* Bottom actions */}
      <div style={{
        padding: 'var(--space-md) var(--space-sm)',
        paddingBottom: 'calc(var(--space-md) + env(safe-area-inset-bottom))',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-xs)',
        background: isMobile ? 'rgba(12,12,12,0.85)' : undefined,
        backdropFilter: isMobile ? 'blur(8px)' : undefined,
      }}>
        {/* Credits indicator */}
        {credits && credits.limit_remaining !== null && showExpanded && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: 'var(--space-sm) var(--space-md)',
              marginBottom: 'var(--space-xs)',
              fontSize: '0.6875rem',
              fontFamily: 'var(--font-mono)',
              color: credits.limit_remaining > 5
                ? 'var(--text-muted)'
                : credits.limit_remaining > 1
                  ? 'var(--warning)'
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
              padding: 'var(--space-sm)',
              marginBottom: 'var(--space-xs)',
              minHeight: TOUCH_MIN_HEIGHT,
              minWidth: TOUCH_MIN_HEIGHT,
              color: credits.limit_remaining > 5
                ? 'var(--text-muted)'
                : credits.limit_remaining > 1
                  ? 'var(--warning)'
                  : 'var(--error)',
            }}
          >
            <Coins size={16} />
          </div>
        )}

        {user && showExpanded && (
          <div style={{
            padding: 'var(--space-sm) var(--space-md)',
            marginBottom: 'var(--space-xs)',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }} title={user.email}>
            {user.email}
          </div>
        )}
        <div style={{ display: 'flex', gap: 'var(--space-xs)', flexDirection: isMobile ? 'row' : 'column' }}>
          {user && user.email !== 'local@localhost' && (
            <button
              type="button"
              onClick={() => logout()}
              className="sidebar-footer-btn"
              style={{ justifyContent: showExpanded ? 'flex-start' : 'center', flex: isMobile ? 1 : undefined }}
              title={showExpanded ? undefined : 'Sign out'}
              aria-label={showExpanded ? undefined : 'Sign out'}
            >
              <LogOut size={18} />
              {showExpanded && <span>Sign out</span>}
            </button>
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="sidebar-footer-btn"
            style={{ justifyContent: showExpanded ? 'flex-start' : 'center', flex: isMobile ? 1 : undefined }}
            title={showExpanded ? undefined : 'Settings'}
            aria-label={showExpanded ? undefined : 'Settings'}
          >
            <Settings size={18} />
            {showExpanded && <span>Settings</span>}
          </button>
        </div>

        <button
          type="button"
          onClick={() => isMobile ? setSidebarMobileOpen(false) : setSidebarCollapsed(!sidebarCollapsed)}
          className="sidebar-footer-btn"
          hidden={isMobile}
          style={{ justifyContent: showExpanded ? 'flex-start' : 'center' }}
          title={isMobile ? 'Close' : (sidebarCollapsed ? 'Expand' : 'Collapse')}
          aria-expanded={isMobile ? sidebarMobileOpen : !sidebarCollapsed}
          aria-label={isMobile ? 'Close menu' : (sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar')}
        >
          {isMobile ? <X size={18} /> : (sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />)}
          {showExpanded && <span>{isMobile ? 'Close' : 'Collapse'}</span>}
        </button>
      </div>
    </motion.aside>
    </>
  );
}
