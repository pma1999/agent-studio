import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  isAgentConnected,
  sendFileOpRequest,
} from '../agentRelay/registry.js';
import { logToolExecution } from './execAudit.js';

/**
 * Longer than the local agent's own 100s upload-abort timeout, so the local
 * agent's own "upload failed" error reaches this tool's result before the
 * relay itself times out the request.
 */
export const SEND_FILE_TIMEOUT_MS = 120_000;

const MODEL_COUNCIL_ERROR = (toolName: string) =>
  `${toolName} requires the interactive execution context; not available from Model Council in v1.`;
const LOCAL_AGENT_ERROR = 'local agent is not connected';

const sendFileArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

type SendFileResponse = {
  ok: boolean;
  error?: string;
  fileId?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  expiresAt?: string;
};

function invalidArguments(toolName: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ');
  return `Invalid ${toolName} arguments: ${issues}`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'error' in error) {
    const message = (error as { error?: unknown }).error;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function responseError(toolName: string, response: SendFileResponse): string {
  return typeof response.error === 'string' && response.error.trim()
    ? response.error
    : `${toolName} failed`;
}

function pathFromArgs(args: Record<string, unknown>): string {
  return typeof args?.path === 'string' ? args.path : '';
}

function createFinisher(
  userId: string,
  conversationId: string | undefined,
  toolName: string,
): (output: Record<string, unknown>, isError: boolean, command: string) => string {
  const startedAt = Date.now();
  let auditLogged = false;
  return (output, isError, command) => {
    if (!auditLogged) {
      auditLogged = true;
      logToolExecution({
        userId,
        conversationId,
        toolName,
        backend: 'local',
        command,
        durationMs: Date.now() - startedAt,
        isError,
      });
    }
    return JSON.stringify(output);
  };
}

export async function sendFileTool(
  args: Record<string, unknown>,
  userId: string,
  conversationId?: string,
): Promise<string> {
  const finish = createFinisher(userId, conversationId, 'send_file');
  const rawPath = pathFromArgs(args);
  const command = `send_file ${rawPath}`;
  if (conversationId === undefined) {
    return finish({ ok: false, error: MODEL_COUNCIL_ERROR('send_file') }, true, command);
  }
  if (!isAgentConnected(userId)) {
    return finish({ ok: false, error: LOCAL_AGENT_ERROR }, true, command);
  }

  const parsed = sendFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return finish({ ok: false, error: invalidArguments('send_file', parsed.error) }, true, command);
  }

  const { path } = parsed.data;
  const parsedCommand = `send_file ${path}`;
  const request = {
    type: 'send_file_request' as const,
    requestId: `file_op_${nanoid()}`,
    path,
  };

  try {
    const response = await sendFileOpRequest<SendFileResponse>(userId, request, SEND_FILE_TIMEOUT_MS);
    if (response.ok !== true) {
      return finish({ ok: false, error: responseError('send_file', response) }, true, parsedCommand);
    }
    return finish({
      ok: true,
      fileId: response.fileId,
      filename: response.filename,
      mimeType: response.mimeType,
      sizeBytes: response.sizeBytes,
      expiresAt: response.expiresAt,
    }, false, parsedCommand);
  } catch (error) {
    return finish({ ok: false, error: errorMessage(error, 'send_file failed') }, true, parsedCommand);
  }
}
