import React, { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { exportApi, importApi, downloadExport, type ExportPayload, type ExportKind } from '../api/client';
import { Button } from './ui/Button';

export type ExportImportKind = ExportKind;

interface ExportImportButtonsProps {
  kind: ExportImportKind;
  label: string;
  onAfterImport?: () => void;
  variant?: 'inline' | 'stacked';
  className?: string;
}

type ResultMessage = { type: 'success'; text: string } | { type: 'error'; text: string };

export function ExportImportButtons({
  kind,
  label,
  onAfterImport,
  variant = 'inline',
  className,
}: ExportImportButtonsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ResultMessage | null>(null);

  const clearResult = () => setResult(null);

  const handleExport = async () => {
    setExporting(true);
    setResult(null);
    try {
      const data =
        kind === 'all'
          ? await exportApi.all()
          : kind === 'agents'
            ? await exportApi.agents()
            : kind === 'tools'
              ? await exportApi.tools()
              : await exportApi.mcpServers();
      downloadExport(data, kind);
      setResult({ type: 'success', text: `Exported ${label.toLowerCase()}` });
      setTimeout(clearResult, 2500);
    } catch (err) {
      setResult({ type: 'error', text: err instanceof Error ? err.message : 'Export failed' });
    } finally {
      setExporting(false);
    }
  };

  const handleImportClick = () => {
    setResult(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    setResult(null);
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as ExportPayload;
      if (typeof payload?.version !== 'number' || !payload?.kind) {
        throw new Error('Invalid export file: missing version or kind');
      }
      const res = await importApi.import(payload);
      const { created } = res;
      const parts = [];
      if (created.agents > 0) parts.push(`${created.agents} agent${created.agents !== 1 ? 's' : ''}`);
      if (created.tools > 0) parts.push(`${created.tools} tool${created.tools !== 1 ? 's' : ''}`);
      if (created.mcp_servers > 0) parts.push(`${created.mcp_servers} MCP server${created.mcp_servers !== 1 ? 's' : ''}`);
      const setupCount = res.requires_configuration?.length ?? 0;
      const base = parts.length ? `Imported: ${parts.join(', ')}` : 'Import complete';
      setResult({
        type: 'success',
        text: setupCount > 0
          ? `${base}. ${setupCount} MCP server${setupCount === 1 ? '' : 's'} imported safely as setup-required draft${setupCount === 1 ? '' : 's'}; add the missing private values before enabling.`
          : base,
      });
      onAfterImport?.();
      setTimeout(clearResult, 3500);
    } catch (err) {
      setResult({ type: 'error', text: err instanceof Error ? err.message : 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  const isInline = variant === 'inline';

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: isInline ? 'row' : 'column',
        alignItems: isInline ? 'center' : 'stretch',
        gap: '10px',
        flexWrap: 'wrap',
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleFileChange}
        style={{ display: 'none' }}
        aria-hidden
      />
      <motion.div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          flexWrap: 'wrap',
          padding: '4px 6px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          background: 'var(--bg-surface)',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      >
        <Button
          variant="ghost"
          size="sm"
          icon={exporting ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}
          onClick={handleExport}
          disabled={exporting || importing}
          title={`Export ${label}`}
          style={{
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
          }}
        >
          Export
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={importing ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpFromLine size={14} />}
          onClick={handleImportClick}
          disabled={exporting || importing}
          title={`Import ${label}`}
          style={{
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
          }}
        >
          Import
        </Button>
      </motion.div>
      <AnimatePresence mode="wait">
        {result && (
          <motion.div
            key={result.text}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-body)',
              color: result.type === 'success' ? 'var(--success)' : 'var(--error)',
            }}
          >
            {result.type === 'success' ? (
              <CheckCircle size={14} style={{ flexShrink: 0 }} />
            ) : (
              <AlertCircle size={14} style={{ flexShrink: 0 }} />
            )}
            <span>{result.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
