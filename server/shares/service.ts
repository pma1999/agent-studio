import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { buildThreadIds } from '../messageTree.js';
import { isLocalAuthMode } from '../middleware/auth.js';
import type { ShareSnapshot, SharedMessage } from '../../shared/shareTypes.js';

/**
 * Conversation share lifecycle (plan.md D3/D4/D6).
 *
 * All share SQL lives here (GC2) — route files stay thin HTTP adapters.
 * Raw tokens exist only in memory: generated here, returned once to the owner;
 * only sha256(token) hex is persisted. Reads serve the frozen snapshot_json,
 * never the live message tables, so later conversation activity never leaks
 * into an existing share.
 */

export function generateShareToken(): string {
  return nanoid(48);
}

export function hashShareToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export type CreateShareResult =
  | { kind: 'created'; shareId: string; token: string; createdAt: string }
  | { kind: 'conversation-not-found' }
  | { kind: 'sharing-disabled-local-mode' };

export type GetShareResult =
  | { kind: 'active'; shareId: string; createdAt: string }
  | { kind: 'none' }
  | { kind: 'conversation-not-found' };

export type RevokeShareResult =
  | { kind: 'revoked' }
  | { kind: 'none-active' }
  | { kind: 'conversation-not-found' };

export type ResolveShareResult =
  | { kind: 'found'; snapshot: ShareSnapshot }
  | { kind: 'not-found' };

interface SnapshotConversationRow {
  title: string;
  active_leaf_id: string | null;
  agent_name: string | null;
  agent_emoji: string | null;
}

interface SnapshotSourceRow {
  id: string;
  role: string;
  content: string;
  model: string | null;
  annotations: string | null;
  attachments: string | null;
  created_at: string;
}

function parseJsonArray(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseAttachments(raw: string | null): { filename: string }[] | null {
  const parsed = parseJsonArray(raw);
  if (!parsed) return null;
  return parsed
    .map((item) => (item as { filename?: unknown } | null)?.filename)
    .filter((filename): filename is string => typeof filename === 'string' && filename.length > 0)
    .map((filename) => ({ filename }));
}

/**
 * Builds the frozen snapshot for a conversation's currently visible thread:
 * leaf-walk from `active_leaf_id` via buildThreadIds (which internally falls
 * back to created_at ASC, rowid ASC for legacy conversations without a valid
 * leaf chain), roles filtered to user|assistant, every non-allow-list field
 * stripped (plan.md D6). Returns null when the conversation does not exist.
 */
export function buildSnapshot(conversationId: string, now: Date = new Date()): ShareSnapshot | null {
  const conversation = db.prepare(`
    SELECT c.title, c.active_leaf_id, a.name AS agent_name, a.emoji AS agent_emoji
    FROM conversations c
    LEFT JOIN agents a ON c.agent_id = a.id
    WHERE c.id = ?
  `).get(conversationId) as SnapshotConversationRow | undefined;
  if (!conversation) return null;

  const threadIds = buildThreadIds(conversationId, conversation.active_leaf_id);

  const selectMessage = db.prepare(`
    SELECT id, role, content, model, annotations, attachments, created_at
    FROM messages
    WHERE id = ? AND conversation_id = ?
  `);

  const messages: SharedMessage[] = [];
  for (const id of threadIds) {
    const row = selectMessage.get(id, conversationId) as SnapshotSourceRow | undefined;
    if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
    const message: SharedMessage = {
      id: row.id,
      role: row.role,
      content: row.content,
      annotations: parseJsonArray(row.annotations),
      attachments: parseAttachments(row.attachments),
      created_at: row.created_at,
    };
    if (row.role === 'assistant') message.model = row.model ?? null; // assistant-only metadata
    messages.push(message);
  }

  return {
    conversation_title: conversation.title,
    agent_name: conversation.agent_name,
    agent_emoji: conversation.agent_emoji,
    shared_at: now.toISOString(),
    messages,
  };
}

export function createShare(conversationId: string, userId: string): CreateShareResult {
  if (isLocalAuthMode()) return { kind: 'sharing-disabled-local-mode' };

  if (!db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId)) {
    return { kind: 'conversation-not-found' };
  }

  const snapshot = buildSnapshot(conversationId);
  if (!snapshot) return { kind: 'conversation-not-found' }; // deleted between the checks

  // One active share per conversation — rotation deletes any previous row so
  // old links die immediately.
  db.prepare('DELETE FROM conversation_shares WHERE conversation_id = ?').run(conversationId);

  const shareId = nanoid();
  const token = generateShareToken();
  db.prepare(`
    INSERT INTO conversation_shares (id, conversation_id, owner_user_id, token_hash, snapshot_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(shareId, conversationId, userId, hashShareToken(token), JSON.stringify(snapshot));

  const stored = db.prepare('SELECT created_at FROM conversation_shares WHERE id = ?').get(shareId) as { created_at: string };
  return { kind: 'created', shareId, token, createdAt: stored.created_at };
}

export function getShareStatus(conversationId: string, userId: string): GetShareResult {
  if (!db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId)) {
    return { kind: 'conversation-not-found' };
  }

  const row = db.prepare(`
    SELECT id, created_at FROM conversation_shares WHERE conversation_id = ? LIMIT 1
  `).get(conversationId) as { id: string; created_at: string } | undefined;
  return row
    ? { kind: 'active', shareId: row.id, createdAt: row.created_at }
    : { kind: 'none' };
}

export function revokeShare(conversationId: string, userId: string): RevokeShareResult {
  if (!db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId)) {
    return { kind: 'conversation-not-found' };
  }

  const result = db.prepare('DELETE FROM conversation_shares WHERE conversation_id = ?').run(conversationId);
  return result.changes > 0 ? { kind: 'revoked' } : { kind: 'none-active' };
}

export function resolveShareToken(token: string): ResolveShareResult {
  if (!token) return { kind: 'not-found' };

  const row = db.prepare(`
    SELECT snapshot_json FROM conversation_shares WHERE token_hash = ? LIMIT 1
  `).get(hashShareToken(token)) as { snapshot_json: string } | undefined;
  if (!row) return { kind: 'not-found' };

  try {
    return { kind: 'found', snapshot: JSON.parse(row.snapshot_json) as ShareSnapshot };
  } catch {
    return { kind: 'not-found' }; // corrupt row must not crash resolution
  }
}
