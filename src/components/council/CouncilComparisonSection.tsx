import React from 'react';
import { motion } from 'framer-motion';
import { LayoutGrid } from 'lucide-react';
import { AgreementTable } from './AgreementTable';
import { DisagreementTable } from './DisagreementTable';
import { UniqueFindingsTable } from './UniqueFindingsTable';
import type { CouncilComparison } from '../../types';

interface CouncilComparisonSectionProps {
  comparison: CouncilComparison;
  modelIds: string[];
}

export function CouncilComparisonSection({ comparison, modelIds }: CouncilComparisonSectionProps) {
  const hasAgreements = comparison.agreements && comparison.agreements.length > 0;
  const hasDisagreements = comparison.disagreements && comparison.disagreements.length > 0;
  const hasUnique = comparison.unique_findings && comparison.unique_findings.length > 0;

  if (!hasAgreements && !hasDisagreements && !hasUnique) {
    return null;
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '4px',
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 'var(--radius-md)',
            background: 'linear-gradient(135deg, rgba(201, 149, 107, 0.2) 0%, rgba(201, 149, 107, 0.06) 100%)',
            border: '1px solid var(--council-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--council-accent)',
          }}
        >
          <LayoutGrid size={20} />
        </div>
        <div>
          <h3
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontSize: '1.25rem',
              fontWeight: 600,
              color: 'var(--text-primary)',
              letterSpacing: '0.02em',
            }}
          >
            Compare perspectives
          </h3>
          <p
            style={{
              margin: '2px 0 0',
              fontSize: '0.8125rem',
              color: 'var(--text-muted)',
            }}
          >
            Agreement, disagreement, and unique insights across models
          </p>
        </div>
      </div>

      {hasAgreements && (
        <AgreementTable agreements={comparison.agreements!} modelIds={modelIds} />
      )}
      {hasDisagreements && (
        <DisagreementTable disagreements={comparison.disagreements!} />
      )}
      {hasUnique && (
        <UniqueFindingsTable uniqueFindings={comparison.unique_findings!} />
      )}
    </motion.section>
  );
}
