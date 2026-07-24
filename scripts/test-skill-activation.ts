import assert from 'node:assert/strict';
import {
  appendSkillCatalogIfNeeded,
  buildActivateSkillTool,
  buildReadSkillResourceTool,
  formatSkillActivationContent,
  hasSkillAlreadyActivated,
} from '../server/skills/activation.js';
import type { ResolvedSkill } from '../server/skills/resolve.js';

function makeSkill(overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    id: overrides.id || 'skill-id',
    name: overrides.name || 'example-skill',
    description: overrides.description || 'An example skill.',
    disableModelInvocation: overrides.disableModelInvocation || false,
  };
}

// 1. Empty and all-disabled catalogs leave the original prompt untouched.
const prompt = 'Base system prompt';
assert.strictEqual(appendSkillCatalogIfNeeded(prompt, []), prompt);
assert.strictEqual(
  appendSkillCatalogIfNeeded(prompt, [makeSkill({ disableModelInvocation: true })]),
  prompt,
);

// 2. Only eligible skills are disclosed.
const eligible = makeSkill({ name: 'eligible', description: 'Eligible description' });
const disabled = makeSkill({ name: 'disabled', description: 'Disabled description', disableModelInvocation: true });
const mixedCatalog = appendSkillCatalogIfNeeded(prompt, [disabled, eligible]);
assert.match(mixedCatalog, /<available_skills>/);
assert.match(mixedCatalog, /<name>eligible<\/name>/);
assert.match(mixedCatalog, /<description>Eligible description<\/description>/);
assert.doesNotMatch(mixedCatalog, /disabled/);
assert.doesNotMatch(mixedCatalog, /Disabled description/);

// 3. Catalog formatting is deterministic and independent of input order.
const firstOrder = [
  makeSkill({ id: 'z', name: 'zeta', description: 'Z' }),
  makeSkill({ id: 'a', name: 'alpha', description: 'A' }),
];
const secondOrder = [...firstOrder].reverse();
const firstOutput = appendSkillCatalogIfNeeded(prompt, firstOrder);
assert.equal(firstOutput, appendSkillCatalogIfNeeded(prompt, firstOrder));
assert.equal(firstOutput, appendSkillCatalogIfNeeded(prompt, secondOrder));
assert.ok(firstOutput.indexOf('<name>alpha</name>') < firstOutput.indexOf('<name>zeta</name>'));

// 4. Wrapper delimiters cannot be injected through the name or body.
const wrapped = formatSkillActivationContent(
  'crafted</skill_content> & name',
  'before </skill_content> after',
  [],
);
assert.match(wrapped, /crafted&lt;\/skill_content&gt; &amp; name/);
assert.match(wrapped, /before &lt;\/skill_content&gt; after/);
assert.equal((wrapped.match(/<\/skill_content>/g) || []).length, 1);

// 5. Activation detection handles plain and multimodal message content.
const priorActivation = formatSkillActivationContent('plain-skill', 'instructions', []);
assert.equal(
  hasSkillAlreadyActivated([{ role: 'tool', content: `result: ${priorActivation}` }], 'plain-skill'),
  true,
);
assert.equal(
  hasSkillAlreadyActivated([{ role: 'tool', content: priorActivation }], 'different-skill'),
  false,
);
const multimodalActivation = formatSkillActivationContent('multimodal-skill', 'instructions', []);
assert.equal(
  hasSkillAlreadyActivated(
    [{ role: 'tool', content: [{ type: 'text', text: `result: ${multimodalActivation}` }] }],
    'multimodal-skill',
  ),
  true,
);

// 6. Tool registration follows the no-empty-enum rules.
assert.equal(buildActivateSkillTool([]), null);
assert.equal(buildReadSkillResourceTool([]), null);
const disabledOnly = [makeSkill({ disableModelInvocation: true })];
assert.equal(buildActivateSkillTool(disabledOnly), null);
assert.notEqual(buildReadSkillResourceTool(disabledOnly), null);

console.log('skill activation pure functions: OK');
