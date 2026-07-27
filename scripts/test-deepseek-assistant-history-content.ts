import assert from 'node:assert/strict';
import { resolveAssistantHistoryContent } from '../server/providers/index.js';

// 1. Empty content + no tool_calls (the poisoned-row shape from an interrupted stream)
//    must map to '' , NOT null — DeepSeek's API rejects { content: null } with no
//    tool_calls with a 400 "Invalid assistant message: content or tool_calls must be set".
assert.equal(resolveAssistantHistoryContent('', false), '');

// 2. Non-empty content + no tool_calls -> content passes through unchanged.
assert.equal(resolveAssistantHistoryContent('hello', false), 'hello');

// 3. Empty content + tool_calls present -> legitimate pure-tool-call turn, must stay null.
assert.equal(resolveAssistantHistoryContent('', true), null);

// 4. Non-empty content + tool_calls present -> content passes through unchanged.
assert.equal(resolveAssistantHistoryContent('hello', true), 'hello');

console.log('deepseek assistant history content fallback: OK');
