/**
 * Per-user `codex app-server` instance manager.
 *
 * Each allowed user gets at most one app-server subprocess with an isolated
 * Codex home (auth.json + config.toml + thread rollouts). The process speaks
 * JSON-RPC over stdio pipes only — nothing is exposed on the network.
 *
 * Login state (ChatGPT device-code flow) is owned by the app-server itself:
 * `account/login/start` returns a verification URL + code, and the process
 * persists + auto-refreshes the OAuth tokens in the user's home. We only relay
 * the ceremony and report `account/read` state to the UI.
 */

import db from '../db.js';
import { CodexRpc, CodexRpcError } from './rpc.js';
import { isEmailAllowed, codexHomeForUser, writeCodexUserConfig } from './config.js';

export type CodexAccount =
  | { type: 'chatgpt'; email: string | null; planType: string | null }
  | { type: 'apiKey' }
  | null;

export interface PendingLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  startedAt: number;
}

export interface CodexRateLimits {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number | null;
  byLimitId?: Array<{ limitId: string; usedPercent: number; windowDurationMins: number; resetsAt: number | null }>;
}

export interface CodexInstance {
  userId: string;
  email: string;
  homeDir: string;
  rpc: CodexRpc;
  ready: boolean;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
  account: CodexAccount;
  pendingLogin: PendingLogin | null;
  /** Thread ids with a turn currently in flight (concurrency guard). */
  activeTurns: Set<string>;
}

const instances = new Map<string, CodexInstance>();
/** In-flight spawns keyed by user id so concurrent callers share one process. */
const starting = new Map<string, Promise<CodexInstance>>();

export class CodexForbiddenError extends Error {
  constructor() {
    super('ChatGPT provider is not enabled for your account');
    this.name = 'CodexForbiddenError';
  }
}

export class CodexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexUnavailableError';
  }
}

function lookupEmail(userId: string): string {
  const row = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
  return row?.email ?? '';
}

function idleTimeoutMs(): number {
  return Number(process.env.CODEX_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000);
}

function loginTtlMs(): number {
  return Number(process.env.CODEX_LOGIN_TTL_MS ?? 10 * 60 * 1000);
}

function requireAllowed(userId: string): string {
  const email = lookupEmail(userId);
  if (!isEmailAllowed(email)) throw new CodexForbiddenError();
  return email;
}

function scheduleIdleReap(inst: CodexInstance): void {
  if (inst.idleTimer) clearTimeout(inst.idleTimer);
  inst.idleTimer = setTimeout(() => {
    if (Date.now() - inst.lastUsedAt >= idleTimeoutMs()) {
      disposeInstance(inst.userId).catch(() => {});
    }
  }, idleTimeoutMs());
  // Do not keep the Node process alive just because an instance is idling.
  inst.idleTimer.unref?.();
}

async function readAccount(rpc: CodexRpc): Promise<CodexAccount> {
  const res = await rpc.request<{ account?: unknown }>('account/read', { refreshToken: false }, 30_000);
  const acc = res?.account as { type?: string; email?: string | null; planType?: string | null } | null | undefined;
  if (!acc) return null;
  if (acc.type === 'apiKey') return { type: 'apiKey' };
  if (acc.type === 'chatgpt') return { type: 'chatgpt', email: acc.email ?? null, planType: acc.planType ?? null };
  return null;
}

async function spawnInstance(userId: string, email: string): Promise<CodexInstance> {
  const homeDir = codexHomeForUser(userId);
  writeCodexUserConfig(homeDir);
  const rpc = new CodexRpc(homeDir);
  rpc.start();

  const inst: CodexInstance = {
    userId,
    email,
    homeDir,
    rpc,
    ready: false,
    lastUsedAt: Date.now(),
    idleTimer: null,
    account: null,
    pendingLogin: null,
    activeTurns: new Set(),
  };
  instances.set(userId, inst);

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'agent_studio', title: 'Agent Studio', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, 30_000);
    rpc.notify('initialized', {});

    inst.account = await readAccount(rpc);

    rpc.onNotification((method, params) => {
      if (method === 'account/login/completed') handleLoginCompleted(inst, params);
      if (method === 'account/updated') handleAccountUpdated(inst, params);
    });
    rpc.onUnexpectedExit = () => {
      console.warn(`[codex] app-server exited unexpectedly for user ${email}`);
      disposeInstance(userId).catch(() => {});
    };

    inst.ready = true;
    scheduleIdleReap(inst);
    console.log(`[codex] app-server ready for user ${email}`);
    return inst;
  } catch (err) {
    rpc.kill();
    instances.delete(userId);
    throw new CodexUnavailableError(
      err instanceof CodexRpcError
        ? err.message
        : `Failed to start Codex app-server: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function handleLoginCompleted(inst: CodexInstance, params: unknown): void {
  const p = params as { loginId?: string | null; success?: boolean; error?: string | null } | undefined;
  if (!p) return;
  if (p.loginId && inst.pendingLogin && p.loginId !== inst.pendingLogin.loginId) return;
  if (p.success) {
    inst.pendingLogin = null;
    readAccount(inst.rpc)
      .then((account) => {
        inst.account = account;
        inst.lastUsedAt = Date.now();
      })
      .catch((err) => console.warn('[codex] account/read after login failed:', err));
  } else {
    inst.pendingLogin = null;
  }
}

function handleAccountUpdated(inst: CodexInstance, params: unknown): void {
  const p = params as { authMode?: string | null; planType?: string | null } | undefined;
  if (!p) return;
  if (p.authMode === 'chatgpt') {
    inst.account = {
      type: 'chatgpt',
      email: inst.account?.type === 'chatgpt' ? inst.account.email : null,
      planType: p.planType ?? (inst.account?.type === 'chatgpt' ? inst.account.planType : null),
    };
  } else if (p.authMode === null) {
    inst.account = null;
  }
}

function touch(inst: CodexInstance): void {
  inst.lastUsedAt = Date.now();
  scheduleIdleReap(inst);
}

/**
 * Returns the ready app-server for a user, spawning it on first use.
 * Throws CodexForbiddenError / CodexUnavailableError.
 */
export async function getInstance(userId: string): Promise<CodexInstance> {
  const email = requireAllowed(userId);
  const existing = instances.get(userId);
  if (existing?.ready && existing.rpc.isRunning) {
    touch(existing);
    return existing;
  }
  const inFlight = starting.get(userId);
  if (inFlight) {
    const inst = await inFlight;
    touch(inst);
    return inst;
  }
  const promise = spawnInstance(userId, email);
  starting.set(userId, promise);
  try {
    const inst = await promise;
    touch(inst);
    return inst;
  } finally {
    starting.delete(userId);
  }
}

/** Like getInstance, but also requires a connected ChatGPT account. */
export async function getConnectedInstance(userId: string): Promise<CodexInstance> {
  const inst = await getInstance(userId);
  if (inst.account?.type !== 'chatgpt') {
    throw new CodexUnavailableError(
      'ChatGPT account not connected. Open Settings → ChatGPT and complete the sign-in.'
    );
  }
  return inst;
}

export function isUserAllowed(userId: string): boolean {
  return isEmailAllowed(lookupEmail(userId));
}

export function getPendingLogin(inst: CodexInstance): PendingLogin | null {
  const p = inst.pendingLogin;
  if (!p) return null;
  if (Date.now() - p.startedAt > loginTtlMs()) return null;
  return p;
}

/** Starts a ChatGPT device-code login; returns the verification URL + code. */
export async function startChatgptLogin(userId: string): Promise<PendingLogin> {
  const inst = await getInstance(userId);
  if (inst.account?.type === 'chatgpt') {
    throw new CodexUnavailableError('A ChatGPT account is already connected');
  }
  const res = await inst.rpc.request<{ loginId: string; verificationUrl: string; userCode: string }>(
    'account/login/start',
    { type: 'chatgptDeviceCode' },
    30_000
  );
  const pending: PendingLogin = {
    loginId: res.loginId,
    verificationUrl: res.verificationUrl,
    userCode: res.userCode,
    startedAt: Date.now(),
  };
  inst.pendingLogin = pending;
  return pending;
}

export async function cancelChatgptLogin(userId: string): Promise<void> {
  const inst = instances.get(userId);
  if (!inst?.ready) return;
  if (inst.pendingLogin) {
    try {
      await inst.rpc.request('account/login/cancel', { loginId: inst.pendingLogin.loginId }, 15_000);
    } catch {
      // best effort
    }
    inst.pendingLogin = null;
  }
}

/** Signs the ChatGPT account out and reaps the process. */
export async function logoutChatgpt(userId: string): Promise<void> {
  const inst = instances.get(userId);
  if (inst?.ready && inst.rpc.isRunning) {
    try {
      await inst.rpc.request('account/logout', {}, 15_000);
    } catch {
      // best effort
    }
  }
  await disposeInstance(userId);
}

/** Account + ChatGPT rate-limit state for the status endpoint. */
export async function getChatgptStatus(userId: string): Promise<{
  allowed: boolean;
  connected: boolean;
  email: string | null;
  planType: string | null;
  pendingLogin: PendingLogin | null;
  rateLimits: CodexRateLimits | null;
}> {
  const allowed = isUserAllowed(userId);
  if (!allowed) {
    return { allowed: false, connected: false, email: null, planType: null, pendingLogin: null, rateLimits: null };
  }
  let inst: CodexInstance | null = null;
  try {
    inst = await getInstance(userId);
  } catch {
    inst = null;
  }
  if (!inst) {
    return { allowed: true, connected: false, email: null, planType: null, pendingLogin: null, rateLimits: null };
  }
  const account = inst.account;
  let rateLimits: CodexRateLimits | null = null;
  if (account?.type === 'chatgpt') {
    try {
      const res = await inst.rpc.request<{
        rateLimits?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number | null };
        rateLimitsByLimitId?: Record<string, { usedPercent?: number; windowDurationMins?: number; resetsAt?: number | null }>;
      }>('account/rateLimits/read', {}, 30_000);
      const primary = res?.rateLimits;
      const byLimitId = res?.rateLimitsByLimitId;
      rateLimits = {
        usedPercent: primary?.usedPercent,
        windowDurationMins: primary?.windowDurationMins,
        resetsAt: primary?.resetsAt ?? null,
        byLimitId: byLimitId
          ? Object.entries(byLimitId).map(([limitId, b]) => ({
              limitId,
              usedPercent: b.usedPercent ?? 0,
              windowDurationMins: b.windowDurationMins ?? 0,
              resetsAt: b.resetsAt ?? null,
            }))
          : undefined,
      };
    } catch {
      // rate limits are best-effort
    }
  }
  return {
    allowed: true,
    connected: account?.type === 'chatgpt',
    email: account?.type === 'chatgpt' ? account.email : null,
    planType: account?.type === 'chatgpt' ? account.planType : null,
    pendingLogin: getPendingLogin(inst),
    rateLimits,
  };
}

/** Models available to the connected ChatGPT account, namespaced `codex:<id>`. */
export async function listChatgptModels(userId: string): Promise<
  Array<{ id: string; name: string; description: string; context_length: number; pricing: { prompt: string; completion: string } }>
> {
  const inst = await getConnectedInstance(userId);
  const res = await inst.rpc.request<{
    data?: Array<{ id?: string; displayName?: string | null; description?: string | null; contextWindow?: number | null; hidden?: boolean }>;
  }>('model/list', {}, 30_000);
  const models = res?.data ?? [];
  return models
    .filter((m) => !m.hidden && !!m.id)
    .map((m) => ({
      id: `codex:${m.id}`,
      name: m.displayName || m.id || 'Codex model',
      description: m.description || '',
      context_length: m.contextWindow ?? 0,
      pricing: { prompt: '0', completion: '0' },
    }));
}

export async function disposeInstance(userId: string): Promise<void> {
  const inst = instances.get(userId);
  if (!inst) return;
  instances.delete(userId);
  if (inst.idleTimer) clearTimeout(inst.idleTimer);
  if (inst.rpc.isRunning) inst.rpc.kill();
}

/** Periodic sweep for instances that somehow missed their own idle timer. */
export function startCodexReaper(): void {
  const intervalMs = Math.max(idleTimeoutMs() / 3, 60_000);
  const timer = setInterval(() => {
    for (const inst of [...instances.values()]) {
      if (Date.now() - inst.lastUsedAt >= idleTimeoutMs()) {
        disposeInstance(inst.userId).catch(() => {});
      }
    }
  }, intervalMs);
  timer.unref?.();
}
