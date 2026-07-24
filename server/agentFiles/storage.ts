import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import db, { DB_DIRECTORY } from '../db.js';
import { inferMimeType } from '../utils/mimeTypes.js';

export const MAX_SEND_FILE_BYTES = 100 * 1024 * 1024;
export const AGENT_FILE_TTL_MS = 72 * 60 * 60 * 1000;
export const AGENT_FILE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const AGENT_FILES_DIR = path.join(DB_DIRECTORY, 'agent-files');

export interface StoredAgentFile {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  expiresAt: string;
}

interface StoredAgentFileRow {
  id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  expires_at: string;
}

function mapStoredAgentFile(row: StoredAgentFileRow): StoredAgentFile {
  return {
    id: row.id,
    userId: row.user_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    expiresAt: row.expires_at,
  };
}

export function saveAgentFile(params: {
  userId: string;
  agentId: string;
  filename: string;
  content: Buffer;
}): StoredAgentFile {
  const id = nanoid();
  const userDirectory = path.join(AGENT_FILES_DIR, params.userId);
  const storagePath = path.join(userDirectory, id);
  const mimeType = inferMimeType(params.filename);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + AGENT_FILE_TTL_MS).toISOString();

  fs.mkdirSync(userDirectory, { recursive: true });
  fs.writeFileSync(storagePath, params.content);
  try {
    db.prepare(`
      INSERT INTO agent_files (
        id, user_id, agent_id, filename, mime_type, size_bytes,
        storage_path, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.userId,
      params.agentId,
      params.filename,
      mimeType,
      params.content.length,
      storagePath,
      createdAt,
      expiresAt,
    );
  } catch (error) {
    try { fs.unlinkSync(storagePath); } catch { /* best-effort rollback */ }
    throw error;
  }

  return {
    id,
    userId: params.userId,
    filename: params.filename,
    mimeType,
    sizeBytes: params.content.length,
    storagePath,
    expiresAt,
  };
}

export function getActiveAgentFile(fileId: string): StoredAgentFile | undefined {
  const row = db.prepare(`
    SELECT id, user_id, filename, mime_type, size_bytes, storage_path, expires_at
    FROM agent_files
    WHERE id = ? AND expires_at > ?
  `).get(fileId, new Date().toISOString()) as StoredAgentFileRow | undefined;
  return row ? mapStoredAgentFile(row) : undefined;
}

export function sweepExpiredAgentFiles(): void {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT id, storage_path
    FROM agent_files
    WHERE expires_at <= ?
  `).all(now) as Array<{ id: string; storage_path: string }>;

  const deleteStatement = db.prepare('DELETE FROM agent_files WHERE id = ?');
  for (const row of rows) {
    try { fs.unlinkSync(row.storage_path); } catch { /* file may already be absent */ }
    deleteStatement.run(row.id);
  }
}

export function startAgentFileSweep(): void {
  sweepExpiredAgentFiles();
  setInterval(sweepExpiredAgentFiles, AGENT_FILE_SWEEP_INTERVAL_MS).unref();
}
