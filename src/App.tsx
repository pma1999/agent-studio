import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from './stores/store';
import { Layout } from './components/Layout';
import { AgentList } from './components/AgentList';
import { AgentEditor } from './components/AgentEditor';
import { ChatView } from './components/ChatView';
import { ToolsView } from './components/ToolsView';
import { McpView } from './components/McpView';
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
    setUser,
    checkAuth,
    currentView,
    loadAgents,
    loadConversations,
    loadSettings,
    loadCredits,
    setOpenRouterApiKey,
    setSettingsOpen,
    setOpenRouterOAuthSuccess,
    setOpenRouterOAuthError,
  } = useStore();

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
  }, [user, loadAgents, loadConversations, loadSettings]);

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

  if (!user) {
    return <AuthView />;
  }

  return (
    <Layout>
      <AnimatePresence mode="wait">
        {currentView === 'agents' && (
          <motion.div
            key="agents"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            style={{ height: '100%', overflow: 'hidden' }}
          >
            <AgentList />
          </motion.div>
        )}
        {currentView === 'tools' && (
          <motion.div
            key="tools"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            style={{ height: '100%', overflow: 'hidden' }}
          >
            <ToolsView />
          </motion.div>
        )}
        {currentView === 'mcp' && (
          <motion.div
            key="mcp"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            style={{ height: '100%', overflow: 'hidden' }}
          >
            <McpView />
          </motion.div>
        )}
        {currentView === 'chat' && (
          <motion.div
            key="chat"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            style={{ height: '100%', overflow: 'hidden' }}
          >
            <ChatView />
          </motion.div>
        )}
        {currentView === 'settings' && (
          <motion.div
            key="settings"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            style={{ height: '100%', overflow: 'hidden' }}
          >
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
              Settings are accessible via the sidebar gear icon
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modals */}
      <AgentEditor />
      <SettingsPanel />
    </Layout>
  );
}

export default App;
