/**
 * Env/config for the Codex app-server provider.
 *
 * The ChatGPT provider runs one `codex app-server` subprocess per allowed user.
 * Each process owns an isolated Codex home directory (auth.json, config.toml,
 * thread rollouts) under `CODEX_HOME_ROOT`, so accounts never share state.
 *
 * Feature gating: the provider only exists for users whose email is listed in
 * `CODEX_ALLOWED_EMAILS` (comma-separated). Without that variable the provider
 * is disabled entirely.
 */

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);

export const CODEX_PROVIDER_ID = 'codex';

function readCommaList(name: string): string[] {
  const raw = process.env[name] ?? '';
  return raw
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

export const codexConfig = {
  /** Emails allowed to use the ChatGPT/Codex provider. Empty = feature disabled. */
  allowedEmails: readCommaList('CODEX_ALLOWED_EMAILS'),
  /** Root directory holding one per-user Codex home (defaults next to the SQLite DB). */
  homeRoot: process.env.CODEX_HOME_ROOT ?? path.join(path.dirname(process.env.DATABASE_PATH ?? 'agent-studio.db'), 'codex'),
  /** How long an unused app-server process stays alive before being reaped (ms). */
  idleTimeoutMs: Number(process.env.CODEX_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000),
  /** Total wall-clock budget for one turn (ms). */
  turnTimeoutMs: Number(process.env.CODEX_TURN_TIMEOUT_MS ?? 300_000),
  /** Window during which a pending device-code login stays usable (ms). */
  loginTtlMs: Number(process.env.CODEX_LOGIN_TTL_MS ?? 10 * 60 * 1000),
};

export function isCodexFeatureEnabled(): boolean {
  return codexConfig.allowedEmails.length > 0;
}

export function isEmailAllowed(email: string | null | undefined): boolean {
  if (!isCodexFeatureEnabled()) return false;
  const normalized = String(email ?? '').trim().toLowerCase();
  return codexConfig.allowedEmails.includes(normalized);
}

export function codexHomeForUser(userId: string): string {
  return path.join(codexConfig.homeRoot, userId);
}

/** Path of the Codex CLI entrypoint (the npm wrapper). Throws when not installed. */
export function resolveCodexEntry(): string {
  try {
    return require_.resolve('@openai/codex/bin/codex.js');
  } catch {
    throw new Error(
      'Codex CLI is not installed. Run `npm install @openai/codex` to enable the ChatGPT provider.'
    );
  }
}

/** Best-effort per-user Codex config: chat-safe, no shell writes, no approval prompts. */
export function writeCodexUserConfig(homeDir: string): void {
  try {
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(homeDir, 'config.toml');
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(
        configPath,
        ['approval_policy = "never"', 'sandbox_mode = "read-only"', ''].join('\n'),
        { mode: 0o600 }
      );
    }
  } catch (err) {
    console.warn('[codex] Could not write per-user config:', err);
  }
}
