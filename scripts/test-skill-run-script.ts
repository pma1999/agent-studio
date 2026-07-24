import assert from 'node:assert/strict';
import {
  buildSkillScriptCommand,
  isValidSkillScriptPath,
  resolveScriptInterpreter,
  resolveScriptShellQuoting,
  shellQuoteArg,
} from '../server/skills/activation.js';

// 1. Interpreter selection is explicit and platform/shell-aware.
assert.equal(resolveScriptInterpreter('.py', 'linux', 'bash'), 'python3');
assert.equal(resolveScriptInterpreter('.py', 'win32', 'pwsh'), 'python');
assert.equal(resolveScriptInterpreter('.sh', 'linux', 'bash'), 'bash');
assert.equal(resolveScriptInterpreter('.js', 'linux', 'bash'), 'node');
assert.equal(resolveScriptInterpreter('.ts', 'linux', 'bash'), 'npx tsx');
assert.equal(resolveScriptInterpreter('.rb', 'linux', 'bash'), 'ruby');
assert.equal(resolveScriptInterpreter('.ps1', 'windows', 'pwsh'), 'pwsh -File');
assert.equal(resolveScriptInterpreter('.ps1', 'windows', 'powershell'), 'powershell -File');
assert.equal(resolveScriptInterpreter('.exe', 'linux', 'bash'), null);

// 2. Only the skill scripts/ subtree is eligible for execution.
assert.equal(isValidSkillScriptPath('scripts/run.py'), true);
assert.equal(isValidSkillScriptPath('references/run.py'), false);
assert.equal(isValidSkillScriptPath('run.py'), false);

// 3. POSIX arguments are individually double-quoted and special characters escaped.
assert.equal(shellQuoteArg('a "quoted" $VAR \\ path'), '"a \\"quoted\\" \\$VAR \\\\ path"');

// 4. PowerShell uses single-quoted literals; apostrophes are doubled and the
// adversarial cmd metacharacters stay inside one literal.
const adversarialArgument = 'x" & <command> & rem "';
assert.equal(resolveScriptShellQuoting('bash'), 'posix');
assert.equal(resolveScriptShellQuoting('sh'), 'posix');
assert.equal(resolveScriptShellQuoting('pwsh'), 'powershell');
assert.equal(resolveScriptShellQuoting('powershell'), 'powershell');
assert.equal(resolveScriptShellQuoting('cmd'), null);
assert.equal(resolveScriptShellQuoting('unknown-shell'), null);
assert.equal(shellQuoteArg(adversarialArgument, 'bash'), '"x\\" & <command> & rem \\""');
assert.equal(shellQuoteArg(adversarialArgument, 'sh'), '"x\\" & <command> & rem \\""');
assert.equal(shellQuoteArg(adversarialArgument, 'pwsh'), "'x\" & <command> & rem \"'");
assert.equal(shellQuoteArg(adversarialArgument, 'powershell'), "'x\" & <command> & rem \"'");
assert.equal(shellQuoteArg("x' & <command>", 'powershell'), "'x'' & <command>'");
assert.throws(
  () => shellQuoteArg(adversarialArgument, 'cmd'),
  /run_skill_script is not supported when the connected local agent's shell is cmd/,
);
assert.throws(
  () => shellQuoteArg('x%PATH% ^ &', 'cmd'),
  /run_skill_script is not supported when the connected local agent's shell is cmd/,
);

// 5. The script basename uses the same quoting boundary as arguments.
assert.equal(
  buildSkillScriptCommand('python3', 'scripts/a "quoted" $VAR `tick` file.py', ['arg']),
  'python3 "a \\"quoted\\" \\$VAR \\`tick\\` file.py" "arg"',
);
assert.throws(
  () => buildSkillScriptCommand('python', 'scripts/run.py', [adversarialArgument], 'cmd'),
  /run_skill_script is not supported when the connected local agent's shell is cmd/,
);

console.log('skill script pure functions: OK');
