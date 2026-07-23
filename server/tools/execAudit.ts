/**
 * Audit logging for tool executions that run real commands (run_command,
 * MCP stdio tool calls, etc). Writes one row per call into the
 * `tool_executions` table.
 *
 * A logging failure must never break the caller's actual tool execution:
 * `logToolExecution` swallows every error and reports it via console.error
 * rather than throwing.
 */

import { nanoid } from 'nanoid';
import db from '../db.js';

/** Audit-table `command` column is truncated to this many characters before insert. */
const MAX_AUDIT_COMMAND_CHARS = 4000;

export interface ExecAuditEntry {
  userId: string;
  conversationId?: string | null;
  toolCallId?: string | null;
  toolName: string;
  backend: 'local' | 'e2b' | 'mcp-stdio';
  command?: string | null;
  cwd?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  blockedPattern?: string | null;
  confirmationRequired?: boolean;
  confirmationResult?: 'approved' | 'declined' | 'timeout' | null;
  isError?: boolean;
}

export function logToolExecution(entry: ExecAuditEntry): void {
  try {
    const command =
      typeof entry.command === 'string'
        ? entry.command.slice(0, MAX_AUDIT_COMMAND_CHARS)
        : (entry.command ?? null);

    // Prepared lazily (per call, not at module load time): this module can be
    // imported before migrate() has created the tool_executions table (ESM
    // import graphs resolve before an app's own startup code calls migrate()),
    // so a module-top-level db.prepare() here would throw on cold start.
    db.prepare(
      `INSERT INTO tool_executions (
        id, user_id, conversation_id, tool_call_id, tool_name, backend,
        command, cwd, exit_code, duration_ms, blocked_pattern,
        confirmation_required, confirmation_result, is_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nanoid(),
      entry.userId,
      entry.conversationId ?? null,
      entry.toolCallId ?? null,
      entry.toolName,
      entry.backend,
      command,
      entry.cwd ?? null,
      entry.exitCode ?? null,
      entry.durationMs ?? null,
      entry.blockedPattern ?? null,
      entry.confirmationRequired ? 1 : 0,
      entry.confirmationResult ?? null,
      entry.isError ? 1 : 0
    );
  } catch (err) {
    console.error('[execAudit] failed to log tool execution:', err);
  }
}
