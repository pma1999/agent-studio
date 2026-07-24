import fs from 'node:fs/promises';
import path from 'node:path';
import { scopePath } from './fileOpsExecutor.js';
import type { SendFn } from './commandExecutor.js';
import type { SendFileRequestMessage } from './transport.js';

export const MAX_SEND_FILE_BYTES = 100 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 100_000;

export type UploadResult =
  | { ok: true; fileId: string; filename: string; mimeType: string; sizeBytes: number; expiresAt: string }
  | { ok: false; error: string };

export type UploadFn = (params: {
  backendUrl: string;
  token: string;
  filename: string;
  content: Buffer;
  signal: AbortSignal;
}) => Promise<UploadResult>;

export interface SendFileExecutorOptions {
  workspaceRoot: string;
  allowOutsideWorkspace: boolean;
  backendUrl: string;
  token: string;
  send: SendFn;
  /** Defaults to a real `fetch()`-based implementation; tests inject a fake. */
  uploadFn?: UploadFn;
}

export interface SendFileExecutor {
  handleSendFileRequest(request: SendFileRequestMessage): Promise<void>;
}

type UploadSuccessBody = {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUploadSuccessBody(value: unknown): value is UploadSuccessBody {
  if (!isRecord(value)) return false;
  return (
    typeof value.fileId === 'string' &&
    typeof value.filename === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.sizeBytes === 'number' &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    typeof value.expiresAt === 'string'
  );
}

async function defaultUpload({ backendUrl, token, filename, content, signal }: Parameters<UploadFn>[0]): Promise<UploadResult> {
  try {
    const response = await fetch(new URL('/api/agent/files/upload', backendUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'X-File-Name-B64': Buffer.from(filename, 'utf8').toString('base64'),
      },
      body: content as unknown as BodyInit,
      signal,
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: `upload failed (HTTP ${response.status})` };
    }

    if (!response.ok) {
      if (isRecord(body) && typeof body.error === 'string' && body.error.length > 0) {
        return { ok: false, error: body.error };
      }
      return { ok: false, error: `upload failed (HTTP ${response.status})` };
    }

    if (!isUploadSuccessBody(body)) {
      return { ok: false, error: 'upload failed (invalid response)' };
    }
    return { ok: true, ...body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `upload failed: ${message}` };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSendFileExecutor(options: SendFileExecutorOptions): SendFileExecutor {
  const upload = options.uploadFn ?? defaultUpload;

  async function handleSendFileRequest(request: SendFileRequestMessage): Promise<void> {
    const scope = scopePath(request.path, options.workspaceRoot, options.allowOutsideWorkspace);
    if (!scope.ok) {
      options.send({ type: 'send_file_response', requestId: request.requestId, ok: false, error: scope.error });
      return;
    }

    const resolved = scope.resolved;
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        options.send({ type: 'send_file_response', requestId: request.requestId, ok: false, error: `File not found: "${resolved}"` });
        return;
      }
      options.send({ type: 'send_file_response', requestId: request.requestId, ok: false, error: `Failed to stat file: ${errorMessage(error)}` });
      return;
    }

    if (stat.isDirectory()) {
      options.send({
        type: 'send_file_response',
        requestId: request.requestId,
        ok: false,
        error: `"${resolved}" is a directory, not a file. Use list_directory instead.`,
      });
      return;
    }

    if (stat.size > MAX_SEND_FILE_BYTES) {
      options.send({
        type: 'send_file_response',
        requestId: request.requestId,
        ok: false,
        error: `File too large: "${resolved}" exceeds the ${MAX_SEND_FILE_BYTES}-byte send limit.`,
      });
      return;
    }

    let content: Buffer;
    try {
      content = await fs.readFile(resolved);
    } catch (error) {
      options.send({ type: 'send_file_response', requestId: request.requestId, ok: false, error: `Failed to read file: ${errorMessage(error)}` });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const result = await upload({
        backendUrl: options.backendUrl,
        token: options.token,
        filename: path.basename(resolved),
        content,
        signal: controller.signal,
      });
      if (!result.ok) {
        options.send({ type: 'send_file_response', requestId: request.requestId, ok: false, error: result.error });
        return;
      }
      options.send({
        type: 'send_file_response',
        requestId: request.requestId,
        ok: true,
        fileId: result.fileId,
        filename: result.filename,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      options.send({ type: 'send_file_response', requestId: request.requestId, ok: false, error: `upload failed: ${errorMessage(error)}` });
    } finally {
      clearTimeout(timeout);
    }
  }

  return { handleSendFileRequest };
}
