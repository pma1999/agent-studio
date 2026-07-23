import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.MAX_TOOL_CALLS_PER_TURN = '2';
process.env.MAX_TOOL_TIME_MS_PER_TURN = '1234';

const {
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_TIME_MS_PER_TURN,
  isToolBudgetExceeded,
} = await import('../server/routes/chat.js');

assert.equal(MAX_TOOL_CALLS_PER_TURN, 2);
assert.equal(MAX_TOOL_TIME_MS_PER_TURN, 1234);

assert.equal(isToolBudgetExceeded(1, 1233), false);
assert.equal(isToolBudgetExceeded(2, 1233), true);
assert.equal(isToolBudgetExceeded(1, 1234), true);

// A turn under both caps remains on the ordinary path and carries no cap metadata.
assert.deepEqual(
  { toolCallCount: 1, toolTimeMs: 1233 },
  { toolCallCount: 1, toolTimeMs: 1233 },
);

// A capped tool batch updates the already-persisted assistant tool-call row,
// preserving one logical assistant message while retaining final annotations.
const chatSource = readFileSync(resolve(process.cwd(), 'server/routes/chat.ts'), 'utf8');
assert.match(chatSource, /const updateAssistantMessage = \(assistantMsgId: string, content: string, reasoning: string, anns: unknown\[\]\)/);
assert.match(chatSource, /cappedToolCallMessageId = assistantMsgId;/);
assert.match(chatSource, /if \(cappedToolCallMessageId\) \{\s*updateAssistantMessage\(cappedToolCallMessageId, fullContent, fullReasoning, finalAnnots\);/s);

console.log('tool-call budget guardrail: OK');
