import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  isAgentConnected,
  sendFileOpRequest,
} from '../agentRelay/registry.js';
import { logToolExecution } from './execAudit.js';
import { truncateCommandOutput } from './execCommand.js';
import * as fileReadGuard from './fileReadGuard.js';

export const MAX_LINE_LENGTH = 2_000;
export const DEFAULT_READ_LIMIT_LINES = 2_000;
export const MAX_READ_SCAN_BYTES = 10_000_000;
export const MAX_WRITE_FILE_BYTES = 10_000_000;
export const MAX_LIST_ENTRIES = 1_000;
export const FILE_OP_TIMEOUT_MS = 30_000;
export const DELETE_FILE_TIMEOUT_MS = 90_000;

const MODEL_COUNCIL_ERROR = (toolName: string) =>
  `${toolName} requires the interactive execution context; not available from Model Council in v1.`;
const LOCAL_AGENT_ERROR = 'local agent is not connected';

const readFileArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

const writeFileArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string(),
});

const editFileArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const deleteFileArgsSchema = z.object({
  path: z.string().min(1, 'path is required'),
  recursive: z.boolean().optional(),
});

const listDirectoryArgsSchema = z.object({
  path: z.string().min(1, 'path must not be empty').optional(),
});

type FileOpResponse = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

type ReadFileResponse = FileOpResponse & {
  content?: string;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
};

type WriteFileResponse = FileOpResponse & {
  bytesWritten?: number;
  created?: boolean;
};

type EditFileResponse = FileOpResponse & {
  replacementsMade?: number;
};

type DeleteFileResponse = FileOpResponse & {
  kind?: 'file' | 'directory';
  confirmation?: 'declined' | 'timeout';
};

type ListDirectoryResponse = FileOpResponse & {
  entries?: Array<{ name: string; type: string; sizeBytes?: number }>;
  truncated?: boolean;
  totalEntries?: number;
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

function responseError(toolName: string, response: FileOpResponse): string {
  return typeof response.error === 'string' && response.error.trim()
    ? response.error
    : `${toolName} failed`;
}

function pathFromArgs(args: Record<string, unknown>): string {
  return typeof args?.path === 'string' ? args.path : '';
}

function writeAuditCommand(path: string, bytesWritten?: unknown): string {
  const bytes = typeof bytesWritten === 'number' && Number.isFinite(bytesWritten) ? bytesWritten : 0;
  return `write_file ${path} (${bytes} bytes)`;
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

export async function readFileTool(
  args: Record<string, unknown>,
  userId: string,
  conversationId?: string,
): Promise<string> {
  const finish = createFinisher(userId, conversationId, 'read_file');
  const rawPath = pathFromArgs(args);
  if (conversationId === undefined) {
    return finish({ error: MODEL_COUNCIL_ERROR('read_file') }, true, `read_file ${rawPath}`);
  }
  if (!isAgentConnected(userId)) {
    return finish({ error: LOCAL_AGENT_ERROR }, true, `read_file ${rawPath}`);
  }

  const parsed = readFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return finish({ error: invalidArguments('read_file', parsed.error) }, true, `read_file ${rawPath}`);
  }

  const { path, offset = 1, limit = DEFAULT_READ_LIMIT_LINES } = parsed.data;
  const command = `read_file ${path}`;
  const request = {
    type: 'read_file_request' as const,
    requestId: `file_op_${nanoid()}`,
    path,
    offset,
    limit,
  };

  try {
    const response = await sendFileOpRequest<ReadFileResponse>(userId, request, FILE_OP_TIMEOUT_MS);
    if (response.ok !== true) {
      return finish({ error: responseError('read_file', response) }, true, command);
    }
    const content = truncateCommandOutput(String(response.content ?? ''));
    fileReadGuard.markPathRead(conversationId, path);
    return finish({
      ...response,
      content: content.text,
      truncated: Boolean(response.truncated || content.truncated),
    }, false, command);
  } catch (error) {
    return finish({ error: errorMessage(error, 'read_file failed') }, true, command);
  }
}

export async function writeFileTool(
  args: Record<string, unknown>,
  userId: string,
  conversationId?: string,
): Promise<string> {
  const finish = createFinisher(userId, conversationId, 'write_file');
  const rawPath = pathFromArgs(args);
  if (conversationId === undefined) {
    return finish({ error: MODEL_COUNCIL_ERROR('write_file') }, true, writeAuditCommand(rawPath));
  }
  if (!isAgentConnected(userId)) {
    return finish({ error: LOCAL_AGENT_ERROR }, true, writeAuditCommand(rawPath));
  }

  const parsed = writeFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return finish({ error: invalidArguments('write_file', parsed.error) }, true, writeAuditCommand(rawPath));
  }

  const { path, content } = parsed.data;
  const command = writeAuditCommand(path);
  const request = {
    type: 'write_file_request' as const,
    requestId: `file_op_${nanoid()}`,
    path,
    content,
    hasBeenRead: fileReadGuard.hasPathBeenRead(conversationId, path),
  };

  try {
    const response = await sendFileOpRequest<WriteFileResponse>(userId, request, FILE_OP_TIMEOUT_MS);
    const responseCommand = writeAuditCommand(path, response.bytesWritten);
    if (response.ok !== true) {
      return finish({ error: responseError('write_file', response) }, true, responseCommand);
    }
    fileReadGuard.markPathRead(conversationId, path);
    return finish({ ...response }, false, responseCommand);
  } catch (error) {
    return finish({ error: errorMessage(error, 'write_file failed') }, true, command);
  }
}

export async function editFileTool(
  args: Record<string, unknown>,
  userId: string,
  conversationId?: string,
): Promise<string> {
  const finish = createFinisher(userId, conversationId, 'edit_file');
  const rawPath = pathFromArgs(args);
  const command = `edit_file ${rawPath}`;
  if (conversationId === undefined) {
    return finish({ error: MODEL_COUNCIL_ERROR('edit_file') }, true, command);
  }
  if (!isAgentConnected(userId)) {
    return finish({ error: LOCAL_AGENT_ERROR }, true, command);
  }

  const parsed = editFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return finish({ error: invalidArguments('edit_file', parsed.error) }, true, command);
  }

  const { path, old_string: oldString, new_string: newString, replace_all: replaceAll } = parsed.data;
  const parsedCommand = `edit_file ${path}`;
  const request = {
    type: 'edit_file_request' as const,
    requestId: `file_op_${nanoid()}`,
    path,
    oldString,
    newString,
    ...(replaceAll === undefined ? {} : { replaceAll }),
    hasBeenRead: fileReadGuard.hasPathBeenRead(conversationId, path),
  };

  try {
    const response = await sendFileOpRequest<EditFileResponse>(userId, request, FILE_OP_TIMEOUT_MS);
    if (response.ok !== true) {
      return finish({ error: responseError('edit_file', response) }, true, parsedCommand);
    }
    fileReadGuard.markPathRead(conversationId, path);
    return finish({ ...response }, false, parsedCommand);
  } catch (error) {
    return finish({ error: errorMessage(error, 'edit_file failed') }, true, parsedCommand);
  }
}

export async function deleteFileTool(
  args: Record<string, unknown>,
  userId: string,
  conversationId?: string,
): Promise<string> {
  const finish = createFinisher(userId, conversationId, 'delete_file');
  const rawPath = pathFromArgs(args);
  const rawRecursive = args?.recursive === true;
  const command = `delete_file ${rawPath}${rawRecursive ? ' --recursive' : ''}`;
  if (conversationId === undefined) {
    return finish({ error: MODEL_COUNCIL_ERROR('delete_file') }, true, command);
  }
  if (!isAgentConnected(userId)) {
    return finish({ error: LOCAL_AGENT_ERROR }, true, command);
  }

  const parsed = deleteFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    return finish({ error: invalidArguments('delete_file', parsed.error) }, true, command);
  }

  const { path, recursive } = parsed.data;
  const parsedCommand = `delete_file ${path}${recursive ? ' --recursive' : ''}`;
  const request = {
    type: 'delete_file_request' as const,
    requestId: `file_op_${nanoid()}`,
    path,
    ...(recursive === undefined ? {} : { recursive }),
  };

  try {
    const response = await sendFileOpRequest<DeleteFileResponse>(userId, request, DELETE_FILE_TIMEOUT_MS);
    if (response.ok !== true) {
      return finish({ error: responseError('delete_file', response) }, true, parsedCommand);
    }
    return finish({ ...response }, false, parsedCommand);
  } catch (error) {
    return finish({ error: errorMessage(error, 'delete_file failed') }, true, parsedCommand);
  }
}

export async function listDirectoryTool(
  args: Record<string, unknown>,
  userId: string,
  conversationId?: string,
): Promise<string> {
  const finish = createFinisher(userId, conversationId, 'list_directory');
  const rawPath = pathFromArgs(args);
  if (conversationId === undefined) {
    return finish({ error: MODEL_COUNCIL_ERROR('list_directory') }, true, `list_directory ${rawPath}`);
  }
  if (!isAgentConnected(userId)) {
    return finish({ error: LOCAL_AGENT_ERROR }, true, `list_directory ${rawPath}`);
  }

  const parsed = listDirectoryArgsSchema.safeParse(args);
  if (!parsed.success) {
    return finish({ error: invalidArguments('list_directory', parsed.error) }, true, `list_directory ${rawPath}`);
  }

  const path = parsed.data.path ?? '.';
  const command = `list_directory ${path}`;
  const request = {
    type: 'list_directory_request' as const,
    requestId: `file_op_${nanoid()}`,
    path,
  };

  try {
    const response = await sendFileOpRequest<ListDirectoryResponse>(userId, request, FILE_OP_TIMEOUT_MS);
    if (response.ok !== true) {
      return finish({ error: responseError('list_directory', response) }, true, command);
    }
    return finish({ ...response }, false, command);
  } catch (error) {
    return finish({ error: errorMessage(error, 'list_directory failed') }, true, command);
  }
}
