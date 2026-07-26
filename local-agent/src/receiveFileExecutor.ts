import fs from 'node:fs/promises';
import path from 'node:path';
import type { SendFn } from './commandExecutor.js';
import type { ReceiveFileRequestMessage } from './transport.js';

export const MAX_RECEIVE_FILE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 100_000;
const MAX_COLLISION_ATTEMPTS = 100;

export type DownloadResult = { ok: true; content: Buffer } | { ok: false; error: string };

export type DownloadFn = (params: {
  backendUrl: string;
  token: string;
  fileId: string;
  signal: AbortSignal;
}) => Promise<DownloadResult>;

export interface ReceiveFileExecutorOptions {
  workspaceRoot: string;
  backendUrl: string;
  token: string;
  send: SendFn;
  /** Defaults to a real `fetch()`-based implementation; tests inject a fake. */
  downloadFn?: DownloadFn;
}

export interface ReceiveFileExecutor {
  handleReceiveFileRequest(request: ReceiveFileRequestMessage): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A second, independent sanitization pass over `request.filename` — the
 * backend (Task 02) already sanitized it once (`server/routes/agentFiles.ts`'s
 * own `sanitizeFilename`), but this process never trusts a single hop's
 * validation alone (mirrors the outbound path's own "size checked in three
 * places" precedent). Intentionally duplicated logic, not a shared import
 * (`local-agent/` and `server/` never cross-import, see `transport.ts`).
 */
function sanitizeFilename(filename: string): string {
  const sanitized = filename.replace(/[\/\\\x00-\x1f:<>"|?*]/g, '').trim().slice(0, 255);
  return sanitized || 'file';
}

async function defaultDownload({ backendUrl, token, fileId, signal }: Parameters<DownloadFn>[0]): Promise<DownloadResult> {
  try {
    const response = await fetch(new URL(`/api/agent/files/inbound/${fileId}`, backendUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: `download failed (HTTP ${response.status})` };
      }
      if (isRecord(body) && typeof body.error === 'string' && body.error.length > 0) {
        return { ok: false, error: body.error };
      }
      return { ok: false, error: `download failed (HTTP ${response.status})` };
    }

    const arrayBuffer = await response.arrayBuffer();
    return { ok: true, content: Buffer.from(arrayBuffer) };
  } catch (error) {
    return { ok: false, error: `download failed: ${errorMessage(error)}` };
  }
}

export function createReceiveFileExecutor(options: ReceiveFileExecutorOptions): ReceiveFileExecutor {
  const download = options.downloadFn ?? defaultDownload;

  async function handleReceiveFileRequest(request: ReceiveFileRequestMessage): Promise<void> {
    if (request.sizeBytes > MAX_RECEIVE_FILE_BYTES) {
      options.send({
        type: 'receive_file_response',
        requestId: request.requestId,
        ok: false,
        error: `File too large: declared size exceeds the ${MAX_RECEIVE_FILE_BYTES}-byte receive limit.`,
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let content: Buffer;
    try {
      const result = await download({
        backendUrl: options.backendUrl,
        token: options.token,
        fileId: request.fileId,
        signal: controller.signal,
      });
      if (!result.ok) {
        options.send({ type: 'receive_file_response', requestId: request.requestId, ok: false, error: result.error });
        return;
      }
      content = result.content;
    } catch (error) {
      options.send({ type: 'receive_file_response', requestId: request.requestId, ok: false, error: `download failed: ${errorMessage(error)}` });
      return;
    } finally {
      clearTimeout(timeout);
    }

    // Defense in depth: the declared `sizeBytes` is not blindly trusted —
    // re-check against the actual downloaded byte length.
    if (content.length > MAX_RECEIVE_FILE_BYTES) {
      options.send({
        type: 'receive_file_response',
        requestId: request.requestId,
        ok: false,
        error: `File too large: downloaded content exceeds the ${MAX_RECEIVE_FILE_BYTES}-byte receive limit.`,
      });
      return;
    }

    const uploadsDir = path.join(options.workspaceRoot, 'uploads');
    try {
      await fs.mkdir(uploadsDir, { recursive: true });
    } catch (error) {
      options.send({
        type: 'receive_file_response',
        requestId: request.requestId,
        ok: false,
        error: `Failed to create uploads directory: ${errorMessage(error)}`,
      });
      return;
    }

    const safeName = sanitizeFilename(request.filename);
    const ext = path.extname(safeName);
    const stem = safeName.slice(0, safeName.length - ext.length);

    let writtenAbsolutePath: string | undefined;
    // attempt 0 is the plain name (no suffix); attempts 1..MAX_COLLISION_ATTEMPTS
    // are the suffixed collision-avoidance retries.
    for (let attempt = 0; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
      const candidateName = attempt === 0 ? safeName : `${stem} (${attempt})${ext}`;
      const candidatePath = path.join(uploadsDir, candidateName);
      try {
        await fs.writeFile(candidatePath, content, { flag: 'wx' });
        writtenAbsolutePath = candidatePath;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          options.send({
            type: 'receive_file_response',
            requestId: request.requestId,
            ok: false,
            error: `Failed to write file: ${errorMessage(error)}`,
          });
          return;
        }
        // Name taken — never overwrite; try the next suffixed candidate.
      }
    }

    if (!writtenAbsolutePath) {
      options.send({
        type: 'receive_file_response',
        requestId: request.requestId,
        ok: false,
        error: `Could not find a free filename for "${safeName}" in "${uploadsDir}" after ${MAX_COLLISION_ATTEMPTS} attempts.`,
      });
      return;
    }

    const writtenPath = path.relative(options.workspaceRoot, writtenAbsolutePath).split(path.sep).join('/');
    options.send({
      type: 'receive_file_response',
      requestId: request.requestId,
      ok: true,
      writtenPath,
      bytesWritten: content.length,
    });
  }

  return { handleReceiveFileRequest };
}
