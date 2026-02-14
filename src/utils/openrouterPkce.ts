/**
 * OpenRouter OAuth PKCE utilities (browser-only, no Buffer).
 * @see https://openrouter.ai/docs/guides/overview/auth/oauth
 */

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';

export const PKCE_STORAGE_KEY = 'openrouter_pkce';

export interface PkceStorage {
  code_verifier: string;
  state: string;
}

/**
 * Generate a cryptographically random code_verifier (43–128 chars).
 * Uses 64 bytes encoded as base64url.
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return arrayBufferToBase64Url(bytes.buffer);
}

/**
 * Generate a random state string for CSRF protection (e.g. 16 bytes hex).
 */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Create S256 code_challenge: base64url(sha256(verifier)).
 */
export async function createSHA256CodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToBase64Url(hash);
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the OpenRouter auth URL to redirect the user to.
 */
export function buildAuthUrl(options: { callbackUrl: string; codeChallenge: string; state: string }): string {
  const params = new URLSearchParams({
    callback_url: options.callbackUrl,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    state: options.state,
  });
  return `${OPENROUTER_AUTH_URL}?${params.toString()}`;
}

export interface ExchangeResult {
  key: string;
}

export interface ExchangeError {
  error?: string;
  message?: string;
}

/**
 * Exchange the authorization code for an API key.
 * Throws with a user-friendly message on 400/403.
 */
export async function exchangeCodeForKey(
  code: string,
  codeVerifier: string
): Promise<ExchangeResult> {
  const res = await fetch(OPENROUTER_KEYS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256',
    }),
  });

  const body = (await res.json().catch(() => ({}))) as ExchangeResult & ExchangeError;

  if (!res.ok) {
    const msg = body?.error ?? body?.message ?? `HTTP ${res.status}`;
    if (res.status === 400 && String(msg).toLowerCase().includes('code_challenge_method')) {
      throw new Error('Invalid code challenge method. Please try connecting again.');
    }
    if (res.status === 403 && (String(msg).toLowerCase().includes('invalid code') || String(msg).toLowerCase().includes('code_verifier'))) {
      throw new Error('Invalid or expired code. Please try connecting again.');
    }
    if (res.status === 405) {
      throw new Error('Request method not allowed. Please try again.');
    }
    throw new Error(typeof msg === 'string' ? msg : 'Failed to exchange code for key.');
  }

  if (!body?.key || typeof body.key !== 'string') {
    throw new Error('No API key in response.');
  }

  return { key: body.key };
}
