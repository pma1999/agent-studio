import React from 'react';
import { motion } from 'framer-motion';

interface PremiumToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  description?: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  color?: string;
}

export function PremiumToggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  size = 'md',
  color = 'var(--accent)',
}: PremiumToggleProps) {
  const sizes = {
    sm: { width: 36, height: 20, knob: 14, padding: 3 },
    md: { width: 48, height: 26, knob: 20, padding: 3 },
    lg: { width: 60, height: 32, knob: 26, padding: 3 },
  };

  const s = sizes[size];

  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <motion.div
        role="switch"
        aria-checked={checked}
        onClick={() => !disabled && onChange(!checked)}
        animate={{
          backgroundColor: checked ? color : 'var(--bg-hover)',
        }}
        transition={{ duration: 0.2 }}
        style={{
          width: s.width,
          height: s.height,
          borderRadius: s.height / 2,
          position: 'relative',
          flexShrink: 0,
          marginTop: label ? 2 : 0,
          boxShadow: checked ? `0 0 12px ${color}40` : 'inset 0 2px 4px rgba(0,0,0,0.1)',
        }}
        whileHover={!disabled ? { scale: 1.05 } : {}}
        whileTap={!disabled ? { scale: 0.95 } : {}}
      >
        <motion.div
          animate={{
            x: checked ? s.width - s.knob - s.padding : s.padding,
            y: s.padding,
          }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          style={{
            width: s.knob,
            height: s.knob,
            borderRadius: '50%',
            backgroundColor: '#fff',
            boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {checked && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              style={{
                width: s.knob * 0.4,
                height: s.knob * 0.4,
                borderRadius: '50%',
                backgroundColor: color,
              }}
            />
          )}
        </motion.div>
      </motion.div>

      {(label || description) && (
        <div style={{ flex: 1, minWidth: 0 }}>
          {label && (
            <div
              style={{
                fontSize: size === 'sm' ? '0.8125rem' : '0.9375rem',
                fontWeight: 500,
                color: 'var(--text-primary)',
                marginBottom: description ? '2px' : 0,
              }}
            >
              {label}
            </div>
          )}
          {description && (
            <div
              style={{
                fontSize: size === 'sm' ? '0.75rem' : '0.8125rem',
                color: 'var(--text-muted)',
                lineHeight: 1.4,
              }}
            >
              {description}
            </div>
          )}
        </div>
      )}
    </label>
  );
}
