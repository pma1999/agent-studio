import assert from 'node:assert/strict';
import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OPENROUTER_TITLE_MODEL,
  createFallbackConversationTitle,
  generateConversationTitleWithOpenRouter,
  isAutoConversationTitlesEnabled,
  sanitizeGeneratedConversationTitle,
} from '../server/conversationTitles.js';

assert.equal(isAutoConversationTitlesEnabled(undefined), false);
assert.equal(isAutoConversationTitlesEnabled(''), false);
assert.equal(isAutoConversationTitlesEnabled('false'), false);
assert.equal(isAutoConversationTitlesEnabled('true'), true);
assert.equal(isAutoConversationTitlesEnabled('1'), true);

assert.equal(createFallbackConversationTitle(''), 'New conversation');
assert.equal(createFallbackConversationTitle('   Build   a   test plan   '), 'Build a test plan');
assert.equal(
  createFallbackConversationTitle('This is a deliberately long first message that should be shortened for the sidebar'),
  'This is a deliberately long first message that sho...'
);

assert.equal(sanitizeGeneratedConversationTitle('"Quarterly Planning"'), 'Quarterly Planning');
assert.equal(sanitizeGeneratedConversationTitle('Title: API Key Rotation.'), 'API Key Rotation');
assert.equal(sanitizeGeneratedConversationTitle('# Markdown Heading'), 'Markdown Heading');
assert.equal(sanitizeGeneratedConversationTitle('Untitled'), null);
assert.equal(sanitizeGeneratedConversationTitle('x'), null);

// Reasoning residue must never become the title.
assert.equal(
  sanitizeGeneratedConversationTitle('<think>Analyze: user wants a name. Okay.</think>Deploy Pipeline'),
  'Deploy Pipeline',
);
assert.equal(
  sanitizeGeneratedConversationTitle('<thinking>Step one. Step two.</thinking>\n\nKPI Dashboard'),
  'KPI Dashboard',
);
assert.equal(sanitizeGeneratedConversationTitle('<think>Only reasoning, no answer</think>'), null);
assert.equal(sanitizeGeneratedConversationTitle('<REASONING>case insensitive reasoning</REASONING>Final Title'), 'Final Title');
assert.equal(sanitizeGeneratedConversationTitle('<think>never closed, all reasoning'), null);
assert.equal(
  sanitizeGeneratedConversationTitle('long reasoning about the message</think>Budget Tracker'),
  'Budget Tracker',
);
assert.equal(
  sanitizeGeneratedConversationTitle('Answer</think>kept after orphan close'),
  'kept after orphan close',
);

let calls = 0;
let capturedBody: Record<string, unknown> | null = null;
const fetchOk = async (input: string, init?: RequestInit): Promise<Response> => {
  calls++;
  assert.equal(input, OPENROUTER_CHAT_COMPLETIONS_URL);
  assert.equal(init?.method, 'POST');
  assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer sk-test');
  capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return new Response(JSON.stringify({
    choices: [{ message: { content: '"Agent Prompt Refactor"' } }],
  }), { status: 200 });
};

const generated = await generateConversationTitleWithOpenRouter({
  apiKey: ' sk-test ',
  userMessage: 'Please refactor the agent prompt loading flow.',
  systemPrompt: 'You are a coding assistant.',
  fetchImpl: fetchOk,
});

assert.equal(generated, 'Agent Prompt Refactor');
assert.equal(calls, 1);
assert.equal(capturedBody?.model, OPENROUTER_TITLE_MODEL);
assert.equal(capturedBody?.stream, false);
assert.deepEqual(capturedBody?.reasoning, { enabled: false, exclude: true });
assert.deepEqual(capturedBody?.provider, { require_parameters: true });
assert.equal(capturedBody?.max_tokens, 512);
const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
assert.equal(messages[0].role, 'system');
assert.match(messages[1].content, /You are a coding assistant/);
assert.match(messages[1].content, /Please refactor the agent prompt loading flow/);

// A reasoning model that ignores the flags and inlines <think> tags in content.
const thinkModel = await generateConversationTitleWithOpenRouter({
  apiKey: 'sk-test',
  userMessage: 'Name this',
  fetchImpl: async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: '<think>The user asks about database indexing. A title could be "Database Indexing".</think>Database Indexing',
        reasoning_content: 'The user asks about database indexing.',
      },
    }],
  }), { status: 200 }),
});
assert.equal(thinkModel, 'Database Indexing');

// Content delivered as parts array; reasoning fields must be ignored.
const partsModel = await generateConversationTitleWithOpenRouter({
  apiKey: 'sk-test',
  userMessage: 'Name this',
  fetchImpl: async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: [{ type: 'text', text: 'Cache' }, { type: 'text', text: 'Eviction Policy' }],
        reasoning: 'internal chain of thought that must not appear',
      },
    }],
  }), { status: 200 }),
});
assert.equal(partsModel, 'Cache Eviction Policy');

// All-reasoning content (token budget exhausted mid-think) → null → caller falls back.
const exhaustedBudget = await generateConversationTitleWithOpenRouter({
  apiKey: 'sk-test',
  userMessage: 'Name this',
  fetchImpl: async () => new Response(JSON.stringify({
    choices: [{ message: { content: '<think>Still deciding what to call' } }],
  }), { status: 200 }),
});
assert.equal(exhaustedBudget, null);

calls = 0;
const noKey = await generateConversationTitleWithOpenRouter({
  apiKey: '',
  userMessage: 'Name this',
  fetchImpl: async () => {
    calls++;
    return new Response('{}');
  },
});
assert.equal(noKey, null);
assert.equal(calls, 0);

const invalidResponse = await generateConversationTitleWithOpenRouter({
  apiKey: 'sk-test',
  userMessage: 'Name this',
  fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Untitled' } }] }), { status: 200 }),
});
assert.equal(invalidResponse, null);

const httpError = await generateConversationTitleWithOpenRouter({
  apiKey: 'sk-test',
  userMessage: 'Name this',
  fetchImpl: async () => new Response('bad gateway', { status: 502 }),
});
assert.equal(httpError, null);

console.log('conversation title tests passed');
