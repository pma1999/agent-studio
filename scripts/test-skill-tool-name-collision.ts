import assert from 'node:assert/strict';
import { excludeReservedSkillToolNames } from '../server/routes/chat.js';
import { RESERVED_SKILL_TOOL_NAMES } from '../server/routes/tools.js';

// 1. The three names reserved for the Skills feature are exactly these, case-sensitive.
assert.deepEqual(RESERVED_SKILL_TOOL_NAMES, ['activate_skill', 'read_skill_resource', 'run_skill_script']);

// 2. No collision: base tools and skill tools are simply concatenated (skill tools last).
assert.deepEqual(
  excludeReservedSkillToolNames([{ name: 'web_search' }, { name: 'get_current_time' }], [{ name: 'activate_skill' }]),
  [{ name: 'web_search' }, { name: 'get_current_time' }, { name: 'activate_skill' }],
);

// 3. A stale/pre-existing user tool sharing a reserved name is dropped from the base list; the
//    skill tool (the reserved, canonical owner) is the only entry with that name in the result.
const collided = excludeReservedSkillToolNames(
  [{ name: 'run_skill_script', extra: 'user-http-tool' }, { name: 'unrelated_tool' }],
  [{ name: 'run_skill_script', extra: 'skill-tool' }],
);
assert.equal(collided.filter((t) => t.name === 'run_skill_script').length, 1);
assert.equal(collided.find((t) => t.name === 'run_skill_script')?.extra, 'skill-tool');
assert.deepEqual(collided.map((t) => t.name).sort(), ['run_skill_script', 'unrelated_tool'].sort());

// 4. No skill tools resolved (e.g. no skills assigned) -> base tools pass through untouched,
//    including one that happens to be named like a reserved skill-tool name (nothing to defend
//    against when no skill tool exists to collide with).
assert.deepEqual(
  excludeReservedSkillToolNames([{ name: 'activate_skill' }], []),
  [{ name: 'activate_skill' }],
);

// 5. Multiple simultaneous collisions are all resolved in favor of the skill tools.
const multiCollision = excludeReservedSkillToolNames(
  [
    { name: 'activate_skill', extra: 'user' },
    { name: 'read_skill_resource', extra: 'user' },
    { name: 'run_skill_script', extra: 'user' },
    { name: 'keeper', extra: 'user' },
  ],
  [
    { name: 'activate_skill', extra: 'skill' },
    { name: 'read_skill_resource', extra: 'skill' },
    { name: 'run_skill_script', extra: 'skill' },
  ],
);
assert.equal(multiCollision.length, 4);
for (const reserved of RESERVED_SKILL_TOOL_NAMES) {
  const matches = multiCollision.filter((t) => t.name === reserved);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].extra, 'skill');
}
assert.ok(multiCollision.some((t) => t.name === 'keeper' && t.extra === 'user'));

console.log('skill tool name collision defense: OK');
