import React from 'react';
import { motion } from 'framer-motion';
import { MessageSquareOff } from 'lucide-react';
import { ModelAvatar, getModelDisplayName } from './ModelAvatar';
import { useIsMobile } from '../../utils/breakpoints';
import type { CouncilComparison } from '../../types';

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.07 },
  },
};

const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0 },
};

interface DisagreementTableProps {
  disagreements: NonNullable<CouncilComparison['disagreements']>;
}

export function DisagreementTable({ disagreements }: DisagreementTableProps) {
  const isMobile = useIsMobile();
  if (!disagreements.length) return null;

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
          background: 'linear-gradient(180deg, rgba(212, 165, 87, 0.1) 0%, transparent 100%)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}
      >
        <MessageSquareOff size={20} style={{ color: 'var(--warning)', flexShrink: 0 }} />
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.1rem',
            fontWeight: 600,
            color: 'var(--council-text)',
            letterSpacing: '0.04em',
          }}
        >
          Where they disagree
        </span>
      </div>
      {isMobile ? (
        <div>
          {disagreements.map((row, idx) => (
            <motion.div
              key={idx}
              variants={item}
              style={{
                padding: '14px 16px',
                borderBottom: idx < disagreements.length - 1 ? '1px solid var(--border)' : 'none',
                background: idx % 2 === 0 ? 'transparent' : 'rgba(212, 165, 87, 0.04)',
              }}
            >
              <div style={{ fontSize: '0.9375rem', fontWeight: 500, color: 'var(--text-primary)', marginBottom: 10 }}>
                {row.topic}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: row.why_they_differ ? 10 : 0 }}>
                {row.stances.map((s, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '8px 10px',
                      background: 'var(--bg-elevated)',
                      borderRadius: 'var(--radius-sm)',
                      borderLeft: '3px solid var(--council-border)',
                    }}
                  >
                    <ModelAvatar modelId={s.model_id} size="xs" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 2 }}>
                        {getModelDisplayName(s.model_id)}
                      </div>
                      <div style={{ fontSize: '0.875rem', lineHeight: 1.45, color: 'var(--text-secondary)' }}>
                        {s.stance}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {row.why_they_differ && (
                <div style={{ fontSize: '0.8125rem', lineHeight: 1.5, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  {row.why_they_differ}
                </div>
              )}
            </motion.div>
          ))}
        </div>
      ) : (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
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
                  width: '22%',
                }}
              >
                Topic
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
                  width: '48%',
                }}
              >
                Stances
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
                Why they differ
              </th>
            </tr>
          </thead>
          <tbody>
            {disagreements.map((row, idx) => (
              <motion.tr
                key={idx}
                variants={item}
                style={{
                  borderBottom: idx < disagreements.length - 1 ? '1px solid var(--border)' : 'none',
                  background: idx % 2 === 0 ? 'transparent' : 'rgba(212, 165, 87, 0.04)',
                }}
              >
                <td
                  style={{
                    padding: '14px 16px',
                    fontSize: '0.9375rem',
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    verticalAlign: 'top',
                  }}
                >
                  {row.topic}
                </td>
                <td style={{ padding: '14px 16px', verticalAlign: 'top' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {row.stances.map((s, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '10px',
                          padding: '8px 10px',
                          background: 'var(--bg-elevated)',
                          borderRadius: 'var(--radius-sm)',
                          borderLeft: '3px solid var(--council-border)',
                        }}
                      >
                        <ModelAvatar modelId={s.model_id} size="xs" />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: '0.7rem',
                              color: 'var(--text-muted)',
                              marginBottom: '2px',
                            }}
                          >
                            {getModelDisplayName(s.model_id)}
                          </div>
                          <div
                            style={{
                              fontSize: '0.875rem',
                              lineHeight: 1.45,
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {s.stance}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </td>
                <td
                  style={{
                    padding: '14px 16px',
                    fontSize: '0.8125rem',
                    lineHeight: 1.5,
                    color: 'var(--text-secondary)',
                    fontStyle: 'italic',
                    verticalAlign: 'top',
                  }}
                >
                  {row.why_they_differ}
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </motion.div>
  );
}
