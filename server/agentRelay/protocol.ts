import crypto from 'node:crypto';
import { z } from 'zod';
import db from '../db.js';

export const AgentToBackendMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    agentVersion: z.string(),
    deviceName: z.string(),
    platform: z.string().optional(),
    shell: z.object({
      kind: z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'sh']),
      execPath: z.string(),
    }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal('heartbeat') }).strict(),
  z.object({ type: z.literal('command_awaiting_confirmation'), requestId: z.string() }).strict(),
  z.object({
    type: z.literal('command_output_chunk'),
    requestId: z.string(),
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
    seq: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal('command_response'),
    requestId: z.string(),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().nonnegative(),
    blockedPattern: z.string().optional(),
    confirmation: z.enum(['approved', 'declined', 'timeout']).optional(),
  }).strict(),
  z.object({
    type: z.literal('read_file_response'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    content: z.string().optional(),
    totalLines: z.number().int().nonnegative().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('write_file_response'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    bytesWritten: z.number().int().nonnegative().optional(),
    created: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('edit_file_response'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    replacementsMade: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    type: z.literal('delete_file_response'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    kind: z.enum(['file', 'directory']).optional(),
    confirmation: z.enum(['declined', 'timeout']).optional(),
  }).strict(),
  z.object({
    type: z.literal('list_directory_response'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    entries: z.array(z.object({
      name: z.string(),
      type: z.enum(['file', 'directory', 'symlink', 'other']),
      sizeBytes: z.number().int().nonnegative().optional(),
    }).strict()).optional(),
    truncated: z.boolean().optional(),
    totalEntries: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    type: z.literal('send_file_response'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    fileId: z.string().optional(),
    filename: z.string().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    expiresAt: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal('receive_file_response'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    writtenPath: z.string().optional(),
    bytesWritten: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    type: z.literal('mcp_start_response'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal('mcp_stop_response'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal('mcp_message'),
    channelId: z.string(),
    payload: z.unknown(),
  }).strict(),
  z.object({
    type: z.literal('mcp_exited'),
    channelId: z.string(),
    exitCode: z.number().int().nullable(),
  }).strict(),
]);

export const BackendToAgentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello_ack'), agentId: z.string() }).strict(),
  z.object({ type: z.literal('heartbeat_ack') }).strict(),
  z.object({
    type: z.literal('command_request'),
    requestId: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive(),
  }).strict(),
  z.object({ type: z.literal('command_cancel'), requestId: z.string() }).strict(),
  z.object({
    type: z.literal('read_file_request'),
    requestId: z.string(),
    path: z.string(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    type: z.literal('write_file_request'),
    requestId: z.string(),
    path: z.string(),
    content: z.string(),
    hasBeenRead: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('edit_file_request'),
    requestId: z.string(),
    path: z.string(),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
    hasBeenRead: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('delete_file_request'),
    requestId: z.string(),
    path: z.string(),
    recursive: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('list_directory_request'),
    requestId: z.string(),
    path: z.string(),
  }).strict(),
  z.object({
    type: z.literal('send_file_request'),
    requestId: z.string(),
    path: z.string(),
  }).strict(),
  z.object({
    type: z.literal('receive_file_request'),
    requestId: z.string(),
    fileId: z.string(),
    filename: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    mimeType: z.string(),
  }).strict(),
  z.object({
    type: z.literal('mcp_start_request'),
    requestId: z.string(),
    channelId: z.string(),
    config: z.object({
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('mcp_stop_request'),
    requestId: z.string(),
    channelId: z.string(),
  }).strict(),
  z.object({
    type: z.literal('mcp_message'),
    channelId: z.string(),
    payload: z.unknown(),
  }).strict(),
]);

export type AgentToBackendMessage = z.infer<typeof AgentToBackendMessageSchema>;
export type BackendToAgentMessage = z.infer<typeof BackendToAgentMessageSchema>;

const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 8;

export function generatePairingCode(): string {
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_CODE_ALPHABET[crypto.randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function validateAgentToken(token: string): { userId: string; agentId: string } | null {
  if (!token) return null;
  const row = db.prepare(`
    SELECT id, user_id
    FROM paired_agents
    WHERE token_hash = ? AND revoked_at IS NULL
    LIMIT 1
  `).get(hashToken(token)) as { id: string; user_id: string } | undefined;
  return row ? { userId: row.user_id, agentId: row.id } : null;
}
