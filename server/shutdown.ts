import type { Server } from 'http';
import type { Response } from 'express';
import type Database from 'better-sqlite3';

/**
 * Graceful shutdown manager.
 *
 * Handles SIGTERM/SIGINT to allow in-flight requests to complete,
 * notifies SSE clients, closes the database, and exits cleanly.
 *
 * Railway sends SIGTERM on redeploy; the default grace period is 10 s
 * (we configure it to 30 s in railway.json so long streams can drain).
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let shuttingDown = false;

/** Active SSE response objects. We notify them on shutdown so the frontend
 *  can display a friendly message instead of a raw connection error.       */
const activeStreams = new Set<Response>();

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** True once a shutdown signal has been received. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Register an SSE response so it can be drained on shutdown. */
export function trackStream(res: Response): void {
  activeStreams.add(res);
  res.on('close', () => activeStreams.delete(res));
}

/** Unregister an SSE response (called when the handler finishes normally). */
export function untrackStream(res: Response): void {
  activeStreams.delete(res);
}

// ---------------------------------------------------------------------------
// Shutdown sequence
// ---------------------------------------------------------------------------

function drainStreams(): void {
  for (const res of activeStreams) {
    try {
      if (!res.writableEnded) {
        // Send an SSE event the frontend understands.
        res.write(`data: ${JSON.stringify({ error: 'Server is restarting. Please retry in a moment.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch {
      // already closed — ignore
    }
  }
  activeStreams.clear();
}

/**
 * Install SIGTERM / SIGINT handlers and wire up the shutdown sequence.
 *
 * @param server  The HTTP server returned by `app.listen()`
 * @param db      The better-sqlite3 database instance
 */
export function setupGracefulShutdown(server: Server, db: Database.Database): void {
  // Reduce keep-alive so idle connections close faster during shutdown.
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 6_000; // must be > keepAliveTimeout

  const shutdown = (signal: string) => {
    if (shuttingDown) return;       // prevent double-entry
    shuttingDown = true;

    console.log(`[shutdown] ${signal} received — starting graceful shutdown`);

    // 1. Notify all active SSE clients so the frontend can react.
    drainStreams();

    // 2. Stop accepting new connections.
    server.close(() => {
      console.log('[shutdown] HTTP server closed (no more connections)');
      closeAndExit();
    });

    // 3. After a generous timeout, force-close remaining connections and exit.
    //    This must be shorter than Railway's grace period (configured to 30 s).
    const FORCE_CLOSE_MS = 25_000;
    setTimeout(() => {
      console.log('[shutdown] Force-closing remaining connections');
      // Node 18.2+ — force close all kept-alive sockets.
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      closeAndExit();
    }, FORCE_CLOSE_MS).unref();

    let exited = false;
    function closeAndExit() {
      if (exited) return;
      exited = true;
      try {
        // Checkpoint WAL so all data is flushed to the main database file.
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
        console.log('[shutdown] Database closed');
      } catch (e) {
        console.error('[shutdown] DB close error:', e);
      }
      console.log('[shutdown] Exiting');
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
