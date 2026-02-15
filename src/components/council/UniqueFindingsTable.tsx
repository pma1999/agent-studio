import React from 'react';
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { ModelAvatar, getModelDisplayName } from './ModelAvatar';
import type { CouncilComparison } from '../../types';

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
};

const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0 },
};

interface UniqueFindingsTableProps {
  uniqueFindings: NonNullable<CouncilComparison['unique_findings']>;
}

export function UniqueFindingsTable({ uniqueFindings }: UniqueFindingsTableProps) {
  if (!uniqueFindings.length) return null;

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={container}
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--council-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        boxShadow: 'var(--council-inner-shadow)',
      }}
    >
      <div
        style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--council-border)',
          background: 'linear-gradient(180deg, rgba(201, 149, 107, 0.14) 0%, transparent 100%)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}
      >
        <Sparkles size={20} style={{ color: 'var(--council-accent)', flexShrink: 0 }} />
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.1rem',
            fontWeight: 600,
            color: 'var(--council-text)',
            letterSpacing: '0.04em',
          }}
        >
          Unique discoveries
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 400 }}>
          <thead>
            <tr>
              <th
                scope="col"
                style={{
                  textAlign: 'left',
                  padding: '12px 16px',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-muted)',
                  borderBottom: '1px solid var(--border)',
                  width: 120,
                }}
              >
                Model
              </th>
              <th
                scope="col"
                style={{
                  textAlign: 'left',
                  padding: '12px 16px',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-muted)',
                  borderBottom: '1px solid var(--border)',
                  width: '45%',
                }}
              >
                Unique finding
              </th>
              <th
                scope="col"
                style={{
                  textAlign: 'left',
                  padding: '12px 16px',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-muted)',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                Why it matters
              </th>
            </tr>
          </thead>
          <tbody>
            {uniqueFindings.map((row, idx) => (
              <motion.tr
                key={idx}
                variants={item}
                style={{
                  borderBottom: idx < uniqueFindings.length - 1 ? '1px solid var(--border)' : 'none',
                  background: idx % 2 === 0 ? 'transparent' : 'rgba(201, 149, 107, 0.05)',
                }}
              >
                <td style={{ padding: '14px 16px', verticalAlign: 'top' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ModelAvatar modelId={row.model_id} size="sm" />
                    <span
                      style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {getModelDisplayName(row.model_id)}
                    </span>
                  </div>
                </td>
                <td
                  style={{
                    padding: '14px 16px',
                    fontSize: '0.9375rem',
                    lineHeight: 1.5,
                    color: 'var(--text-primary)',
                    verticalAlign: 'top',
                  }}
                >
                  {row.finding}
                </td>
                <td
                  style={{
                    padding: '14px 16px',
                    fontSize: '0.8125rem',
                    lineHeight: 1.5,
                    color: 'var(--text-secondary)',
                    verticalAlign: 'top',
                  }}
                >
                  {row.why_it_matters || '—'}
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}
