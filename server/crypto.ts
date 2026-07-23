import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export const SENSITIVE_SETTINGS_KEYS = new Set([
  'openrouter_api_key',
  'deepseek_api_key',
  'search_api_key',
  'jina_api_key',
  'e2b_api_key',
]);

function getEncryptionKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 32) return null;
  return crypto.createHash('sha256').update(raw.slice(0, 64)).digest();
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  } catch {
    throw new Error('Encryption failed');
  }
}

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  if (!key) return ciphertext;
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) return ciphertext;
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const enc = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
  } catch {
    return ciphertext;
  }
}

export function isSensitive(key: string): boolean {
  return SENSITIVE_SETTINGS_KEYS.has(key);
}

/** Returns a masked value for API responses (e.g. "sk-****...****"). */
export function maskValue(value: string | null | undefined): string {
  if (value == null || value === '') return '';
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/** Decrypt if value looks like our encrypted payload (base64 with right length), else return as-is (legacy plain). */
export function decryptSetting(value: string | null | undefined, key: string): string {
  if (value == null || value === '') return '';
  if (!isSensitive(key)) return value;
  try {
    const buf = Buffer.from(value, 'base64');
    if (buf.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1) return decrypt(value);
  } catch {
    // Legacy plain value
  }
  return value;
}
