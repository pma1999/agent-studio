import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AtSign, Bot, X, Sparkles } from 'lucide-react';
import type { Agent } from '../../types';

interface PremiumMentionInputProps {
  value: string;
  onChange: (value: string, invokeAgentId?: string) => void;
  agents: Agent[];
  placeholder?: string;
  disabled?: boolean;
  maxRows?: number;
  minRows?: number;
  onSubmit?: () => void;
  submitDisabled?: boolean;
}

interface Mention {
  agent: Agent;
  startIndex: number;
  endIndex: number;
}

export function PremiumMentionInput({
  value,
  onChange,
  agents,
  placeholder = 'Type a message... Use @ to invoke an agent',
  disabled = false,
  maxRows = 10,
  minRows = 1,
  onSubmit,
  submitDisabled,
}: PremiumMentionInputProps) {
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState<number | null>(null);
  const [activeMention, setActiveMention] = useState<Mention | null>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Extract mentions from text
  const extractMentions = useCallback((text: string): Mention[] => {
    const mentions: Mention[] = [];
    const mentionRegex = /@(\w+)/g;
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      const agentName = match[1];
      const agent = agents.find(
        (a) => a.name.toLowerCase() === agentName.toLowerCase()
      );
      if (agent) {
        mentions.push({
          agent,
          startIndex: match.index,
          endIndex: match.index + match[0].length,
        });
      }
    }
    return mentions;
  }, [agents]);

  // Get active mention (the last one)
  const mentions = useMemo(() => extractMentions(value), [extractMentions, value]);

  useEffect(() => {
    if (mentions.length > 0) {
      setActiveMention(mentions[mentions.length - 1]);
    } else {
      setActiveMention(null);
    }
  }, [mentions]);

  // Calculate dropdown position
  const updateDropdownPosition = useCallback(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.top - 8, // Position above the container
        left: rect.left,
        width: rect.width,
      });
    }
  }, []);

  // Filter agents based on mention query
  const filteredAgents = useMemo(() => {
    if (!mentionQuery) return agents.slice(0, 6);
    const query = mentionQuery.toLowerCase();
    return agents
      .filter(
        (agent) =>
          agent.name.toLowerCase().includes(query) ||
          (agent.description?.toLowerCase() || '').includes(query)
      )
      .sort((a, b) => {
        const aNameMatch = a.name.toLowerCase().startsWith(query) ? 2 : a.name.toLowerCase().includes(query) ? 1 : 0;
        const bNameMatch = b.name.toLowerCase().startsWith(query) ? 2 : b.name.toLowerCase().includes(query) ? 1 : 0;
        return bNameMatch - aNameMatch;
      })
      .slice(0, 6);
  }, [agents, mentionQuery]);

  // Handle input changes
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const newCursorPos = e.target.selectionStart;
    setCursorPosition(newCursorPos);
    onChange(newValue, activeMention?.agent.id);

    // Check if we're in a mention context
    const textBeforeCursor = newValue.slice(0, newCursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex !== -1) {
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
      const hasSpaceAfterAt = textAfterAt.includes(' ');

      if (!hasSpaceAfterAt && newCursorPos > lastAtIndex) {
        setMentionQuery(textAfterAt);
        setMentionStartPos(lastAtIndex);
        setShowMentionDropdown(true);
        setHighlightedIndex(0);
        updateDropdownPosition();
      } else {
        setShowMentionDropdown(false);
        setMentionQuery('');
        setMentionStartPos(null);
      }
    } else {
      setShowMentionDropdown(false);
      setMentionQuery('');
      setMentionStartPos(null);
    }
  };

  // Select an agent from the dropdown
  const selectAgent = useCallback((agent: Agent) => {
    if (mentionStartPos !== null) {
      const beforeMention = value.slice(0, mentionStartPos);
      const afterCursor = value.slice(cursorPosition);
      const newValue = `${beforeMention}@${agent.name} ${afterCursor}`;
      onChange(newValue, agent.id);
      setShowMentionDropdown(false);
      setMentionQuery('');
      setMentionStartPos(null);

      // Focus and set cursor position after the mention
      setTimeout(() => {
        if (textareaRef.current) {
          const newCursorPos = mentionStartPos + agent.name.length + 2; // +2 for @ and space
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
    }
  }, [mentionStartPos, value, cursorPosition, onChange]);

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMentionDropdown && filteredAgents.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < filteredAgents.length - 1 ? prev + 1 : prev
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (filteredAgents[highlightedIndex]) {
            selectAgent(filteredAgents[highlightedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setShowMentionDropdown(false);
          break;
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (onSubmit && !submitDisabled) {
        onSubmit();
      }
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      const lineHeight = 24;
      const minHeight = minRows * lineHeight;
      const maxHeight = maxRows * lineHeight;
      textareaRef.current.style.height = `${Math.min(Math.max(scrollHeight, minHeight), maxHeight)}px`;
    }
  }, [value, minRows, maxRows]);

  // Update position on window resize/scroll
  useEffect(() => {
    const handleResize = () => {
      if (showMentionDropdown) {
        updateDropdownPosition();
      }
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [showMentionDropdown, updateDropdownPosition]);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowMentionDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Remove mention
  const removeMention = () => {
    if (activeMention) {
      const before = value.slice(0, activeMention.startIndex);
      const after = value.slice(activeMention.endIndex);
      onChange(before + after, undefined);
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      {/* Active Mention Badge */}
      <AnimatePresence>
        {activeMention && !showMentionDropdown && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.9 }}
            transition={{ duration: 0.2 }}
            style={{
              position: 'absolute',
              top: -40,
              left: 12,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 10px',
              background: 'var(--accent-muted)',
              border: '1px solid var(--border-accent)',
              borderRadius: 'var(--radius-md)',
              zIndex: 10,
            }}
          >
            <Sparkles size={14} style={{ color: 'var(--accent)' }} />
            <span
              style={{
                fontSize: '0.8125rem',
                fontWeight: 500,
                color: 'var(--accent)',
              }}
            >
              Using {activeMention.agent.emoji || '🤖'} {activeMention.agent.name}
            </span>
            <button
              onClick={removeMention}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '2px',
                background: 'transparent',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                marginLeft: '4px',
              }}
            >
              <X size={12} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Textarea */}
      <div
        style={{
          position: 'relative',
          background: 'var(--bg-elevated)',
          border: `1px solid ${disabled ? 'var(--border)' : 'var(--border-light)'}`,
          borderRadius: 'var(--radius-lg)',
          transition: 'all 0.2s ease',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          rows={minRows}
          style={{
            width: '100%',
            padding: '14px 16px',
            fontSize: '0.9375rem',
            lineHeight: '1.5',
            color: 'var(--text-primary)',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontFamily: 'var(--font-body)',
            minHeight: minRows * 24,
          }}
        />

        {/* @ Hint */}
        {!value && !disabled && (
          <div
            style={{
              position: 'absolute',
              right: 16,
              bottom: 14,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 8px',
              background: 'var(--bg-surface)',
              borderRadius: 'var(--radius-sm)',
              pointerEvents: 'none',
            }}
          >
            <AtSign size={12} style={{ color: 'var(--text-muted)' }} />
            <span
              style={{
                fontSize: '0.6875rem',
                color: 'var(--text-muted)',
                fontWeight: 500,
              }}
            >
              for agents
            </span>
          </div>
        )}
      </div>

      {/* Mention Dropdown - Rendered with fixed position to avoid clipping */}
      <AnimatePresence>
        {showMentionDropdown && filteredAgents.length > 0 && (
          <motion.div
            className="mention-dropdown"
            role="listbox"
            aria-label="Invoke agent"
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            style={{
              position: 'fixed',
              top: Math.max(8, dropdownPos.top - 280),
              left: dropdownPos.left,
              width: typeof window !== 'undefined' ? Math.min(dropdownPos.width, window.innerWidth - 24) : dropdownPos.width,
              maxHeight: '280px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-light)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05)',
              zIndex: 99999,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: '12px 14px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: 'var(--bg-surface)',
                flexShrink: 0,
              }}
            >
              <AtSign size={14} style={{ color: 'var(--accent)' }} />
              <span
                style={{
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                Invoke Agent
              </span>
            </div>

            {/* Agent List */}
            <div style={{ overflow: 'auto', flex: 1, padding: '4px' }}>
              {filteredAgents.map((agent, index) => (
                <motion.button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={index === highlightedIndex}
                  className="mention-dropdown-item"
                  onClick={() => selectAgent(agent)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    marginBottom: '2px',
                    background: index === highlightedIndex ? 'var(--bg-hover)' : 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    borderLeft: `3px solid ${index === highlightedIndex ? 'var(--accent)' : 'transparent'}`,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.1s ease',
                  }}
                >
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--accent-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '1.25rem',
                      flexShrink: 0,
                    }}
                  >
                    {agent.emoji || '🤖'}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {agent.name}
                    </div>
                    {agent.description && (
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          marginTop: '2px',
                        }}
                      >
                        {agent.description}
                      </div>
                    )}
                  </div>
                  <Bot size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                </motion.button>
              ))}
            </div>

            {/* Footer */}
            <div
              style={{
                padding: '10px 14px',
                borderTop: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontSize: '0.6875rem',
                  color: 'var(--text-muted)',
                }}
              >
                Use ↑↓ to navigate, Enter to select, Esc to close
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
