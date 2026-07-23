import crypto from 'node:crypto';
import { z } from 'zod';
import db from '../db.js';

export const AgentToBackendMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), agentVersion: z.string(), deviceName: z.string() }).strict(),
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
