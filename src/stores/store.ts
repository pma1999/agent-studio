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
  ConversationStreamState,
  GeneralChatSettings,
  ReasoningEffort,
  CouncilMember,
  CouncilConfig,
  ProviderRoutingConfig,
  ConversationToolConfigOverride,
  ConversationSkillConfigOverride,
  ChatArtifact,
} from '../types';
import type { AuthUser } from '../api/client';
import { agentsApi, conversationsApi, messagesApi, settingsApi, creditsApi, usageApi, authApi, type MessagesListResponse } from '../api/client';

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
  updateConversationTitle: (conversationId: string, title: string) => void;

  // Messages
  messages: Message[];
  messagesLoading: boolean;
  /** Resolves with the fetched payload (so callers can read additive fields the
   *  store does not retain, e.g. active_turn_id) or undefined when the fetch
   *  failed or was dropped by the stale-conversation guard. */
  loadMessages: (conversationId: string, options?: { silent?: boolean }) => Promise<MessagesListResponse | undefined>;
  addMessage: (message: Message) => void;
  updateLastAssistantMessage: (content: string) => void;
  /** Id of the visible thread's leaf message for the active conversation (null when no tree data). */
  activeLeafId: string | null;
  setActiveLeaf: (messageId: string | null) => void;

  // Chat state — per-conversation live streams (see ConversationStreamState).
  // A conversation is "streaming" iff streamsByConversation[conversationId] exists;
  // entries are created by beginStream and deleted by endStream.
  streamsByConversation: Record<string, ConversationStreamState>;
  beginStream: (conversationId: string) => void;
  endStream: (conversationId: string) => void;
  appendStreamContent: (conversationId: string, chunk: string) => void;
  appendStreamReasoning: (conversationId: string, chunk: string) => void;
  setStreamAbortController: (conversationId: string, controller: AbortController | null) => void;

  // Ordered live activity timeline events, keyed per conversation.
  appendStreamContentEvent: (conversationId: string, chunk: string) => void;
  appendStreamReasoningEvent: (conversationId: string, chunk: string) => void;
  upsertStreamToolCall: (conversationId: string, data: { id: string; name: string; arguments: string; source?: ToolSource }) => void;
  completeStreamToolCall: (conversationId: string, data: { id: string; name: string; ok: boolean; result?: string; duration_ms?: number; source?: ToolSource; metadata?: Record<string, unknown> }) => void;
  appendStreamToolOutputChunk: (conversationId: string, data: { id: string; stream: 'stdout' | 'stderr'; text: string; seq: number }) => void;
  resetStreamActivity: (conversationId: string) => void;

  // Per-message reasoning override (null = use agent defaults)
  reasoningOverride: ReasoningConfig | null;
  setReasoningOverride: (config: ReasoningConfig | null) => void;

  // Per-conversation model override (null = use agent default)
  conversationModelOverrides: Record<string, string | null>;
  setConversationModelOverride: (conversationId: string, model: string | null) => void;
  getConversationModelOverride: (conversationId: string) => string | null;
  conversationProviderRoutingOverrides: Record<string, ProviderRoutingConfig | null>;
  setConversationProviderRoutingOverride: (conversationId: string, providerRouting: ProviderRoutingConfig | null) => void;
  getConversationProviderRoutingOverride: (conversationId: string) => ProviderRoutingConfig | null;

  // Per-conversation tool/MCP config override (undefined = no override, use agent/general-chat defaults)
  conversationToolConfigOverrides: Record<string, ConversationToolConfigOverride | undefined>;
  setConversationToolConfigOverride: (conversationId: string, config: ConversationToolConfigOverride | undefined) => void;
  getConversationToolConfigOverride: (conversationId: string) => ConversationToolConfigOverride | undefined;

  // Per-conversation skill config override (undefined = no override, use agent/general-chat defaults)
  conversationSkillConfigOverrides: Record<string, ConversationSkillConfigOverride | undefined>;
  setConversationSkillConfigOverride: (conversationId: string, config: ConversationSkillConfigOverride | undefined) => void;
  getConversationSkillConfigOverride: (conversationId: string) => ConversationSkillConfigOverride | undefined;

  // Ordered live activity timeline (text/thinking/tool) for current streaming message
  // (now per conversation — see streamsByConversation above)

  // Artifacts — per-conversation sidecar content
  artifactsByConversation: Record<string, Record<string, ChatArtifact>>;
  activeArtifactId: string | null;
  artifactPanelOpen: boolean;
  upsertConversationArtifact(conversationId: string, artifact: ChatArtifact): void;
  hydrateConversationArtifacts(conversationId: string, artifacts: ChatArtifact[]): void;
  setActiveArtifact(conversationId: string | null, artifactId: string | null): void;
  closeArtifactPanel(): void;
  clearConversationArtifacts(conversationId: string): void;

  // Settings
  openRouterApiKey: string;
  setOpenRouterApiKey: (key: string) => void;
  autoConversationTitlesEnabled: boolean;
  setAutoConversationTitlesEnabled: (enabled: boolean) => void;
  deepSeekApiKey: string;
  setDeepSeekApiKey: (key: string) => void;
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
  /** True while the chat composer is focused (used to hide mobile bottom nav). */
  composerFocused: boolean;
  setComposerFocused: (focused: boolean) => void;
  artifactGalleryOpen: boolean;
  setArtifactGalleryOpen: (open: boolean) => void;
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
  loadConversations: async (_agentId?: string) => {
    set({ conversationsLoading: true });
    try {
      // Always load the FULL conversation list. The redesigned sidebar shows a
      // single unified, agent-labeled "Recents" list; scoping/recovery is done
      // client-side via search. The agentId param is kept for signature
      // compatibility with existing callers but no longer filters the fetch.
      const conversations = await conversationsApi.list();
      set({ conversations, conversationsLoading: false });
    } catch (err) {
      console.error('Failed to load conversations:', err);
      set({ conversationsLoading: false });
    }
  },
  activeConversationId: null,
  setActiveConversationId: (id) => set((state) => {
    if (id === state.activeConversationId) return state;
    // When switching conversations, seed the active leaf from the selected
    // conversation (the list already carries active_leaf_id), else reset.
    const conversation = id ? state.conversations.find((c) => c.id === id) : undefined;
    return {
      activeConversationId: id,
      activeLeafId: conversation?.active_leaf_id ?? null,
    };
  }),
  updateConversationTitle: (conversationId, title) => set((state) => ({
    conversations: state.conversations.map((conversation) =>
      conversation.id === conversationId
        ? { ...conversation, title }
        : conversation
    ),
  })),

  // Messages
  messages: [],
  messagesLoading: false,
  loadMessages: async (conversationId: string, options?: { silent?: boolean }): Promise<MessagesListResponse | undefined> => {
    if (!options?.silent) {
      set({ messagesLoading: true });
    }
    try {
      const payload = await messagesApi.list(conversationId);
      const { messages, active_leaf_id } = payload;
      // Stale-fetch guard: with parallel per-conversation streams allowed, a
      // background completion can finish while another conversation is being
      // viewed; applying its fetch here would clobber the visible thread.
      if (get().activeConversationId !== conversationId) {
        set({ messagesLoading: false });
        return undefined;
      }
      let finalMessages = messages;
      let finalLeafId: string | null = active_leaf_id ?? null;
      // A stream is live for this conversation: keep a temp assistant placeholder
      // at the thread tail so in-flight text stays attached across conversation
      // switches (the server has no draft row to show until T3 lands).
      if (get().streamsByConversation[conversationId]) {
        const lastFetched = messages[messages.length - 1];
        const serverDraftLive = lastFetched?.role === 'assistant' && lastFetched.generation_status === 'streaming';
        const hasLivePlaceholder = messages.some((m) => m.role === 'assistant' && m.id.startsWith('temp-'));
        if (!serverDraftLive && !hasLivePlaceholder) {
          const leafId = finalLeafId ?? lastFetched?.id ?? null;
          const livePlaceholder: Message = {
            id: `temp-live-${conversationId}`,
            conversation_id: conversationId,
            role: 'assistant',
            content: '',
            parent_id: leafId,
            created_at: new Date().toISOString(),
          };
          finalMessages = [...messages, livePlaceholder];
          finalLeafId = livePlaceholder.id;
        }
      }
      set({ messages: finalMessages, activeLeafId: finalLeafId, messagesLoading: false });
      return payload;
    } catch (err) {
      console.error('Failed to load messages:', err);
      set({ messagesLoading: false });
      return undefined;
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
  activeLeafId: null,
  setActiveLeaf: (messageId) => {
    set({ activeLeafId: messageId });
    // Persist the cursor only for real (non-null) targets; null is a local reset and
    // temp-* ids are optimistic placeholders the server doesn't know yet (the chat
    // POST itself sets the server-side cursor) — sending them would 404 and trigger
    // a mid-stream reload that wipes the temp messages from the UI.
    const isTempId = typeof messageId === 'string' && messageId.startsWith('temp-');
    if (messageId !== null && !isTempId) {
      const conversationId = get().activeConversationId;
      if (conversationId) {
        conversationsApi.setActiveLeaf(conversationId, messageId).catch((err) => {
          console.error('Failed to set active leaf:', err);
          // Resync from the server so the local tree matches reality.
          const currentId = get().activeConversationId;
          if (currentId) {
            get().loadMessages(currentId, { silent: true });
          }
        });
      }
    }
  },

  // Chat state — per-conversation live streams
  streamsByConversation: {},
  beginStream: (conversationId) => set((state) => ({
    streamsByConversation: {
      ...state.streamsByConversation,
      [conversationId]: {
        content: '',
        reasoning: '',
        activityEvents: [],
        startTime: Date.now(),
        abortController: null,
      },
    },
  })),
  endStream: (conversationId) => set((state) => {
    if (!(conversationId in state.streamsByConversation)) return {};
    const next = { ...state.streamsByConversation };
    delete next[conversationId];
    return { streamsByConversation: next };
  }),
  appendStreamContent: (conversationId, chunk) => set((state) => {
    const entry = state.streamsByConversation[conversationId];
    if (!entry || !chunk) return {};
    return {
      streamsByConversation: {
        ...state.streamsByConversation,
        [conversationId]: { ...entry, content: entry.content + chunk },
      },
    };
  }),
  appendStreamReasoning: (conversationId, chunk) => set((state) => {
    const entry = state.streamsByConversation[conversationId];
    if (!entry || !chunk) return {};
    return {
      streamsByConversation: {
        ...state.streamsByConversation,
        [conversationId]: { ...entry, reasoning: entry.reasoning + chunk },
      },
    };
  }),
  setStreamAbortController: (conversationId, controller) => set((state) => {
    const entry = state.streamsByConversation[conversationId];
    if (!entry) return {};
    return {
      streamsByConversation: {
        ...state.streamsByConversation,
        [conversationId]: { ...entry, abortController: controller },
      },
    };
  }),

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
  conversationProviderRoutingOverrides: {},
  setConversationProviderRoutingOverride: (conversationId, providerRouting) =>
    set((state) => ({
      conversationProviderRoutingOverrides: {
        ...state.conversationProviderRoutingOverrides,
        [conversationId]: providerRouting,
      },
    })),
  getConversationProviderRoutingOverride: (conversationId) => {
    return get().conversationProviderRoutingOverrides[conversationId] ?? null;
  },

  // Per-conversation tool/MCP config override
  conversationToolConfigOverrides: {},
  setConversationToolConfigOverride: (conversationId, config) =>
    set((state) => ({
      conversationToolConfigOverrides: {
        ...state.conversationToolConfigOverrides,
        [conversationId]: config,
      },
    })),
  getConversationToolConfigOverride: (conversationId) => {
    return get().conversationToolConfigOverrides[conversationId];
  },

  // Per-conversation skill config override
  conversationSkillConfigOverrides: {},
  setConversationSkillConfigOverride: (conversationId, config) =>
    set((state) => ({
      conversationSkillConfigOverrides: {
        ...state.conversationSkillConfigOverrides,
        [conversationId]: config,
      },
    })),
  getConversationSkillConfigOverride: (conversationId) => {
    return get().conversationSkillConfigOverrides[conversationId];
  },

  // Ordered streaming activity timeline (append by arrival order), per conversation
  appendStreamContentEvent: (conversationId, chunk) => set((state) => {
    const entry = state.streamsByConversation[conversationId];
    if (!entry || !chunk) return {};
    const events = entry.activityEvents;
    const last = events[events.length - 1];
    if (last && last.type === 'content') {
      const next = [...events];
      next[next.length - 1] = {
        ...last,
        content: last.content + chunk,
      };
      return {
        streamsByConversation: {
          ...state.streamsByConversation,
          [conversationId]: { ...entry, activityEvents: next },
        },
      };
    }
    return {
      streamsByConversation: {
        ...state.streamsByConversation,
        [conversationId]: {
          ...entry,
          activityEvents: [
            ...events,
            {
              id: `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'content',
              content: chunk,
            },
          ],
        },
      },
    };
  }),
  appendStreamReasoningEvent: (conversationId, chunk) => set((state) => {
    const entry = state.streamsByConversation[conversationId];
    if (!entry || !chunk) return {};
    const events = entry.activityEvents;
    const last = events[events.length - 1];
    if (last && last.type === 'reasoning') {
      const next = [...events];
      next[next.length - 1] = {
        ...last,
        content: last.content + chunk,
      };
      return {
        streamsByConversation: {
          ...state.streamsByConversation,
          [conversationId]: { ...entry, activityEvents: next },
        },
      };
    }
    return {
      streamsByConversation: {
        ...state.streamsByConversation,
        [conversationId]: {
          ...entry,
          activityEvents: [
            ...events,
            {
              id: `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'reasoning',
              content: chunk,
            },
          ],
        },
      },
    };
  }),
  upsertStreamToolCall: (conversationId, data) => set((state) => {
    const entry = state.streamsByConversation[conversationId];
    if (!entry) return {};
    const idx = entry.activityEvents.findIndex(
      (ev) => ev.type === 'tool' && ev.tool.id === data.id
    );
    let nextEvents: StreamingActivityEvent[];
    if (idx === -1) {
      nextEvents = [
        ...entry.activityEvents,
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
      ];
    } else {
      const prev = entry.activityEvents[idx];
      if (prev.type !== 'tool') return {};
      nextEvents = [...entry.activityEvents];
      nextEvents[idx] = {
        ...prev,
        tool: {
          ...prev.tool,
          name: data.name || prev.tool.name,
          arguments: data.arguments || prev.tool.arguments,
          status: 'running',
          source: data.source || prev.tool.source,
        },
      };
    }
    return {
      streamsByConversation: {
        ...state.streamsByConversation,
        [conversationId]: { ...entry, activityEvents: nextEvents },
      },
    };
  }),
  completeStreamToolCall: (conversationId, data) => set((state) => {
    const entry = state.streamsByConversation[conversationId];
    if (!entry) return {};
    const idx = entry.activityEvents.findIndex(
      (ev) => ev.type === 'tool' && ev.tool.id === data.id
    );
    let nextEvents: StreamingActivityEvent[];
    if (idx === -1) {
      nextEvents = [
        ...entry.activityEvents,
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
            metadata: data.metadata,
          },
        },
      ];
    } else {
      const prev = entry.activityEvents[idx];
      if (prev.type !== 'tool') return {};
      nextEvents = [...entry.activityEvents];
      nextEvents[idx] = {
        ...prev,
        tool: {
          ...prev.tool,
          name: data.name || prev.tool.name,
          status: data.ok ? 'done' : 'error',
          ok: data.ok,
          result: data.result,
          duration_ms: data.duration_ms,
          source: data.source || prev.tool.source,
          metadata: data.metadata,
        },
      };
    }
    return {
      streamsByConversation: {
        ...state.streamsByConversation,
        [conversationId]: { ...entry, activityEvents: nextEvents },
      },
    };
  }),
  appendStreamToolOutputChunk: (conversationId, data) => set((state) => {
    const entry = state.streamsByConversation[conversationId];
    if (!entry) return {};
    const idx = entry.activityEvents.findIndex(
      (ev) => ev.type === 'tool' && ev.tool.id === data.id
    );
    // A chunk arriving before its tool_call event would be a backend-ordering bug outside
    // this store's control (chat.ts always emits tool_call before dispatching); no-op rather
    // than fabricate a placeholder execution with an unknown name/arguments.
    if (idx === -1) return {};
    const prev = entry.activityEvents[idx];
    if (prev.type !== 'tool') return {};
    const nextEvents = [...entry.activityEvents];
    nextEvents[idx] = {
      ...prev,
      tool: {
        ...prev.tool,
        liveOutput: [
          ...(prev.tool.liveOutput || []),
          { stream: data.stream, text: data.text, seq: data.seq },
        ],
      },
    };
    return {
      streamsByConversation: {
        ...state.streamsByConversation,
        [conversationId]: { ...entry, activityEvents: nextEvents },
      },
    };
  }),
  resetStreamActivity: (conversationId) => set((state) => {
    const entry = state.streamsByConversation[conversationId];
    if (!entry) return {};
    return {
      streamsByConversation: {
        ...state.streamsByConversation,
        [conversationId]: { ...entry, activityEvents: [] },
      },
    };
  }),

  // Artifacts — per-conversation sidecar content
  artifactsByConversation: {},
  activeArtifactId: null,
  artifactPanelOpen: false,
  upsertConversationArtifact: (conversationId, artifact) => set((state) => {
    const prevBucket = state.artifactsByConversation[conversationId] ?? {};
    const isFirstInConversation = Object.keys(prevBucket).length === 0;
    const nextBucket = { ...prevBucket, [artifact.id]: artifact };
    // Auto-select semantics: set activeArtifactId to this artifact when the panel
    // is already open showing an artifact from this conversation, OR when this is
    // the first artifact ever for this conversation (no prior bucket entry).
    const activeBelongsToThisConv = state.activeArtifactId !== null && state.activeArtifactId in prevBucket;
    const shouldAutoSelect = isFirstInConversation || (state.artifactPanelOpen && activeBelongsToThisConv);
    return {
      artifactsByConversation: {
        ...state.artifactsByConversation,
        [conversationId]: nextBucket,
      },
      ...(shouldAutoSelect ? { activeArtifactId: artifact.id } : {}),
    };
  }),
  hydrateConversationArtifacts: (conversationId, artifacts) => set((state) => {
    const nextBucket: Record<string, ChatArtifact> = {};
    for (const a of artifacts) nextBucket[a.id] = a;
    let nextActive: string | null = state.activeArtifactId;
    if (nextActive !== null && !(nextActive in nextBucket)) {
      // Prefer lastActiveArtifact:<convId> from localStorage if it exists in this hydrate.
      try {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(`lastActiveArtifact:${conversationId}`) : null;
        if (saved && saved in nextBucket) nextActive = saved;
        else nextActive = null;
      } catch {
        nextActive = null;
      }
    } else if (nextActive === null && artifacts.length > 0) {
      try {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(`lastActiveArtifact:${conversationId}`) : null;
        if (saved && saved in nextBucket) nextActive = saved;
      } catch {}
    }
    return {
      artifactsByConversation: {
        ...state.artifactsByConversation,
        [conversationId]: nextBucket,
      },
      activeArtifactId: nextActive !== null && nextActive in nextBucket ? nextActive : null,
      ...(nextActive !== null && nextActive in nextBucket && state.activeArtifactId === null && !state.artifactPanelOpen && artifacts.length > 0 ? { artifactPanelOpen: true } : {}),
    };
  }),
  setActiveArtifact: (conversationId, artifactId) => set(() => {
    if (conversationId && artifactId) {
      try { localStorage.setItem(`lastActiveArtifact:${conversationId}`, artifactId); } catch {}
    } else if (conversationId && artifactId === null) {
      try { localStorage.removeItem(`lastActiveArtifact:${conversationId}`); } catch {}
    }
    return {
      activeArtifactId: artifactId,
      ...(artifactId !== null ? { artifactPanelOpen: true } : {}),
    };
  }),
  closeArtifactPanel: () => set({ artifactPanelOpen: false }),
  clearConversationArtifacts: (conversationId) => set((state) => {
    const bucket = state.artifactsByConversation[conversationId];
    if (!bucket) return {};
    const activeWasInBucket = state.activeArtifactId !== null && state.activeArtifactId in bucket;
    const next = { ...state.artifactsByConversation };
    delete next[conversationId];
    return {
      artifactsByConversation: next,
      ...(activeWasInBucket ? { activeArtifactId: null, artifactPanelOpen: false } : {}),
    };
  }),

  // Settings
  openRouterApiKey: '',
  setOpenRouterApiKey: (key) => set({ openRouterApiKey: key }),
  autoConversationTitlesEnabled: false,
  setAutoConversationTitlesEnabled: (enabled) => set({ autoConversationTitlesEnabled: enabled }),
  deepSeekApiKey: '',
  setDeepSeekApiKey: (key) => set({ deepSeekApiKey: key }),
  loadSettings: async () => {
    try {
      const data = await settingsApi.getAll();
      set({
        openRouterApiKey: data.openrouter_api_key ?? '',
        autoConversationTitlesEnabled: data.auto_conversation_titles_enabled === 'true' || data.auto_conversation_titles_enabled === '1',
        deepSeekApiKey: data.deepseek_api_key ?? '',
      });
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
      let skill_ids: string[] = [];
      try {
        const raw = settings['general_chat_skill_ids'];
        if (raw && typeof raw === 'string') {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) skill_ids = parsed.filter((id): id is string => typeof id === 'string');
        }
      } catch {
        // keep []
      }
      const toolChoiceRaw = settings['general_chat_tool_choice'];
      const tool_choice = toolChoiceRaw === 'none' ? 'none' : 'auto';
      const parallelRaw = settings['general_chat_parallel_tool_calls'];
      const parallel_tool_calls = parallelRaw === '0' ? 0 : 1;
      let provider_routing: ProviderRoutingConfig | null = null;
      try {
        const raw = settings['general_chat_provider_routing'];
        if (raw && typeof raw === 'string') {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed?.mode === 'auto') {
            provider_routing = { mode: 'auto' };
          } else if (parsed?.mode === 'provider' && typeof parsed.provider_slug === 'string' && parsed.provider_slug.trim()) {
            provider_routing = {
              mode: 'provider',
              provider_slug: parsed.provider_slug.trim(),
              allow_fallbacks: parsed.allow_fallbacks !== false,
            };
          }
        }
      } catch {
        // keep null
      }

      const generalSettings: GeneralChatSettings = {
        model: settings['general_chat_model'] || 'openrouter/auto',
        provider_routing,
        system_prompt: settings['general_chat_system_prompt'] || 'You are a helpful AI assistant. You provide thoughtful, well-structured responses.',
        emoji: settings['general_chat_emoji'] || '💬',
        tool_ids,
        mcp_server_ids,
        skill_ids,
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
        settingsApi.set('general_chat_provider_routing', settings.provider_routing ? JSON.stringify(settings.provider_routing) : ''),
        settingsApi.set('general_chat_system_prompt', settings.system_prompt),
        settingsApi.set('general_chat_emoji', settings.emoji || '💬'),
        settingsApi.set('general_chat_tool_ids', JSON.stringify(settings.tool_ids ?? [])),
        settingsApi.set('general_chat_mcp_server_ids', JSON.stringify(settings.mcp_server_ids ?? [])),
        settingsApi.set('general_chat_skill_ids', JSON.stringify(settings.skill_ids ?? [])),
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
  composerFocused: false,
  setComposerFocused: (focused) => set({ composerFocused: focused }),
  artifactGalleryOpen: false,
  setArtifactGalleryOpen: (open) => set({ artifactGalleryOpen: open }),
}));
