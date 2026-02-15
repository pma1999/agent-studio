import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, MessageSquare, Wrench, Plug, Settings, ChevronLeft, ChevronRight, Coins, X, LogOut, Plus } from 'lucide-react';
import { useStore } from '../stores/store';
import { useChat } from '../hooks/useChat';
import { useIsMobile, usePrefersReducedMotion } from '../utils/breakpoints';
import { ConversationList } from './ConversationList';

const navItems = [
  { id: 'chat' as const, label: 'Chat', icon: MessageSquare },
  { id: 'agents' as const, label: 'Agents', icon: Bot },
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
  } = useStore();
  const { startGeneralChat } = useChat();
  const isMobile = useIsMobile();
  const prefersReducedMotion = usePrefersReducedMotion();
  const asideRef = useRef<HTMLElement>(null);
  const previousMobileOpenRef = useRef(sidebarMobileOpen);

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
        gap: 'var(--space-md)',
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

      {/* Navigation */}
      <div style={{
        padding: 'var(--space-md) var(--space-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-xs)',
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
              style={{ justifyContent: showExpanded ? 'flex-start' : 'center' }}
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

      {/* Conversations list (when expanded) */}
      {showExpanded && (
        <>
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.2, delay: prefersReducedMotion ? 0 : 0.08 }}
            style={{
              height: '1px',
              background: 'var(--border)',
              margin: 'var(--space-xs) var(--space-md)',
            }}
          />

          {/* New Chat Button */}
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.2, delay: prefersReducedMotion ? 0 : 0.1 }}
            style={{ padding: 'var(--space-sm) var(--space-md)' }}
          >
            <motion.button
              onClick={() => startGeneralChat()}
              whileHover={prefersReducedMotion ? undefined : { scale: 1.02 }}
              whileTap={prefersReducedMotion ? undefined : { scale: 0.98 }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--space-sm)',
                padding: 'var(--space-md) var(--space-md)',
                background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)',
                color: 'var(--text-inverse)',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: 'var(--shadow-accent-button)',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {!prefersReducedMotion && (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: '-100%',
                  width: '100%',
                  height: '100%',
                  background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
                  animation: 'shine 3s infinite',
                }} />
              )}
              <Plus size={18} />
              New Chat
            </motion.button>
          </motion.div>

          {/* Conversations */}
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.2, delay: prefersReducedMotion ? 0 : 0.14 }}
            style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 'var(--space-sm)',
            }}>
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
        {user && user.email !== 'local@localhost' && (
        <button
          type="button"
          onClick={() => logout()}
          className="sidebar-footer-btn"
          style={{ justifyContent: showExpanded ? 'flex-start' : 'center' }}
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
          style={{ justifyContent: showExpanded ? 'flex-start' : 'center' }}
          title={showExpanded ? undefined : 'Settings'}
          aria-label={showExpanded ? undefined : 'Settings'}
        >
          <Settings size={18} />
          {showExpanded && <span>Settings</span>}
        </button>

        <button
          type="button"
          onClick={() => isMobile ? setSidebarMobileOpen(false) : setSidebarCollapsed(!sidebarCollapsed)}
          className="sidebar-footer-btn"
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
