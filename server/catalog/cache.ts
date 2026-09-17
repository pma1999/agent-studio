/**
 * TTL cache for upstream catalog data with in-flight deduplication,
 * stale-on-error and a persisted last-known-good snapshot.
 *
 * Entries are addressed by a `scope` (who/what the data belongs to, e.g.
 * `deepseek:user:<id>`) and a `variant` (what it was fetched with, e.g. a hash
 * of the API key). A variant mismatch is a miss: rotating a key never serves
 * data fetched with the previous one, and one scope never reads another's.
 */

export interface SnapshotRecord {
  variant: string;
  payload: unknown;
  fetchedAt: number;
}

/** Persistence for last-known-good data (DB in production, memory in tests). */
export interface SnapshotStore {
  read(scope: string): SnapshotRecord | null;
  write(scope: string, record: SnapshotRecord): void;
  delete(scope: string): void;
}

export interface CacheHit<T> {
  value: T;
  fetchedAt: number;
  /** True when served after a failed refresh. */
  stale: boolean;
}

interface MemoryEntry<T> {
  variant: string;
  value: T;
  fetchedAt: number;
}

export interface ReadOptions {
  force?: boolean;
  preferCached?: boolean;
}

export interface CachedResourceOptions {
  ttlMs: number;
  store?: SnapshotStore | null;
  now?: () => number;
  /**
   * Errors that invalidate instead of serving the last good value (e.g. a
   * revoked credential): the scope is forgotten and the error rethrown.
   */
  isFatal?: (err: unknown) => boolean;
}

export class CachedResource<T> {
  private readonly memory = new Map<string, MemoryEntry<T>>();
  private readonly inflight = new Map<string, Promise<CacheHit<T>>>();
  private readonly ttlMs: number;
  private readonly store: SnapshotStore | null;
  private readonly now: () => number;
  private readonly isFatal: (err: unknown) => boolean;

  constructor(options: CachedResourceOptions) {
    this.ttlMs = options.ttlMs;
    this.store = options.store ?? null;
    this.now = options.now ?? Date.now;
    this.isFatal = options.isFatal ?? (() => false);
  }

  /**
   * Fresh memory hit, else one shared fetch per scope+variant. On fetch
   * failure serves the last good value (memory, then snapshot) marked stale;
   * rethrows only when there is nothing to serve.
   */
  async get(scope: string, variant: string, fetcher: () => Promise<T>, opts: { force?: boolean } = {}): Promise<CacheHit<T>> {
    const hit = this.memory.get(scope);
    if (!opts.force && hit && hit.variant === variant && this.now() - hit.fetchedAt < this.ttlMs) {
      return { value: hit.value, fetchedAt: hit.fetchedAt, stale: false };
    }
    const flightKey = `${scope}|${variant}`;
    const pending = this.inflight.get(flightKey);
    if (pending) return pending;

    const run = (async (): Promise<CacheHit<T>> => {
      try {
        const value = await fetcher();
        const fetchedAt = this.now();
        this.memory.set(scope, { variant, value, fetchedAt });
        try {
          this.store?.write(scope, { variant, payload: value, fetchedAt });
        } catch (err) {
          console.warn(`[catalog] snapshot write failed for ${scope}:`, err instanceof Error ? err.message : String(err));
        }
        return { value, fetchedAt, stale: false };
      } catch (err) {
        if (this.isFatal(err)) {
          this.forget(scope);
          throw err;
        }
        const fallback = this.lastGood(scope, variant);
        if (fallback) return { ...fallback, stale: true };
        throw err;
      } finally {
        this.inflight.delete(flightKey);
      }
    })();
    this.inflight.set(flightKey, run);
    return run;
  }

  /**
   * Stale-while-revalidate: any last good value is returned immediately (an
   * expired one triggers a background refresh); only a cold scope waits for
   * the fetch.
   */
  async getFast(scope: string, variant: string, fetcher: () => Promise<T>): Promise<CacheHit<T>> {
    const known = this.peek(scope, variant);
    if (!known) return this.get(scope, variant, fetcher);
    if (known.stale) {
      this.get(scope, variant, fetcher, { force: true }).catch((err) => {
        console.warn(`[catalog] background refresh failed for ${scope}:`, err instanceof Error ? err.message : String(err));
      });
    }
    return known;
  }

  /**
   * Read policy shared by adapters: `force` refetches; `preferCached` (the send
   * path) never waits when anything is known; otherwise an expired value is
   * refreshed before returning (catalog listing for the UI).
   */
  read(scope: string, variant: string, fetcher: () => Promise<T>, opts: ReadOptions = {}): Promise<CacheHit<T>> {
    if (opts.force) return this.get(scope, variant, fetcher, { force: true });
    if (opts.preferCached) return this.getFast(scope, variant, fetcher);
    return this.get(scope, variant, fetcher);
  }

  /** Last good value without fetching (memory first, then snapshot). */
  peek(scope: string, variant: string): CacheHit<T> | null {
    const fresh = this.memory.get(scope);
    if (fresh && fresh.variant === variant) {
      return { value: fresh.value, fetchedAt: fresh.fetchedAt, stale: this.now() - fresh.fetchedAt >= this.ttlMs };
    }
    const fallback = this.lastGood(scope, variant);
    return fallback ? { ...fallback, stale: true } : null;
  }

  invalidate(scope: string): void {
    this.memory.delete(scope);
  }

  /** Drops memory and snapshot for a scope (e.g. the user removed their key). */
  forget(scope: string): void {
    this.memory.delete(scope);
    try {
      this.store?.delete(scope);
    } catch {
      // best effort
    }
  }

  private lastGood(scope: string, variant: string): { value: T; fetchedAt: number } | null {
    const mem = this.memory.get(scope);
    if (mem && mem.variant === variant) return { value: mem.value, fetchedAt: mem.fetchedAt };
    let record: SnapshotRecord | null = null;
    try {
      record = this.store?.read(scope) ?? null;
    } catch {
      record = null;
    }
    if (!record || record.variant !== variant) return null;
    const value = record.payload as T;
    this.memory.set(scope, { variant, value, fetchedAt: record.fetchedAt });
    return { value, fetchedAt: record.fetchedAt };
  }
}

/** In-memory snapshot store (tests, and a safe default when no DB is wired). */
export function createMemorySnapshotStore(): SnapshotStore & { records: Map<string, SnapshotRecord> } {
  const records = new Map<string, SnapshotRecord>();
  return {
    records,
    read: (scope) => records.get(scope) ?? null,
    write: (scope, record) => {
      records.set(scope, record);
    },
    delete: (scope) => {
      records.delete(scope);
    },
  };
}
