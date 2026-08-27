import { nanoid } from 'nanoid';
import db from '../db.js';
import {
  ARTIFACT_KINDS,
  MAX_ARTIFACT_CONTENT_CHARS,
  MAX_ARTIFACT_TITLE_CHARS,
  type ArtifactKind,
  type ChatArtifact,
} from '../../shared/artifactTypes.js';

interface ArtifactRow {
  id: string;
  user_id: string;
  conversation_id: string;
  message_id: string | null;
  kind: string;
  title: string;
  language: string | null;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export function mapArtifactRow(row: ArtifactRow): ChatArtifact {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    kind: row.kind as ArtifactKind,
    title: row.title,
    language: row.language,
    content: row.content,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const LANGUAGE_RE = /^[a-zA-Z0-9+#._-]{1,40}$/;

function validateTitle(title: unknown): string {
  if (typeof title !== 'string') throw new Error('title must be a string');
  const t = title.trim();
  if (!t) throw new Error('title must not be empty');
  if (t.length > MAX_ARTIFACT_TITLE_CHARS) throw new Error(`title must be at most ${MAX_ARTIFACT_TITLE_CHARS} characters`);
  return t;
}

function validateKind(kind: unknown): ArtifactKind {
  if (typeof kind !== 'string' || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of: ${ARTIFACT_KINDS.join(', ')}`);
  }
  return kind as ArtifactKind;
}

function validateLanguage(language: unknown): string | null {
  if (language === undefined || language === null || language === '') return null;
  if (typeof language !== 'string') throw new Error('language must be a string');
  if (!LANGUAGE_RE.test(language)) throw new Error('language must match /^[a-zA-Z0-9+#._-]{1,40}$/');
  return language;
}

function validateContent(content: unknown): string {
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (content.length > MAX_ARTIFACT_CONTENT_CHARS) throw new Error(`content must be at most ${MAX_ARTIFACT_CONTENT_CHARS} characters`);
  return content;
}

export function createArtifact(input: {
  userId: string;
  conversationId: string;
  messageId?: string | null;
  kind: ArtifactKind;
  title: string;
  language?: string | null;
  content: string;
}): ChatArtifact {
  const kind = validateKind(input.kind);
  const title = validateTitle(input.title);
  const language = validateLanguage(input.language);
  const content = validateContent(input.content);

  const id = nanoid();
  const now = new Date().toISOString();
  const version = 1;
  const messageId = input.messageId ?? null;

  const insertArtifact = db.prepare(`
    INSERT INTO artifacts (id, user_id, conversation_id, message_id, kind, title, language, content, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVersion = db.prepare(`
    INSERT INTO artifact_versions (id, artifact_id, user_id, version, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    insertArtifact.run(id, input.userId, input.conversationId, messageId, kind, title, language, content, version, now, now);
    insertVersion.run(nanoid(), id, input.userId, version, content, now);
  });

  run();

  return {
    id,
    conversation_id: input.conversationId,
    message_id: messageId,
    kind,
    title,
    language,
    content,
    version,
    created_at: now,
    updated_at: now,
  };
}

export function appendArtifactVersion(input: {
  userId: string;
  artifactId: string;
  content: string;
  title?: string | null;
  messageId?: string | null;
}): ChatArtifact {
  const content = validateContent(input.content);

  const row = db.prepare('SELECT * FROM artifacts WHERE id = ? AND user_id = ?').get(input.artifactId, input.userId) as ArtifactRow | undefined;
  if (!row) throw new Error('artifact not found');

  let nextTitle = row.title;
  if (input.title !== undefined && input.title !== null) {
    nextTitle = validateTitle(input.title);
  }

  const nextVersion = row.version + 1;
  const now = new Date().toISOString();
  const nextMessageId = input.messageId !== undefined ? (input.messageId ?? null) : row.message_id;

  const updateArtifact = db.prepare(`
    UPDATE artifacts SET content = ?, title = ?, version = ?, updated_at = ?, message_id = ? WHERE id = ? AND user_id = ?
  `);
  const insertVersion = db.prepare(`
    INSERT INTO artifact_versions (id, artifact_id, user_id, version, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    updateArtifact.run(content, nextTitle, nextVersion, now, nextMessageId, input.artifactId, input.userId);
    insertVersion.run(nanoid(), input.artifactId, input.userId, nextVersion, content, now);
  });
  run();

  const updated = db.prepare('SELECT * FROM artifacts WHERE id = ? AND user_id = ?').get(input.artifactId, input.userId) as ArtifactRow;
  return mapArtifactRow(updated);
}

export function getArtifact(artifactId: string, userId: string): ChatArtifact | undefined {
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ? AND user_id = ?').get(artifactId, userId) as ArtifactRow | undefined;
  return row ? mapArtifactRow(row) : undefined;
}

export function listConversationArtifacts(conversationId: string, userId: string): ChatArtifact[] {
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId) as { id: string } | undefined;
  if (!conv) throw new Error('conversation not found');
  const rows = db.prepare('SELECT * FROM artifacts WHERE conversation_id = ? AND user_id = ? ORDER BY updated_at ASC').all(conversationId, userId) as ArtifactRow[];
  return rows.map(mapArtifactRow);
}
