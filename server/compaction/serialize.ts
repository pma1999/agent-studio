/**
 * Pure compaction serializers (compact-serialize).
 *
 * No db/network imports: the caller (compact-route) passes visible-thread
 * rows in root→leaf order. Contracts: G5 (head line format, 2000-char cut,
 * attachment descriptors, ceil(chars/4) estimate), G3 (template heading
 * validation).
 *
 * G6 (turn-granular verbatim tail) is GONE on purpose: the checkpoint row is
 * inserted at the END of the thread (`parent_id` = pre-compact leaf) and the
 * chat builder cuts everything up to and including it (G10,
 * `selectModelView`), so a "kept tail" sat BEFORE the cut and never reached
 * the provider — those rows were neither summarized nor sent. The head is now
 * the whole visible slice since the last on-thread checkpoint.
 */

export interface CompactRow {
  id: string;
  role: string;
  content: unknown;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  annotations?: string | null;
  reasoning_content?: string | null;
  attachments?: string | null;
  turn_id?: string | null;
}

/** G5: tool-output cut threshold (chars). */
export const TOOL_OUTPUT_MAX_CHARS = 2000;

/** G3: canonical template headings in order (also the `missing` report vocabulary). */
const TEMPLATE_HEADINGS = [
  '## Objective',
  '## Important Details',
  '## Work State',
  '### Completed',
  '### Active',
  '### Blocked',
  '## Next Move',
  '## Relevant Files',
  '## Session Facts',
] as const;

/** G5: token estimate everywhere (no tokenizer dependency). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Content flattening (G5: multimodal/array content → text parts only)
// ---------------------------------------------------------------------------

type FlatPart = { kind: 'text'; text: string } | { kind: 'descriptor'; text: string };

function flatPart(part: unknown): FlatPart | null {
  if (typeof part === 'string') return part ? { kind: 'text', text: part } : null;
  if (!part || typeof part !== 'object') return null;
  const o = part as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : '';
  if (type === 'text') {
    return typeof o.text === 'string' && o.text ? { kind: 'text', text: o.text } : null;
  }
  if (type === 'file') {
    const f = (o.file ?? {}) as Record<string, unknown>;
    const name =
      (typeof f.filename === 'string' && f.filename ? f.filename : null) ??
      (typeof o.filename === 'string' && o.filename ? o.filename : null) ??
      'unknown';
    return { kind: 'descriptor', text: `[file: ${name}]` };
  }
  if (type === 'image_url' || type === 'image') {
    return { kind: 'descriptor', text: '[image]' };
  }
  if (typeof o.text === 'string' && o.text) return { kind: 'text', text: o.text };
  return { kind: 'descriptor', text: type ? `[${type} part]` : '[non-text part]' };
}

function flatParts(content: unknown): FlatPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : [];
  if (typeof content === 'number' || typeof content === 'boolean' || typeof content === 'bigint') {
    return [{ kind: 'text', text: String(content) }];
  }
  if (Array.isArray(content)) {
    const out: FlatPart[] = [];
    for (const item of content) {
      const p = flatPart(item);
      if (p) out.push(p);
    }
    return out;
  }
  const p = flatPart(content);
  return p ? [p] : [];
}

/** All parts (text + descriptors) joined — the row's full text weight. */
function flattenText(content: unknown): string {
  return flatParts(content)
    .map((p) => p.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/**
 * Tool-error detection (brief contract): row content JSON parses to
 * `{ok:false}` (top-level) OR content starts with `[Tool execution error]`
 * (the MCP error-output prefix, server/mcp/client.ts) → `[Tool error]`,
 * else `[Tool result]`.
 */
function isToolError(content: string): boolean {
  if (content.startsWith('[Tool execution error]')) return true;
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return !!parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).ok === false;
  } catch {
    return false;
  }
}

/** G5: tool output cut at 2000 chars + ` [truncated N chars]`. */
function cutToolOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)} [truncated ${text.length - TOOL_OUTPUT_MAX_CHARS} chars]`;
}

interface ParsedToolCall {
  name: string;
  args: string;
}

/** Canonical `[{id,type,function:{name,arguments}}]` form (server/routes/chat.ts). */
function parseToolCalls(raw: string | null | undefined): ParsedToolCall[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ParsedToolCall[] = [];
    for (const tc of parsed) {
      const fn = (tc as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
      if (!fn || typeof fn.name !== 'string' || !fn.name) continue;
      // Arguments travel WHOLE, like OpenCode's serializer
      // (`core/src/session/compaction.ts`: the tool input is stringified with
      // no cut). For write/edit-style tools the arguments ARE the content that
      // was written — the one thing the summary most needs to preserve. Only
      // tool OUTPUT is cut (2000 chars, same threshold as OpenCode).
      out.push({ name: fn.name, args: typeof fn.arguments === 'string' ? fn.arguments : '' });
    }
    return out;
  } catch {
    return [];
  }
}

/** G5: attachments JSON col → `[Attached <mime-or-unknown>: <name>]` lines, never data. */
function attachmentLines(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const mime =
        (['mime', 'mimeType', 'contentType'] as const)
          .map((k) => o[k])
          .find((v): v is string => typeof v === 'string' && v.length > 0) ?? 'unknown';
      const name =
        (typeof o.filename === 'string' && o.filename ? o.filename : null) ??
        (typeof o.name === 'string' && o.name ? o.name : null) ??
        'unknown';
      return `[Attached ${mime}: ${name}]`;
    });
  } catch {
    return [];
  }
}

function roleLabel(role: string): string {
  return `[${role.charAt(0).toUpperCase()}${role.slice(1)}]`;
}

/** One row → its line group (possibly empty for skipped/vacuous rows). */
function serializeRow(row: CompactRow): string[] {
  // Belt-and-braces: the caller excludes history before prior checkpoints,
  // but compaction rows must never leak into the head either way.
  if (!row.role || row.role === 'compaction') return [];

  if (row.role === 'tool') {
    const text = flattenText(row.content);
    const raw = typeof row.content === 'string' ? row.content : text;
    const label = isToolError(raw) ? '[Tool error]' : '[Tool result]';
    return [text ? `${label} ${cutToolOutput(text)}` : label];
  }

  if (row.role === 'assistant') {
    const lines: string[] = [];
    if (row.reasoning_content && row.reasoning_content.trim()) {
      lines.push(`[Assistant reasoning] ${row.reasoning_content}`);
    }
    const text = flattenText(row.content);
    // DeepSeek reality: content:null-with-tools rows carry no text —
    // never emit a phantom `[Assistant]` line for them.
    if (text.trim()) lines.push(`[Assistant] ${text}`);
    for (const tc of parseToolCalls(row.tool_calls)) {
      lines.push(`[Assistant tool call]: ${tc.name}(${tc.args})`);
    }
    lines.push(...attachmentLines(row.attachments));
    return lines;
  }

  // user + any other role (e.g. orphan system rows): text line, then
  // content-part descriptors and attachment descriptors as own lines.
  const lines: string[] = [];
  const parts = flatParts(row.content);
  const joined = parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
  if (joined.trim()) lines.push(`${roleLabel(row.role)} ${joined}`);
  for (const p of parts) {
    if (p.kind === 'descriptor') lines.push(p.text);
  }
  lines.push(...attachmentLines(row.attachments));
  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** G5: each row → exactly one line group; groups joined with `\n`. */
export function serializeHead(rows: CompactRow[]): string {
  const lines: string[] = [];
  for (const row of rows) lines.push(...serializeRow(row));
  return lines.join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * G3: the summary must contain all 9 headings as line-anchored markdown
 * headings (`^#{2,3}\s+<title>\s*$`, case-sensitive; ## vs ### interchangeable).
 */
export function validateSummaryTemplate(text: string): { ok: true } | { ok: false; missing: string[] } {
  const lines = text.split('\n');
  const missing = TEMPLATE_HEADINGS.filter((heading) => {
    const title = heading.replace(/^#+\s+/, '');
    const re = new RegExp(`^#{2,3}\\s+${escapeRegExp(title)}\\s*$`);
    return !lines.some((l) => re.test(l));
  });
  return missing.length === 0 ? { ok: true } : { ok: false, missing: [...missing] };
}
