import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, ArrowDown, StopCircle, MessageSquare, Bot, Brain, FileUp, Link, X, Users, SlidersHorizontal, Wrench, Layers, Laptop, History, Cpu, Share2 } from 'lucide-react';
import { CouncilToggle } from './CouncilToggle';
import { CouncilStreamingView } from './CouncilStreamingView';
import { useStore } from '../stores/store';
import { useIsMobile, usePrefersReducedMotion } from '../utils/breakpoints';
import { useChat } from '../hooks/useChat';
import { useTurnReconciliation } from '../hooks/useTurnReconciliation';
import { getCurrentVariant, getTurnVariants, findVariantLeaf } from '../utils/threads';
import { findVariantAssistantModel } from '../utils/variantUtils';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { MessageBubble } from './MessageBubble';
import { EmptyState } from './EmptyState';
import { ShareDialog } from './ShareDialog';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { ModelSelectorCore } from './ModelSelectorCore';
import { ProviderRoutingSelector } from './ProviderRoutingSelector';
import { ConversationToolsSelector } from './ConversationToolsSelector';
import { ConversationSkillsSelector } from './ConversationSkillsSelector';
import { conversationsApi, skillsApi, agentPairingApi, agentUploadsApi, settingsApi } from '../api/client';
import { isLlamaCppModel, stripLlamaCppPrefix } from '../utils/providers';
import { effectiveReasoningBudgetV2, LLAMACPP_PRESET_META, overridesForKey, parseLlamaCppActivePreset, parseLlamaCppPresetsRow } from '../utils/llamacppKnobs';
import { PremiumMentionInput } from './ui/PremiumMentionInput';
import { Sheet } from './ui/Sheet';
import { ConversationTokenSummary, StreamingTokenCounter } from './TokenCounter';
import type {
  ReasoningEffort,
  ReasoningConfig,
  PDFEngine,
  ChatAttachmentInput,
  ToolExecution,
  ToolSource,
  StreamingActivityEvent,
  ProviderRoutingConfig,
  Skill,
  Message,
} from '../types';

const MAX_PDF_ATTACHMENTS = 5;
const MAX_PDF_MB = 20;

interface PendingAttachment {
  id: string;
  filename: string;
  file?: File;
  url?: string;
  error?: string;
}

const PDF_ENGINE_OPTIONS: { value: '' | PDFEngine; label: string; title: string }[] = [
  { value: '', label: 'Auto', title: 'Let OpenRouter choose' },
  { value: 'pdf-text', label: 'Text', title: 'Best for text PDFs (free)' },
  { value: 'mistral-ocr', label: 'OCR', title: 'Scanned docs (may have cost)' },
  { value: 'native', label: 'Native', title: 'Model-native when supported' },
];

const EFFORT_OPTIONS: { value: ReasoningEffort; label: string; short: string }[] = [
  { value: 'minimal', label: 'Minimal', short: 'Min' },
  { value: 'low', label: 'Low', short: 'Low' },
  { value: 'medium', label: 'Medium', short: 'Med' },
  { value: 'high', label: 'High', short: 'High' },
  { value: 'xhigh', label: 'Maximum', short: 'Max' },
  { value: 'max', label: 'Ultra', short: 'Ultra' },
];

const BUILTIN_TOOL_NAMES = new Set(['web_search', 'get_current_time', 'web_fetch', 'run_command', 'read_file', 'write_file', 'edit_file', 'delete_file', 'list_directory']);

/** Stable empty activity-events list so idle renders keep referential identity. */
const EMPTY_STREAMING_EVENTS: StreamingActivityEvent[] = [];

function inferToolSource(name: string): ToolSource {
  if (name.startsWith('mcp_')) return 'mcp';
  if (BUILTIN_TOOL_NAMES.has(name)) return 'builtin';
  return 'http';
}

function inferToolResultOk(result?: string): boolean | undefined {
  if (result === undefined) return undefined;
  const trimmed = result.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('[Tool execution error]')) return false;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = parsed.error;
      return !(err !== undefined && err !== null && String(err).trim().length > 0);
    }
  } catch {
    // Non-JSON outputs are valid results.
  }
  return true;
}

export function ChatView() {
  const {
    messages,
    messagesLoading,
    streamsByConversation,
    activeConversationId,
    authRequired,
    addMessage,
    conversations,
    agents,
    selectedAgentId,
    setCurrentView,
    reasoningOverride,
    setReasoningOverride,
    conversationModelOverrides,
    setConversationModelOverride,
    conversationProviderRoutingOverrides,
    setConversationProviderRoutingOverride,
    conversationToolConfigOverrides,
    setConversationToolConfigOverride,
    conversationSkillConfigOverrides,
    setConversationSkillConfigOverride,
    loadConversations,
    generalChatSettings,
    councilEnabled,
    councilConfig,
    selectedCouncilId,
    councilMemberProgress,
    councilSynthesisPhase,
    activeLeafId,
    setActiveLeaf,
  } = useStore();
  // Streaming state of THE ACTIVE conversation only: switching to another
  // conversation frees its composer even while this one keeps generating.
  const activeStream = activeConversationId ? streamsByConversation[activeConversationId] : undefined;
  const isStreaming = !!activeStream;
  const streamingContent = activeStream?.content ?? '';
  const reasoningContent = activeStream?.reasoning ?? '';
  const streamStartTime = activeStream?.startTime ?? null;
  const streamingActivityEvents = activeStream?.activityEvents ?? EMPTY_STREAMING_EVENTS;
  const streamingActivitySignature = useMemo(() => (
    streamingActivityEvents
      .map((ev) => (
        ev.type === 'reasoning'
          ? `r:${ev.id}:${ev.content.length}`
          : ev.type === 'content'
            ? `c:${ev.id}:${ev.content.length}`
            : `t:${ev.tool.id}:${ev.tool.status}:${(ev.tool.result || '').length}:${ev.tool.liveOutput?.length || 0}`
      ))
      .join('|')
  ), [streamingActivityEvents]);
  const { sendMessage, cancelStream, startNewChat, startGeneralChat, relaunchFromMessage, retryLastAssistant, getActiveThread } = useChat();
  // Reopen reconciliation (RC4): tracks a server-side turn for this conversation
  // when there is no local stream entry (e.g. tab refreshed mid-generation).
  const { reconciling } = useTurnReconciliation(activeConversationId);
  // The server-reported streaming draft (GC13): while reconciling, the latest
  // assistant row of the thread with generation_status === 'streaming' renders
  // with the live presentation and suppressed message actions.
  const polledStreamingMessage = useMemo(() => {
    if (!reconciling) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant') {
        return m.generation_status === 'streaming' ? m : null;
      }
    }
    return null;
  }, [reconciling, messages]);
  const [inputValue, setInputValue] = useState('');
  const [showReasoningPopover, setShowReasoningPopover] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [pdfEngine, setPdfEngine] = useState<'' | PDFEngine>('');
  const [pdfUrlInput, setPdfUrlInput] = useState('');
  const [pdfUrlError, setPdfUrlError] = useState('');
  const [sendFileError, setSendFileError] = useState('');
  const [isSendingFile, setIsSendingFile] = useState(false);
  const [streamingModelSnapshot, setStreamingModelSnapshot] = useState<string | null>(null);
  const [streamingProviderRoutingSnapshot, setStreamingProviderRoutingSnapshot] = useState<ProviderRoutingConfig | null>(null);
  // Edit-message state: local to this view; saving re-launches the turn as a new variant.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  // Model that produced the original response (only used for the edit hint).
  const [editOriginalModel, setEditOriginalModel] = useState<string | null>(null);
  const [invokeAgentId, setInvokeAgentId] = useState<string | undefined>(undefined);
  const [invokeSkillNames, setInvokeSkillNames] = useState<string[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reasoningBtnRef = useRef<HTMLButtonElement>(null);
  const reasoningPopoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendFileInputRef = useRef<HTMLInputElement>(null);
  const prevIsStreamingRef = useRef(isStreaming);
  const scrollDependency = useMemo(
    () =>
      isStreaming
        ? `${streamingContent.length}:${reasoningContent.length}:${streamingActivitySignature}`
        : `${messages.length}:${activeLeafId ?? 'none'}:${messages[messages.length - 1]?.id ?? ''}:${polledStreamingMessage?.content.length ?? 'idle'}`,
    [
      isStreaming,
      streamingContent.length,
      reasoningContent.length,
      streamingActivitySignature,
      messages.length,
      activeLeafId,
      messages[messages.length - 1]?.id,
      polledStreamingMessage?.content.length,
    ]
  );
  const { containerRef, scrollToBottom, showScrollButton, handleScroll } = useAutoScroll(scrollDependency);

  // Fetch the skill catalog once, on mount — there is no global store cache for
  // skills to reuse, consistent with this app's per-component-fetch convention.
  useEffect(() => {
    skillsApi.list().then(setSkills).catch(() => setSkills([]));
  }, []);

  // When stream ends, keep view at bottom (instant scroll after layout)
  useLayoutEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming) {
      setStreamingModelSnapshot(null);
      setStreamingProviderRoutingSnapshot(null);
    }
    if (wasStreaming && !isStreaming && messages.length > 0) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToBottom('auto'));
      });
    }
  }, [isStreaming, messages.length, scrollToBottom]);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const agent = agents.find((a) => a.id === (activeConversation?.agent_id || selectedAgentId));
  const isGeneralChat = !agent;

  // Default model for this chat: agent's model, or general chat settings model when in general chat
  const defaultModelForChat = agent
    ? agent.model
    : (generalChatSettings?.model ?? 'openrouter/auto');
  const defaultProviderRoutingForChat = agent
    ? (agent.provider_routing ?? null)
    : (generalChatSettings?.provider_routing ?? null);
  const defaultToolIdsForChat = agent ? (agent.tool_ids ?? []) : (generalChatSettings?.tool_ids ?? []);
  const defaultMcpServerIdsForChat = agent ? (agent.mcp_server_ids ?? []) : (generalChatSettings?.mcp_server_ids ?? []);
  const defaultSkillIdsForChat = agent ? (agent.skill_ids ?? []) : (generalChatSettings?.skill_ids ?? []);

  const effectiveConversationModel = useMemo(() => {
    if (!activeConversationId) return null;
    const override = conversationModelOverrides[activeConversationId];
    if (override !== undefined) return override;
    return activeConversation?.model ?? null;
  }, [activeConversationId, conversationModelOverrides, activeConversation?.model]);
  const effectiveConversationProviderRouting = useMemo(() => {
    if (!activeConversationId) return null;
    const override = conversationProviderRoutingOverrides[activeConversationId];
    if (override !== undefined) return override;
    return activeConversation?.provider_routing ?? null;
  }, [activeConversationId, conversationProviderRoutingOverrides, activeConversation?.provider_routing]);

  const effectiveConversationToolConfig = useMemo(() => {
    if (!activeConversationId) {
      return { overrideActive: false, toolIds: defaultToolIdsForChat, mcpServerIds: defaultMcpServerIdsForChat };
    }
    const override = conversationToolConfigOverrides[activeConversationId];
    const source = override !== undefined
      ? override
      : { tools_overridden: !!activeConversation?.tools_overridden, tool_ids: activeConversation?.tool_ids ?? [], mcp_server_ids: activeConversation?.mcp_server_ids ?? [] };
    return {
      overrideActive: source.tools_overridden,
      toolIds: source.tools_overridden ? source.tool_ids : defaultToolIdsForChat,
      mcpServerIds: source.tools_overridden ? source.mcp_server_ids : defaultMcpServerIdsForChat,
    };
  }, [activeConversationId, conversationToolConfigOverrides, activeConversation, defaultToolIdsForChat, defaultMcpServerIdsForChat]);

  const effectiveConversationSkillConfig = useMemo(() => {
    if (!activeConversationId) {
      return { overrideActive: false, skillIds: defaultSkillIdsForChat };
    }
    const override = conversationSkillConfigOverrides[activeConversationId];
    const source = override !== undefined
      ? override
      : { skills_overridden: !!activeConversation?.skills_overridden, skill_ids: activeConversation?.skill_ids ?? [] };
    return {
      overrideActive: source.skills_overridden,
      skillIds: source.skills_overridden ? source.skill_ids : defaultSkillIdsForChat,
    };
  }, [activeConversationId, conversationSkillConfigOverrides, activeConversation, defaultSkillIdsForChat]);

  // Model used for the next (or current streaming) message; shown in the assistant bubble when streaming.
  const effectiveModelForThisMessage = effectiveConversationModel ?? defaultModelForChat;

  const handleConversationModelChange = useCallback(
    async (modelId: string | null) => {
      if (!activeConversationId) return;
      setConversationModelOverride(activeConversationId, modelId);
      setConversationProviderRoutingOverride(activeConversationId, null);
      try {
        await conversationsApi.updateModel(activeConversationId, modelId);
        await loadConversations();
      } catch (err) {
        console.error('Failed to update conversation model:', err);
      }
    },
    [activeConversationId, setConversationModelOverride, setConversationProviderRoutingOverride, loadConversations]
  );

  const handleConversationProviderRoutingChange = useCallback(
    async (routing: ProviderRoutingConfig | null) => {
      if (!activeConversationId) return;
      setConversationProviderRoutingOverride(activeConversationId, routing);
      try {
        await conversationsApi.updateProviderRouting(activeConversationId, routing);
        await loadConversations();
      } catch (err) {
        console.error('Failed to update conversation provider routing:', err);
      }
    },
    [activeConversationId, setConversationProviderRoutingOverride, loadConversations]
  );

  const handleConversationToolConfigApply = useCallback(
    async (toolIds: string[], mcpServerIds: string[]) => {
      if (!activeConversationId) return;
      setConversationToolConfigOverride(activeConversationId, { tools_overridden: true, tool_ids: toolIds, mcp_server_ids: mcpServerIds });
      try {
        await conversationsApi.updateToolConfig(activeConversationId, toolIds, mcpServerIds);
        await loadConversations();
      } catch (err) {
        console.error('Failed to update conversation tool config:', err);
      }
    },
    [activeConversationId, setConversationToolConfigOverride, loadConversations]
  );

  const handleConversationToolConfigReset = useCallback(async () => {
    if (!activeConversationId) return;
    setConversationToolConfigOverride(activeConversationId, { tools_overridden: false, tool_ids: [], mcp_server_ids: [] });
    try {
      await conversationsApi.resetToolConfig(activeConversationId);
      await loadConversations();
    } catch (err) {
      console.error('Failed to reset conversation tool config:', err);
    }
  }, [activeConversationId, setConversationToolConfigOverride, loadConversations]);

  const handleConversationSkillConfigApply = useCallback(
    async (skillIds: string[]) => {
      if (!activeConversationId) return;
      setConversationSkillConfigOverride(activeConversationId, { skills_overridden: true, skill_ids: skillIds });
      try {
        await conversationsApi.updateSkillConfig(activeConversationId, skillIds);
        await loadConversations();
      } catch (err) {
        console.error('Failed to update conversation skill config:', err);
      }
    },
    [activeConversationId, setConversationSkillConfigOverride, loadConversations]
  );

  const handleConversationSkillConfigReset = useCallback(async () => {
    if (!activeConversationId) return;
    setConversationSkillConfigOverride(activeConversationId, { skills_overridden: false, skill_ids: [] });
    try {
      await conversationsApi.resetSkillConfig(activeConversationId);
      await loadConversations();
    } catch (err) {
      console.error('Failed to reset conversation skill config:', err);
    }
  }, [activeConversationId, setConversationSkillConfigOverride, loadConversations]);

  // Determine effective reasoning state: override > agent default > general chat settings (when no agent)
  const effectiveReasoning: ReasoningConfig = useMemo(() => {
    if (reasoningOverride) return reasoningOverride;
    if (agent?.reasoning_enabled) {
      return {
        enabled: true,
        effort: agent.reasoning_effort || undefined,
        max_tokens: agent.reasoning_max_tokens || undefined,
      };
    }
    if (isGeneralChat && generalChatSettings?.reasoning_enabled) {
      return {
        enabled: true,
        effort: generalChatSettings.reasoning_effort || undefined,
        max_tokens: generalChatSettings.reasoning_max_tokens || undefined,
      };
    }
    return { enabled: false };
  }, [reasoningOverride, agent, isGeneralChat, generalChatSettings]);

  const reasoningActive = effectiveReasoning.enabled;
  const currentEffort = effectiveReasoning.effort || 'medium';

  // D5 honesty (Increment 2): when the chat runs on a llama.cpp model, the
  // persisted launch config at resolution v2 (defaults ⊕ active preset ⊕ model
  // override) decides whether per-chat thinking can produce tokens and how far
  // it can go. Read the FOUR settings rows fail-soft and surface the result on
  // the toggle; -1 (unlimited) renders no hint at all.
  const chatModelId = effectiveConversationModel ?? defaultModelForChat;
  const chatModelIsLlamaCpp = isLlamaCppModel(chatModelId);
  const chatModelKey = chatModelIsLlamaCpp ? stripLlamaCppPrefix(chatModelId) : null;
  const [llamacppBudgetHint, setLlamacppBudgetHint] = useState<{ budget: number; source: string } | null>(null);
  useEffect(() => {
    if (!chatModelIsLlamaCpp) {
      setLlamacppBudgetHint(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      settingsApi.get('llamacpp_load_defaults'),
      settingsApi.get('llamacpp_presets'),
      settingsApi.get('llamacpp_active_preset'),
      settingsApi.get('llamacpp_model_overrides'),
    ]).then(([defaultsRow, presetsRow, activePresetRow, overridesRow]) => {
      if (cancelled) return;
      const activeId = parseLlamaCppActivePreset(activePresetRow.value);
      const presetLayer = parseLlamaCppPresetsRow(presetsRow.value)[activeId];
      const budget = effectiveReasoningBudgetV2(
        defaultsRow.value,
        presetsRow.value,
        activePresetRow.value,
        overridesRow.value,
        chatModelKey,
      );
      // Winning layer for the hint copy: model override > active preset > global defaults.
      const overrideSupplied =
        chatModelKey != null &&
        overridesForKey(overridesRow.value, chatModelKey).reasoning_budget !== undefined;
      const source = overrideSupplied
        ? 'model override'
        : presetLayer.reasoning_budget !== undefined
          ? `preset ${LLAMACPP_PRESET_META.find((m) => m.id === activeId)?.label ?? activeId}`
          : 'global defaults';
      setLlamacppBudgetHint({ budget, source });
    }).catch(() => {
      if (!cancelled) setLlamacppBudgetHint(null);
    });
    return () => { cancelled = true; };
  }, [chatModelIsLlamaCpp, chatModelKey]);

  const isMobile = useIsMobile();
  const setComposerFocused = useStore((s) => s.setComposerFocused);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Clear the composing flag if the chat unmounts while focused.
  useEffect(() => () => setComposerFocused(false), [setComposerFocused]);
  const composerOptionsActive =
    reasoningActive || councilEnabled || !!pdfEngine;
  const prefersReducedMotion = usePrefersReducedMotion();

  // Close popover when clicking outside
  useEffect(() => {
    if (!showReasoningPopover) return;
    const handleClick = (e: MouseEvent) => {
      if (
        reasoningPopoverRef.current && !reasoningPopoverRef.current.contains(e.target as Node) &&
        reasoningBtnRef.current && !reasoningBtnRef.current.contains(e.target as Node)
      ) {
        setShowReasoningPopover(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showReasoningPopover]);

  const toggleReasoning = useCallback(() => {
    if (reasoningActive) {
      setReasoningOverride({ enabled: false });
    } else {
      const defaultEffort = agent?.reasoning_effort ?? generalChatSettings?.reasoning_effort ?? 'medium';
      setReasoningOverride({ enabled: true, effort: defaultEffort });
    }
  }, [reasoningActive, agent, generalChatSettings?.reasoning_effort, setReasoningOverride]);

  const setEffort = useCallback((effort: ReasoningEffort) => {
    setReasoningOverride({
      ...effectiveReasoning,
      enabled: true,
      effort,
    });
  }, [effectiveReasoning, setReasoningOverride]);

  // Reset reasoning override when switching conversations
  useEffect(() => {
    setReasoningOverride(null);
    setShowReasoningPopover(false);
    setEditingMessageId(null);
    setEditContent('');
    setEditOriginalModel(null);
  }, [activeConversationId, setReasoningOverride]);

  // Tool results memo (must be before early return)
  const toolResultsByCallId = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        map.set(msg.tool_call_id, msg.content || '');
      }
    }
    return map;
  }, [messages]);

  const toolExecutionsByMessageId = useMemo(() => {
    const map = new Map<string, ToolExecution[]>();
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) continue;
      const executions: ToolExecution[] = msg.tool_calls.map((tc) => {
        const toolName = tc.function?.name || tc.id;
        const result = toolResultsByCallId.get(tc.id);
        const ok = inferToolResultOk(result);
        return {
          id: tc.id,
          name: toolName,
          arguments: tc.function?.arguments || '{}',
          status: result === undefined ? 'running' : ok === false ? 'error' : 'done',
          result,
          ok,
          source: inferToolSource(toolName),
        };
      });
      map.set(msg.id, executions);
    }
    return map;
  }, [messages, toolResultsByCallId]);

  // The visible thread hangs from the active leaf, so variant navigation swaps
  // entire tails instead of mutating flat message order.
  const activeThread = useMemo(() => getActiveThread(), [messages, activeLeafId, getActiveThread]);

  // Active variant of the turn the current leaf belongs to (index is 1-based).
  const currentVariant = useMemo(
    () => getCurrentVariant(messages, activeLeafId),
    [messages, activeLeafId]
  );

  // All user-variant roots per turn, so any message with alternatives can show
  // the switcher — not just the active turn (mid-thread edits stay reachable).
  const variantsByTurn = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const m of messages) {
      if (m.role === 'user' && m.turn_id) {
        const list = map.get(m.turn_id);
        if (list) list.push(m);
        else map.set(m.turn_id, [m]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.variant_seq ?? 1) - (b.variant_seq ?? 1));
    }
    return map;
  }, [messages]);

  // Ids on the visible chain: used to find which variant of each turn is active.
  const activeChainIds = useMemo(() => new Set(activeThread.map((m) => m.id)), [activeThread]);

  // Model badge per user variant (last assistant of the same turn/variant), for
  // the variant-list popover.
  const variantModels = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const m of messages) {
      if (m.role === 'user' && m.turn_id && !(m.id in map)) {
        map[m.id] = findVariantAssistantModel(messages, m);
      }
    }
    return map;
  }, [messages]);

  const handleStartEdit = useCallback((msg: Message) => {
    if (isStreaming) return;
    setEditingMessageId(msg.id);
    setEditContent(msg.content);
    // Remember the model that produced the original response (only used as an
    // informational hint in the edit footer; the re-run always uses the
    // conversation's effective model).
    setEditOriginalModel(findVariantAssistantModel(messages, msg));
  }, [isStreaming, messages]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditContent('');
    setEditOriginalModel(null);
  }, []);

  const handleSubmitEdit = useCallback(async () => {
    if (!editingMessageId || isStreaming) return;
    const content = editContent.trim();
    if (!content) return;
    setEditingMessageId(null);
    setEditContent('');
    setEditOriginalModel(null);
    try {
      await relaunchFromMessage(editingMessageId, { content });
    } catch (err) {
      console.error('Failed to relaunch message:', err);
    }
    requestAnimationFrame(() => scrollToBottom('auto'));
  }, [editingMessageId, isStreaming, editContent, relaunchFromMessage, scrollToBottom]);

  const handleRetry = useCallback(() => {
    if (isStreaming) return;
    retryLastAssistant();
  }, [isStreaming, retryLastAssistant]);

  const handleSelectVariant = useCallback((variantId: string) => {
    if (isStreaming) return;
    const leaf = findVariantLeaf(messages, variantId);
    setActiveLeaf(leaf ?? variantId);
  }, [messages, isStreaming, setActiveLeaf]);

  const handleNavigateVariant = useCallback((direction: -1 | 1, userMessageId: string) => {
    if (isStreaming) return;
    const variants = getTurnVariants(messages, userMessageId);
    const chainIds = new Set(getActiveThread().map((m) => m.id));
    const activeIdx = variants.findIndex((v) => chainIds.has(v.id));
    const target = variants[activeIdx + direction];
    if (!target) return;
    const leaf = findVariantLeaf(messages, target.id);
    setActiveLeaf(leaf ?? target.id);
  }, [messages, isStreaming, setActiveLeaf]);

  const handleGoToLatestVariant = useCallback(() => {
    if (!currentVariant || isStreaming) return;
    const variants = getTurnVariants(messages, currentVariant.userMessageId);
    const last = variants[variants.length - 1];
    if (!last) return;
    handleSelectVariant(last.id);
  }, [currentVariant, messages, isStreaming, handleSelectVariant]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [inputValue]);

  const addAttachmentsFromFiles = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    setPendingAttachments((prev) => {
      const next = [...prev];
      const maxAdd = MAX_PDF_ATTACHMENTS - next.length;
      for (let i = 0; i < Math.min(files.length, maxAdd); i++) {
        const file = files[i];
        if (file.type !== 'application/pdf') continue;
        if (file.size > MAX_PDF_MB * 1024 * 1024) continue;
        next.push({
          id: `att-${Date.now()}-${i}`,
          filename: file.name,
          file,
        });
      }
      return next.slice(0, MAX_PDF_ATTACHMENTS);
    });
  }, []);

  const addAttachmentFromUrl = useCallback(() => {
    const raw = pdfUrlInput.trim();
    setPdfUrlError('');
    if (!raw) return;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        setPdfUrlError('URL must be http or https');
        return;
      }
    } catch {
      setPdfUrlError('Enter a valid URL');
      return;
    }
    const filename = raw.split('/').pop()?.split('?')[0] || 'document.pdf';
    const name = filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`;
    setPendingAttachments((prev) => {
      const next = prev.length >= MAX_PDF_ATTACHMENTS ? prev.slice(0, MAX_PDF_ATTACHMENTS - 1) : [...prev];
      next.push({ id: `att-url-${Date.now()}`, filename: name, url: raw });
      return next;
    });
    setPdfUrlInput('');
  }, [pdfUrlInput]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // "Send to my computer" — wholly separate from the PDF-attach control above:
  // delivers arbitrary files to the connected local agent's workspace.
  const handleSendToComputerClick = useCallback(async () => {
    setSendFileError('');
    if (!activeConversationId || isStreaming || isSendingFile) return;
    try {
      const pairings = await agentPairingApi.listPairings();
      if (!pairings.some((p) => p.connected)) {
        setSendFileError('No local agent is connected.');
        return;
      }
    } catch (err) {
      setSendFileError(err instanceof Error ? err.message : 'Could not check local agent connection.');
      return;
    }
    sendFileInputRef.current?.click();
  }, [activeConversationId, isStreaming, isSendingFile]);

  const handleSendFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!picked.length || !activeConversationId) return;
    setIsSendingFile(true);
    setSendFileError('');
    for (const file of picked) {
      if (file.size > 100 * 1024 * 1024) {
        setSendFileError(`"${file.name}" exceeds the 100 MiB size limit.`);
        continue;
      }
      try {
        const { message } = await agentUploadsApi.send(activeConversationId, file);
        addMessage(message);
      } catch (err) {
        setSendFileError(`Failed to send "${file.name}": ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
    setIsSendingFile(false);
  }, [activeConversationId, addMessage]);

  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || isStreaming) return;

    let attachmentsPayload: ChatAttachmentInput[] | undefined;
    if (pendingAttachments.length > 0) {
      attachmentsPayload = [];
      for (const a of pendingAttachments) {
        if (a.url) {
          attachmentsPayload.push({ filename: a.filename, url: a.url });
        } else if (a.file) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.onerror = () => reject(new Error('Failed to read file'));
            r.readAsDataURL(a.file!);
          });
          attachmentsPayload.push({ filename: a.filename, file_data: dataUrl });
        }
      }
    }

    const usesCouncil = councilEnabled && !!councilConfig;
    const outgoingModel = effectiveConversationModel ?? defaultModelForChat;
    const outgoingProviderRouting = usesCouncil
      ? null
      : effectiveConversationProviderRouting ?? defaultProviderRoutingForChat ?? { mode: 'auto' as const };
    setStreamingModelSnapshot(outgoingModel);
    setStreamingProviderRoutingSnapshot(outgoingProviderRouting);

    sendMessage(inputValue, {
      ...(attachmentsPayload?.length && { attachments: attachmentsPayload }),
      ...(pdfEngine && { pdf_engine: pdfEngine }),
      ...(invokeAgentId && { invokeAgentId }),
      ...(invokeSkillNames.length && { invokeSkillNames }),
      ...(councilEnabled && councilConfig && {
      councilConfig,
      ...(selectedCouncilId && { councilMemberId: selectedCouncilId }),
    }),
    });
    setInputValue('');
    setPendingAttachments([]);
    setInvokeAgentId(undefined);
    setInvokeSkillNames([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [inputValue, isStreaming, pendingAttachments, pdfEngine, sendMessage, invokeAgentId, invokeSkillNames, councilEnabled, councilConfig, selectedCouncilId, effectiveConversationModel, defaultModelForChat, effectiveConversationProviderRouting, defaultProviderRoutingForChat]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // No active conversation
  if (!activeConversationId) {
    return (
      <EmptyState
        icon={<MessageSquare size={32} />}
        title="Start a Conversation"
        description="Start a new chat to begin. Use @ to mention an agent for specialized help."
        action={
          <Button
            variant="primary"
            icon={<MessageSquare size={16} />}
            onClick={() => startGeneralChat()}
          >
            New Chat
          </Button>
        }
      />
    );
  }

  // Build the visible thread (root → active leaf), including streaming placeholders
  const displayMessages = activeThread.filter((m) => m.role !== 'tool');
  const lastMsg = displayMessages[displayMessages.length - 1];
  // Error bubbles are temp- prefixed but carry their FINAL content — they must
  // render through the normal content path, not as an empty streaming placeholder.
  const isLastMsgStreamingPlaceholder = lastMsg && lastMsg.role === 'assistant' && lastMsg.id.startsWith('temp-') && !lastMsg.id.startsWith('temp-error-');

  return (
    <div
      className="chat-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Chat Header — hidden on mobile; the title lives in the sticky top app bar */}
      {!isMobile && (
      <header className="chat-view-header" aria-label="Conversation header">
        <div className="chat-view-header-icon">
          {agent ? (
            <span className="chat-view-header-icon-inner chat-view-header-icon-agent" aria-hidden="true">
              {agent.emoji}
            </span>
          ) : (
            <span className="chat-view-header-icon-inner chat-view-header-icon-general" aria-hidden="true">
              {generalChatSettings?.emoji ?? '💬'}
            </span>
          )}
        </div>
        <div className="chat-view-header-main">
          <h1 className="chat-view-header-title">
            {activeConversation?.title || 'New conversation'}
          </h1>
          <div className="chat-view-header-meta">
            {agent?.name || 'General Chat'} ·
            <span className="chat-view-header-model-wrap">
              <ModelSelectorCore
                variant="conversation"
                value={effectiveConversationModel}
                onChange={handleConversationModelChange}
                agentModel={defaultModelForChat}
                conversationModel={activeConversation?.model}
                ariaLabel="Select AI model for this conversation"
              />
              <ProviderRoutingSelector
                modelId={effectiveConversationModel ?? defaultModelForChat}
                value={effectiveConversationProviderRouting}
                onChange={handleConversationProviderRoutingChange}
                inheritedRouting={defaultProviderRoutingForChat}
                disabled={isStreaming}
                allowDefault
                compact
              />
              <ConversationToolsSelector
                toolIds={effectiveConversationToolConfig.toolIds}
                mcpServerIds={effectiveConversationToolConfig.mcpServerIds}
                overrideActive={effectiveConversationToolConfig.overrideActive}
                onApply={handleConversationToolConfigApply}
                onReset={handleConversationToolConfigReset}
                disabled={isStreaming || !activeConversationId}
              />
              <ConversationSkillsSelector
                skillIds={effectiveConversationSkillConfig.skillIds}
                overrideActive={effectiveConversationSkillConfig.overrideActive}
                onApply={handleConversationSkillConfigApply}
                onReset={handleConversationSkillConfigReset}
                disabled={isStreaming || !activeConversationId}
              />
            </span>
          </div>
        </div>
        <ConversationTokenSummary messages={messages} />
        <IconButton
          label="Share conversation"
          title={!authRequired ? 'Sharing requires accounts (hosted deployments)' : undefined}
          disabled={!authRequired}
          onClick={() => setShareOpen(true)}
        >
          <Share2 size={16} />
        </IconButton>
      </header>
      )}
      <ShareDialog
        isOpen={shareOpen}
        conversationId={activeConversationId}
        onClose={() => setShareOpen(false)}
      />

      {/* Messages + FAB wrapper (position relative so FAB is positioned above input) */}
      <div className="chat-view-messages-wrapper" style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="chat-view-messages-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: `0 var(--content-padding-x)`,
          }}
        >
        <div className="chat-view-messages-inner" style={{
          maxWidth: 'var(--chat-content-max-width, 800px)',
          margin: '0 auto',
          paddingBottom: 'var(--content-padding-y)',
        }}>
          {messagesLoading ? (
            <div className="chat-loading-skeleton" aria-live="polite" aria-busy="true">
              {prefersReducedMotion ? (
                <div className="chat-loading-simple">
                  <div className="chat-loading-dots" aria-hidden="true">
                    <span className="chat-loading-dot" />
                    <span className="chat-loading-dot" />
                    <span className="chat-loading-dot" />
                  </div>
                  <p>Loading conversation...</p>
                </div>
              ) : (
                <>
                  <div className="chat-loading-skeleton-row">
                    <div className="chat-loading-skeleton-avatar" />
                    <div className="chat-loading-skeleton-content">
                      <div className="chat-loading-skeleton-line chat-loading-skeleton-line-short" />
                      <div className="chat-loading-skeleton-line" />
                    </div>
                  </div>
                  <div className="chat-loading-skeleton-row">
                    <div className="chat-loading-skeleton-avatar" />
                    <div className="chat-loading-skeleton-content">
                      <div className="chat-loading-skeleton-line" />
                      <div className="chat-loading-skeleton-line chat-loading-skeleton-line-medium" />
                    </div>
                  </div>
                  <div className="chat-loading-skeleton-row">
                    <div className="chat-loading-skeleton-avatar" />
                    <div className="chat-loading-skeleton-content">
                      <div className="chat-loading-skeleton-line chat-loading-skeleton-line-short" />
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : messages.length === 0 ? (
            <motion.div
              className="chat-welcome-state"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.4, ease: [0.4, 0, 0.2, 1] }}
            >
              <div className="chat-welcome-icon" aria-hidden="true">
                {agent?.emoji ?? (generalChatSettings?.emoji ?? '✨')}
              </div>
              <h2 className="chat-welcome-title">
                Chat with {agent?.name ?? (isGeneralChat ? 'General Chat' : 'Agent')}
              </h2>
              <p className="chat-welcome-description">
                {agent?.description || 'Send a message to start the conversation.'}
              </p>
              <div className="chat-welcome-suggestions">
                {[
                  agent?.description ? 'What can you help me with?' : 'Ask anything',
                  'Explain a concept simply',
                  'Help me brainstorm',
                ].slice(0, 3).map((label, i) => (
                  <button
                    key={i}
                    type="button"
                    className="chat-welcome-suggestion-chip"
                    onClick={() => setInputValue(label)}
                    aria-label={`Suggested: ${label}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </motion.div>
          ) : (
            <>
              {/* Council Streaming View */}
              {(councilEnabled || councilMemberProgress.size > 0) && isStreaming && (
                <CouncilStreamingView
                  memberProgress={councilMemberProgress}
                  synthesisPhase={councilSynthesisPhase}
                  streamingContent={streamingContent}
                />
              )}
              {displayMessages.map((msg, i) => {
              const isStreamingMsg = isLastMsgStreamingPlaceholder && i === displayMessages.length - 1;
              // Server-reported streaming draft while reconciling (poll mode):
              // rendered with the live presentation, actions suppressed (GC13).
              const isPolledStreamingMsg = !!polledStreamingMessage && msg.id === polledStreamingMessage.id;
              const isLiveMsg = isStreamingMsg || isPolledStreamingMsg;
              const timelineCalls = !isStreamingMsg
                ? toolExecutionsByMessageId.get(msg.id)
                : undefined;
              const activityEvents: StreamingActivityEvent[] | undefined = isStreamingMsg
                ? streamingActivityEvents
                : undefined;
              // Variant switcher on ANY user message whose turn has alternatives —
              // the active variant of that turn is the one on the visible chain.
              const turnVariants = msg.role === 'user' && msg.turn_id
                ? (variantsByTurn.get(msg.turn_id) ?? [])
                : [];
              const activeVariantInTurn = turnVariants.find((v) => activeChainIds.has(v.id));
              const variantInfo = turnVariants.length > 1
                ? {
                    total: turnVariants.length,
                    index: activeVariantInTurn?.variant_seq ?? 1,
                    userMessageId: activeVariantInTurn?.id ?? msg.id,
                  }
                : null;
              const showRetry =
                !isStreamingMsg &&
                !isLastMsgStreamingPlaceholder &&
                msg.role === 'assistant' &&
                !msg.id.startsWith('temp-') &&
                !msg.is_council_synthesis &&
                !msg.council_run_id &&
                i === displayMessages.length - 1;
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isStreaming={isLiveMsg}
                  streamingContent={isStreamingMsg ? streamingContent : isPolledStreamingMsg ? (msg.content || '') : undefined}
                  streamingReasoning={isStreamingMsg ? reasoningContent : isPolledStreamingMsg ? (msg.reasoning_content || '') : undefined}
                  streamingActivityEvents={activityEvents}
                  showGeneratingIndicator={isPolledStreamingMsg}
                  agentEmoji={agent?.emoji}
                  toolExecutions={timelineCalls}
                  toolActivityLive={isStreamingMsg && !!activityEvents?.some((ev) => ev.type === 'tool')}
                  streamingModel={isStreamingMsg ? (streamingModelSnapshot ?? effectiveModelForThisMessage) : undefined}
                  streamingProviderRouting={isStreamingMsg ? streamingProviderRoutingSnapshot : undefined}
                  isEditing={editingMessageId === msg.id}
                  editContent={editingMessageId === msg.id ? editContent : undefined}
                  onEditContentChange={setEditContent}
                  editOriginalModel={editingMessageId === msg.id ? editOriginalModel : undefined}
                  relaunchModel={effectiveConversationModel ?? defaultModelForChat}
                  onStartEdit={() => handleStartEdit(msg)}
                  onCancelEdit={handleCancelEdit}
                  onSubmitEdit={handleSubmitEdit}
                  streamingDisabled={isStreaming}
                  variantTotal={variantInfo?.total}
                  variantIndex={variantInfo?.index}
                  variantMessages={variantInfo ? turnVariants : undefined}
                  variantModels={variantModels}
                  activeVariantId={variantInfo?.userMessageId}
                  onNavigateVariant={handleNavigateVariant}
                  onSelectVariant={handleSelectVariant}
                  showRetry={showRetry}
                  onRetry={handleRetry}
                />
              );
            })}
            </>
          )}

          {/* Subtle hint when the visible thread ends at an earlier variant of the active turn */}
          {currentVariant && currentVariant.index < currentVariant.total && !isStreaming && !editingMessageId && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
              <motion.button
                type="button"
                className="message-older-variant-banner"
                onClick={handleGoToLatestVariant}
                initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                aria-label="View the latest variant"
              >
                <History size={12} />
                <span>Viewing an earlier version</span>
                <span className="message-older-variant-banner-link">· View the latest</span>
              </motion.button>
            </div>
          )}
        </div>
        </div>
        {/* Scroll to bottom (inside wrapper so positioned relative to messages area) */}
        <AnimatePresence>
          {showScrollButton && (
            <motion.button
              type="button"
              aria-label="Scroll to bottom"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              onClick={() => scrollToBottom()}
              className="chat-scroll-btn"
              style={{
                position: 'absolute',
                left: '50%',
                transform: 'translateX(-50%)',
                bottom: 'var(--chat-scroll-fab-bottom, 100px)',
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: 'var(--shadow-md)',
                zIndex: 10,
                transition: 'background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast)',
              }}
            >
              <ArrowDown size={16} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Input Area */}
      <div className="chat-view-input">
        <div className="chat-view-input-inner">
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            minWidth: 0,
          }} className="chat-input-container">
            {/* Toolbar row — desktop only; on mobile these controls move into the options sheet */}
            {!isMobile && (
            <div style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              justifyContent: 'flex-start',
              flexWrap: 'wrap',
            }} className="chat-input-toolbar">
              {/* Reasoning toggle button */}
              {(
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <button
                    ref={reasoningBtnRef}
                    type="button"
                    aria-label={reasoningActive ? `Thinking: ${currentEffort}` : 'Enable thinking'}
                    aria-expanded={showReasoningPopover}
                    onClick={() => setShowReasoningPopover(!showReasoningPopover)}
                    title={reasoningActive ? `Thinking: ${currentEffort}` : 'Enable thinking'}
                    style={{
                      height: '32px',
                      padding: '0 10px',
                      borderRadius: 'var(--radius-md)',
                      background: reasoningActive ? 'var(--accent-soft)' : 'var(--bg-surface)',
                      border: `1px solid ${reasoningActive ? 'var(--border-accent)' : 'var(--border)'}`,
                      color: reasoningActive ? 'var(--accent)' : 'var(--text-muted)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      transition: 'all 0.2s ease',
                      position: 'relative',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                    }}
                    onMouseEnter={(e) => {
                      if (!reasoningActive) {
                        e.currentTarget.style.background = 'var(--bg-hover)';
                        e.currentTarget.style.borderColor = 'var(--border-light)';
                      } else {
                        e.currentTarget.style.background = 'var(--accent-soft)';
                        e.currentTarget.style.boxShadow = '0 0 12px var(--accent-soft)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!reasoningActive) {
                        e.currentTarget.style.background = 'var(--bg-surface)';
                        e.currentTarget.style.borderColor = 'var(--border)';
                      } else {
                        e.currentTarget.style.background = 'var(--accent-soft)';
                        e.currentTarget.style.boxShadow = 'none';
                      }
                    }}
                  >
                    <Brain size={14} />
                    <span className="toolbar-button-text">Think</span>
                    {/* Active glow dot */}
                    {reasoningActive && (
                      <div style={{
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        background: 'var(--accent)',
                        boxShadow: '0 0 6px rgb(var(--copper-rgb) / 0.6)',
                      }} />
                    )}
                  </button>

                  {/* Reasoning Popover */}
                  <AnimatePresence>
                    {showReasoningPopover && (
                      <motion.div
                        ref={reasoningPopoverRef}
                        initial={{ opacity: 0, y: 8, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.96 }}
                        transition={{ duration: 0.15 }}
                        style={{
                          position: 'absolute',
                          bottom: 'calc(100% + 8px)',
                          left: '0',
                          width: '260px',
                          maxWidth: 'calc(100vw - 24px)',
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border-light)',
                          borderRadius: 'var(--radius-md)',
                          boxShadow: 'var(--shadow-lg)',
                          overflow: 'hidden',
                          zIndex: 100,
                        }}
                      >
                        {/* Header with toggle */}
                        <div style={{
                          padding: '12px 14px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          borderBottom: '1px solid var(--border)',
                        }}>
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                          }}>
                            <Brain size={14} style={{ color: reasoningActive ? 'var(--accent)' : 'var(--text-muted)' }} />
                            <span style={{
                              fontSize: '0.8125rem',
                              fontWeight: 600,
                              color: 'var(--text-primary)',
                              letterSpacing: '0.01em',
                            }}>
                              Thinking
                            </span>
                          </div>
                          {/* Mini toggle */}
                          <div
                            onClick={(e) => { e.stopPropagation(); toggleReasoning(); }}
                            style={{
                              width: '34px',
                              height: '18px',
                              borderRadius: '9px',
                              background: reasoningActive ? 'var(--accent)' : 'var(--bg-base)',
                              border: `1px solid ${reasoningActive ? 'var(--accent)' : 'var(--border)'}`,
                              position: 'relative',
                              cursor: 'pointer',
                              transition: 'all 0.2s ease',
                              flexShrink: 0,
                            }}
                          >
                            <div style={{
                              width: '14px',
                              height: '14px',
                              borderRadius: '50%',
                              background: reasoningActive ? '#ffffff' : 'var(--text-muted)',
                              position: 'absolute',
                              top: '1px',
                              left: reasoningActive ? '17px' : '1px',
                              transition: 'all 0.2s ease',
                            }} />
                          </div>
                        </div>

                        {/* Effort levels */}
                        {reasoningActive && (
                          <div style={{ padding: '10px 14px 12px' }}>
                            <div style={{
                              fontSize: '0.625rem',
                              fontWeight: 600,
                              color: 'var(--text-muted)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.08em',
                              marginBottom: '8px',
                            }}>
                              Effort
                            </div>
                            <div style={{
                              display: 'flex',
                              gap: '0',
                              background: 'var(--bg-base)',
                              borderRadius: 'var(--radius-sm)',
                              border: '1px solid var(--border)',
                              padding: '2px',
                            }}>
                              {EFFORT_OPTIONS.map((opt) => {
                                const isActive = currentEffort === opt.value;
                                return (
                                  <button
                                    key={opt.value}
                                    onClick={() => setEffort(opt.value)}
                                    style={{
                                      flex: 1,
                                      padding: '5px 2px',
                                      fontSize: '0.6875rem',
                                      fontWeight: isActive ? 600 : 400,
                                      fontFamily: 'var(--font-body)',
                                      border: 'none',
                                      borderRadius: 'calc(var(--radius-sm) - 2px)',
                                      cursor: 'pointer',
                                      transition: 'all 0.12s ease',
                                      background: isActive ? 'var(--accent-soft)' : 'transparent',
                                      color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                                    }}
                                  >
                                    {opt.short}
                                  </button>
                                );
                              })}
                            </div>

                            {/* Info line */}
                            <div style={{
                              marginTop: '8px',
                              fontSize: '0.625rem',
                              color: 'var(--text-muted)',
                              lineHeight: 1.4,
                            }}>
                              Model will show its reasoning process before responding.
                              {!reasoningOverride && (agent?.reasoning_enabled ? (
                                <span style={{ color: 'var(--text-secondary)' }}> Using agent defaults.</span>
                              ) : isGeneralChat && generalChatSettings?.reasoning_enabled ? (
                                <span style={{ color: 'var(--text-secondary)' }}> Using general chat defaults.</span>
                              ) : null)}
                            </div>

                            {/* D5 (Increment 2): launch config caps thinking for this provider.
                                budget === 0 ⇒ fully disabled warning; budget > 0 + reasoning on ⇒
                                neutral cap line; budget < 0 (unlimited) ⇒ render nothing. */}
                            {chatModelIsLlamaCpp && llamacppBudgetHint?.budget === 0 && (
                              <div style={{
                                marginTop: '8px',
                                padding: '6px 8px',
                                background: 'rgba(245, 158, 11, 0.08)',
                                border: '1px solid rgba(245, 158, 11, 0.2)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: '0.625rem',
                                color: 'var(--state-warning)',
                                lineHeight: 1.4,
                              }}>
                                Thinking is fully disabled by the launch config (reasoning_budget = 0).
                              </div>
                            )}
                            {chatModelIsLlamaCpp &&
                              llamacppBudgetHint != null &&
                              llamacppBudgetHint.budget > 0 &&
                              reasoningActive && (
                              <div style={{
                                marginTop: '8px',
                                padding: '6px 8px',
                                background: 'var(--bg-base)',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: '0.625rem',
                                color: 'var(--text-muted)',
                                lineHeight: 1.4,
                              }}>
                                Thinking capped at {llamacppBudgetHint.budget} tokens ({llamacppBudgetHint.source}).
                              </div>
                            )}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Council Toggle */}
              <CouncilToggle disabled={isStreaming} placement="above" />
            </div>
            )}

            {/* Main input row - textarea and send button */}
            <div style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'flex-end',
              minWidth: 0,
            }} className="chat-input-main-row">
            {isMobile && (
              <button
                type="button"
                onClick={() => setOptionsOpen(true)}
                aria-label="Message options"
                style={{
                  width: 44,
                  height: 44,
                  flexShrink: 0,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  color: composerOptionsActive ? 'var(--accent)' : 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  position: 'relative',
                }}
              >
                <SlidersHorizontal size={20} />
                {composerOptionsActive && (
                  <span
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                    }}
                  />
                )}
              </button>
            )}
            <div style={{
              flex: 1,
              minWidth: 0,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              overflow: 'hidden',
              transition: 'border-color var(--transition-fast)',
            }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  addAttachmentsFromFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <input
                ref={sendFileInputRef}
                type="file"
                multiple
                disabled={isStreaming || isSendingFile}
                style={{ display: 'none' }}
                onChange={handleSendFileChange}
              />
              {/* PDF attachments + URL row */}
              {(pendingAttachments.length > 0 || !isStreaming) && (
                <div style={{
                  padding: '10px 14px 0',
                  borderBottom: pendingAttachments.length > 0 ? '1px solid var(--border)' : 'none',
                  paddingBottom: pendingAttachments.length > 0 ? 10 : 0,
                  marginBottom: pendingAttachments.length > 0 ? 0 : 0,
                }}>
                  {pendingAttachments.length > 0 && (
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '6px',
                      marginBottom: '8px',
                    }}>
                      <AnimatePresence>
                        {pendingAttachments.map((a) => (
                          <motion.div
                            key={a.id}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            transition={{ duration: 0.15 }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                              padding: '4px 8px',
                              borderRadius: 'var(--radius-sm)',
                              background: 'var(--accent-glow)',
                              border: '1px solid var(--border-accent)',
                              fontSize: '0.75rem',
                              color: 'var(--text-primary)',
                              maxWidth: '100%',
                            }}
                          >
                            <FileUp size={12} style={{ flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.filename}>
                              {a.filename}
                            </span>
                            {a.url && <span style={{ color: 'var(--text-muted)', fontSize: '0.625rem' }}>URL</span>}
                            <button
                              type="button"
                              aria-label="Remove attachment"
                              onClick={() => removeAttachment(a.id)}
                              style={{
                                padding: 0,
                                border: 'none',
                                background: 'none',
                                color: 'var(--text-muted)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--error)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                            >
                              <X size={12} />
                            </button>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  )}
                  {pendingAttachments.length > 0 && !!(agent as { structured_output_enabled?: boolean })?.structured_output_enabled && (
                    <div style={{
                      fontSize: '0.6875rem',
                      color: 'var(--text-muted)',
                      marginBottom: 6,
                      padding: '4px 0',
                    }}>
                      This agent uses structured JSON output; with PDFs the model may return plain text instead.
                    </div>
                  )}
                  {!isStreaming && !isMobile && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={pendingAttachments.length >= MAX_PDF_ATTACHMENTS}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 10px',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-body)',
                          color: 'var(--text-secondary)',
                          background: 'var(--bg-base)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          cursor: pendingAttachments.length >= MAX_PDF_ATTACHMENTS ? 'not-allowed' : 'pointer',
                          opacity: pendingAttachments.length >= MAX_PDF_ATTACHMENTS ? 0.6 : 1,
                        }}
                      >
                        <FileUp size={12} />
                        Attach PDF
                      </button>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: '120px' }}>
                        <Link size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                        <input
                          type="url"
                          value={pdfUrlInput}
                          onChange={(e) => setPdfUrlInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAttachmentFromUrl())}
                          placeholder="PDF URL"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            padding: '4px 8px',
                            fontSize: '0.75rem',
                            fontFamily: 'var(--font-body)',
                            background: 'var(--bg-base)',
                            border: `1px solid ${pdfUrlError ? 'var(--error)' : 'var(--border)'}`,
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--text-primary)',
                            outline: 'none',
                          }}
                          aria-label="PDF URL"
                        />
                        <button
                          type="button"
                          onClick={addAttachmentFromUrl}
                          style={{
                            padding: '4px 8px',
                            fontSize: '0.6875rem',
                            fontFamily: 'var(--font-body)',
                            color: 'var(--accent)',
                            background: 'transparent',
                            border: '1px solid var(--border-accent)',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                          }}
                        >
                          Add
                        </button>
                      </div>
                      {pdfUrlError && <span style={{ fontSize: '0.6875rem', color: 'var(--error)' }}>{pdfUrlError}</span>}
                      <button
                        type="button"
                        onClick={handleSendToComputerClick}
                        disabled={!activeConversationId || isStreaming || isSendingFile}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 10px',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-body)',
                          color: 'var(--text-secondary)',
                          background: 'var(--bg-base)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          cursor: (!activeConversationId || isStreaming || isSendingFile) ? 'not-allowed' : 'pointer',
                          opacity: (!activeConversationId || isStreaming || isSendingFile) ? 0.6 : 1,
                        }}
                      >
                        <Laptop size={12} />
                        {isSendingFile ? 'Sending…' : 'Send to my computer'}
                      </button>
                      {sendFileError && <span style={{ fontSize: '0.6875rem', color: 'var(--error)' }}>{sendFileError}</span>}
                    </div>
                  )}
                </div>
              )}
              <PremiumMentionInput
                value={inputValue}
                onChange={(val, agentId, skillNames) => {
                  setInputValue(val);
                  setInvokeAgentId(agentId);
                  setInvokeSkillNames(skillNames ?? []);
                }}
                disabled={isStreaming}
                placeholder={isStreaming ? 'Waiting for response...' : 'Send a message... Use @ to mention an agent, / to invoke a skill'}
                agents={agents}
                skills={skills}
                onSubmit={handleSend}
                submitDisabled={!inputValue.trim() || isStreaming}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                minRows={1}
                maxRows={10}
              />
            </div>
            {/* Send / Stop button — Stop is offered both for a locally attached
                stream and while reconciling a server-side turn (the rewritten
                cancelStream cancels upstream via POST /api/chat/stop either way). */}
            {isStreaming || reconciling ? (
              <button
                type="button"
                className="chat-send-btn chat-stop-btn"
                aria-label="Stop generating"
                onClick={cancelStream}
                title="Stop generating"
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: 'var(--radius-md)',
                  background: 'rgba(201, 107, 107, 0.15)',
                  border: '1px solid rgba(201, 107, 107, 0.3)',
                  color: 'var(--error)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(201, 107, 107, 0.25)';
                  e.currentTarget.style.boxShadow = '0 0 12px rgba(201, 107, 107, 0.2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(201, 107, 107, 0.15)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <StopCircle size={20} />
              </button>
            ) : (
              <button
                type="button"
                className="chat-send-btn"
                aria-label="Send message"
                onClick={handleSend}
                disabled={!inputValue.trim()}
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: 'var(--radius-md)',
                  background: inputValue.trim() ? 'var(--accent)' : 'var(--bg-elevated)',
                  border: '1px solid transparent',
                  color: inputValue.trim() ? 'var(--text-inverse)' : 'var(--text-muted)',
                  cursor: inputValue.trim() ? 'pointer' : 'not-allowed',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'all var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  if (inputValue.trim()) {
                    e.currentTarget.style.background = 'var(--accent-hover)';
                    e.currentTarget.style.boxShadow = 'var(--shadow-glow)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (inputValue.trim()) {
                    e.currentTarget.style.background = 'var(--accent)';
                    e.currentTarget.style.boxShadow = 'none';
                  }
                }}
              >
                <Send size={18} />
              </button>
            )}
          </div>
          </div>
          <div className="chat-input-hints" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 4px 0',
            gap: '12px',
            flexWrap: 'wrap',
          }}>
            <span style={{
              fontSize: '0.6875rem',
              color: isStreaming ? 'var(--error)' : 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
            }}>
              {isStreaming ? (
                <>
                  <StreamingTokenCounter
                    streamingContent={streamingContent}
                    reasoningContent={reasoningContent}
                    streamStartTime={streamStartTime}
                  />
                  <span style={{ marginLeft: '8px', color: 'var(--error)' }}>
                    {isMobile ? '· stop' : '· click stop to cancel'}
                  </span>
                </>
              ) : (
                <>
                  {isMobile ? 'Enter to send' : 'Enter to send · Shift+Enter for new line'}
                  {reasoningActive && (
                    <span style={{ color: 'var(--accent)', marginLeft: '8px' }}>
                      · Thinking: {currentEffort}
                    </span>
                  )}
                  {pendingAttachments.length > 0 && (
                    <span style={{ marginLeft: '8px' }}>
                      · {pendingAttachments.length} PDF{pendingAttachments.length !== 1 ? 's' : ''} (max {MAX_PDF_ATTACHMENTS}, {MAX_PDF_MB} MB each)
                    </span>
                  )}
                </>
              )}
            </span>
            {!isStreaming && !isMobile && (
              <select
                value={pdfEngine}
                onChange={(e) => setPdfEngine((e.target.value || '') as '' | PDFEngine)}
                title="PDF processing engine"
                aria-label="PDF engine"
                style={{
                  fontSize: '0.6875rem',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '2px 6px',
                  cursor: 'pointer',
                }}
              >
                {PDF_ENGINE_OPTIONS.map((opt) => (
                  <option key={opt.value || 'auto'} value={opt.value} title={opt.title}>
                    PDF: {opt.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Mobile composer options — everything that used to crowd the toolbar */}
      {isMobile && (
        <Sheet isOpen={optionsOpen} onClose={() => setOptionsOpen(false)} title="Message options">
          <div className="composer-options">
            <section className="composer-options-section">
              <div className="composer-options-row">
                <span className="composer-options-label"><Brain size={15} /> Thinking</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={reasoningActive}
                  onClick={toggleReasoning}
                  className={`composer-switch ${reasoningActive ? 'is-on' : ''}`}
                  aria-label="Toggle thinking"
                >
                  <span className="composer-switch-knob" />
                </button>
              </div>
              {reasoningActive && (
                <div className="composer-effort">
                  {EFFORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={currentEffort === opt.value ? 'is-active' : ''}
                      onClick={() => setEffort(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="composer-options-section">
              <span className="composer-options-label"><Users size={15} /> Council</span>
              <CouncilToggle disabled={isStreaming} placement="above" />
            </section>

            <section className="composer-options-section">
              <span className="composer-options-label"><Cpu size={15} /> Model for this conversation</span>
              <div className="composer-options-controls">
                <ModelSelectorCore
                  variant="conversation"
                  value={effectiveConversationModel}
                  onChange={handleConversationModelChange}
                  agentModel={defaultModelForChat}
                  conversationModel={activeConversation?.model ?? null}
                  disabled={isStreaming}
                  compact
                />
                <ProviderRoutingSelector
                  modelId={effectiveConversationModel ?? defaultModelForChat}
                  value={effectiveConversationProviderRouting}
                  onChange={handleConversationProviderRoutingChange}
                  inheritedRouting={defaultProviderRoutingForChat}
                  disabled={isStreaming}
                  allowDefault
                  compact
                />
              </div>
            </section>

            <section className="composer-options-section">
              <span className="composer-options-label"><Wrench size={15} /> Tools for this conversation</span>
              <div className="composer-options-controls">
                <ConversationToolsSelector
                  toolIds={effectiveConversationToolConfig.toolIds}
                  mcpServerIds={effectiveConversationToolConfig.mcpServerIds}
                  overrideActive={effectiveConversationToolConfig.overrideActive}
                  onApply={handleConversationToolConfigApply}
                  onReset={handleConversationToolConfigReset}
                  disabled={isStreaming || !activeConversationId}
                  compact
                />
              </div>
            </section>

            <section className="composer-options-section">
              <span className="composer-options-label"><Layers size={15} /> Skills for this conversation</span>
              <div className="composer-options-controls">
                <ConversationSkillsSelector
                  skillIds={effectiveConversationSkillConfig.skillIds}
                  overrideActive={effectiveConversationSkillConfig.overrideActive}
                  onApply={handleConversationSkillConfigApply}
                  onReset={handleConversationSkillConfigReset}
                  disabled={isStreaming || !activeConversationId}
                  compact
                />
              </div>
            </section>

            {!isStreaming && (
              <section className="composer-options-section">
                <span className="composer-options-label"><FileUp size={15} /> PDF attachments</span>
                <div className="composer-options-controls">
                  <button
                    type="button"
                    className="composer-options-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={pendingAttachments.length >= MAX_PDF_ATTACHMENTS}
                  >
                    <FileUp size={14} /> Attach PDF
                  </button>
                </div>
                <div className="composer-options-controls">
                  <Link size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <input
                    type="url"
                    value={pdfUrlInput}
                    onChange={(e) => setPdfUrlInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAttachmentFromUrl())}
                    placeholder="PDF URL"
                    className="composer-options-input"
                    aria-label="PDF URL"
                  />
                  <button type="button" className="composer-options-btn" onClick={addAttachmentFromUrl}>
                    Add
                  </button>
                </div>
                {pdfUrlError && (
                  <span style={{ fontSize: '0.6875rem', color: 'var(--error)' }}>{pdfUrlError}</span>
                )}
                <span className="composer-options-label" style={{ marginTop: 4 }}>PDF engine</span>
                <select
                  value={pdfEngine}
                  onChange={(e) => setPdfEngine((e.target.value || '') as '' | PDFEngine)}
                  className="composer-options-input"
                  aria-label="PDF engine"
                >
                  {PDF_ENGINE_OPTIONS.map((opt) => (
                    <option key={opt.value || 'auto'} value={opt.value} title={opt.title}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </section>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
