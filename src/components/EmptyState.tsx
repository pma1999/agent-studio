import React from 'react';
import { motion } from 'framer-motion';

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
      className="empty-state-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: '20px',
        height: '100%',
      }}
    >
      <motion.div
        initial={{ scale: 0.8 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        style={{
          width: '80px',
          height: '80px',
          borderRadius: '50%',
          background: 'var(--accent-glow)',
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent)',
          marginBottom: '8px',
        }}
      >
        {icon}
      </motion.div>
      <h2 style={{
        fontFamily: 'var(--font-display)',
        fontSize: '1.75rem',
        fontWeight: 500,
        color: 'var(--text-primary)',
      }}>
        {title}
      </h2>
      <p style={{
        color: 'var(--text-muted)',
        maxWidth: '400px',
        lineHeight: 1.6,
        fontSize: '0.938rem',
      }}>
        {description}
      </p>
      {action && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          style={{ marginTop: '8px' }}
        >
          {action}
        </motion.div>
      )}
    </motion.div>
  );
}
