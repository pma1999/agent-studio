import { z } from 'zod';
import db from '../db.js';
import { ARTIFACT_KINDS, MAX_ARTIFACT_CONTENT_CHARS, MAX_ARTIFACT_TITLE_CHARS, type ArtifactKind } from '../../shared/artifactTypes.js';
import { createArtifact, appendArtifactVersion } from '../artifacts/storage.js';
import { CREATE_ARTIFACT_DESCRIPTION, CREATE_ARTIFACT_SCHEMA, UPDATE_ARTIFACT_DESCRIPTION, UPDATE_ARTIFACT_SCHEMA } from './artifactToolDefs.js';

// Re-export single-source constants for registry.ts (GC3).
export { CREATE_ARTIFACT_DESCRIPTION, CREATE_ARTIFACT_SCHEMA, UPDATE_ARTIFACT_DESCRIPTION, UPDATE_ARTIFACT_SCHEMA } from './artifactToolDefs.js';

const LANGUAGE_RE = /^[a-zA-Z0-9+#._-]{1,40}$/;

const createArtifactArgsSchema = z
  .object({
    kind: z.enum(ARTIFACT_KINDS as unknown as [string, ...string[]], { message: `kind must be one of: ${ARTIFACT_KINDS.join(', ')}` }),
    title: z.string().trim().min(1, 'title must not be empty').max(MAX_ARTIFACT_TITLE_CHARS, `title must be at most ${MAX_ARTIFACT_TITLE_CHARS} characters`),
    content: z.string().min(1, 'content is required').max(MAX_ARTIFACT_CONTENT_CHARS, `content must be at most ${MAX_ARTIFACT_CONTENT_CHARS} characters`),
    language: z.string().regex(LANGUAGE_RE, 'language must match /^[a-zA-Z0-9+#._-]{1,40}$/').optional(),
  })
  .strict();

const updateArtifactArgsSchema = z
  .object({
    artifact_id: z.string().min(1, 'artifact_id is required'),
    title: z.string().trim().min(1, 'title must not be empty').max(MAX_ARTIFACT_TITLE_CHARS, `title must be at most ${MAX_ARTIFACT_TITLE_CHARS} characters`).optional(),
    content: z.string().min(1, 'content is required').max(MAX_ARTIFACT_CONTENT_CHARS, `content must be at most ${MAX_ARTIFACT_CONTENT_CHARS} characters`),
  })
  .strict();

function invalidArguments(toolName: string, error: z.ZodError): string {
  const issues = error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
  return `Invalid ${toolName} arguments: ${issues}`;
}

function softError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export async function createArtifactTool(
  args: Record<string, unknown>,
  userId?: string,
  conversationId?: string
): Promise<string> {
  if (!userId || !conversationId) {
    return JSON.stringify({ ok: false, error: 'artifact context unavailable: missing user or conversation context' });
  }

  const parsed = createArtifactArgsSchema.safeParse(args);
  if (!parsed.success) {
    return JSON.stringify({ ok: false, error: invalidArguments('create_artifact', parsed.error) });
  }

  const { kind, title, content, language } = parsed.data;

  try {
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId) as { id: string } | undefined;
    if (!conv) {
      return JSON.stringify({ ok: false, error: 'conversation not found' });
    }
  } catch (e) {
    return JSON.stringify({ ok: false, error: softError(e, 'conversation not found') });
  }

  try {
    const artifact = createArtifact({
      userId,
      conversationId,
      kind: kind as ArtifactKind,
      title,
      language: language ?? null,
      content,
    });
    return JSON.stringify({ ok: true, artifactId: artifact.id, version: artifact.version, kind: artifact.kind });
  } catch (e) {
    return JSON.stringify({ ok: false, error: softError(e, 'create_artifact failed') });
  }
}

export async function updateArtifactTool(
  args: Record<string, unknown>,
  userId?: string,
  conversationId?: string
): Promise<string> {
  if (!userId || !conversationId) {
    return JSON.stringify({ ok: false, error: 'artifact context unavailable: missing user or conversation context' });
  }

  const parsed = updateArtifactArgsSchema.safeParse(args);
  if (!parsed.success) {
    return JSON.stringify({ ok: false, error: invalidArguments('update_artifact', parsed.error) });
  }

  const { artifact_id, title, content } = parsed.data;

  try {
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId) as { id: string } | undefined;
    if (!conv) {
      return JSON.stringify({ ok: false, error: 'conversation not found' });
    }
  } catch (e) {
    return JSON.stringify({ ok: false, error: softError(e, 'conversation not found') });
  }

  const existing = db.prepare('SELECT id FROM artifacts WHERE id = ? AND user_id = ?').get(artifact_id, userId) as { id: string } | undefined;
  if (!existing) {
    return JSON.stringify({ ok: false, error: 'artifact not found' });
  }

  try {
    const artifact = appendArtifactVersion({
      userId,
      artifactId: artifact_id,
      content,
      title: title ?? null,
    });
    return JSON.stringify({ ok: true, artifactId: artifact.id, version: artifact.version, kind: artifact.kind });
  } catch (e) {
    return JSON.stringify({ ok: false, error: softError(e, 'update_artifact failed') });
  }
}
