import assert from 'node:assert/strict';
import {
  buildRunSkillScriptTool,
  buildSkillScriptCommand,
  isValidSkillScriptPath,
  resolveScriptInterpreter,
  resolveScriptShellQuoting,
  shellQuoteArg,
} from '../server/skills/activation.js';
import {
  registerAgentConnection,
  unregisterAgentConnection,
  type AgentConnection,
} from '../server/agentRelay/registry.js';
import type {
  AgentToBackendMessage,
  BackendToAgentMessage,
} from '../server/agentRelay/protocol.js';
import type { ResolvedSkill } from '../server/skills/resolve.js';

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

// 6. The `stdin` parameter is advertised only to an agent that declares it can
// deliver it. Offering it to an older agent would be worse than withholding it:
// the agent drops the field, the script blocks on a stdin that never closes,
// and it dies at the timeout with nothing in the output explaining why.
{
  class FakeConnection implements AgentConnection {
    private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
    private connected = true;
    onClosed: (() => void) | undefined;
    isConnected() { return this.connected; }
    send(_message: BackendToAgentMessage) { /* not exercised here */ }
    onMessage(callback: (message: AgentToBackendMessage) => void) { this.callbacks.push(callback); }
    close() {
      if (!this.connected) return;
      this.connected = false;
      this.onClosed?.();
    }
    getIdentity() { return { platform: 'win32', shell: { kind: 'pwsh', execPath: 'pwsh.exe' } }; }
    receive(message: AgentToBackendMessage) {
      for (const callback of this.callbacks) callback(message);
    }
  }

  const skills = [{ name: 'zotero-intake', description: 'd' }] as unknown as ResolvedSkill[];

  const properties = (userId: string) => {
    const tool = buildRunSkillScriptTool(skills, userId);
    assert.ok(tool, 'a connected agent must yield a run_skill_script tool');
    return tool.openAIDef.function.parameters.properties as Record<string, unknown>;
  };

  const hello = (capabilities?: string[]): AgentToBackendMessage => ({
    type: 'hello',
    agentVersion: 'test',
    deviceName: 'test device',
    platform: 'win32',
    ...(capabilities ? { capabilities } : {}),
  });

  // An agent that declares the capability gets the parameter.
  const modern = new FakeConnection();
  modern.onClosed = () => unregisterAgentConnection('user-modern', modern);
  registerAgentConnection('user-modern', modern);
  modern.receive(hello(['llamacpp', 'command-stdin']));
  assert.ok(properties('user-modern').stdin, 'an agent declaring command-stdin must be offered stdin');

  // One that connects without declaring it does not — and neither does one that
  // sends no capabilities at all, which is how every agent paired before the
  // capability existed presents itself.
  for (const [userId, capabilities] of [
    ['user-old-caps', ['llamacpp']],
    ['user-no-caps', undefined],
  ] as const) {
    const legacy = new FakeConnection();
    legacy.onClosed = () => unregisterAgentConnection(userId, legacy);
    registerAgentConnection(userId, legacy);
    legacy.receive(hello(capabilities as string[] | undefined));
    const props = properties(userId);
    assert.equal(props.stdin, undefined, `${userId} must not be offered stdin`);
    // The rest of the tool is unaffected: only the one property is gated.
    assert.ok(props.name && props.script_path && props.args && props.timeout_seconds);
    legacy.close();
  }

  modern.close();
  console.log('run_skill_script stdin capability gate: OK');
}

console.log('skill script pure functions: OK');
