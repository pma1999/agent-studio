import type { Message } from '../types';

/** Safety cap for parent-chain walks (guards against cyclic/corrupt data). */
const MAX_PARENT_DEPTH = 5000;

/**
 * Builds the visible thread of a conversation: the chain walked from `leafId`
 * upwards through `parent_id` links, returned root → leaf.
 *
 * Fallbacks (legacy / unmigrated data):
 * - `leafId` is null, not found, or no message in the list carries a `parent_id`:
 *   returns ALL messages ordered by `created_at` ASC (stable on ties — insertion order).
 */
export function buildThread(messages: Message[], leafId: string | null): Message[] {
  const byId = new Map<string, Message>();
  let hasParents = false;
  for (const message of messages) {
    byId.set(message.id, message);
    if (message.parent_id != null) hasParents = true;
  }

  const leaf = leafId ? byId.get(leafId) : undefined;
  if (leaf && hasParents) {
    const chain: Message[] = [];
    const seen = new Set<string>();
    let current: Message | undefined = leaf;
    let depth = 0;
    while (current && depth <= MAX_PARENT_DEPTH && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current = current.parent_id != null ? byId.get(current.parent_id) : undefined;
      depth++;
    }
    // Even a broken mid-chain link still yields the reachable prefix (leaf → root).
    if (chain.length > 0) {
      return chain.reverse();
    }
  }

  // Legacy ordering: created_at ASC; `Array.prototype.sort` is stable, so ties keep
  // the original (insertion) order.
  return [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Returns all role='user' messages sharing the turn_id of `userMessageId`,
 * ordered by variant_seq ASC (fallback: created_at ASC).
 * If the message is not a user message or has no turn_id → `[message]`.
 * If the message id is unknown → `[]`.
 */
export function getTurnVariants(messages: Message[], userMessageId: string): Message[] {
  const target = messages.find((message) => message.id === userMessageId);
  if (!target) return [];
  if (target.role !== 'user' || !target.turn_id) return [target];

  const variants = messages.filter(
    (message) => message.role === 'user' && message.turn_id === target.turn_id
  );

  return [...variants].sort((a, b) => {
    const seqA = a.variant_seq ?? Number.MAX_SAFE_INTEGER;
    const seqB = b.variant_seq ?? Number.MAX_SAFE_INTEGER;
    if (seqA !== seqB) return seqA - seqB;
    return a.created_at.localeCompare(b.created_at);
  });
}

/**
 * Finds the tail of the thread that hangs off the variant rooted at
 * `variantUserMessageId`: the deepest descendant via parent_id, INCLUDING
 * later turns that continue the variant's thread (e.g. a user message sent
 * after an aborted response — that turn is the variant's legitimate
 * continuation, so no turn_id filtering is applied). Ties (two branches of
 * equal depth, e.g. sibling turn variants) resolve toward the earlier created
 * message — the original continuation. Returns the root itself when it has no
 * descendants. Returns null when the root message is unknown.
 */
export function findVariantLeaf(messages: Message[], variantUserMessageId: string): string | null {
  const root = messages.find((message) => message.id === variantUserMessageId);
  if (!root) return null;

  const children = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.parent_id != null) {
      const siblings = children.get(message.parent_id) ?? [];
      siblings.push(message);
      children.set(message.parent_id, siblings);
    }
  }

  let best: Message = root;
  let bestDepth = 0;
  const stack: Array<{ message: Message; depth: number }> = [{ message: root, depth: 0 }];

  while (stack.length > 0) {
    const { message, depth } = stack.pop()!;
    const isDeeper = depth > bestDepth;
    const isTieBetter =
      depth === bestDepth &&
      (message.created_at < best.created_at ||
        (message.created_at === best.created_at && message.id < best.id));
    if (isDeeper || isTieBetter) {
      best = message;
      bestDepth = depth;
    }
    for (const child of children.get(message.id) ?? []) {
      stack.push({ message: child, depth: depth + 1 });
    }
  }

  return best.id;
}

/**
 * From the active leaf, walks up to the nearest role='user' message and reports
 * its variant position: `index` = its variant_seq (fallback 1), `total` = number
 * of variants in that turn. Returns null when the leaf is unknown or the chain
 * contains no user message.
 */
export function getCurrentVariant(
  messages: Message[],
  leafId: string | null,
): { userMessageId: string; turnId: string; index: number; total: number } | null {
  if (!leafId) return null;

  const byId = new Map<string, Message>();
  for (const message of messages) byId.set(message.id, message);

  let current = byId.get(leafId);
  if (!current) return null;

  let depth = 0;
  while (current.role !== 'user' && current.parent_id != null && depth <= MAX_PARENT_DEPTH) {
    current = byId.get(current.parent_id);
    if (!current) return null;
    depth++;
  }
  if (current.role !== 'user') return null;

  const variants = getTurnVariants(messages, current.id);
  return {
    userMessageId: current.id,
    turnId: current.turn_id ?? '',
    index: current.variant_seq ?? 1,
    total: variants.length,
  };
}
