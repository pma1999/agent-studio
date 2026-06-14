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
const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
assert.equal(messages[0].role, 'system');
assert.match(messages[1].content, /You are a coding assistant/);
assert.match(messages[1].content, /Please refactor the agent prompt loading flow/);

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
