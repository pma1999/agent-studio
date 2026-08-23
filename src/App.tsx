import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from './stores/store';
import { useChat } from './hooks/useChat';
import { conversationPath, parseClientPath } from './utils/url';
import { SharedConversationPage } from './components/share/SharedConversationPage';
import type { View } from './types';
import { Layout } from './components/Layout';
import { AgentList } from './components/AgentList';
import { AgentEditor } from './components/AgentEditor';
import { ChatView } from './components/ChatView';
import { ToolsView } from './components/ToolsView';
import { McpView } from './components/McpView';
import { SkillsView } from './components/SkillsView';
import { CouncilManager } from './components/CouncilManager';
import { CouncilEditor } from './components/CouncilEditor';
import { SettingsPanel } from './components/SettingsPanel';
import { AuthView } from './components/AuthView';
import { settingsApi, setOnUnauthorized } from './api/client';
import {
  PKCE_STORAGE_KEY,
  exchangeCodeForKey,
} from './utils/openrouterPkce';

const CONVERSATION_NOT_FOUND_NOTICE =
  'Conversation not found — it may have been deleted or is not shared with this account.';

/** Views restorable from history.state when returning to a `/` entry. */
const VIEWS: View[] = ['agents', 'chat', 'tools', 'mcp', 'skills', 'councils'];

function App() {
  const {
    user,
    userLoading,
    authRequired,
    setUser,
    checkAuth,
    currentView,
    loadAgents,
    loadConversations,
    loadSettings,
    loadCredits,
    loadGeneralChatSettings,
    activeConversationId,
    setCurrentView,
    setActiveConversationId,
    loadMessages,
    conversations,
    setSelectedAgentId,
    generalChatSettings,
    setOpenRouterApiKey,
    setSettingsOpen,
    setOpenRouterOAuthSuccess,
    setOpenRouterOAuthError,
  } = useStore();
  const { startGeneralChat, startNewChat } = useChat();

  // --- Deep links (T6): the store is the single source of truth; the URL is a
  // projection of it (writer effect below), and boot/popstate project URLs back
  // into the store. `/s/<token>` is rendered as full-screen share page.
  const [shareToken, setShareToken] = useState<string | null>(() => {
    const parsed = parseClientPath(window.location.pathname);
    return parsed.kind === 'share' ? parsed.token : null;
  });
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [urlSyncTick, setUrlSyncTick] = useState(0); // wakes the writer once boot resolves
  // Snapshot of the boot URL taken synchronously at first render — the central
  // writer's mount-time evaluation may normalize history before the async boot
  // resolver gets to read window.location.pathname.
  const initialPathRef = useRef(parseClientPath(window.location.pathname));
  const bootDoneRef = useRef(false); // writer stays passive until boot resolution finishes
  const conversationsLoadedRef = useRef(false);
  const popstateAppliedRef = useRef(false); // popstate won the race; boot must not re-apply
  const firstUrlEvalRef = useRef(true); // first writer evaluation replaces instead of pushing

  // Shared resolver for `/c/<id>` from boot restore AND popstate. Applies a
  // known id exactly like a sidebar click; degrades unknown ids to home plus an
  // informed notice. Awaits the conversation list before declaring "unknown".
  const applyChatDeepLink = useCallback(async (conversationId: string): Promise<void> => {
    if (!conversationsLoadedRef.current) await loadConversations();
    conversationsLoadedRef.current = true;
    const exists = useStore.getState().conversations.some((c) => c.id === conversationId);
    if (!exists) {
      window.history.replaceState(null, '', '/');
      setLinkNotice(CONVERSATION_NOT_FOUND_NOTICE);
      return;
    }
    setLinkNotice(null);
    setActiveConversationId(conversationId);
    setCurrentView('chat');
    void loadMessages(conversationId);
  }, [loadConversations, setActiveConversationId, setCurrentView, loadMessages]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    setOnUnauthorized(() => setUser(null));
    return () => setOnUnauthorized(null);
  }, [setUser]);

  useEffect(() => {
    if (!user) return;
    loadAgents();
    loadConversations();
    loadSettings();
    loadGeneralChatSettings();
  }, [user, loadAgents, loadConversations, loadSettings, loadGeneralChatSettings]);

  // Boot restore: apply the initial deep link once auth has resolved. The
  // conversation list is awaited before deciding an id is unknown (R-N3).
  // StrictMode-safe: idempotent via bootDoneRef re-checked after the await.
  useEffect(() => {
    if (userLoading || !user) return;
    if (bootDoneRef.current) return;
    if (initialPathRef.current.kind === 'share') {
      bootDoneRef.current = true; // share page owns everything; just arm the writer
      setUrlSyncTick((t) => t + 1);
      return;
    }
    let cancelled = false;
    (async () => {
      const parsed = initialPathRef.current;
      if (!popstateAppliedRef.current) {
        if (parsed.kind === 'chat') {
          await applyChatDeepLink(parsed.conversationId);
        } else if (window.location.pathname !== '/') {
          window.history.replaceState(null, '', '/'); // normalize non-link paths to home
        }
      }
      if (cancelled) return;
      conversationsLoadedRef.current = true;
      bootDoneRef.current = true;
      setUrlSyncTick((t) => t + 1); // writer may now take over the URL
    })();
    return () => {
      cancelled = true;
    };
  }, [user, userLoading, applyChatDeepLink]);

  // Central URL writer: projects store navigation state onto the address bar.
  // Passive (history entries only) — never touches streams or view mounting.
  useEffect(() => {
    if (shareToken !== null) return; // /s/<token> owns the URL bar
    if (!bootDoneRef.current) return; // boot resolution owns the URL until done
    const isFirstEval = firstUrlEvalRef.current;
    firstUrlEvalRef.current = false;
    const isChatPath = currentView === 'chat' && activeConversationId !== null;
    const desired = isChatPath ? conversationPath(activeConversationId) : '/';
    if (isChatPath) setLinkNotice(null); // any successful selection clears a stale notice
    if (window.location.pathname === desired) return;
    if (isFirstEval) window.history.replaceState(window.history.state, '', desired);
    else window.history.pushState({ view: currentView }, '', desired);
  }, [currentView, activeConversationId, shareToken, urlSyncTick]);

  // Back/forward: re-parse the location and swap rendering accordingly. Entries
  // the writer pushed carry `{ view }` in history.state so returning to a `/`
  // entry restores the tab it showed; entries without state fall back to home.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const parsed = parseClientPath(window.location.pathname);
      if (parsed.kind === 'share') {
        setShareToken(parsed.token);
        return;
      }
      popstateAppliedRef.current = true;
      setShareToken(null);
      if (!bootDoneRef.current) {
        bootDoneRef.current = true;
        setUrlSyncTick((t) => t + 1);
      }
      if (parsed.kind === 'chat') {
        void applyChatDeepLink(parsed.conversationId);
      } else {
        if (window.location.pathname !== '/') window.history.replaceState(event.state, '', '/');
        setLinkNotice(null);
        setActiveConversationId(null);
        const restored = (event.state as { view?: unknown } | null)?.view;
        setCurrentView(VIEWS.includes(restored as View) ? (restored as View) : 'chat');
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyChatDeepLink, setActiveConversationId, setCurrentView]);


  // Handle OAuth PKCE callback: ?code=...&state=... (state optional if provider doesn't echo it)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');

    if (!code) return;

    const storedRaw = sessionStorage.getItem(PKCE_STORAGE_KEY);
    if (!storedRaw) {
      clearOAuthParams();
      setOpenRouterOAuthError('Session expired or invalid. Please try connecting again.');
      setSettingsOpen(true);
      return;
    }

    let stored: { code_verifier: string; state: string };
    try {
      stored = JSON.parse(storedRaw) as { code_verifier: string; state: string };
    } catch {
      sessionStorage.removeItem(PKCE_STORAGE_KEY);
      clearOAuthParams();
      setOpenRouterOAuthError('Session expired or invalid. Please try connecting again.');
      setSettingsOpen(true);
      return;
    }

    if (state != null && stored.state !== state) {
      sessionStorage.removeItem(PKCE_STORAGE_KEY);
      clearOAuthParams();
      setOpenRouterOAuthError('Invalid state. Please try connecting again.');
      setSettingsOpen(true);
      return;
    }

    let mounted = true;

    (async () => {
      try {
        const { key } = await exchangeCodeForKey(code, stored.code_verifier);
        if (!mounted) return;

        sessionStorage.removeItem(PKCE_STORAGE_KEY);
        await settingsApi.set('openrouter_api_key', key);
        setOpenRouterApiKey(key);
        await loadSettings();
        await loadCredits();
        setOpenRouterOAuthSuccess(true);
        setOpenRouterOAuthError(null);
        clearOAuthParams();
        setSettingsOpen(true);
      } catch (err) {
        if (!mounted) return;
        sessionStorage.removeItem(PKCE_STORAGE_KEY);
        clearOAuthParams();
        setOpenRouterOAuthError(err instanceof Error ? err.message : 'Failed to connect. Please try again.');
        setSettingsOpen(true);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [setOpenRouterApiKey, setSettingsOpen, setOpenRouterOAuthSuccess, setOpenRouterOAuthError, loadSettings, loadCredits]);

  function clearOAuthParams() {
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    const clean = url.pathname + url.search + url.hash;
    window.history.replaceState(null, '', clean || '/');
  }

  // `/s/<token>` renders full screen BEFORE every auth gate so anonymous
  // viewers never hit the login wall.
  if (shareToken !== null) {
    return <SharedConversationPage token={shareToken} />;
  }

  if (userLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)' }}>
        <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-body)' }}>Loading…</div>
      </div>
    );
  }

  if (authRequired && !user) {
    return <AuthView />;
  }

  if (!authRequired && !user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-body)' }}>Could not load session.</div>
        <button
          type="button"
          onClick={() => checkAuth()}
          style={{
            padding: 'var(--space-sm) var(--space-md)',
            fontFamily: 'var(--font-body)',
            fontSize: '0.875rem',
            color: 'var(--accent)',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const viewMotion = {
    initial: { opacity: 0, x: -20 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: 20 },
    transition: { duration: 0.25, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] },
  };
  const viewStyle: React.CSSProperties = { height: '100%', overflow: 'hidden' };

  return (
    <Layout>
      {linkNotice && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 'var(--space-sm)',
            left: 'var(--space-md)',
            right: 'var(--space-md)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-md)',
            padding: 'var(--space-sm) var(--space-md)',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderLeft: '3px solid var(--accent)',
            borderRadius: 'var(--radius)',
          }}
        >
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-body)', fontSize: '0.85rem' }}>
            {linkNotice}
          </span>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setLinkNotice(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontFamily: 'var(--font-body)',
              fontSize: '1rem',
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      )}
      <AnimatePresence mode="wait">
        {currentView === 'agents' && (
          <motion.div key="agents" {...viewMotion} style={viewStyle}>
            <AgentList />
          </motion.div>
        )}
        {currentView === 'tools' && (
          <motion.div key="tools" {...viewMotion} style={viewStyle}>
            <ToolsView />
          </motion.div>
        )}
        {currentView === 'mcp' && (
          <motion.div key="mcp" {...viewMotion} style={viewStyle}>
            <McpView />
          </motion.div>
        )}
        {currentView === 'skills' && (
          <motion.div key="skills" {...viewMotion} style={viewStyle}>
            <SkillsView />
          </motion.div>
        )}
        {currentView === 'councils' && (
          <motion.div key="councils" {...viewMotion} style={viewStyle}>
            <CouncilManager />
          </motion.div>
        )}
        {currentView === 'chat' && (
          <motion.div key="chat" {...viewMotion} style={viewStyle}>
            <ChatView />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modals */}
      <AgentEditor />
      <CouncilEditor />
      <SettingsPanel />
    </Layout>
  );
}

export default App;
