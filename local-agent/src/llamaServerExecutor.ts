/**
 * Spawns/stops/observes ONE `llama-server` child process on this machine,
 * driven by the backend over the relayed `llamacpp_*` frames (hand-mirrored
 * in `transport.ts` from `server/agentRelay/protocol.ts`,
 * global-constraints.md §2 — keep both sides in sync).
 *
 * Security posture:
 * - every refusal below happens BEFORE any process exists;
 * - the argv array goes straight to `spawn(exePath, args, {shell:false,
 *   windowsHide:true, cwd:dirname(exePath)})` — NEVER through a shell string,
 *   so nothing user-controlled can be interpreted as shell syntax;
 * - the destination host must be loopback and the port within 1024–65535
 *   regardless of what any upstream validator accepted (defense-in-depth);
 * - exactly ONE llama-server child is tracked per agent process; the backend
 *   orchestrates stop→spawn swaps itself.
 *
 * Bounded memory (§2): a single 64 KiB ring buffer of merged stdout+stderr is
 * kept from spawn (`llamacpp_logs_request` responses never exceed their
 * maxBytes), plus a small stderr-only tail carried on the one-shot
 * `llamacpp_exited` push. Directory scans are capped at 2000 entries.
 *
 * Kill semantics (§2, binding):
 * - stop: win32 soft `taskkill /pid P` → wait ≤ graceMs → still alive ⇒
 *   `taskkill /pid P /t /f` (`forced:true`); posix SIGTERM → SIGKILL.
 *   CTRL_C_EVENT graceful shutdown is deliberately NOT attempted.
 * - unknown/stale pid ⇒ `{ok:true}` idempotent (not-running).
 * - agent disconnect kills the tracked child (ARC-04 parity) — no orphans.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import type { MinimalChildProcess } from './commandExecutor.js';
import type {
  AgentToBackendMessage,
  LlamacppLogsRequestMessage,
  LlamacppScanRequestMessage,
  LlamacppSpawnMessage,
  LlamacppStatusRequestMessage,
  LlamacppStopMessage,
} from './transport.js';

/** Merged stdout+stderr retention ceiling (global-constraints.md §2). */
export const LLAMACPP_RING_BUFFER_BYTES = 64 * 1024;
/** Hard cap on `.gguf` entries returned per scan (global-constraints.md §2). */
export const SCAN_ENTRY_CAP = 2000;
/** Stderr-only tail carried on the `llamacpp_exited` push (diagnostic). */
const STDERR_TAIL_BYTES = 4_096;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface LlamaServerExecutor {
  handleLlamacppScan(msg: LlamacppScanRequestMessage): void;
  handleLlamacppSpawn(msg: LlamacppSpawnMessage): void;
  handleLlamacppStop(msg: LlamacppStopMessage): void;
  handleLlamacppStatus(msg: LlamacppStatusRequestMessage): void;
  handleLlamacppLogs(msg: LlamacppLogsRequestMessage): void;
  /** ARC-04 parity: hard-kills the tracked child; fresh state for reconnect. */
  handleDisconnect(): void;
}

export interface LlamaServerExecutorOptions {
  send: (msg: AgentToBackendMessage) => void;
  /** Defaults to `process.platform`; injected so tests pin one kill path. */
  platform?: NodeJS.Platform;
  /**
   * EVERY process creation goes through this seam — the llama-server child
   * AND the Windows taskkill killer spawns — so tests observe kill commands
   * without real processes. Defaults to node `child_process.spawn`.
   */
  spawnFn?: (cmd: string, args: string[], o: object) => MinimalChildProcess;
  /** Timestamp source for startedAt/lastExitAt; defaults to Date.now. */
  nowMs?: () => number;
}

interface TrackedChild {
  child: MinimalChildProcess;
  pid: number;
  exePath: string;
  args: string[];
  host: string;
  port: number;
  startedAt: number;
}

interface PendingStop {
  requestId: string;
  timer: NodeJS.Timeout;
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  const relevant = chunk.length > maxBytes ? chunk.subarray(chunk.length - maxBytes) : chunk;
  if (relevant.length >= maxBytes) return Buffer.from(relevant);
  const combined = Buffer.concat([current, relevant]);
  return combined.length > maxBytes ? Buffer.from(combined.subarray(combined.length - maxBytes)) : combined;
}

/** Keeps the LAST `maxBytes` bytes of the merged output stream (64 KiB ring). */
function appendRingBuffer(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  const combined = current.length === 0 ? chunk : Buffer.concat([current, chunk]);
  return combined.length > maxBytes ? Buffer.from(combined.subarray(combined.length - maxBytes)) : combined;
}

export function createLlamaServerExecutor(options: LlamaServerExecutorOptions): LlamaServerExecutor {
  const platform = options.platform ?? process.platform;
  const nowMs = options.nowMs ?? Date.now;
  const doSpawn =
    options.spawnFn ?? ((cmd: string, args: string[], o: object) => spawn(cmd, args, o as SpawnOptions) as unknown as MinimalChildProcess);

  let tracked: TrackedChild | null = null;
  let pendingStop: PendingStop | null = null;
  let ring: Buffer = Buffer.alloc(0);
  let totalLoggedBytes = 0;
  let stderrTail: Buffer = Buffer.alloc(0);
  let lastExitCode: number | null = null;
  let lastExitAt: number | null = null;
  /** Set when our stop/disconnect initiated the death of the tracked child. */
  let terminatedByAgent = false;

  function spawnKiller(args: string[]): void {
    // Same seam as the child itself: argv-array, shell-free, hidden window.
    // `args` holds only the taskkill flags (e.g. ['/pid', '4242', '/t', '/f']).
    try {
      doSpawn('taskkill', args, { shell: false, windowsHide: true });
    } catch {
      /* killer spawn is best-effort; the hard branch below re-checks liveness */
    }
  }

  function clearStopTimer(): void {
    if (pendingStop) {
      clearTimeout(pendingStop.timer);
      pendingStop = null;
    }
  }

  function appendRing(chunk: Buffer): void {
    totalLoggedBytes += chunk.length;
    ring = appendRingBuffer(ring, chunk, LLAMACPP_RING_BUFFER_BYTES);
  }

  function handleLlamacppScan(msg: LlamacppScanRequestMessage): void {
    const respond = (response: Extract<AgentToBackendMessage, { type: 'llamacpp_scan_response' }>): void => {
      options.send(response);
    };
    if (!path.isAbsolute(msg.dir)) {
      respond({ type: 'llamacpp_scan_response', requestId: msg.requestId, ok: false, error: 'dir must be an absolute path' });
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(msg.dir, { withFileTypes: true });
    } catch (error) {
      respond({
        type: 'llamacpp_scan_response',
        requestId: msg.requestId,
        ok: false,
        error: `cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const entries: Array<{ path: string; name: string; sizeBytes?: number }> = [];
    let truncated = false;
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue; // non-recursive: directories/symlinks skipped
      const name = dirent.name;
      const lower = name.toLowerCase();
      if (!lower.endsWith('.gguf')) continue;
      if (lower.startsWith('mmproj')) continue;
      if (entries.length >= SCAN_ENTRY_CAP) {
        truncated = true;
        break;
      }
      const fullPath = path.join(msg.dir, name);
      let sizeBytes: number | undefined;
      try {
        sizeBytes = fs.statSync(fullPath).size;
      } catch {
        /* entry stays listed without a size */
      }
      entries.push({ path: fullPath, name, sizeBytes });
    }
    respond({ type: 'llamacpp_scan_response', requestId: msg.requestId, ok: true, entries, truncated });
  }

  function refuseSpawn(requestId: string, error: string): void {
    options.send({ type: 'llamacpp_spawn_response', requestId, ok: false, error });
  }

  function handleLlamacppSpawn(msg: LlamacppSpawnMessage): void {
    const { requestId, exePath, host, port, args } = msg;

    // --- Validation refusals, ALL BEFORE any process starts ---
    if (tracked) {
      refuseSpawn(requestId, 'llama-server already running; stop it first');
      return;
    }
    if (typeof exePath !== 'string' || exePath.length === 0 || !path.isAbsolute(exePath)) {
      refuseSpawn(requestId, 'exePath must be an absolute path');
      return;
    }
    try {
      if (!fs.statSync(exePath).isFile()) throw new Error('not a file');
    } catch {
      refuseSpawn(requestId, `exePath does not exist: stat failed`);
      return;
    }
    const expectedBasename = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    if (path.basename(exePath).toLowerCase() !== expectedBasename) {
      refuseSpawn(requestId, `exePath basename must be ${expectedBasename}`);
      return;
    }
    if (!LOOPBACK_HOSTS.has(host)) {
      refuseSpawn(requestId, 'host must be loopback (127.0.0.1, localhost, ::1)');
      return;
    }
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      refuseSpawn(requestId, 'port must be an integer between 1024 and 65535');
      return;
    }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      refuseSpawn(requestId, 'args must be an array of strings');
      return;
    }

    // --- Spawn: argv-array straight to the OS, never a shell string ---
    let child: MinimalChildProcess;
    try {
      child = doSpawn(exePath, [...args], { shell: false, windowsHide: true, cwd: path.dirname(exePath) });
    } catch (error) {
      refuseSpawn(requestId, `spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (typeof child.pid !== 'number') {
      refuseSpawn(requestId, 'failed to start llama-server (no pid)');
      return;
    }

    const pid = child.pid;
    let exitHandled = false;

    const onDeath = (exitCode: number | null): void => {
      // Exactly-once exit push per tracked child death.
      if (exitHandled) return;
      exitHandled = true;
      lastExitCode = exitCode;
      lastExitAt = nowMs();
      const wasTerminatedByAgent = terminatedByAgent;
      terminatedByAgent = false;
      if (tracked?.child === child) tracked = null; // never clobber a newer child
      // A stop that was still waiting out its grace window resolves promptly.
      if (pendingStop) {
        const { requestId: stopRequestId } = pendingStop;
        clearStopTimer();
        options.send({ type: 'llamacpp_stop_response', requestId: stopRequestId, ok: true, forced: false });
      }
      const tail = stderrTail.toString('utf8');
      const payload: Extract<AgentToBackendMessage, { type: 'llamacpp_exited' }> = {
        type: 'llamacpp_exited',
        pid,
        exitCode,
      };
      if (wasTerminatedByAgent) payload.terminatedByAgent = true;
      if (tail.length > 0) payload.stderrTail = tail;
      options.send(payload);
    };

    child.on('close', onDeath);
    child.on('error', () => onDeath(null)); // e.g. ENOENT racing validation

    child.stdout?.on('data', (raw: Buffer | string) => appendRing(toBuffer(raw)));
    child.stderr?.on('data', (raw: Buffer | string) => {
      const chunk = toBuffer(raw);
      appendRing(chunk);
      stderrTail = appendTail(stderrTail, chunk, STDERR_TAIL_BYTES);
    });

    // Fresh log window per spawned run: bytes from a previous child stay
    // readable until the next spawn replaces them, never leak into the new
    // child's logs.
    ring = Buffer.alloc(0);
    totalLoggedBytes = 0;
    stderrTail = Buffer.alloc(0);

    tracked = { child, pid, exePath, args: [...args], host, port, startedAt: nowMs() };
    // Single debug line per spawn; argv/user paths are never logged.
    console.log(`[local-agent] llama-server spawned (pid=${pid})`);
    options.send({ type: 'llamacpp_spawn_response', requestId, ok: true, pid });
  }

  function beginStopSequence(msg: LlamacppStopMessage, child: MinimalChildProcess, pid: number): void {
    let forced = false;
    const finish = (): void => {
      pendingStop = null;
      options.send({ type: 'llamacpp_stop_response', requestId: msg.requestId, ok: true, forced });
    };
    const timer = setTimeout(() => {
      // Still alive after the grace window ⇒ escalate to the hard kill.
      const stillAlive = child.exitCode === null && child.signalCode === null;
      if (stillAlive) {
        forced = true;
        if (platform === 'win32') {
          spawnKiller(['/pid', String(pid), '/t', '/f']);
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
      finish();
    }, msg.graceMs);
    pendingStop = { requestId: msg.requestId, timer };

    if (platform === 'win32') {
      // Soft attempt first (may be a no-op on console apps — the named risk);
      // the grace timer escalates to the tree kill when still alive.
      spawnKiller(['/pid', String(pid)]);
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  function handleLlamacppStop(msg: LlamacppStopMessage): void {
    const { requestId, pid, graceMs } = msg;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
      options.send({
        type: 'llamacpp_stop_response',
        requestId,
        ok: false,
        error: 'graceMs must be a non-negative integer',
      });
      return;
    }
    // Unknown/stale pid ⇒ idempotent not-running success (§2).
    if (!tracked || tracked.pid !== pid) {
      options.send({ type: 'llamacpp_stop_response', requestId, ok: true });
      return;
    }
    // A duplicate stop for an already-stopping child answers ok without re-killing.
    if (pendingStop) {
      options.send({ type: 'llamacpp_stop_response', requestId, ok: true });
      return;
    }
    terminatedByAgent = true;
    beginStopSequence(msg, tracked.child, tracked.pid);
  }

  function handleLlamacppStatus(msg: LlamacppStatusRequestMessage): void {
    const response: Extract<AgentToBackendMessage, { type: 'llamacpp_status_response' }> = {
      type: 'llamacpp_status_response',
      requestId: msg.requestId,
      running: tracked !== null,
      pid: tracked?.pid ?? null,
      exePath: tracked?.exePath ?? null,
      args: tracked ? [...tracked.args] : null,
      port: tracked?.port ?? null,
      startedAt: tracked?.startedAt ?? null,
      lastExitCode,
      lastExitAt,
    };
    if (tracked) response.host = tracked.host;
    options.send(response);
  }

  function handleLlamacppLogs(msg: LlamacppLogsRequestMessage): void {
    const maxBytes = Math.max(1, Math.min(65_536, Math.floor(msg.maxBytes)));
    const available = ring.length;
    const take = Math.min(maxBytes, available);
    // Byte-slicing may split a trailing utf-8 code point; content is
    // diagnostics only and always ≤ maxBytes.
    const text = available === 0 ? '' : ring.subarray(available - take).toString('utf8');
    options.send({
      type: 'llamacpp_logs_response',
      requestId: msg.requestId,
      ok: true,
      text,
      truncated: totalLoggedBytes > take,
    });
  }

  function handleDisconnect(): void {
    // No socket left to answer: drop any in-flight stop sequence silently.
    clearStopTimer();
    const current = tracked;
    tracked = null;
    ring = Buffer.alloc(0);
    totalLoggedBytes = 0;
    stderrTail = Buffer.alloc(0);
    if (current) {
      terminatedByAgent = true; // consumed by the child's own death push below
      if (platform === 'win32') {
        spawnKiller(['/pid', String(current.pid), '/t', '/f']);
      } else {
        try {
          current.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }

  return { handleLlamacppScan, handleLlamacppSpawn, handleLlamacppStop, handleLlamacppStatus, handleLlamacppLogs, handleDisconnect };
}
