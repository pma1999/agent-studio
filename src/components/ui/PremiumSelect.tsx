import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Search, Check, Sparkles } from 'lucide-react';

interface SelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  badge?: string;
  badgeColor?: string;
  metadata?: { label: string; value: string }[];
  category?: string;
  featured?: boolean;
}

interface PremiumSelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  searchable?: boolean;
  disabled?: boolean;
  loading?: boolean;
  width?: string;
  maxHeight?: string;
  renderTrigger?: (selected: SelectOption | undefined) => React.ReactNode;
}

export function PremiumSelect({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  label,
  searchable = false,
  disabled = false,
  loading = false,
  width = '100%',
  maxHeight = '320px',
  renderTrigger,
}: PremiumSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  // Filter and categorize options
  const filteredOptions = React.useMemo(() => {
    if (!searchQuery) return options;
    const query = searchQuery.toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(query) ||
        o.description?.toLowerCase().includes(query) ||
        o.category?.toLowerCase().includes(query)
    );
  }, [options, searchQuery]);

  const groupedOptions = React.useMemo(() => {
    const groups: Record<string, SelectOption[]> = {};
    filteredOptions.forEach((opt) => {
      const cat = opt.category || 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(opt);
    });
    return groups;
  }, [filteredOptions]);

  // Handle click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search when opened
  useEffect(() => {
    if (isOpen && searchable && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen, searchable]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setIsOpen(true);
        }
        return;
      }

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          setIsOpen(false);
          break;
        case 'ArrowDown':
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < filteredOptions.length - 1 ? prev + 1 : prev
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (filteredOptions[highlightedIndex]) {
            onChange(filteredOptions[highlightedIndex].value);
            setIsOpen(false);
            setSearchQuery('');
          }
          break;
      }
    },
    [isOpen, filteredOptions, highlightedIndex, onChange]
  );

  return (
    <div ref={containerRef} style={{ position: 'relative', width }}>
      {label && (
        <label
          style={{
            display: 'block',
            fontSize: '0.75rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            marginBottom: '8px',
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </label>
      )}

      {/* Trigger */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        disabled={disabled || loading}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '10px 14px',
          background: disabled ? 'var(--bg-surface)' : 'var(--bg-elevated)',
          border: `1px solid ${isOpen ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-md)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s ease',
          outline: 'none',
          boxShadow: isOpen ? '0 0 0 3px var(--accent-muted)' : 'none',
        }}
      >
        {renderTrigger ? (
          renderTrigger(selectedOption)
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
            {selectedOption?.icon && (
              <span style={{ flexShrink: 0, color: 'var(--text-secondary)' }}>
                {selectedOption.icon}
              </span>
            )}
            <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
              {selectedOption ? (
                <>
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
                    {selectedOption.label}
                  </div>
                  {selectedOption.description && (
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {selectedOption.description}
                    </div>
                  )}
                </>
              ) : (
                <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                  {placeholder}
                </span>
              )}
            </div>
          </div>
        )}
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          style={{ flexShrink: 0, color: 'var(--text-muted)' }}
        >
          {loading ? (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            >
              <Sparkles size={16} />
            </motion.div>
          ) : (
            <ChevronDown size={16} />
          )}
        </motion.div>
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              maxHeight,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-light)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-lg)',
              zIndex: 1000,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Search */}
            {searchable && (
              <div
                style={{
                  padding: '12px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <Search size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setHighlightedIndex(0);
                    }}
                    placeholder="Search..."
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      fontSize: '0.875rem',
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-body)',
                    }}
                  />
                </div>
              </div>
            )}

            {/* Options */}
            <div style={{ overflow: 'auto', flex: 1 }}>
              {filteredOptions.length === 0 ? (
                <div
                  style={{
                    padding: '24px',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    fontSize: '0.875rem',
                  }}
                >
                  No options found
                </div>
              ) : (
                Object.entries(groupedOptions).map(([category, categoryOptions]) => (
                  <div key={category}>
                    <div
                      style={{
                        padding: '8px 14px',
                        fontSize: '0.6875rem',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        background: 'var(--bg-surface)',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      {category}
                    </div>
                    {categoryOptions.map((option, idx) => {
                      const globalIndex = filteredOptions.findIndex((o) => o.value === option.value);
                      const isHighlighted = globalIndex === highlightedIndex;
                      const isSelected = option.value === value;

                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            onChange(option.value);
                            setIsOpen(false);
                            setSearchQuery('');
                          }}
                          onMouseEnter={() => setHighlightedIndex(globalIndex)}
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '12px',
                            padding: '12px 14px',
                            background: isHighlighted
                              ? 'var(--bg-hover)'
                              : isSelected
                              ? 'var(--accent-muted)'
                              : 'transparent',
                            border: 'none',
                            borderLeft: `3px solid ${
                              isSelected ? 'var(--accent)' : 'transparent'
                            }`,
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'all 0.1s ease',
                          }}
                        >
                          {option.icon && (
                            <span
                              style={{
                                flexShrink: 0,
                                marginTop: '2px',
                                color: isSelected ? 'var(--accent)' : 'var(--text-secondary)',
                              }}
                            >
                              {option.icon}
                            </span>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                marginBottom: option.description || option.metadata ? '4px' : 0,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: '0.875rem',
                                  fontWeight: isSelected ? 600 : 500,
                                  color: 'var(--text-primary)',
                                }}
                              >
                                {option.label}
                              </span>
                              {option.featured && (
                                <Sparkles size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                              )}
                              {option.badge && (
                                <span
                                  style={{
                                    fontSize: '0.625rem',
                                    fontWeight: 600,
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    background: option.badgeColor || 'var(--accent-muted)',
                                    color: option.badgeColor ? '#fff' : 'var(--accent)',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.04em',
                                  }}
                                >
                                  {option.badge}
                                </span>
                              )}
                            </div>
                            {option.description && (
                              <div
                                style={{
                                  fontSize: '0.75rem',
                                  color: 'var(--text-muted)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {option.description}
                              </div>
                            )}
                            {option.metadata && (
                              <div
                                style={{
                                  display: 'flex',
                                  gap: '12px',
                                  marginTop: '6px',
                                }}
                              >
                                {option.metadata.map((meta) => (
                                  <span
                                    key={meta.label}
                                    style={{
                                      fontSize: '0.6875rem',
                                      color: 'var(--text-muted)',
                                      fontFamily: 'var(--font-mono)',
                                    }}
                                  >
                                    {meta.label}: {meta.value}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          {isSelected && (
                            <motion.span
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              style={{ color: 'var(--accent)', flexShrink: 0 }}
                            >
                              <Check size={18} />
                            </motion.span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
