import { create } from 'zustand';
import type {
  Agent,
  Conversation,
  Message,
  View,
  OpenRouterCredits,
  UsageStats,
  ReasoningConfig,
  ToolExecution,
  ToolSource,
  StreamingActivityEvent,
  GeneralChatSettings,
  ReasoningEffort,
  CouncilMember,
  CouncilConfig,
} from '../types';
import type { AuthUser } from '../api/client';
import { agentsApi, conversationsApi, messagesApi, settingsApi, creditsApi, usageApi, authApi } from '../api/client';

interface AppState {
  // Auth / session
  user: AuthUser | null;
  userLoading: boolean;
  authRequired: boolean;
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
  loadMessages: (conversationId: string, options?: { silent?: boolean }) => Promise<void>;
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

  // Per-conversation model override (null = use agent default)
  conversationModelOverrides: Record<string, string | null>;
  setConversationModelOverride: (conversationId: string, model: string | null) => void;
  getConversationModelOverride: (conversationId: string) => string | null;

  // Ordered live activity timeline (text/thinking/tool) for current streaming message
  streamingActivityEvents: StreamingActivityEvent[];
  appendStreamingContentEvent: (chunk: string) => void;
  appendStreamingReasoningEvent: (chunk: string) => void;
  upsertStreamingToolCall: (data: { id: string; name: string; arguments: string; source?: ToolSource }) => void;
  completeStreamingToolCall: (data: { id: string; name: string; ok: boolean; result?: string; duration_ms?: number; source?: ToolSource }) => void;
  resetStreamingActivityEvents: () => void;

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

  // General Chat Settings
  generalChatSettings: GeneralChatSettings | null;
  generalChatSettingsLoading: boolean;
  loadGeneralChatSettings: () => Promise<void>;
  saveGeneralChatSettings: (settings: GeneralChatSettings) => Promise<void>;

  // Council / Model Council
  councilEnabled: boolean;
  toggleCouncil: () => void;
  selectedCouncilId: string | null;
  setSelectedCouncilId: (id: string | null) => void;
  councilConfig: CouncilConfig | null;
  setCouncilConfig: (config: CouncilConfig | null) => void;
  councilMembers: CouncilMember[];
  councilMembersLoading: boolean;
  loadCouncilMembers: () => Promise<void>;
  councilIsExecuting: boolean;
  setCouncilIsExecuting: (executing: boolean) => void;
  councilMemberProgress: Map<
    number,
    { status: 'pending' | 'running' | 'complete' | 'error'; modelId: string; progress?: number }
  >;
  setCouncilMemberProgress: (
    progress: Map<number, { status: 'pending' | 'running' | 'complete' | 'error'; modelId: string; progress?: number }> |
    ((prev: Map<number, { status: 'pending' | 'running' | 'complete' | 'error'; modelId: string; progress?: number }>) =>
      Map<number, { status: 'pending' | 'running' | 'complete' | 'error'; modelId: string; progress?: number }>)
  ) => void;
  councilSynthesisPhase: boolean;
  setCouncilSynthesisPhase: (phase: boolean) => void;
  councilStreamingContent: string;
  setCouncilStreamingContent: (content: string | ((prev: string) => string)) => void;
  appendCouncilStreamingContent: (chunk: string) => void;
  resetCouncilState: () => void;

  // Council Editor
  councilEditorOpen: boolean;
  setCouncilEditorOpen: (open: boolean) => void;
  editingCouncil: CouncilMember | null;
  setEditingCouncil: (council: CouncilMember | null) => void;

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
  authRequired: true,
  setUser: (user) => set({ user }),
  checkAuth: async () => {
    set({ userLoading: true });
    try {
      const { authRequired } = await authApi.config();
      set({ authRequired });
      const user = await authApi.me();
      set({ user, userLoading: false });
    } catch {
      set((state) => ({ user: null, userLoading: false, authRequired: state.authRequired }));
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
  currentView: 'chat',
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
  loadMessages: async (conversationId: string, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      set({ messagesLoading: true });
    }
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

  // Per-conversation model override
  conversationModelOverrides: {},
  setConversationModelOverride: (conversationId, model) =>
    set((state) => ({
      conversationModelOverrides: {
        ...state.conversationModelOverrides,
        [conversationId]: model,
      },
    })),
  getConversationModelOverride: (conversationId) => {
    return get().conversationModelOverrides[conversationId] ?? null;
  },

  // Ordered streaming activity timeline (append by arrival order)
  streamingActivityEvents: [],
  appendStreamingContentEvent: (chunk) => set((state) => {
    if (!chunk) return {};
    const events = state.streamingActivityEvents;
    const last = events[events.length - 1];
    if (last && last.type === 'content') {
      const next = [...events];
      next[next.length - 1] = {
        ...last,
        content: last.content + chunk,
      };
      return { streamingActivityEvents: next };
    }
    return {
      streamingActivityEvents: [
        ...events,
        {
          id: `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'content',
          content: chunk,
        },
      ],
    };
  }),
  appendStreamingReasoningEvent: (chunk) => set((state) => {
    if (!chunk) return {};
    const events = state.streamingActivityEvents;
    const last = events[events.length - 1];
    if (last && last.type === 'reasoning') {
      const next = [...events];
      next[next.length - 1] = {
        ...last,
        content: last.content + chunk,
      };
      return { streamingActivityEvents: next };
    }
    return {
      streamingActivityEvents: [
        ...events,
        {
          id: `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'reasoning',
          content: chunk,
        },
      ],
    };
  }),
  upsertStreamingToolCall: (data) => set((state) => {
    const idx = state.streamingActivityEvents.findIndex(
      (ev) => ev.type === 'tool' && ev.tool.id === data.id
    );
    if (idx === -1) {
      return {
        streamingActivityEvents: [
          ...state.streamingActivityEvents,
          {
            id: `tool-${data.id}`,
            type: 'tool',
            tool: {
              id: data.id,
              name: data.name,
              arguments: data.arguments || '{}',
              status: 'running',
              source: data.source || 'unknown',
            },
          },
        ],
      };
    }

    const next = [...state.streamingActivityEvents];
    const prev = next[idx];
    if (prev.type !== 'tool') return {};
    next[idx] = {
      ...prev,
      tool: {
        ...prev.tool,
        name: data.name || prev.tool.name,
        arguments: data.arguments || prev.tool.arguments,
        status: 'running',
        source: data.source || prev.tool.source,
      },
    };
    return { streamingActivityEvents: next };
  }),
  completeStreamingToolCall: (data) => set((state) => {
    const idx = state.streamingActivityEvents.findIndex(
      (ev) => ev.type === 'tool' && ev.tool.id === data.id
    );
    if (idx === -1) {
      return {
        streamingActivityEvents: [
          ...state.streamingActivityEvents,
          {
            id: `tool-${data.id}`,
            type: 'tool',
            tool: {
              id: data.id,
              name: data.name,
              arguments: '{}',
              status: data.ok ? 'done' : 'error',
              ok: data.ok,
              result: data.result,
              duration_ms: data.duration_ms,
              source: data.source || 'unknown',
            },
          },
        ],
      };
    }

    const next = [...state.streamingActivityEvents];
    const prev = next[idx];
    if (prev.type !== 'tool') return {};
    next[idx] = {
      ...prev,
      tool: {
        ...prev.tool,
        name: data.name || prev.tool.name,
        status: data.ok ? 'done' : 'error',
        ok: data.ok,
        result: data.result,
        duration_ms: data.duration_ms,
        source: data.source || prev.tool.source,
      },
    };
    return { streamingActivityEvents: next };
  }),
  resetStreamingActivityEvents: () => set({ streamingActivityEvents: [] }),

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

  // General Chat Settings
  generalChatSettings: null,
  generalChatSettingsLoading: false,
  loadGeneralChatSettings: async () => {
    set({ generalChatSettingsLoading: true });
    try {
      const settings = await settingsApi.getAll();
      let tool_ids: string[] = [];
      try {
        const raw = settings['general_chat_tool_ids'];
        if (raw && typeof raw === 'string') {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) tool_ids = parsed.filter((id): id is string => typeof id === 'string');
        }
      } catch {
        // keep []
      }
      let mcp_server_ids: string[] = [];
      try {
        const raw = settings['general_chat_mcp_server_ids'];
        if (raw && typeof raw === 'string') {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) mcp_server_ids = parsed.filter((id): id is string => typeof id === 'string');
        }
      } catch {
        // keep []
      }
      const toolChoiceRaw = settings['general_chat_tool_choice'];
      const tool_choice = toolChoiceRaw === 'none' ? 'none' : 'auto';
      const parallelRaw = settings['general_chat_parallel_tool_calls'];
      const parallel_tool_calls = parallelRaw === '0' ? 0 : 1;

      const generalSettings: GeneralChatSettings = {
        model: settings['general_chat_model'] || 'openrouter/auto',
        system_prompt: settings['general_chat_system_prompt'] || 'You are a helpful AI assistant. You provide thoughtful, well-structured responses.',
        emoji: settings['general_chat_emoji'] || '💬',
        tool_ids,
        mcp_server_ids,
        tool_choice,
        parallel_tool_calls,
        reasoning_enabled: settings['general_chat_reasoning_enabled'] === 'true',
        reasoning_effort: (settings['general_chat_reasoning_effort'] as ReasoningEffort) || 'medium',
        reasoning_max_tokens: settings['general_chat_reasoning_max_tokens']
          ? parseInt(settings['general_chat_reasoning_max_tokens'], 10)
          : undefined,
      };
      set({ generalChatSettings: generalSettings, generalChatSettingsLoading: false });
    } catch (err) {
      console.error('Failed to load general chat settings:', err);
      set({ generalChatSettingsLoading: false });
    }
  },
  saveGeneralChatSettings: async (settings) => {
    try {
      await Promise.all([
        settingsApi.set('general_chat_model', settings.model),
        settingsApi.set('general_chat_system_prompt', settings.system_prompt),
        settingsApi.set('general_chat_emoji', settings.emoji || '💬'),
        settingsApi.set('general_chat_tool_ids', JSON.stringify(settings.tool_ids ?? [])),
        settingsApi.set('general_chat_mcp_server_ids', JSON.stringify(settings.mcp_server_ids ?? [])),
        settingsApi.set('general_chat_tool_choice', settings.tool_choice ?? 'auto'),
        settingsApi.set('general_chat_parallel_tool_calls', String(settings.parallel_tool_calls ?? 1)),
        settingsApi.set('general_chat_reasoning_enabled', String(settings.reasoning_enabled)),
        settingsApi.set('general_chat_reasoning_effort', settings.reasoning_effort || 'medium'),
        settingsApi.set('general_chat_reasoning_max_tokens', String(settings.reasoning_max_tokens || '')),
      ]);
      set({ generalChatSettings: settings });
    } catch (err) {
      console.error('Failed to save general chat settings:', err);
    }
  },

  // Council / Model Council
  councilEnabled: false,
  toggleCouncil: () => set((state) => ({ councilEnabled: !state.councilEnabled })),
  selectedCouncilId: null,
  setSelectedCouncilId: (id) => set({ selectedCouncilId: id }),
  councilConfig: null,
  setCouncilConfig: (config) => set({ councilConfig: config }),
  councilMembers: [],
  councilMembersLoading: false,
  loadCouncilMembers: async () => {
    set({ councilMembersLoading: true });
    try {
      const { getCouncilMembers } = await import('../api/councilClient.js');
      const members = await getCouncilMembers();
      set({ councilMembers: members, councilMembersLoading: false });
    } catch (err) {
      console.error('Failed to load council members:', err);
      set({ councilMembersLoading: false });
    }
  },
  councilIsExecuting: false,
  setCouncilIsExecuting: (executing) => set({ councilIsExecuting: executing }),
  councilMemberProgress: new Map(),
  setCouncilMemberProgress: (progress) => set((state) => ({
    councilMemberProgress: typeof progress === 'function'
      ? progress(state.councilMemberProgress)
      : progress
  })),
  councilSynthesisPhase: false,
  setCouncilSynthesisPhase: (phase) => set({ councilSynthesisPhase: phase }),
  councilStreamingContent: '',
  setCouncilStreamingContent: (content) => set((state) => ({
    councilStreamingContent: typeof content === 'function'
      ? (content as (prev: string) => string)(state.councilStreamingContent)
      : content
  })),
  appendCouncilStreamingContent: (chunk) => set((state) => ({
    councilStreamingContent: state.councilStreamingContent + chunk,
  })),
  resetCouncilState: () => set({
    councilEnabled: false,
    selectedCouncilId: null,
    councilConfig: null,
    councilIsExecuting: false,
    councilMemberProgress: new Map(),
    councilSynthesisPhase: false,
    councilStreamingContent: '',
  }),

  // Council Editor
  councilEditorOpen: false,
  setCouncilEditorOpen: (open) => set({ councilEditorOpen: open }),
  editingCouncil: null,
  setEditingCouncil: (council) => set({ editingCouncil: council }),

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
