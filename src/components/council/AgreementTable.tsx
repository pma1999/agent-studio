import React from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2 } from 'lucide-react';
import { ModelAvatar, getModelDisplayName } from './ModelAvatar';
import { useIsMobile } from '../../utils/breakpoints';
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

interface AgreementTableProps {
  agreements: NonNullable<CouncilComparison['agreements']>;
  modelIds: string[];
}

export function AgreementTable({ agreements, modelIds }: AgreementTableProps) {
  const isMobile = useIsMobile();
  if (!agreements.length) return null;

  const modelIdToIndex = new Map(modelIds.map((id, i) => [id, i]));

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
          background: 'linear-gradient(180deg, rgba(122, 184, 143, 0.12) 0%, transparent 100%)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}
      >
        <CheckCircle2 size={20} style={{ color: 'var(--council-success)', flexShrink: 0 }} />
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.1rem',
            fontWeight: 600,
            color: 'var(--council-text)',
            letterSpacing: '0.04em',
          }}
        >
          Where they agree
        </span>
      </div>
      {isMobile ? (
        <div>
          {agreements.map((row, idx) => (
            <motion.div
              key={idx}
              variants={item}
              style={{
                padding: '14px 16px',
                borderBottom: idx < agreements.length - 1 ? '1px solid var(--border)' : 'none',
                background: idx % 2 === 0 ? 'transparent' : 'rgba(122, 184, 143, 0.04)',
              }}
            >
              <div style={{ fontSize: '0.9375rem', lineHeight: 1.5, color: 'var(--text-primary)', marginBottom: 10 }}>
                {row.finding}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: row.evidence ? 10 : 0 }}>
                {modelIds.filter((id) => row.model_ids.includes(id)).map((id) => (
                  <span
                    key={id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '3px 9px 3px 4px',
                      borderRadius: 'var(--radius-pill)',
                      background: 'rgba(122, 184, 143, 0.12)',
                      border: '1px solid var(--council-border)',
                      fontSize: '0.75rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <ModelAvatar modelId={id} size="xs" />
                    {getModelDisplayName(id)}
                  </span>
                ))}
              </div>
              {row.evidence && (
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  {row.evidence}
                </div>
              )}
            </motion.div>
          ))}
        </div>
      ) : (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
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
                  width: '40%',
                }}
              >
                Finding
              </th>
              {modelIds.map((id) => (
                <th
                  key={id}
                  scope="col"
                  style={{
                    textAlign: 'center',
                    padding: '12px 10px',
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--border)',
                    width: 60,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <ModelAvatar modelId={id} size="xs" />
                  </div>
                </th>
              ))}
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
                Evidence
              </th>
            </tr>
          </thead>
          <tbody>
            {agreements.map((row, idx) => (
              <motion.tr
                key={idx}
                variants={item}
                style={{
                  borderBottom: idx < agreements.length - 1 ? '1px solid var(--border)' : 'none',
                  background: idx % 2 === 0 ? 'transparent' : 'rgba(122, 184, 143, 0.04)',
                }}
              >
                <td
                  style={{
                    padding: '14px 16px',
                    fontSize: '0.9375rem',
                    lineHeight: 1.5,
                    color: 'var(--text-primary)',
                  }}
                >
                  {row.finding}
                </td>
                {modelIds.map((id) => {
                  const agrees = row.model_ids.includes(id);
                  return (
                    <td key={id} style={{ textAlign: 'center', padding: '14px 10px' }}>
                      {agrees ? (
                        <CheckCircle2
                          size={18}
                          style={{ color: 'var(--council-success)', margin: '0 auto' }}
                        />
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>—</span>
                      )}
                    </td>
                  );
                })}
                <td
                  style={{
                    padding: '14px 16px',
                    fontSize: '0.8125rem',
                    color: 'var(--text-secondary)',
                    fontStyle: row.evidence ? 'italic' : 'normal',
                  }}
                >
                  {row.evidence || '—'}
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
