import db from './db.js';

/**
 * Message-tree helpers (editing / retry / variants / threads).
 *
 * Messages form a tree of threads instead of a linear list:
 *  - parent_id: id of the message that precedes this one in its thread (NULL only
 *    for the very first message of a conversation).
 *  - turn_id: groups one turn — a user message plus ALL of its continuation
 *    (assistant/tool messages). Variants of a turn share the same turn_id.
 *  - variant_seq: 1-based index of the variant inside the turn. Editing or
 *    retrying creates a new variant with MAX(variant_seq)+1.
 *  - conversations.active_leaf_id: cursor pointing at the last message of the
 *    currently visible thread (used to navigate variants and continue from any branch).
 */

export interface TurnVariant {
  id: string;
  model: string | null;
  content: string;
  created_at: string;
  variant_seq: number;
}

const MAX_CHAIN_WALK = 5000;

/**
 * One-time backfill for conversations created before the message-tree columns
 * existed. Walks every conversation's messages in chronological order and:
 *  - chains them via parent_id (each message points at the previous one),
 *  - groups each user message + its continuations into a turn
 *    (turn_id = user message id; assistant/tool messages reuse the last user turn),
 *  - sets variant_seq = 1 for every backfilled row,
 *  - points conversations.active_leaf_id at the last message of each conversation.
 *
 * Only called from migrate() inside the guarded block that creates the columns,
 * so it runs exactly once per database. It must be callable directly from test
 * scripts as well.
 */
export function backfillMessageTree(): void {
  const conversations = db.prepare('SELECT id FROM conversations').all() as { id: string }[];
  const updateMsg = db.prepare('UPDATE messages SET parent_id = ?, turn_id = ?, variant_seq = ? WHERE id = ?');
  const updateLeaf = db.prepare('UPDATE conversations SET active_leaf_id = ? WHERE id = ?');

  const run = db.transaction(() => {
    for (const conv of conversations) {
      const rows = db.prepare(`
        SELECT id, role FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, rowid ASC
      `).all(conv.id) as { id: string; role: string }[];

      let prev: string | null = null;
      let lastUserTurn: string | null = null;
      let lastId: string | null = null;

      for (const row of rows) {
        const turnId = row.role === 'user' ? row.id : lastUserTurn; // may stay NULL (orphan system rows)
        if (row.role === 'user') lastUserTurn = row.id;
        updateMsg.run(prev, turnId, 1, row.id);
        prev = row.id;
        lastId = row.id;
      }

      if (lastId) updateLeaf.run(lastId, conv.id);
    }
  });
  run();
}

/**
 * Rebuilds the visible thread for a conversation by walking parent_id upward
 * from the given leaf (never ORDER BY created_at). Returns ids root → leaf.
 *
 * Defensive fallback: when the leaf is NULL, does not belong to the
 * conversation, the chain is broken (missing parent row) or the walk hits the
 * safety cap, all ids are returned in created_at ASC, rowid ASC order.
 */
export function buildThreadIds(conversationId: string, leafId: string | null | undefined): string[] {
  const chronologicalFallback = () =>
    (db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC').all(conversationId) as { id: string }[])
      .map((r) => r.id);

  if (!leafId) return chronologicalFallback();

  const rows = db.prepare('SELECT id, parent_id FROM messages WHERE conversation_id = ?').all(conversationId) as { id: string; parent_id: string | null }[];
  const parentById = new Map<string, string | null>();
  const idSet = new Set<string>();
  for (const r of rows) {
    parentById.set(r.id, r.parent_id);
    idSet.add(r.id);
  }
  if (!idSet.has(leafId)) return chronologicalFallback();

  const chain: string[] = [];
  let current: string | null = leafId;
  for (let i = 0; i < MAX_CHAIN_WALK && current; i++) {
    chain.push(current);
    const parent = parentById.get(current);
    if (parent === undefined) {
      // Broken chain: parent row missing from this conversation → defensive fallback.
      return chronologicalFallback();
    }
    current = parent;
  }
  if (current) {
    // Safety cap hit (cycle or pathological chain) → defensive fallback.
    return chronologicalFallback();
  }
  return chain.reverse();
}

/**
 * Lists the variants of a turn: all role='user' messages sharing turn_id,
 * ordered by variant_seq ascending.
 */
export function getTurnVariants(conversationId: string, turnId: string): TurnVariant[] {
  return db.prepare(`
    SELECT id, model, content, created_at, variant_seq
    FROM messages
    WHERE conversation_id = ? AND turn_id = ? AND role = 'user'
    ORDER BY variant_seq ASC
  `).all(conversationId, turnId) as TurnVariant[];
}

/**
 * Tail of the thread hanging off the variant root: the deepest descendant via
 * parent_id, INCLUDING later turns that continue the variant's thread (e.g. a
 * user message sent after an aborted response). No turn_id filtering — those
 * later turns are the variant's legitimate continuation. Ties (two branches of
 * equal depth, e.g. sibling turn variants) resolve toward the earlier created
 * message — the original continuation. Returns the root itself when it has no
 * continuation. Returns null when the root does not exist or is not a user
 * message.
 */
export function findVariantLeaf(conversationId: string, variantRootId: string): string | null {
  const root = db.prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ? AND role = ?').get(variantRootId, conversationId, 'user') as { id: string } | undefined;
  if (!root) return null;

  const row = db.prepare(`
    WITH RECURSIVE chain(id, created_at, depth) AS (
      SELECT id, created_at, 0 FROM messages WHERE id = ?
      UNION ALL
      SELECT m.id, m.created_at, c.depth + 1
      FROM messages m
      JOIN chain c ON m.parent_id = c.id
      WHERE m.conversation_id = ?
    )
    SELECT id FROM chain
    ORDER BY depth DESC, created_at ASC, id ASC
    LIMIT 1
  `).get(variantRootId, conversationId) as { id: string } | undefined;

  return row?.id ?? null;
}
