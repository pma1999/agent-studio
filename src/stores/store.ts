import { create } from 'zustand';
import type { Agent, Conversation, Message, View, OpenRouterCredits, UsageStats, ReasoningConfig } from '../types';
import type { AuthUser } from '../api/client';
import { agentsApi, conversationsApi, messagesApi, settingsApi, creditsApi, usageApi, authApi } from '../api/client';

interface AppState {
  // Auth / session
  user: AuthUser | null;
  userLoading: boolean;
  setUser: (user: AuthUser | null) => void;
  checkAuth: () => Promise<void>;
  logout: () => Promise<void>;

  // View
  currentView: View;
  setCurrentView: (view: View) => void;

  // Agents
  agents: Agent[];
  agentsLoading: boolean;
  loadAgents: () => Promise<void>;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;

  // Conversations
  conversations: Conversation[];
  conversationsLoading: boolean;
  loadConversations: (agentId?: string) => Promise<void>;
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;

  // Messages
  messages: Message[];
  messagesLoading: boolean;
  loadMessages: (conversationId: string) => Promise<void>;
  addMessage: (message: Message) => void;
  updateLastAssistantMessage: (content: string) => void;

  // Chat state
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
  streamingContent: string;
  setStreamingContent: (content: string) => void;
  appendStreamingContent: (chunk: string) => void;

  // Stream cancellation
  abortController: AbortController | null;
  setAbortController: (controller: AbortController | null) => void;

  // Streaming performance (for token speed display)
  streamStartTime: number | null;
  setStreamStartTime: (t: number | null) => void;

  // Reasoning / Thinking
  reasoningContent: string;
  setReasoningContent: (content: string) => void;
  appendReasoningContent: (chunk: string) => void;

  // Per-message reasoning override (null = use agent defaults)
  reasoningOverride: ReasoningConfig | null;
  setReasoningOverride: (config: ReasoningConfig | null) => void;

  // Current tool call during streaming (e.g. { name: 'web_search' })
  streamingToolCall: { name: string } | null;
  setStreamingToolCall: (v: { name: string } | null) => void;

  // Settings
  openRouterApiKey: string;
  setOpenRouterApiKey: (key: string) => void;
  loadSettings: () => Promise<void>;

  // OAuth PKCE callback feedback
  openRouterOAuthSuccess: boolean;
  setOpenRouterOAuthSuccess: (v: boolean) => void;
  openRouterOAuthError: string | null;
  setOpenRouterOAuthError: (v: string | null) => void;

  // Credits (OpenRouter)
  credits: OpenRouterCredits | null;
  creditsLoading: boolean;
  loadCredits: () => Promise<void>;

  // Usage stats
  usageStats: UsageStats | null;
  usageStatsLoading: boolean;
  loadUsageStats: () => Promise<void>;

  // UI
  agentEditorOpen: boolean;
  setAgentEditorOpen: (open: boolean) => void;
  editingAgent: Agent | null;
  setEditingAgent: (agent: Agent | null) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  sidebarMobileOpen: boolean;
  setSidebarMobileOpen: (open: boolean) => void;
}

export const useStore = create<AppState>((set, get) => ({
  // Auth
  user: null,
  userLoading: true,
  setUser: (user) => set({ user }),
  checkAuth: async () => {
    set({ userLoading: true });
    try {
      const user = await authApi.me();
      set({ user, userLoading: false });
    } catch {
      set({ user: null, userLoading: false });
    }
  },
  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      /* ignore */
    }
    set({ user: null });
  },

  // View
  currentView: 'agents',
  setCurrentView: (view) => set({ currentView: view }),

  // Agents
  agents: [],
  agentsLoading: false,
  loadAgents: async () => {
    set({ agentsLoading: true });
    try {
      const agents = await agentsApi.list();
      set({ agents, agentsLoading: false });
    } catch (err) {
      console.error('Failed to load agents:', err);
      set({ agentsLoading: false });
    }
  },
  selectedAgentId: null,
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),

  // Conversations
  conversations: [],
  conversationsLoading: false,
  loadConversations: async (agentId?: string) => {
    set({ conversationsLoading: true });
    try {
      const conversations = await conversationsApi.list(agentId);
      set({ conversations, conversationsLoading: false });
    } catch (err) {
      console.error('Failed to load conversations:', err);
      set({ conversationsLoading: false });
    }
  },
  activeConversationId: null,
  setActiveConversationId: (id) => set({ activeConversationId: id }),

  // Messages
  messages: [],
  messagesLoading: false,
  loadMessages: async (conversationId: string) => {
    set({ messagesLoading: true });
    try {
      const messages = await messagesApi.list(conversationId);
      set({ messages, messagesLoading: false });
    } catch (err) {
      console.error('Failed to load messages:', err);
      set({ messagesLoading: false });
    }
  },
  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message],
  })),
  updateLastAssistantMessage: (content) => set((state) => {
    const messages = [...state.messages];
    const lastIdx = messages.length - 1;
    if (lastIdx >= 0 && messages[lastIdx].role === 'assistant') {
      messages[lastIdx] = { ...messages[lastIdx], content };
    }
    return { messages };
  }),

  // Chat state
  isStreaming: false,
  setIsStreaming: (v) => set({ isStreaming: v }),
  streamingContent: '',
  setStreamingContent: (content) => set({ streamingContent: content }),
  appendStreamingContent: (chunk) => set((state) => ({
    streamingContent: state.streamingContent + chunk,
  })),

  // Stream cancellation
  abortController: null,
  setAbortController: (controller) => set({ abortController: controller }),

  streamStartTime: null,
  setStreamStartTime: (t) => set({ streamStartTime: t }),

  // Reasoning / Thinking
  reasoningContent: '',
  setReasoningContent: (content) => set({ reasoningContent: content }),
  appendReasoningContent: (chunk) => set((state) => ({
    reasoningContent: state.reasoningContent + chunk,
  })),

  // Per-message reasoning override
  reasoningOverride: null,
  setReasoningOverride: (config) => set({ reasoningOverride: config }),

  // Streaming tool call indicator
  streamingToolCall: null,
  setStreamingToolCall: (v) => set({ streamingToolCall: v }),

  // Settings
  openRouterApiKey: '',
  setOpenRouterApiKey: (key) => set({ openRouterApiKey: key }),
  loadSettings: async () => {
    try {
      const data = await settingsApi.getAll();
      set({ openRouterApiKey: data.openrouter_api_key ?? '' });
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  },

  openRouterOAuthSuccess: false,
  setOpenRouterOAuthSuccess: (v) => set({ openRouterOAuthSuccess: v }),
  openRouterOAuthError: null,
  setOpenRouterOAuthError: (v) => set({ openRouterOAuthError: v }),

  // Credits
  credits: null,
  creditsLoading: false,
  loadCredits: async () => {
    set({ creditsLoading: true });
    try {
      const result = await creditsApi.get();
      set({ credits: result.data, creditsLoading: false });
    } catch (err) {
      console.error('Failed to load credits:', err);
      set({ creditsLoading: false });
    }
  },

  // Usage stats
  usageStats: null,
  usageStatsLoading: false,
  loadUsageStats: async () => {
    set({ usageStatsLoading: true });
    try {
      const stats = await usageApi.stats();
      set({ usageStats: stats, usageStatsLoading: false });
    } catch (err) {
      console.error('Failed to load usage stats:', err);
      set({ usageStatsLoading: false });
    }
  },

  // UI
  agentEditorOpen: false,
  setAgentEditorOpen: (open) => set({ agentEditorOpen: open }),
  editingAgent: null,
  setEditingAgent: (agent) => set({ editingAgent: agent }),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  sidebarMobileOpen: false,
  setSidebarMobileOpen: (open) => set({ sidebarMobileOpen: open }),
}));
