import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AtSign, Bot, X, Sparkles, Layers } from 'lucide-react';
import type { Agent, Skill } from '../../types';

interface PremiumMentionInputProps {
  value: string;
  onChange: (value: string, invokeAgentId?: string, invokeSkillNames?: string[]) => void;
  agents: Agent[];
  skills: Skill[];
  placeholder?: string;
  disabled?: boolean;
  maxRows?: number;
  minRows?: number;
  onSubmit?: () => void;
  submitDisabled?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}

interface Mention {
  agent: Agent;
  startIndex: number;
  endIndex: number;
}

interface SkillMention {
  skill: Skill;
  startIndex: number;
  endIndex: number;
}

export function PremiumMentionInput({
  value,
  onChange,
  agents,
  skills,
  placeholder = 'Type a message... Use @ to invoke an agent',
  disabled = false,
  maxRows = 10,
  minRows = 1,
  onSubmit,
  submitDisabled,
  onFocus,
  onBlur,
}: PremiumMentionInputProps) {
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState<number | null>(null);
  const [activeMention, setActiveMention] = useState<Mention | null>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });
  const [showSkillDropdown, setShowSkillDropdown] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [skillHighlightedIndex, setSkillHighlightedIndex] = useState(0);
  const [skillStartPos, setSkillStartPos] = useState<number | null>(null);
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

  // Extract every `/skill-name` mention from text (unlike extractMentions/activeMention,
  // every match matters here, not just the last — there is no floating badge for skills,
  // so we don't need singular "active" tracking, only the deduplicated name list below).
  const extractSkillMentions = useCallback((text: string): SkillMention[] => {
    const skillMentions: SkillMention[] = [];
    const skillRegex = /(?:^|\s)\/([a-z0-9-]+)/gi;
    let match;
    while ((match = skillRegex.exec(text)) !== null) {
      const skillName = match[1];
      const skill = skills.find(
        (s) => s.name.toLowerCase() === skillName.toLowerCase()
      );
      if (skill) {
        const slashIndex = match[0].startsWith('/') ? match.index : match.index + 1;
        skillMentions.push({
          skill,
          startIndex: slashIndex,
          endIndex: slashIndex + 1 + skillName.length,
        });
      }
    }
    return skillMentions;
  }, [skills]);

  // Deduplicated skill names currently mentioned in `text` — computed fresh at every
  // onChange call site rather than duplicating the dedup logic at each one.
  const currentSkillNames = useCallback((text: string): string[] | undefined => {
    const names = Array.from(new Set(extractSkillMentions(text).map((m) => m.skill.name)));
    return names.length > 0 ? names : undefined;
  }, [extractSkillMentions]);

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

  // Filter skills based on skill query
  const filteredSkills = useMemo(() => {
    if (!skillQuery) return skills.slice(0, 6);
    const query = skillQuery.toLowerCase();
    return skills
      .filter(
        (skill) =>
          skill.name.toLowerCase().includes(query) ||
          (skill.description?.toLowerCase() || '').includes(query)
      )
      .sort((a, b) => {
        const aNameMatch = a.name.toLowerCase().startsWith(query) ? 2 : a.name.toLowerCase().includes(query) ? 1 : 0;
        const bNameMatch = b.name.toLowerCase().startsWith(query) ? 2 : b.name.toLowerCase().includes(query) ? 1 : 0;
        return bNameMatch - aNameMatch;
      })
      .slice(0, 6);
  }, [skills, skillQuery]);

  // Handle input changes
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const newCursorPos = e.target.selectionStart;
    setCursorPosition(newCursorPos);
    onChange(newValue, activeMention?.agent.id, currentSkillNames(newValue));

    // Check if we're in a mention (@) or skill (/) context. The two trigger
    // characters are mutually exclusive at any one cursor position — whichever
    // one last occurs closer to the cursor wins.
    const textBeforeCursor = newValue.slice(0, newCursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    const lastSlashIndex = textBeforeCursor.lastIndexOf('/');

    const textAfterAt = lastAtIndex !== -1 ? textBeforeCursor.slice(lastAtIndex + 1) : '';
    const hasSpaceAfterAt = textAfterAt.includes(' ');
    const atActive = lastAtIndex !== -1 && !hasSpaceAfterAt && newCursorPos > lastAtIndex;

    const textAfterSlash = lastSlashIndex !== -1 ? textBeforeCursor.slice(lastSlashIndex + 1) : '';
    const hasSpaceAfterSlash = textAfterSlash.includes(' ');
    const slashActive = lastSlashIndex !== -1 && !hasSpaceAfterSlash && newCursorPos > lastSlashIndex;

    if (atActive && (!slashActive || lastAtIndex > lastSlashIndex)) {
      setMentionQuery(textAfterAt);
      setMentionStartPos(lastAtIndex);
      setShowMentionDropdown(true);
      setHighlightedIndex(0);
      setShowSkillDropdown(false);
      setSkillQuery('');
      setSkillStartPos(null);
      updateDropdownPosition();
    } else if (slashActive && (!atActive || lastSlashIndex > lastAtIndex)) {
      setSkillQuery(textAfterSlash);
      setSkillStartPos(lastSlashIndex);
      setShowSkillDropdown(true);
      setSkillHighlightedIndex(0);
      setShowMentionDropdown(false);
      setMentionQuery('');
      setMentionStartPos(null);
      updateDropdownPosition();
    } else {
      setShowMentionDropdown(false);
      setMentionQuery('');
      setMentionStartPos(null);
      setShowSkillDropdown(false);
      setSkillQuery('');
      setSkillStartPos(null);
    }
  };

  // Select an agent from the dropdown
  const selectAgent = useCallback((agent: Agent) => {
    if (mentionStartPos !== null) {
      const beforeMention = value.slice(0, mentionStartPos);
      const afterCursor = value.slice(cursorPosition);
      const newValue = `${beforeMention}@${agent.name} ${afterCursor}`;
      onChange(newValue, agent.id, currentSkillNames(newValue));
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
  }, [mentionStartPos, value, cursorPosition, onChange, currentSkillNames]);

  // Select a skill from the dropdown — mirrors selectAgent exactly.
  const selectSkill = useCallback((skill: Skill) => {
    if (skillStartPos !== null) {
      const beforeSkill = value.slice(0, skillStartPos);
      const afterCursor = value.slice(cursorPosition);
      const newValue = `${beforeSkill}/${skill.name} ${afterCursor}`;
      onChange(newValue, activeMention?.agent.id, currentSkillNames(newValue));
      setShowSkillDropdown(false);
      setSkillQuery('');
      setSkillStartPos(null);

      // Focus and set cursor position after the skill mention
      setTimeout(() => {
        if (textareaRef.current) {
          const newCursorPos = skillStartPos + skill.name.length + 2; // +2 for / and space
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
    }
  }, [skillStartPos, value, cursorPosition, onChange, activeMention, currentSkillNames]);

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
    } else if (showSkillDropdown && filteredSkills.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSkillHighlightedIndex((prev) =>
            prev < filteredSkills.length - 1 ? prev + 1 : prev
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSkillHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (filteredSkills[skillHighlightedIndex]) {
            selectSkill(filteredSkills[skillHighlightedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setShowSkillDropdown(false);
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
      if (showMentionDropdown || showSkillDropdown) {
        updateDropdownPosition();
      }
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [showMentionDropdown, showSkillDropdown, updateDropdownPosition]);

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowMentionDropdown(false);
        setShowSkillDropdown(false);
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
      const newValue = before + after;
      onChange(newValue, undefined, currentSkillNames(newValue));
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
          onFocus={onFocus}
          onBlur={onBlur}
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

      {/* Skill Dropdown - same fixed-position structure as the agent mention dropdown */}
      <AnimatePresence>
        {showSkillDropdown && filteredSkills.length > 0 && (
          <motion.div
            className="mention-dropdown"
            role="listbox"
            aria-label="Invoke skill"
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
              <Layers size={14} style={{ color: 'var(--accent)' }} />
              <span
                style={{
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                Invoke Skill
              </span>
            </div>

            {/* Skill List */}
            <div style={{ overflow: 'auto', flex: 1, padding: '4px' }}>
              {filteredSkills.map((skill, index) => (
                <motion.button
                  key={skill.id}
                  type="button"
                  role="option"
                  aria-selected={index === skillHighlightedIndex}
                  className="mention-dropdown-item"
                  onClick={() => selectSkill(skill)}
                  onMouseEnter={() => setSkillHighlightedIndex(index)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    marginBottom: '2px',
                    background: index === skillHighlightedIndex ? 'var(--bg-hover)' : 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    borderLeft: `3px solid ${index === skillHighlightedIndex ? 'var(--accent)' : 'transparent'}`,
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
                    <Layers size={16} style={{ color: 'var(--accent)' }} />
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
                      {skill.name}
                    </div>
                    {skill.description && (
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
                        {skill.description}
                      </div>
                    )}
                  </div>
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
