import assert from 'node:assert/strict';
import { selectSkillResolutionSource } from '../server/skills/resolve.js';

// 1. Active conversation override wins regardless of isGeneralChat/generalSettings
assert.deepEqual(
  selectSkillResolutionSource({
    conversationOverride: { skills_overridden: true, skill_ids: ['s1', 's2'] },
    isGeneralChat: true,
    generalSettings: { skill_ids: ['general-1'] },
  }),
  { kind: 'conversation-override', skill_ids: ['s1', 's2'] },
);

// 2. No override + isGeneralChat true + non-null generalSettings -> general-settings
assert.deepEqual(
  selectSkillResolutionSource({
    conversationOverride: { skills_overridden: false, skill_ids: [] },
    isGeneralChat: true,
    generalSettings: { skill_ids: ['general-1'] },
  }),
  { kind: 'general-settings', skill_ids: ['general-1'] },
);

// 3. No override + isGeneralChat false -> agent-default regardless of generalSettings
assert.deepEqual(
  selectSkillResolutionSource({
    conversationOverride: { skills_overridden: false, skill_ids: [] },
    isGeneralChat: false,
    generalSettings: { skill_ids: ['general-1'] },
  }),
  { kind: 'agent-default' },
);
assert.deepEqual(
  selectSkillResolutionSource({
    conversationOverride: { skills_overridden: false, skill_ids: [] },
    isGeneralChat: false,
    generalSettings: null,
  }),
  { kind: 'agent-default' },
);

// 4. Active override with an empty skill_ids array still returns conversation-override
assert.deepEqual(
  selectSkillResolutionSource({
    conversationOverride: { skills_overridden: true, skill_ids: [] },
    isGeneralChat: false,
    generalSettings: null,
  }),
  { kind: 'conversation-override', skill_ids: [] },
);

console.log('skill resolution precedence: OK');
