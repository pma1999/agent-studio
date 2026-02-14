import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  Code2,
  Globe,
  Sparkles,
  Wrench,
} from 'lucide-react';
import type { ToolExecution, ToolSource } from '../types';

interface ToolCallTimelineProps {
  calls: ToolExecution[];
  isStreaming?: boolean;
}

function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if ((!trimmed.startsWith('{') && !trimmed.startsWith('[')) || trimmed.length < 2) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function prettifyToolName(name: string): string {
  if (!name) return 'tool';
  const cleaned = name.startsWith('mcp_')
    ? name.split('_').slice(3).join('_') || name
    : name;
  return cleaned.replace(/_/g, ' ');
}

function sourceLabel(source: ToolSource | undefined, name: string): string {
  if (source === 'mcp' || name.startsWith('mcp_')) return 'MCP';
  if (source === 'builtin' || name === 'web_search' || name === 'get_current_time') return 'Built-in';
  if (source === 'http') return 'HTTP';
  return 'Tool';
}

function formatDuration(durationMs?: number): string | null {
  if (durationMs === undefined || durationMs < 0) return null;
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function DataPanel({
  title,
  value,
  accent,
}: {
  title: string;
  value: string;
  accent: 'request' | 'result';
}) {
  const parsed = React.useMemo(() => tryParseJson(value), [value]);
  const [view, setView] = React.useState<'formatted' | 'raw'>('formatted');
  const tone = accent === 'request' ? 'var(--tool-call-request)' : 'var(--tool-call-result)';

  return (
    <div className="tool-call-panel" style={{ borderColor: `${tone}55` }}>
      <div className="tool-call-panel-header">
        <span className="tool-call-panel-title">
          <Code2 size={12} />
          {title}
        </span>
        {parsed !== null && (
          <div className="tool-call-panel-toggle">
            {(['formatted', 'raw'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                className={`tool-call-panel-toggle-btn${view === mode ? ' active' : ''}`}
              >
                {mode}
              </button>
            ))}
          </div>
        )}
      </div>
      <pre className="tool-call-code">
        {parsed !== null && view === 'formatted'
          ? JSON.stringify(parsed, null, 2)
          : value}
      </pre>
    </div>
  );
}

function ToolCallCard({
  call,
  index,
}: {
  call: ToolExecution;
  index: number;
}) {
  const [expanded, setExpanded] = React.useState(call.status === 'running');
  const duration = formatDuration(call.duration_ms);
  const source = sourceLabel(call.source, call.name);
  const prettyName = prettifyToolName(call.name);

  React.useEffect(() => {
    if (call.status === 'running') {
      setExpanded(true);
    }
  }, [call.status]);

  const statusMeta =
    call.status === 'running'
      ? { icon: <CircleDashed size={14} className="tool-call-spin" />, label: 'Running', className: 'running' }
      : call.status === 'error'
        ? { icon: <AlertCircle size={14} />, label: 'Error', className: 'error' }
        : { icon: <CheckCircle2 size={14} />, label: 'Done', className: 'done' };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.2 }}
      className={`tool-call-card ${statusMeta.className}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="tool-call-card-header"
        aria-expanded={expanded}
      >
        <div className="tool-call-card-left">
          <div className="tool-call-card-icon">
            {source === 'MCP' ? <Globe size={13} /> : <Wrench size={13} />}
          </div>
          <div className="tool-call-card-title-wrap">
            <div className="tool-call-card-title">{prettyName}</div>
            <div className="tool-call-card-subtitle">
              <span className="tool-call-badge">{source}</span>
              <span className={`tool-call-status ${statusMeta.className}`}>
                {statusMeta.icon}
                {statusMeta.label}
              </span>
              {duration && (
                <span className="tool-call-duration">
                  <Clock3 size={11} />
                  {duration}
                </span>
              )}
            </div>
          </div>
        </div>
        <span className="tool-call-chevron">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="tool-call-card-body"
          >
            <DataPanel title="Request" value={call.arguments || '{}'} accent="request" />
            {call.result !== undefined ? (
              <DataPanel title="Result" value={call.result || ''} accent="result" />
            ) : (
              <div className="tool-call-pending-result">
                <CircleDashed size={13} className="tool-call-spin" />
                Waiting for tool result...
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function ToolCallTimeline({ calls, isStreaming = false }: ToolCallTimelineProps) {
  if (!calls.length) return null;
  const runningCount = calls.filter((c) => c.status === 'running').length;

  return (
    <section className="tool-telemetry">
      <div className="tool-telemetry-header">
        <div className="tool-telemetry-title">
          <Sparkles size={13} />
          Tool activity
        </div>
        <div className="tool-telemetry-meta">
          <span className="tool-telemetry-count">
            {calls.length} call{calls.length !== 1 ? 's' : ''}
          </span>
          {isStreaming && (
            <span className="tool-telemetry-live">
              <span className="tool-telemetry-live-dot" />
              {runningCount > 0 ? `${runningCount} running` : 'Live'}
            </span>
          )}
        </div>
      </div>
      <div className="tool-telemetry-list">
        {calls.map((call, index) => (
          <ToolCallCard key={call.id} call={call} index={index} />
        ))}
      </div>
    </section>
  );
}
