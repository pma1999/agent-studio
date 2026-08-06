/**
 * Minimal JSON-RPC 2.0 client over the `codex app-server` stdio transport.
 *
 * The app-server protocol uses newline-delimited JSON: one message per line.
 * Messages with an `id` and no `method` are responses; messages with an `id`
 * AND a `method` are server-initiated requests the client must answer;
 * messages without an `id` are notifications.
 *
 * One CodexRpc instance owns exactly one spawned `codex app-server` process
 * and its per-user Codex home (auth.json, config.toml, thread rollouts).
 */

import { spawn, type ChildProcess } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import { resolveCodexEntry } from './config.js';

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (method: string, id: number, params: unknown) => void;

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(message: string, code = -32000, data?: unknown) {
    super(message);
    this.name = 'CodexRpcError';
    this.code = code;
    this.data = data;
  }
}

export class CodexRpc {
  readonly homeDir: string;

  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private notificationHandlers = new Set<NotificationHandler>();
  private serverRequestHandlers = new Set<ServerRequestHandler>();
  private closed = false;

  /** Invoked when the process exits unexpectedly (not via kill()). */
  onUnexpectedExit: (() => void) | null = null;

  constructor(homeDir: string) {
    this.homeDir = homeDir;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  start(): void {
    // The app-server refuses to run when its Codex home does not exist.
    fs.mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    const entry = resolveCodexEntry();
    this.proc = spawn(process.execPath, [entry, 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: this.homeDir,
        HOME: this.homeDir,
        TERM: 'dumb',
        NO_COLOR: '1',
      },
    });
    this.closed = false;
    this.proc.on('error', (err) => {
      this.failAllPending(new CodexRpcError(`Codex app-server failed to start: ${err.message}`));
    });
    this.proc.on('exit', (code, signal) => {
      this.failAllPending(
        new CodexRpcError(`Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      );
      if (!this.closed) {
        // Unexpected exit (crash). Let the manager decide whether to restart.
        this.onUnexpectedExit?.();
      }
    });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) {
        console.log(`[codex:${this.homeDir.split(/[\\/]/).pop()}] ${text.trimEnd()}`);
      }
    });
    this.rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
  }

  private emit(method: string, params: unknown): void {
    for (const h of [...this.notificationHandlers]) {
      try {
        h(method, params);
      } catch (err) {
        console.error('[codex] notification handler error:', err);
      }
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: JsonRpcError };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && typeof msg.id === 'number' && msg.method) {
      // Server-initiated request: must be answered by the caller.
      for (const h of [...this.serverRequestHandlers]) {
        try {
          h(msg.method, msg.id, msg.params);
        } catch (err) {
          console.error('[codex] server request handler error:', err);
        }
      }
      return;
    }
    if (msg.id !== undefined && typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new CodexRpcError(msg.error.message || 'Codex request failed', msg.error.code, msg.error.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      this.emit(msg.method, msg.params);
    }
  }

  /** Sends a request and resolves with the result (rejects on error/timeout). */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable || this.closed) {
      return Promise.reject(new CodexRpcError('Codex app-server is not running'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify(params === undefined ? { id, method } : { id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`Codex request timed out after ${timeoutMs}ms: ${method}`, -32001));
      }, timeoutMs ?? 60_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc!.stdin!.write(payload + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new CodexRpcError(`Failed to write to Codex app-server: ${err.message}`));
        }
      });
    });
  }

  /** Answers a server-initiated request. */
  respond(id: number, result: unknown): void {
    this.writeLine(JSON.stringify({ id, result }));
  }

  respondError(id: number, error: { code: number; message: string }): void {
    this.writeLine(JSON.stringify({ id, error }));
  }

  /** Sends a notification (no id). */
  notify(method: string, params?: unknown): void {
    this.writeLine(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  private writeLine(line: string): void {
    if (this.proc?.stdin?.writable && !this.closed) {
      this.proc.stdin.write(line + '\n');
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  get isRunning(): boolean {
    return !!this.proc && !this.closed && !!this.proc.pid;
  }

  kill(): void {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new CodexRpcError('Codex app-server stopped'));
    }
    this.pending.clear();
    if (this.proc) {
      this.proc.kill('SIGTERM');
      const proc = this.proc;
      // Escalate to SIGKILL after a short grace period.
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      }, 3_000);
    }
    this.proc = null;
    this.rl?.close();
    this.rl = null;
  }
}
