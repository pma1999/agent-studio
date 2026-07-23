import assert from 'node:assert/strict';
import { scanCommand, isPathWithinRoot } from '../shared/commandSafety.js';

function expect(
  command: string,
  workspaceRoot: string | null,
  allowOutsideWorkspace: boolean,
  expectedTier: 0 | 1 | 2,
  expectedLabel?: string | string[]
) {
  const verdict = scanCommand(command, workspaceRoot, allowOutsideWorkspace);
  assert.equal(
    verdict.tier,
    expectedTier,
    `tier mismatch for ${JSON.stringify(command)}: got ${verdict.tier} (label=${verdict.label}), expected ${expectedTier}`
  );
  if (expectedLabel !== undefined) {
    const allowed = Array.isArray(expectedLabel) ? expectedLabel : [expectedLabel];
    assert.ok(
      allowed.includes(verdict.label ?? ''),
      `label mismatch for ${JSON.stringify(command)}: got ${verdict.label}, expected one of ${allowed.join(', ')}`
    );
  }
}

// Tier 0: no match
expect('echo hello', null, false, 0);

// Tier 1: hard blocks, never overridable
expect(':(){ :|:& };:', null, false, 1, 'fork-bomb');
expect('format C:', null, false, 1, 'disk-format');
expect('diskpart', null, false, 1, 'diskpart');
expect('format C:', null, true, 1, 'disk-format'); // allowOutsideWorkspace never downgrades tier 1

// Recursive delete inside workspace root -> tier 0
expect('rm -rf ./build', '/home/user/workspace', false, 0);

// Recursive delete clearly outside workspace root -> tier 2
expect('rm -rf /', '/home/user/workspace', false, 2, 'recursive-delete');

// Recursive delete outside workspace root, opt-out respected -> tier 0
expect('rm -rf /', '/home/user/workspace', true, 0);

// PowerShell recursive delete outside workspace root -> tier 2
// (either "recursive-delete" or "scope-broadening" is acceptable per the
// brief; this implementation checks recursive-delete patterns first, so it
// produces "recursive-delete".)
expect(
  'Remove-Item -Recurse -Force C:\\Users\\someone\\Documents',
  'C:\\Users\\someone\\AgentWorkspace',
  false,
  2,
  ['recursive-delete', 'scope-broadening']
);

// Force push -> tier 2, always (not workspace-scoped)
expect('git push --force origin main', null, false, 2, 'force-push');

// Shutdown -> tier 2, always (not workspace-scoped)
expect('shutdown /r /t 0', null, false, 2, 'power-control');

// isPathWithinRoot direct checks
assert.equal(isPathWithinRoot('./build', '/home/user/workspace'), true);
assert.equal(isPathWithinRoot('/', '/home/user/workspace'), false);
assert.equal(isPathWithinRoot('/home/user/workspace', '/home/user/workspace'), true);
assert.equal(isPathWithinRoot('/home/user/other', '/home/user/workspace'), false);

console.log('command safety scanCommand: OK');
