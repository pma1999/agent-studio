import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from './stores/store';
import { useChat } from './hooks/useChat';
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
    conversations,
    setSelectedAgentId,
    generalChatSettings,
    setOpenRouterApiKey,
    setSettingsOpen,
    setOpenRouterOAuthSuccess,
    setOpenRouterOAuthError,
  } = useStore();
  const { startGeneralChat, startNewChat } = useChat();

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
