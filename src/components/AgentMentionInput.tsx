import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Bot } from 'lucide-react';
import type { Agent } from '../types';

interface AgentMentionInputProps {
  value: string;
  onChange: (value: string, invokeAgentId?: string) => void;
  disabled?: boolean;
  placeholder?: string;
  agents: Agent[];
}

interface MentionedAgent {
  id: string;
  name: string;
  emoji: string;
}

export function AgentMentionInput({
  value,
  onChange,
  disabled = false,
  placeholder = 'Send a message...',
  agents,
}: AgentMentionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionedAgent, setMentionedAgent] = useState<MentionedAgent | null>(null);

  // Filter agents based on search query
  const filteredAgents = useMemo(() => {
    if (!searchQuery) return agents;
    const query = searchQuery.toLowerCase();
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(query) ||
        agent.description.toLowerCase().includes(query)
    );
  }, [agents, searchQuery]);

  // Detect @ mention trigger
  const checkForMention = useCallback(() => {
    const text = value;
    const cursor = cursorPosition;

    // Look for @ before cursor
    let atIndex = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      if (text[i] === '@') {
        atIndex = i;
        break;
      }
      // Stop if we hit a space or newline before finding @
      if (text[i] === ' ' || text[i] === '\n') {
        break;
      }
    }

    if (atIndex !== -1) {
      const query = text.slice(atIndex + 1, cursor);
      // Don't trigger if there's a space in the query
      if (!query.includes(' ')) {
        setMentionStart(atIndex);
        setSearchQuery(query);
        setShowDropdown(true);
        setSelectedIndex(0);
        return;
      }
    }

    setShowDropdown(false);
    setMentionStart(-1);
  }, [value, cursorPosition]);

  // Check for mention on value or cursor change
  useEffect(() => {
    checkForMention();
  }, [checkForMention]);

  // Handle agent selection
  const selectAgent = useCallback((agent: Agent) => {
    if (mentionStart === -1) return;

    const beforeMention = value.slice(0, mentionStart);
    const afterCursor = value.slice(cursorPosition);
    const newValue = beforeMention + afterCursor;

    setMentionedAgent({
      id: agent.id,
      name: agent.name,
      emoji: agent.emoji,
    });
    onChange(newValue, agent.id);
    setShowDropdown(false);
    setMentionStart(-1);
    setSearchQuery('');

    // Focus back to textarea
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  }, [value, cursorPosition, mentionStart, onChange]);

  // Remove mentioned agent
  const removeMentionedAgent = useCallback(() => {
    setMentionedAgent(null);
    onChange(value, undefined);
  }, [value, onChange]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showDropdown) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Allow parent to handle send
        return;
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < filteredAgents.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
        break;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        if (filteredAgents[selectedIndex]) {
          selectAgent(filteredAgents[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setShowDropdown(false);
        break;
    }
  }, [showDropdown, filteredAgents, selectedIndex, selectAgent]);

  // Handle input change
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const newCursor = e.target.selectionStart;
    setCursorPosition(newCursor);

    // If we had a mentioned agent and user is typing, remove it
    if (mentionedAgent && newValue !== value) {
      setMentionedAgent(null);
      onChange(newValue, undefined);
    } else {
      onChange(newValue, mentionedAgent?.id);
    }
  }, [value, mentionedAgent, onChange]);

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [value]);

  // Calculate dropdown position
  const dropdownPosition = useMemo(() => {
    if (!textareaRef.current || mentionStart === -1) return { top: 0, left: 0 };

    const textarea = textareaRef.current;
    const textBeforeMention = value.slice(0, mentionStart);
    const lines = textBeforeMention.split('\n');
    const currentLineIndex = lines.length - 1;

    // Approximate position based on line height and character width
    const lineHeight = 24; // Approximate line height in pixels
    const charWidth = 9; // Approximate character width
    const currentLineLength = lines[currentLineIndex].length;

    const top = (currentLineIndex + 1) * lineHeight;
    const left = Math.min(currentLineLength * charWidth, textarea.clientWidth - 200);

    return { top, left };
  }, [value, mentionStart]);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {/* Mentioned Agent Chip */}
      <AnimatePresence>
        {mentionedAgent && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 10 }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              marginBottom: '8px',
              background: 'var(--accent-glow)',
              border: '1px solid var(--border-accent)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.8125rem',
              color: 'var(--text-primary)',
            }}
          >
            <span>{mentionedAgent.emoji}</span>
            <span style={{ fontWeight: 500 }}>{mentionedAgent.name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
              will process this message
            </span>
            <button
              onClick={removeMentionedAgent}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '2px',
                marginLeft: '4px',
                background: 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                color: 'var(--text-muted)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--error)';
                e.currentTarget.style.background = 'var(--bg-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-muted)';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={(e) => setCursorPosition(e.currentTarget.selectionStart)}
        onKeyUp={(e) => setCursorPosition(e.currentTarget.selectionStart)}
        placeholder={disabled ? 'Waiting for response...' : placeholder}
        disabled={disabled}
        rows={1}
        style={{
          width: '100%',
          padding: '14px 18px',
          fontSize: '0.938rem',
          fontFamily: 'var(--font-body)',
          background: 'transparent',
          color: 'var(--text-primary)',
          border: 'none',
          outline: 'none',
          resize: 'none',
          lineHeight: 1.5,
          maxHeight: '200px',
        }}
      />

      {/* Agent Dropdown */}
      <AnimatePresence>
        {showDropdown && filteredAgents.length > 0 && (
          <motion.div
            ref={dropdownRef}
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            style={{
              position: 'absolute',
              top: dropdownPosition.top,
              left: dropdownPosition.left,
              width: '280px',
              maxHeight: '240px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-light)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-lg)',
              overflow: 'hidden',
              zIndex: 100,
              marginTop: '4px',
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid var(--border)',
                fontSize: '0.6875rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Select Agent
            </div>

            {/* Agent List */}
            <div
              style={{
                maxHeight: '200px',
                overflowY: 'auto',
              }}
            >
              {filteredAgents.map((agent, index) => (
                <button
                  key={agent.id}
                  onClick={() => selectAgent(agent)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    width: '100%',
                    padding: '10px 12px',
                    background:
                      index === selectedIndex
                        ? 'var(--bg-hover)'
                        : 'transparent',
                    border: 'none',
                    borderLeft:
                      index === selectedIndex
                        ? '3px solid var(--accent)'
                        : '3px solid transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.1s ease',
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--accent-glow)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '1rem',
                      flexShrink: 0,
                    }}
                  >
                    {agent.emoji || <Bot size={16} />}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: '0.875rem',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {agent.name}
                    </div>
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {agent.description || 'No description'}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {/* Footer hint */}
            <div
              style={{
                padding: '6px 12px',
                borderTop: '1px solid var(--border)',
                fontSize: '0.6875rem',
                color: 'var(--text-muted)',
                background: 'var(--bg-base)',
              }}
            >
              ↑↓ to navigate · Enter to select · Esc to close
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
