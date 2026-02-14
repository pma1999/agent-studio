import React, { useMemo, useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ArrowDownToLine, ArrowUpFromLine, Coins, Zap, Database } from 'lucide-react';
import type { Message } from '../types';

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.0001) return '<$0.0001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(4)}`;
}

// Conversation-level token summary for the chat header
export function ConversationTokenSummary({ messages }: { messages: Message[] }) {
  const { promptTokens, completionTokens, cost, cachedTokens } = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let totalCost = 0;
    let cached = 0;
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      prompt += msg.prompt_tokens ?? 0;
      completion += msg.completion_tokens ?? 0;
      totalCost += msg.cost ?? 0;
      cached += msg.cached_tokens ?? 0;
    }
    return { promptTokens: prompt, completionTokens: completion, cost: totalCost, cachedTokens: cached };
  }, [messages]);

  const hasAny = promptTokens > 0 || completionTokens > 0 || cost > 0;
  if (!hasAny) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="conversation-token-summary"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '10px',
        padding: '4px 12px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        fontSize: '0.6875rem',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Prompt tokens (in)">
        <ArrowDownToLine size={10} style={{ color: 'var(--accent)' }} />
        {formatTokens(promptTokens)} in
      </span>
      <span style={{ width: '1px', height: '10px', background: 'var(--border)' }} />
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Completion tokens (out)">
        <ArrowUpFromLine size={10} style={{ color: 'var(--success)' }} />
        {formatTokens(completionTokens)} out
      </span>
      {cachedTokens > 0 && (
        <>
          <span style={{ width: '1px', height: '10px', background: 'var(--border)' }} />
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '3px',
              color: 'var(--text-secondary)',
            }}
            title="Cached tokens (cost savings)"
          >
            <Database size={10} />
            {formatTokens(cachedTokens)} cached
          </span>
        </>
      )}
      <span style={{ width: '1px', height: '10px', background: 'var(--border)' }} />
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }} title="Total cost">
        <Coins size={11} />
        {formatCost(cost)}
      </span>
    </motion.div>
  );
}

// Live streaming token counter (estimated tokens + speed)
export function StreamingTokenCounter({
  streamingContent,
  reasoningContent,
  streamStartTime,
}: {
  streamingContent: string;
  reasoningContent: string;
  streamStartTime: number | null;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!streamStartTime) return;
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - streamStartTime) / 1000));
    }, 500);
    return () => clearInterval(t);
  }, [streamStartTime]);

  const estimatedTokens = useMemo(() => {
    const chars = streamingContent.length + reasoningContent.length;
    return Math.ceil(chars / 4);
  }, [streamingContent.length, reasoningContent.length]);

  const tokensPerSec = streamStartTime && elapsed > 0 ? (estimatedTokens / elapsed).toFixed(1) : '—';

  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="streaming-token-counter"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '10px',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.6875rem',
        color: 'var(--text-muted)',
      }}
    >
      <span className="token-pulse-dot" style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: 'var(--accent)',
        flexShrink: 0,
      }} />
      <span title="Estimated output tokens">~{formatTokens(estimatedTokens)} tok</span>
      <span style={{ color: 'var(--border-light)' }}>·</span>
      <span title="Tokens per second">
        <Zap size={10} style={{ verticalAlign: 'middle', marginRight: '2px', color: 'var(--accent)' }} />
        ~{tokensPerSec} tok/s
      </span>
      <span style={{ color: 'var(--border-light)' }}>·</span>
      <span>{elapsed}s</span>
    </motion.span>
  );
}

// Per-message token pills (always visible)
export function MessageTokenPills({ message }: { message: Message }) {
  const cost = message.cost ?? 0;
  const promptTokens = message.prompt_tokens ?? 0;
  const completionTokens = message.completion_tokens ?? 0;
  const reasoningTokens = message.reasoning_tokens ?? 0;
  const cachedTokens = message.cached_tokens ?? 0;

  if (cost === 0 && promptTokens === 0 && completionTokens === 0) return null;

  const parts: React.ReactNode[] = [];
  if (promptTokens > 0 || completionTokens > 0) {
    parts.push(
      <span key="inout" className="token-pill">
        {promptTokens > 0 && `${formatTokens(promptTokens)} in`}
        {promptTokens > 0 && completionTokens > 0 && ' · '}
        {completionTokens > 0 && `${formatTokens(completionTokens)} out`}
      </span>
    );
  }
  if (reasoningTokens > 0) {
    parts.push(
      <span key="reasoning" className="token-pill token-pill-reasoning">
        {formatTokens(reasoningTokens)} reasoning
      </span>
    );
  }
  if (cachedTokens > 0) {
    parts.push(
      <span key="cached" className="token-pill token-pill-cached" title="Cached (cost savings)">
        <Database size={9} style={{ verticalAlign: 'middle', marginRight: '2px' }} />
        {formatTokens(cachedTokens)} cached
      </span>
    );
  }
  if (cost > 0) {
    parts.push(
      <span key="cost" className="token-pill token-pill-cost">
        {formatCost(cost)}
      </span>
    );
  }

  return (
    <div
      className="message-token-pills"
      style={{
        marginTop: '8px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px',
      }}
    >
      {parts}
    </div>
  );
}
