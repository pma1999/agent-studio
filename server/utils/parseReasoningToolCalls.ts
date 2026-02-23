/**
 * Parse tool calls that appear inside reasoning/thinking text.
 * Some models (e.g. Kimi K2/K2.5, GLM 4.7) emit tool calls in the reasoning
 * field instead of in delta.tool_calls; this module extracts them.
 */

import { nanoid } from 'nanoid';
import type { ToolCallSpec } from '../types.js';

const MARKERS = [
  '</tool_calls_section_begin/>',
  '<|tool_calls_section_begin|>',
  '<|tool_calls_section_begin|',
  'tool_calls_section_begin',
] as const;

const KIMI_TOOL_CALL_BEGIN = '<|tool_call_begin|>';
const KIMI_ARG_BEGIN = '<|tool_call_argument_begin|>';
const KIMI_TOOL_CALL_END = '<|tool_call_end|>';

/**
 * Find the span of a balanced JSON value (array or object) starting at index.
 * Skips brackets inside double-quoted strings. Returns [start, end] or null.
 */
function findBalancedJson(text: string, startIndex: number): [number, number] | null {
  const open = text[startIndex];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return null;
  let depth = 1;
  let i = startIndex + 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) depth--;
    i++;
  }
  if (depth !== 0) return null;
  return [startIndex, i];
}

/**
 * Parse JSON-array format: marker followed by [{ "name": "...", "parameters": {...} }].
 * Also accepts "arguments" instead of "parameters".
 */
function parseJsonArrayFormat(reasoning: string): ToolCallSpec[] {
  const lower = reasoning.toLowerCase();
  let searchStart = 0;
  const results: ToolCallSpec[] = [];

  for (const marker of MARKERS) {
    const idx = lower.indexOf(marker.toLowerCase(), searchStart);
    if (idx === -1) continue;
    const afterMarker = idx + marker.length;
    const rest = reasoning.slice(afterMarker);
    const firstBracket = rest.search(/\[|\{/);
    if (firstBracket === -1) continue;
    const span = findBalancedJson(rest, firstBracket);
    if (!span) continue;
    const jsonStr = rest.slice(span[0], span[1]);
    let arr: unknown[];
    if (rest[firstBracket] === '[') {
      try {
        arr = JSON.parse(jsonStr) as unknown[];
      } catch {
        continue;
      }
    } else {
      try {
        arr = [JSON.parse(jsonStr) as object];
      } catch {
        continue;
      }
    }
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (!name) continue;
      const params = obj.parameters ?? obj.arguments;
      const argsStr =
        typeof params === 'string'
          ? params
          : params !== undefined && params !== null
            ? JSON.stringify(params)
            : '{}';
      results.push({
        id: typeof obj.id === 'string' ? obj.id : `call_${nanoid()}`,
        type: 'function',
        function: { name, arguments: argsStr },
      });
    }
    if (results.length > 0) return results;
    searchStart = afterMarker;
  }
  return results;
}

/**
 * Normalize Kimi tool name: "functions.bash:0" -> "bash" so it matches resolvedTools.
 * OpenRouter/agents often register tools as "web_search", "bash", etc., not "functions.bash".
 */
function normalizeKimiToolName(nameIndex: string): string {
  const s = nameIndex.trim();
  const colon = s.indexOf(':');
  const name = colon >= 0 ? s.slice(0, colon).trim() : s;
  const lower = name.toLowerCase();
  if (lower.startsWith('functions.')) {
    return name.slice('functions.'.length);
  }
  return name;
}

/**
 * Parse Kimi/vLLM format: <|tool_call_begin|> name:index <|tool_call_argument_begin|> JSON <|tool_call_end|>
 */
function parseKimiTagFormat(reasoning: string): ToolCallSpec[] {
  const results: ToolCallSpec[] = [];
  let pos = 0;
  while (true) {
    const beginIdx = reasoning.indexOf(KIMI_TOOL_CALL_BEGIN, pos);
    if (beginIdx === -1) break;
    const afterBegin = beginIdx + KIMI_TOOL_CALL_BEGIN.length;
    const argBeginIdx = reasoning.indexOf(KIMI_ARG_BEGIN, afterBegin);
    if (argBeginIdx === -1) {
      pos = afterBegin;
      continue;
    }
    const namePart = reasoning.slice(afterBegin, argBeginIdx).trim();
    const afterArgBegin = argBeginIdx + KIMI_ARG_BEGIN.length;
    const endIdx = reasoning.indexOf(KIMI_TOOL_CALL_END, afterArgBegin);
    if (endIdx === -1) {
      pos = afterArgBegin;
      continue;
    }
    const jsonStr = reasoning.slice(afterArgBegin, endIdx).trim();
    let argsStr = '{}';
    const firstBrace = jsonStr.search(/\{/);
    if (firstBrace >= 0) {
      const span = findBalancedJson(jsonStr, firstBrace);
      if (span) {
        try {
          const parsed = JSON.parse(jsonStr.slice(span[0], span[1]));
          argsStr = typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed) : jsonStr;
        } catch {
          argsStr = jsonStr;
        }
      }
    }
    const name = normalizeKimiToolName(namePart);
    if (name) {
      results.push({
        id: `call_${nanoid()}`,
        type: 'function',
        function: { name, arguments: argsStr },
      });
    }
    pos = endIdx + KIMI_TOOL_CALL_END.length;
  }
  return results;
}

/**
 * Parse XML-lite format: <tool_call><function=name><parameter=n>v</parameter>...</function></tool_call>
 */
function parseXmlToolCallFormat(reasoning: string): ToolCallSpec[] {
  const results: ToolCallSpec[] = [];
  // Match <tool_call> blocks
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match;

  while ((match = toolCallRegex.exec(reasoning)) !== null) {
    const block = match[1];

    // Extract function name: <function=name>
    const functionMatch = /<function=([^>]+)>/i.exec(block);
    if (!functionMatch) continue;

    const name = functionMatch[1].trim();

    // Extract parameters: <parameter=name>value</parameter>
    const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi;
    const args: Record<string, any> = {};
    let pMatch;
    while ((pMatch = paramRegex.exec(block)) !== null) {
      const pName = pMatch[1].trim();
      const pValue = pMatch[2].trim();
      args[pName] = pValue;
    }

    results.push({
      id: `call_${nanoid()}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args)
      }
    });
  }

  return results;
}

/**
 * Extract tool calls from reasoning text. Supports:
 * - JSON array after marker (e.g. </tool_calls_section_begin/> or <|tool_calls_section_begin|>)
 *   with items like { "name": "web_search", "parameters": { ... } }
 * - Kimi/vLLM tag format: <|tool_call_begin|> name:index <|tool_call_argument_begin|> JSON <|tool_call_end|>
 * - XML-lite format: <tool_call><function=web_search><parameter=query>...</parameter></function></tool_call>
 *
 * Returns OpenAI/OpenRouter-style ToolCallSpec[] or [] if none found / parse failed.
 */
export function parseReasoningToolCalls(reasoning: string | null | undefined): ToolCallSpec[] {
  if (!reasoning || typeof reasoning !== 'string') return [];
  const trimmed = reasoning.trim();
  if (!trimmed) return [];

  const results: ToolCallSpec[] = [];

  // Try all formats and accumulate results (some models might mix formats, though rare)
  const fromJson = parseJsonArrayFormat(trimmed);
  if (fromJson.length > 0) results.push(...fromJson);

  const fromKimi = parseKimiTagFormat(trimmed);
  if (fromKimi.length > 0) results.push(...fromKimi);

  const fromXml = parseXmlToolCallFormat(trimmed);
  if (fromXml.length > 0) results.push(...fromXml);

  return results;
}
