import assert from 'node:assert/strict';
import {
  checkBodySizeWarning,
  normalizeMetadata,
  normalizeSkillName,
  parseSkillMd,
  serializeSkillMd,
  validateFrontmatter,
} from '../server/skills/parser.js';

const minimal = `---
name: pdf-processing
description: Extract PDF text and merge files.
---

# PDF Processing
`;

const parsedMinimal = parseSkillMd(minimal);
assert.equal(parsedMinimal.ok, true);
if (parsedMinimal.ok) {
  const validation = validateFrontmatter(parsedMinimal.frontmatter);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
  assert.equal(parsedMinimal.body, '# PDF Processing');
}

const full = `---
name: pdf-processing
description: Extract PDF text, fill forms, and merge files.
license: Apache-2.0
compatibility: Requires Python 3.14+ and uv
allowed-tools: Bash(git:*) Bash(jq:*) Read
metadata:
  author: example-org
  version: "1.0"
  count: 2
---

Use this skill for PDF work.
`;
const parsedFull = parseSkillMd(full);
assert.equal(parsedFull.ok, true);
if (parsedFull.ok) {
  const validation = validateFrontmatter(parsedFull.frontmatter);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
  assert.deepEqual(validation.normalized, {
    name: 'pdf-processing',
    description: 'Extract PDF text, fill forms, and merge files.',
    license: 'Apache-2.0',
    compatibility: 'Requires Python 3.14+ and uv',
    allowedTools: 'Bash(git:*) Bash(jq:*) Read',
    metadata: { author: 'example-org', version: '1.0', count: '2' },
  });
  assert.deepEqual(normalizeMetadata({ count: 2 }), { count: '2' });
}

const invalidNameCases = [
  ['PDF-Processing', 'name must be lowercase'],
  ['-pdf', 'name must not start or end with a hyphen'],
  ['pdf--processing', 'name must not contain consecutive hyphens'],
] as const;
for (const [name, expectedError] of invalidNameCases) {
  const result = validateFrontmatter({ name, description: 'A valid description.' });
  assert.ok(result.errors.includes(expectedError));
}
assert.deepEqual(
  validateFrontmatter({ name: 'café-notes', description: 'A valid description.' }).errors,
  [],
);

assert.ok(validateFrontmatter({ name: 'valid-name' }).errors.includes('description is required'));
assert.ok(
  validateFrontmatter({ name: 'valid-name', description: 'x'.repeat(1025) }).errors.some((error) =>
    error.includes('description must be 1024 characters or fewer'),
  ),
);
assert.deepEqual(
  validateFrontmatter({ name: 'valid-name', description: 'x'.repeat(1024) }).errors,
  [],
);

const unknown = validateFrontmatter({
  name: 'valid-name',
  description: 'A valid description.',
  version: '1.0',
});
assert.ok(unknown.errors.includes('Unexpected field(s) in frontmatter: version'));

const lenient = parseSkillMd(`---
name: url-skill
description: Explain: this value contains an unquoted colon
---

Body
`);
assert.equal(lenient.ok, true);
if (lenient.ok) {
  assert.equal(lenient.frontmatter.description, 'Explain: this value contains an unquoted colon');
}

const unparseable = parseSkillMd(`---
name: broken-skill
description: [unbalanced
---

Body
`);
assert.equal(unparseable.ok, false);
if (!unparseable.ok) assert.notEqual(unparseable.error, '');

const mismatch = validateFrontmatter(
  { name: 'valid-name', description: 'A valid description.' },
  { expectedDirectoryName: 'other-name' },
);
assert.deepEqual(mismatch.errors, []);
assert.ok(mismatch.warnings.includes("Skill name 'valid-name' does not match its folder name 'other-name'"));

const normalized = {
  name: 'research-skill',
  description: 'Research useful information.',
  license: 'MIT',
  compatibility: 'Requires a browser.',
  allowedTools: 'Read Search',
  metadata: { owner: 'team', count: '2' },
};
const roundTrip = parseSkillMd(serializeSkillMd(normalized, '  Instructions here.  '));
assert.equal(roundTrip.ok, true);
if (roundTrip.ok) {
  const roundTripValidation = validateFrontmatter(roundTrip.frontmatter);
  assert.deepEqual(roundTripValidation.errors, []);
  assert.deepEqual(roundTripValidation.normalized, normalized);
  assert.equal(roundTrip.body, 'Instructions here.');
}

assert.equal(checkBodySizeWarning('short body'), null);
assert.notEqual(checkBodySizeWarning(Array.from({ length: 501 }, () => 'line').join('\n')), null);
assert.equal(normalizeSkillName('Ｃａｆé-Skill'), 'café-skill');

assert.equal(parseSkillMd('name: missing delimiters').ok, false);
assert.equal(parseSkillMd('---\nname: missing closing').ok, false);

console.log('skill parser and validator: OK');
