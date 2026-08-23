/**
 * Frozen wire contract for conversation share snapshots (plan.md D6).
 *
 * Allow-list semantics: a ShareSnapshot contains EXACTLY these fields. Anything
 * else on a message row (reasoning_content, token/cost accounting,
 * provider_routing, processed-by-agent internals, tool-call plumbing, tree
 * columns, conversation_id, role='tool' rows) must be stripped when the
 * snapshot is built — additions require a plan revision.
 */

export interface SharedMessage {
  id: string; // React key only
  role: 'user' | 'assistant';
  content: string;
  model?: string | null; // assistant-only informational metadata
  annotations: unknown[] | null; // web citations (url/title) — part of faithful rendering
  attachments: { filename: string }[] | null;
  created_at: string;
}

export interface ShareSnapshot {
  conversation_title: string;
  agent_name: string | null;
  agent_emoji: string | null;
  shared_at: string; // ISO timestamp of share creation
  messages: SharedMessage[];
}
