/**
 * Secondary/defensive detection of blocked, challenged, or otherwise non-content responses
 * returned by a page fetch. The caller is expected to check the primary signal
 * (originHttpStatus / originWarning, sourced from Jina's data.httpStatus / data.warning) first;
 * text_pattern and empty_content below are the defensive fallback for cases that don't surface
 * a structured signal (true captchas, soft paywalls that still return HTTP 200).
 */

export type BlockSignal = 'origin_status' | 'origin_warning' | 'text_pattern' | 'empty_content';

export type BlockDetectionResult =
  | { blocked: false }
  | { blocked: true; signal: BlockSignal; reason: string };

export interface BlockDetectionInput {
  originHttpStatus?: number;
  originWarning?: string;
  originTitle?: string;
  content: string;
  /** Requested response format; text-pattern and empty-content checks only apply to textual formats. */
  respondWith?: string;
}

const TEXTUAL_FORMATS = new Set(['content', 'markdown', 'text']);
const EMPTY_CONTENT_THRESHOLD = 40;

/**
 * Curated, maintainable set of known challenge/captcha/paywall/access-denied phrases
 * (English + Spanish, given this app's bilingual usage). Secondary/defensive signal only —
 * not exhaustive by design.
 */
const BLOCK_TEXT_PATTERNS: RegExp[] = [
  /checking your browser/i,
  /just a moment/i,
  /verify you are human/i,
  /verifying you are human/i,
  /enable javascript and cookies/i,
  /please enable cookies/i,
  /unusual traffic/i,
  /captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /are you a robot/i,
  /access denied/i,
  /acceso denegado/i,
  /403 forbidden/i,
  /you have been blocked/i,
  /request blocked/i,
  /ddos protection by/i,
  /cf-chl/i,
  /ray id/i,
  /subscribe to continue reading/i,
  /suscr[ií]bete para (seguir leyendo|continuar)/i,
  /contenido exclusivo para suscriptores/i,
  /this content is for subscribers only/i,
  /too many requests/i,
];

function matchesTextPattern(title: string | undefined, contentPrefix: string): boolean {
  const haystack = `${title ?? ''}\n${contentPrefix}`;
  return BLOCK_TEXT_PATTERNS.some((re) => re.test(haystack));
}

export function detectBlock(input: BlockDetectionInput): BlockDetectionResult {
  const { originHttpStatus, originWarning, originTitle, content, respondWith } = input;

  if (originHttpStatus !== undefined && originHttpStatus >= 400) {
    return {
      blocked: true,
      signal: 'origin_status',
      reason: originWarning || `El sitio de origen respondió con estado HTTP ${originHttpStatus}.`,
    };
  }

  if (originWarning) {
    return { blocked: true, signal: 'origin_warning', reason: originWarning };
  }

  const isTextual = respondWith === undefined || TEXTUAL_FORMATS.has(respondWith);
  if (!isTextual) return { blocked: false };

  const trimmed = content.trim();
  const contentPrefix = trimmed.slice(0, 2000);
  if (matchesTextPattern(originTitle, contentPrefix)) {
    return {
      blocked: true,
      signal: 'text_pattern',
      reason: 'El contenido parece una página de verificación, captcha o acceso restringido.',
    };
  }

  if (trimmed.length < EMPTY_CONTENT_THRESHOLD) {
    return {
      blocked: true,
      signal: 'empty_content',
      reason: 'El contenido obtenido está vacío o es demasiado corto para ser una página real.',
    };
  }

  return { blocked: false };
}
