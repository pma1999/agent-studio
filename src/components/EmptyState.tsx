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
    >
      <motion.div
        className="empty-state-icon"
        initial={{ scale: 0.8 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        aria-hidden="true"
      >
        {icon}
      </motion.div>
      <h2 className="empty-state-title">{title}</h2>
      <p className="empty-state-description">{description}</p>
      {action && (
        <motion.div
          className="empty-state-action"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          {action}
        </motion.div>
      )}
    </motion.div>
  );
}
