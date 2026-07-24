/**
 * Handles the five file-operation request types end to end:
 * `read_file`/`write_file`/`edit_file`/`delete_file`/`list_directory`.
 * Mirrors `commandExecutor.ts`'s `createCommandExecutor` factory style
 * (closure-based, injectable options, no module-level singletons) and reuses
 * that same file's root-scoping pattern and Tier-2 console-confirmation flow
 * (`delete_file`'s confirmation gate reuses the exact `command_awaiting_confirmation`
 * message type + `confirmTier2` callback instance — no new message type, no
 * second confirmer).
 *
 * As with `shared/commandSafety.ts`'s own documented limitation, workspace-root
 * scoping here is a convenience default, not a hard security boundary: an
 * absolute path or `allowOutsideWorkspace: true` can always reach outside it.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { isPathWithinRoot } from '../../shared/commandSafety.js';
import type {
  DeleteFileRequestMessage,
  EditFileRequestMessage,
  ListDirectoryRequestMessage,
  ReadFileRequestMessage,
  WriteFileRequestMessage,
} from './transport.js';
import type { ConfirmFn, SendFn } from './commandExecutor.js';

export const MAX_LINE_LENGTH = 2000;
export const DEFAULT_READ_LIMIT_LINES = 2000;
export const MAX_READ_SCAN_BYTES = 10_000_000;
export const MAX_WRITE_FILE_BYTES = 10_000_000;
export const MAX_LIST_ENTRIES = 1000;
export const DELETE_LARGE_ENTRY_THRESHOLD = 50;
export const DELETE_LARGE_BYTES_THRESHOLD = 50_000_000;
export const DELETE_SIZE_SCAN_CAP_ENTRIES = 200;
export const DELETE_SIZE_SCAN_CAP_BYTES = 100_000_000;

/** Heuristic scan window for binary detection: a NUL byte anywhere in the first ~8KB. */
const BINARY_SCAN_BYTES = 8192;

export interface FileOpsExecutorOptions {
  workspaceRoot: string;
  allowOutsideWorkspace: boolean;
  send: SendFn;
  /** The SAME callback instance already passed to `createCommandExecutor`. */
  confirmTier2: ConfirmFn;
}

export interface FileOpsExecutor {
  handleReadFileRequest(request: ReadFileRequestMessage): Promise<void>;
  handleWriteFileRequest(request: WriteFileRequestMessage): Promise<void>;
  handleEditFileRequest(request: EditFileRequestMessage): Promise<void>;
  handleDeleteFileRequest(request: DeleteFileRequestMessage): Promise<void>;
  handleListDirectoryRequest(request: ListDirectoryRequestMessage): Promise<void>;
}

type ScopeResult = { ok: true; resolved: string } | { ok: false; error: string };

/**
 * Root-scoping shared by every op except `delete_file` (which has its own,
 * differently-ordered evaluation — see `handleDeleteFileRequest`): resolve
 * against `workspaceRoot` exactly like `commandExecutor.ts`'s `cwd` handling,
 * and reject before any fs access is attempted if it resolves outside the
 * root and `allowOutsideWorkspace` is disabled.
 */
export function scopePath(pathInput: string, workspaceRoot: string, allowOutsideWorkspace: boolean): ScopeResult {
  const resolved = path.resolve(workspaceRoot, pathInput);
  if (!allowOutsideWorkspace && !isPathWithinRoot(pathInput, workspaceRoot)) {
    return {
      ok: false,
      error: `Rejected: "${resolved}" resolves outside the workspace root "${workspaceRoot}" and allowOutsideWorkspace is disabled.`,
    };
  }
  return { ok: true, resolved };
}

function formatLine(lineNumber: number, text: string): string {
  let content = text;
  if (content.length > MAX_LINE_LENGTH) {
    content = `${content.slice(0, MAX_LINE_LENGTH)} … [local-agent] line truncated after ${MAX_LINE_LENGTH} chars`;
  }
  return `${lineNumber}\t${content}`;
}

interface ReadWindowResult {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

/**
 * Streams `resolvedPath` line by line (never `readFileSync`s the whole file),
 * collecting up to `limit` lines starting at 1-based `offset`. Stops early —
 * setting `truncated: true` — once either `limit` lines have been collected
 * or `MAX_READ_SCAN_BYTES` total bytes have been scanned, whichever comes
 * first. Rejects binary files via a NUL-byte heuristic over the first ~8KB
 * scanned (a best-effort heuristic, not exhaustive — see the task report's
 * named-risk note on UTF-16 false positives).
 */
async function readFileWindowed(
  resolvedPath: string,
  offset: number,
  limit: number
): Promise<ReadWindowResult | { error: string }> {
  const stream = fsSync.createReadStream(resolvedPath);
  let leftover = Buffer.alloc(0);
  let bytesScanned = 0;
  let binaryChecked = 0;
  let lineNumber = 0;
  const collected: string[] = [];
  let truncated = false;
  let stoppedEarly = false;

  try {
    for await (const chunkUnknown of stream) {
      const chunk = chunkUnknown as Buffer;
      bytesScanned += chunk.length;

      if (binaryChecked < BINARY_SCAN_BYTES) {
        const scanLen = Math.min(chunk.length, BINARY_SCAN_BYTES - binaryChecked);
        if (chunk.subarray(0, scanLen).includes(0)) {
          stream.destroy();
          return { error: 'Refusing to read: this file appears to be binary (a NUL byte was found near the start of the file).' };
        }
        binaryChecked += scanLen;
      }

      let data = Buffer.concat([leftover, chunk]);
      let newlineIndex: number;
      while ((newlineIndex = data.indexOf(0x0a)) !== -1) {
        let line = data.subarray(0, newlineIndex);
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        lineNumber++;
        if (lineNumber >= offset && collected.length < limit) {
          collected.push(formatLine(lineNumber, line.toString('utf8')));
        }
        data = data.subarray(newlineIndex + 1);
        if (collected.length >= limit) {
          truncated = true;
          stoppedEarly = true;
          break;
        }
      }
      leftover = data;

      if (stoppedEarly) {
        stream.destroy();
        break;
      }

      if (bytesScanned >= MAX_READ_SCAN_BYTES) {
        truncated = true;
        stoppedEarly = true;
        stream.destroy();
        break;
      }
    }
  } catch (error) {
    return { error: `Failed to read file: ${(error as Error).message}` };
  }

  if (!stoppedEarly && leftover.length > 0) {
    lineNumber++;
    if (lineNumber >= offset && collected.length < limit) {
      collected.push(formatLine(lineNumber, leftover.toString('utf8')));
    }
  }

  const totalLines = lineNumber;
  const startLine = offset;
  const endLine = collected.length > 0 ? offset + collected.length - 1 : offset - 1;

  return { content: collected.join('\n'), totalLines, startLine, endLine, truncated };
}

interface ScanResult {
  entries: number;
  bytes: number;
  cappedByScanLimit: boolean;
}

/**
 * Bounded walk of a directory tree for `delete_file`'s Tier-2 large-recursive-
 * delete check: stops as soon as either scan cap is exceeded and reports
 * `cappedByScanLimit: true` (the walk itself can never become the expensive
 * part). Unreadable entries are skipped best-effort — this is a size
 * estimate for a confirmation prompt, not an authoritative accounting.
 *
 * Uses `fs.opendir()` rather than `fs.readdir()` (RC-01, non-blocking
 * hardening from the final review): `readdir` reads an entire directory's
 * direct children into one in-memory array before this function ever gets a
 * chance to look at any of them, so a single directory with an extreme
 * number of direct entries was never actually bounded by the caps below for
 * that one call — contrary to the "the scan can never become the expensive
 * part" design goal. `opendir`'s `Dir` is async-iterable and fetches entries
 * lazily as the `for await` loop asks for them, so breaking out of the loop
 * (as soon as a cap is crossed) genuinely stops further directory reads
 * rather than merely stopping early on an already-fully-read array.
 */
async function boundedScanDirectory(dirPath: string): Promise<ScanResult> {
  let entries = 0;
  let bytes = 0;
  let cappedByScanLimit = false;
  const stack: string[] = [dirPath];

  while (stack.length > 0 && !cappedByScanLimit) {
    const current = stack.pop()!;
    let dir: fsSync.Dir;
    try {
      dir = await fs.opendir(current);
    } catch {
      continue;
    }
    try {
      for await (const entry of dir) {
        entries++;
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          stack.push(entryPath);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.stat(entryPath);
            bytes += stat.size;
          } catch {
            // unreadable file: skip for size purposes, still counted as an entry above
          }
        }
        if (entries >= DELETE_SIZE_SCAN_CAP_ENTRIES || bytes >= DELETE_SIZE_SCAN_CAP_BYTES) {
          cappedByScanLimit = true;
          break;
        }
      }
    } finally {
      await dir.close().catch(() => {});
    }
  }

  return { entries, bytes, cappedByScanLimit };
}

export interface WriteOutcome {
  ok: boolean;
  error?: string;
  bytesWritten?: number;
  created?: boolean;
}

/**
 * Performs the actual write once the pre-checks (root-scoping, the
 * existed-and-unread rejection, and the size cap) have already passed.
 * `existed` is the caller's existence snapshot, normally taken via an
 * `fs.stat` immediately before this call — but filesystem state can change
 * between that snapshot and the write itself (ARC-01 / RC-01, Codex
 * adversarial review): another process (another conversation against this
 * same connected agent, a build tool, a sync client) could create the
 * target in that window. An `existed: false` snapshot is therefore never
 * trusted blindly for the actual write: the create attempt uses an
 * exclusive flag (`wx`), and an `EEXIST` failure — proof the snapshot was
 * stale — re-evaluates the read-before-overwrite guard against the file
 * that actually exists now, rather than falling through to an unconditional
 * truncating write that would silently bypass the guard entirely.
 *
 * Exported so a test can pin `existed` independently of a real `fs.stat`
 * call, deterministically reproducing the exact race window (a stale
 * "doesn't exist" snapshot against a filesystem that already has the file)
 * without needing to win a real, timing-dependent race against the event
 * loop.
 */
export async function performGuardedWrite(
  resolved: string,
  content: string,
  hasBeenRead: boolean,
  existed: boolean
): Promise<WriteOutcome> {
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (!existed) {
    try {
      await fs.writeFile(resolved, content, { encoding: 'utf8', flag: 'wx' });
      return { ok: true, bytesWritten: contentBytes, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // The snapshot was stale: something created this file since the
      // existence check. Re-run the read-before-overwrite guard against
      // reality rather than proceeding blind.
      if (!hasBeenRead) {
        return { ok: false, error: 'This file already exists. Read it first with read_file before overwriting it.' };
      }
      await fs.writeFile(resolved, content, 'utf8');
      return { ok: true, bytesWritten: contentBytes, created: false };
    }
  }

  await fs.writeFile(resolved, content, 'utf8');
  return { ok: true, bytesWritten: contentBytes, created: false };
}

function buildDeleteDescription(kind: 'file' | 'directory', resolvedPath: string, outsideRoot: boolean, scan?: ScanResult): string {
  const scopeNote = outsideRoot ? ' [outside workspace root]' : '';
  if (kind === 'directory' && scan) {
    const approxFiles = scan.cappedByScanLimit ? `${DELETE_SIZE_SCAN_CAP_ENTRIES}+` : String(scan.entries);
    const approxMb = (scan.bytes / 1_000_000).toFixed(1);
    return `delete recursively: ${resolvedPath} (~${approxFiles} files, ~${approxMb} MB)${scopeNote}`;
  }
  return `delete: ${resolvedPath}${scopeNote}`;
}

export function createFileOpsExecutor(options: FileOpsExecutorOptions): FileOpsExecutor {
  async function handleReadFileRequest(request: ReadFileRequestMessage): Promise<void> {
    const scope = scopePath(request.path, options.workspaceRoot, options.allowOutsideWorkspace);
    if (!scope.ok) {
      options.send({ type: 'read_file_response', requestId: request.requestId, ok: false, error: scope.error });
      return;
    }
    const resolved = scope.resolved;
    const offset = request.offset ?? 1;
    const limit = request.limit ?? DEFAULT_READ_LIMIT_LINES;

    try {
      let stat;
      try {
        stat = await fs.stat(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          options.send({ type: 'read_file_response', requestId: request.requestId, ok: false, error: `File not found: "${resolved}"` });
          return;
        }
        throw error;
      }
      if (stat.isDirectory()) {
        options.send({
          type: 'read_file_response',
          requestId: request.requestId,
          ok: false,
          error: `"${resolved}" is a directory, not a file. Use list_directory instead.`,
        });
        return;
      }

      const result = await readFileWindowed(resolved, offset, limit);
      if ('error' in result) {
        options.send({ type: 'read_file_response', requestId: request.requestId, ok: false, error: result.error });
        return;
      }
      options.send({
        type: 'read_file_response',
        requestId: request.requestId,
        ok: true,
        content: result.content,
        totalLines: result.totalLines,
        startLine: result.startLine,
        endLine: result.endLine,
        truncated: result.truncated,
      });
    } catch (error) {
      options.send({
        type: 'read_file_response',
        requestId: request.requestId,
        ok: false,
        error: `Failed to read file: ${(error as Error).message}`,
      });
    }
  }

  async function handleWriteFileRequest(request: WriteFileRequestMessage): Promise<void> {
    const scope = scopePath(request.path, options.workspaceRoot, options.allowOutsideWorkspace);
    if (!scope.ok) {
      options.send({ type: 'write_file_response', requestId: request.requestId, ok: false, error: scope.error });
      return;
    }
    const resolved = scope.resolved;

    try {
      let existed = true;
      try {
        await fs.stat(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') existed = false;
        else throw error;
      }

      if (existed && !request.hasBeenRead) {
        options.send({
          type: 'write_file_response',
          requestId: request.requestId,
          ok: false,
          error: 'This file already exists. Read it first with read_file before overwriting it.',
        });
        return;
      }

      const contentBytes = Buffer.byteLength(request.content, 'utf8');
      if (contentBytes > MAX_WRITE_FILE_BYTES) {
        options.send({
          type: 'write_file_response',
          requestId: request.requestId,
          ok: false,
          error: `Content is ${contentBytes} bytes, exceeding the ${MAX_WRITE_FILE_BYTES}-byte write_file limit; use run_command for large or binary payloads.`,
        });
        return;
      }

      const outcome = await performGuardedWrite(resolved, request.content, request.hasBeenRead, existed);
      if (!outcome.ok) {
        options.send({ type: 'write_file_response', requestId: request.requestId, ok: false, error: outcome.error! });
        return;
      }
      options.send({
        type: 'write_file_response',
        requestId: request.requestId,
        ok: true,
        bytesWritten: outcome.bytesWritten,
        created: outcome.created,
      });
    } catch (error) {
      options.send({
        type: 'write_file_response',
        requestId: request.requestId,
        ok: false,
        error: `Failed to write file: ${(error as Error).message}`,
      });
    }
  }

  async function handleEditFileRequest(request: EditFileRequestMessage): Promise<void> {
    const scope = scopePath(request.path, options.workspaceRoot, options.allowOutsideWorkspace);
    if (!scope.ok) {
      options.send({ type: 'edit_file_response', requestId: request.requestId, ok: false, error: scope.error });
      return;
    }
    const resolved = scope.resolved;

    try {
      try {
        await fs.stat(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          options.send({
            type: 'edit_file_response',
            requestId: request.requestId,
            ok: false,
            error: `File does not exist: "${resolved}"; use write_file to create it.`,
          });
          return;
        }
        throw error;
      }

      if (!request.hasBeenRead) {
        options.send({
          type: 'edit_file_response',
          requestId: request.requestId,
          ok: false,
          error: 'read this file first with read_file',
        });
        return;
      }

      const content = await fs.readFile(resolved, 'utf8');
      const occurrences = request.oldString.length === 0 ? 0 : content.split(request.oldString).length - 1;

      if (occurrences === 0) {
        options.send({ type: 'edit_file_response', requestId: request.requestId, ok: false, error: 'old_string not found in the file.' });
        return;
      }
      if (occurrences > 1 && !request.replaceAll) {
        options.send({
          type: 'edit_file_response',
          requestId: request.requestId,
          ok: false,
          error: `old_string was found ${occurrences} times; make it more specific or pass replace_all:true.`,
        });
        return;
      }
      if (request.oldString === request.newString) {
        options.send({
          type: 'edit_file_response',
          requestId: request.requestId,
          ok: false,
          error: 'new_string must differ from old_string.',
        });
        return;
      }

      const newContent = content.split(request.oldString).join(request.newString);
      await fs.writeFile(resolved, newContent, 'utf8');
      options.send({
        type: 'edit_file_response',
        requestId: request.requestId,
        ok: true,
        replacementsMade: request.replaceAll ? occurrences : 1,
      });
    } catch (error) {
      options.send({
        type: 'edit_file_response',
        requestId: request.requestId,
        ok: false,
        error: `Failed to edit file: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Delete Safety Tiers — exact evaluation order from `global-constraints.md`
   * (deliberately NOT the general "root-scope first, no fs access" rule the
   * other four ops use): stat and the directory/recursive check happen
   * first, regardless of workspace-root location, because they are plain
   * errors, not safety tiers; the outside-root hard block and the
   * large-recursive-delete confirmation are only evaluated once existence
   * and the recursive flag (for a directory) are already confirmed.
   *
   * Classification (this function's stat/scan above) and the actual delete
   * below are re-validated against each other immediately before deleting
   * (ARC-02 / RC-02, Codex adversarial review) — the two are never adjacent
   * in real time, since a Tier-2 delete waits on a real human at the console
   * (up to `DEFAULT_CONFIRMATION_TIMEOUT_MS`, 60s) in between, so the target
   * a human approved can go stale before the delete actually runs.
   */
  async function handleDeleteFileRequest(request: DeleteFileRequestMessage): Promise<void> {
    const resolved = path.resolve(options.workspaceRoot, request.path);

    try {
      let stat;
      try {
        stat = await fs.stat(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          options.send({ type: 'delete_file_response', requestId: request.requestId, ok: false, error: 'path does not exist' });
          return;
        }
        throw error;
      }

      const isDirectory = stat.isDirectory();
      if (isDirectory && !request.recursive) {
        options.send({
          type: 'delete_file_response',
          requestId: request.requestId,
          ok: false,
          error: 'path is a directory; pass recursive:true to delete it and its contents',
        });
        return;
      }

      const outsideRoot = !isPathWithinRoot(request.path, options.workspaceRoot);
      if (outsideRoot && !options.allowOutsideWorkspace) {
        options.send({
          type: 'delete_file_response',
          requestId: request.requestId,
          ok: false,
          error: `Rejected: "${resolved}" resolves outside the workspace root "${options.workspaceRoot}" and allowOutsideWorkspace is disabled.`,
        });
        return;
      }

      let scan: ScanResult | undefined;
      let isLarge = false;
      if (isDirectory) {
        scan = await boundedScanDirectory(resolved);
        isLarge = scan.cappedByScanLimit || scan.entries > DELETE_LARGE_ENTRY_THRESHOLD || scan.bytes > DELETE_LARGE_BYTES_THRESHOLD;
      }

      const needsConfirmation = outsideRoot || isLarge;
      if (needsConfirmation) {
        options.send({ type: 'command_awaiting_confirmation', requestId: request.requestId });
        const description = buildDeleteDescription(isDirectory ? 'directory' : 'file', resolved, outsideRoot, scan);
        const decision = await options.confirmTier2(description);
        if (decision !== 'approved') {
          options.send({
            type: 'delete_file_response',
            requestId: request.requestId,
            ok: false,
            error:
              decision === 'timeout'
                ? 'Confirmation timed out after 60s; delete was not performed.'
                : 'Delete declined at the local console; delete was not performed.',
            confirmation: decision,
          });
          return;
        }
      }

      // Re-validate immediately before the actual delete (ARC-02 / RC-02,
      // Codex adversarial review): the classification above (and, for a
      // Tier-2 delete, the human confirmation prompt) can be stale by the
      // time we actually delete — for an auto (Tier-0) delete, by the small
      // gap since the scan; for a Tier-2 delete, by up to the full
      // confirmation-wait window (DEFAULT_CONFIRMATION_TIMEOUT_MS, up to 60
      // real seconds a human could spend deciding). If the target's
      // existence, kind, or tier classification changed materially in that
      // window, abort rather than deleting on stale information — a human
      // (or an auto-tier decision) approving/allowing what was described no
      // longer describes what is actually about to be deleted otherwise,
      // which defeats the entire purpose of the tier gate.
      let revalidateStat;
      try {
        revalidateStat = await fs.stat(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          options.send({
            type: 'delete_file_response',
            requestId: request.requestId,
            ok: false,
            error: 'Target changed since it was checked (no longer exists); re-run delete_file.',
          });
          return;
        }
        throw error;
      }

      const isDirectoryNow = revalidateStat.isDirectory();
      if (isDirectoryNow !== isDirectory) {
        options.send({
          type: 'delete_file_response',
          requestId: request.requestId,
          ok: false,
          error: 'Target changed since it was checked (file/directory kind changed); re-run delete_file.',
        });
        return;
      }

      if (isDirectoryNow) {
        const rescan = await boundedScanDirectory(resolved);
        const isLargeNow = rescan.cappedByScanLimit || rescan.entries > DELETE_LARGE_ENTRY_THRESHOLD || rescan.bytes > DELETE_LARGE_BYTES_THRESHOLD;
        const needsConfirmationNow = outsideRoot || isLargeNow;
        if (needsConfirmationNow !== needsConfirmation) {
          options.send({
            type: 'delete_file_response',
            requestId: request.requestId,
            ok: false,
            error: 'Target changed since it was checked (delete-safety tier classification changed); re-run delete_file.',
          });
          return;
        }
      }

      if (isDirectory) {
        await fs.rm(resolved, { recursive: true });
      } else {
        await fs.unlink(resolved);
      }
      options.send({ type: 'delete_file_response', requestId: request.requestId, ok: true, kind: isDirectory ? 'directory' : 'file' });
    } catch (error) {
      options.send({
        type: 'delete_file_response',
        requestId: request.requestId,
        ok: false,
        error: `Failed to delete: ${(error as Error).message}`,
      });
    }
  }

  async function handleListDirectoryRequest(request: ListDirectoryRequestMessage): Promise<void> {
    const pathInput = request.path && request.path.length > 0 ? request.path : '.';
    const scope = scopePath(pathInput, options.workspaceRoot, options.allowOutsideWorkspace);
    if (!scope.ok) {
      options.send({ type: 'list_directory_response', requestId: request.requestId, ok: false, error: scope.error });
      return;
    }
    const resolved = scope.resolved;

    try {
      let stat;
      try {
        stat = await fs.stat(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          options.send({ type: 'list_directory_response', requestId: request.requestId, ok: false, error: `path does not exist: "${resolved}"` });
          return;
        }
        throw error;
      }
      if (!stat.isDirectory()) {
        options.send({
          type: 'list_directory_response',
          requestId: request.requestId,
          ok: false,
          error: `"${resolved}" is not a directory.`,
        });
        return;
      }

      // Uses `fs.opendir()` rather than `fs.readdir()` (RC-01, non-blocking
      // hardening from the final review — same rationale as
      // `boundedScanDirectory`'s own opendir switch above): entries are
      // classified/stat'd lazily as the loop asks for them, and the loop
      // breaks the instant `MAX_LIST_ENTRIES` is reached, so a directory
      // with an extreme number of direct entries never has its full
      // listing materialized or every entry stat'd before the cap can act.
      // One deliberate, documented behavior change this enables: once
      // capped, `totalEntries` is a lower bound (the number actually
      // enumerated, i.e. exactly `MAX_LIST_ENTRIES`) rather than the exact
      // total entry count — reporting the true total would require
      // continuing to enumerate every remaining entry regardless of the
      // cap, defeating the point of this fix. `truncated: true` signals the
      // incompleteness, mirroring `read_file`'s own already-established
      // precedent for `totalLines` under the identical "stopped early"
      // constraint.
      // Uses `fs.opendir()` rather than `fs.readdir()` (RC-01, non-blocking
      // hardening from the final review — same rationale as
      // `boundedScanDirectory`'s own opendir switch above): entries are
      // classified/stat'd lazily as the loop asks for them, and the loop
      // breaks the instant `MAX_LIST_ENTRIES` is reached, so a directory
      // with an extreme number of direct entries never has its full
      // listing materialized or every entry stat'd before the cap can act.
      // One deliberate, documented behavior change this enables: once
      // capped, `totalEntries` is a lower bound (the number actually
      // enumerated, i.e. exactly `MAX_LIST_ENTRIES`) rather than the exact
      // total entry count — reporting the true total would require
      // continuing to enumerate every remaining entry regardless of the
      // cap, defeating the point of this fix. `truncated: true` signals the
      // incompleteness, mirroring `read_file`'s own already-established
      // precedent for `totalLines` under the identical "stopped early"
      // constraint.
      const dir = await fs.opendir(resolved);
      const entries: Array<{ name: string; type: 'file' | 'directory' | 'symlink' | 'other'; sizeBytes?: number }> = [];
      let totalEntries = 0;
      let truncated = false;

      try {
        for await (const entry of dir) {
          totalEntries++;
          if (entries.length < MAX_LIST_ENTRIES) {
            let kind: 'file' | 'directory' | 'symlink' | 'other';
            if (entry.isSymbolicLink()) kind = 'symlink';
            else if (entry.isDirectory()) kind = 'directory';
            else if (entry.isFile()) kind = 'file';
            else kind = 'other';

            let sizeBytes: number | undefined;
            if (kind === 'file') {
              try {
                const entryStat = await fs.stat(path.join(resolved, entry.name));
                sizeBytes = entryStat.size;
              } catch {
                sizeBytes = undefined;
              }
            }
            entries.push({ name: entry.name, type: kind, sizeBytes });
          }
          if (entries.length >= MAX_LIST_ENTRIES) {
            truncated = true;
            break;
          }
        }
      } finally {
        await dir.close().catch(() => {});
      }

      options.send({
        type: 'list_directory_response',
        requestId: request.requestId,
        ok: true,
        entries,
        truncated,
        totalEntries,
      });
    } catch (error) {
      options.send({
        type: 'list_directory_response',
        requestId: request.requestId,
        ok: false,
        error: `Failed to list directory: ${(error as Error).message}`,
      });
    }
  }

  return {
    handleReadFileRequest,
    handleWriteFileRequest,
    handleEditFileRequest,
    handleDeleteFileRequest,
    handleListDirectoryRequest,
  };
}
