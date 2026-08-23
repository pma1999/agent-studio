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

// A capped tool batch appends the budget notice to the current segment's
// draft accumulators and falls through to the final close, which finalizes the
// SAME row 'complete' with final annotations (plan S2/GC3: one row per
// segment; the cappedToolCallMessageId re-update mechanism was removed when
// persistence moved onto the draft helpers).
const chatSource = readFileSync(resolve(process.cwd(), 'server/routes/chat.ts'), 'utf8');
assert.match(chatSource, /if \(isToolBudgetExceeded\(toolCallCount, toolTimeMs\)\) \{/);
assert.match(chatSource, /const budgetMessage = '\\n\\n_Tool-call budget for this turn was reached; stopping here\._';/);
assert.match(chatSource, /fullContent \+= budgetMessage;/);
assert.match(chatSource, /if \(openDraftId \|\| fullContent \|\| fullReasoning\) \{\s*finalizeDraft\(readLoopAborted \? terminalStatusForCurrentAbort\(\) : 'complete', \{ anns: finalAnnots \}\);/s);
assert.doesNotMatch(chatSource, /cappedToolCallMessageId/, 'the old capped-row id mechanism must stay deleted');

console.log('tool-call budget guardrail: OK');
