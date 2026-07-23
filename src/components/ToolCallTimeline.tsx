import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  Cloud,
  Code2,
  FileEdit,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  Laptop,
  ShieldAlert,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react';
import type { ToolExecution, ToolOutputChunk, ToolSource } from '../types';

interface ToolCallTimelineProps {
  calls: ToolExecution[];
  isStreaming?: boolean;
  showHeader?: boolean;
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
    ? name.split('_').slice(2).join('_') || name
    : name;
  return cleaned.replace(/_/g, ' ');
}

function sourceLabel(source: ToolSource | undefined, name: string): string {
  if (source === 'mcp' || name.startsWith('mcp_')) return 'MCP';
  if (source === 'builtin' || name === 'web_search' || name === 'get_current_time' || name === 'web_fetch') return 'Built-in';
  if (source === 'http') return 'HTTP';
  return 'Tool';
}

const FILE_TOOL_ICONS: Record<string, React.ReactNode> = {
  read_file: <FileText size={13} />,
  write_file: <FilePlus size={13} />,
  edit_file: <FileEdit size={13} />,
  delete_file: <Trash2 size={13} />,
  list_directory: <FolderOpen size={13} />,
};

function formatDuration(durationMs?: number): string | null {
  if (durationMs === undefined || durationMs < 0) return null;
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

type RunCommandRefusal =
  | { kind: 'blocked'; detail: string }
  | { kind: 'declined' }
  | { kind: 'timeout' };

interface RunCommandInfo {
  /** Only set once a real backend actually ran the command (success or non-zero exit) —
   *  never for a refusal, which never reached a backend. Derived by parsing `call.result`
   *  identically for the live and reconstructed-history paths (the one field both share)
   *  rather than from `call.metadata`, which is never persisted and would otherwise make a
   *  refusal show a badge live that a page reload could not reproduce. */
  backend: 'local' | 'e2b' | null;
  refusal: RunCommandRefusal | null;
  exitCode: number | null;
}

const EMPTY_RUN_COMMAND_INFO: RunCommandInfo = { backend: null, refusal: null, exitCode: null };

function getRunCommandInfo(call: ToolExecution): RunCommandInfo {
  if (call.name !== 'run_command' || call.result === undefined) return EMPTY_RUN_COMMAND_INFO;
  const parsed = tryParseJson(call.result);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_RUN_COMMAND_INFO;
  const body = parsed as Record<string, unknown>;

  const blocked = body.blocked;
  if (blocked && typeof blocked === 'object' && !Array.isArray(blocked)) {
    const { tier, pattern } = blocked as { tier?: unknown; pattern?: unknown };
    const detail = `Tier ${typeof tier === 'number' ? tier : '?'}${typeof pattern === 'string' && pattern ? ` — ${pattern}` : ''}`;
    return { backend: null, refusal: { kind: 'blocked', detail }, exitCode: null };
  }
  if (body.confirmation === 'declined') return { backend: null, refusal: { kind: 'declined' }, exitCode: null };
  if (body.confirmation === 'timeout') return { backend: null, refusal: { kind: 'timeout' }, exitCode: null };

  const backend = body.backend === 'local' || body.backend === 'e2b' ? body.backend : null;
  const exitCode = typeof body.exit_code === 'number' ? body.exit_code : null;
  return { backend, refusal: null, exitCode };
}

function refusalCopy(refusal: RunCommandRefusal): { label: string; detail?: string } {
  switch (refusal.kind) {
    case 'blocked':
      return { label: 'Blocked by safety policy', detail: refusal.detail };
    case 'declined':
      return { label: 'Declined by user' };
    case 'timeout':
      return { label: 'Confirmation timed out' };
  }
}

function BackendBadge({ backend }: { backend: 'local' | 'e2b' }) {
  return backend === 'local' ? (
    <span className="tool-call-badge">
      <Laptop size={10} />
      Local
    </span>
  ) : (
    <span className="tool-call-badge">
      <Cloud size={10} />
      Sandbox
    </span>
  );
}

function LiveTerminalPanel({ liveOutput }: { liveOutput?: ToolOutputChunk[] }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const chunks = liveOutput || [];

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chunks.length]);

  return (
    <div className="tool-call-panel tool-call-terminal-panel">
      <div className="tool-call-panel-header">
        <span className="tool-call-panel-title">
          <Terminal size={12} />
          Live output
        </span>
        <span className="tool-call-terminal-live">
          <span className="tool-telemetry-live-dot" />
          Streaming
        </span>
      </div>
      <div ref={containerRef} className="tool-call-terminal">
        {chunks.length === 0 ? (
          <span className="tool-call-terminal-empty">Waiting for output…</span>
        ) : (
          chunks.map((chunk, i) => (
            <span key={i} className={`tool-call-terminal-${chunk.stream}`}>
              {chunk.text}
            </span>
          ))
        )}
        <span className="tool-call-terminal-cursor" aria-hidden="true" />
      </div>
    </div>
  );
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
  const isRunCommand = call.name === 'run_command';
  const { backend, refusal, exitCode } = React.useMemo(() => getRunCommandInfo(call), [call]);

  React.useEffect(() => {
    if (call.status === 'running') {
      setExpanded(true);
    }
  }, [call.status]);

  const statusMeta = refusal
    ? { icon: <ShieldAlert size={14} />, label: refusalCopy(refusal).label, className: 'refused' }
    : call.status === 'running'
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
            {isRunCommand
              ? <Terminal size={13} />
              : FILE_TOOL_ICONS[call.name] ?? (source === 'MCP' ? <Globe size={13} /> : <Wrench size={13} />)}
          </div>
          <div className="tool-call-card-title-wrap">
            <div className="tool-call-card-title">{prettyName}</div>
            <div className="tool-call-card-subtitle">
              <span className="tool-call-badge">{source}</span>
              {backend && <BackendBadge backend={backend} />}
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
              {!refusal && exitCode !== null && (
                <span className="tool-call-duration">exit {exitCode}</span>
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
            {refusal?.kind === 'blocked' && (
              <p className="tool-call-refusal-detail">{refusalCopy(refusal).detail}</p>
            )}
            {call.status === 'running' && isRunCommand ? (
              <LiveTerminalPanel liveOutput={call.liveOutput} />
            ) : call.result !== undefined ? (
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

export function ToolCallTimeline({ calls, isStreaming = false, showHeader = true }: ToolCallTimelineProps) {
  if (!calls.length) return null;
  const runningCount = calls.filter((c) => c.status === 'running').length;

  return (
    <section className={`tool-telemetry${showHeader ? '' : ' tool-telemetry-inline'}`}>
      {showHeader && (
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
      )}
      <div className="tool-telemetry-list">
        {calls.map((call, index) => (
          <ToolCallCard key={call.id} call={call} index={index} />
        ))}
      </div>
    </section>
  );
}
