/**
 * CLI entry point: loads (or creates, via first-run pairing) the local
 * config, then maintains a persistent connection to the backend, reconnecting
 * with exponential backoff on drop.
 */

import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, saveConfig, getConfigPath, type LocalAgentConfig } from './config.js';
import { connectAgent, type AgentTransportHandle, type BackendToAgentMessage } from './transport.js';
import { createCommandExecutor, createConsoleConfirmer, type CommandExecutor } from './commandExecutor.js';

const AGENT_VERSION = '1.0.0';
const DEFAULT_BACKEND_URL = 'http://localhost:3001';
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const rl = createInterface({ input: process.stdin, output: process.stdout });

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printSecurityWarning(workspaceRoot: string): void {
  console.log('\n' + '='.repeat(70));
  console.log('SECURITY WARNING — READ BEFORE CONTINUING');
  console.log('='.repeat(70));
  console.log(
    `This local agent lets Agent Studio run commands on THIS computer, using\n` +
      `the same permissions as the Windows account you are logged in as right\n` +
      `now (${os.userInfo().username}). Anything this account can read, write,\n` +
      `or delete, this agent can also read, write, or delete when it runs a\n` +
      `command — there is no additional sandbox underneath it.\n`
  );
  console.log(
    `By default, commands run inside this workspace folder:\n` +
      `  ${workspaceRoot}\n` +
      `That folder is a convenience default, NOT a security boundary: a\n` +
      `command can still act outside it (an absolute path, "cd ..", a tool\n` +
      `that writes elsewhere) unless it happens to be caught by the local\n` +
      `blocklist, which only requires your console confirmation for a small\n` +
      `set of recognizably destructive commands (recursive delete outside the\n` +
      `folder, force-push, registry deletes, shutdown/restart) — everything\n` +
      `else runs immediately, without asking.\n`
  );
  console.log(
    `Only continue if you trust the Agent Studio account you are pairing\n` +
      `with, and are comfortable with it running commands as you, on this\n` +
      `machine.\n`
  );
  console.log('='.repeat(70));
}

async function runPairingFlow(): Promise<LocalAgentConfig> {
  console.log('No local configuration found — starting first-time pairing.\n');

  const backendUrlInput = (await rl.question(`Backend URL [${DEFAULT_BACKEND_URL}]: `)).trim();
  const backendUrl = backendUrlInput || DEFAULT_BACKEND_URL;

  const workspaceInput = (await rl.question(`Workspace root directory [${process.cwd()}]: `)).trim();
  const workspaceRoot = path.resolve(workspaceInput || process.cwd());

  const deviceNameInput = (await rl.question(`Device name [${os.hostname()}]: `)).trim();
  const deviceName = deviceNameInput || os.hostname();

  console.log(
    '\nGet a pairing code from Agent Studio in your browser: open Settings ->\n' +
      'Local Agent and click "Pair a new device" to generate an 8-character code.\n'
  );
  const pairingCode = (await rl.question('Pairing code: ')).trim().toUpperCase();

  printSecurityWarning(workspaceRoot);
  const ack = (await rl.question('Type "yes" to accept and continue, or anything else to cancel: ')).trim().toLowerCase();
  if (ack !== 'yes') {
    console.log('\nPairing cancelled — warning was not accepted. No token was saved.');
    process.exit(1);
  }

  const pairUrl = new URL('/api/agent/pair', backendUrl);
  const response = await fetch(pairUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: pairingCode, device_name: deviceName }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Pairing failed (HTTP ${response.status}): ${body}`);
  }
  const { agent_id: agentId, token } = (await response.json()) as { agent_id: string; token: string };

  const config: LocalAgentConfig = {
    backendUrl,
    token,
    agentId,
    workspaceRoot,
    allowOutsideWorkspace: false,
  };
  saveConfig(config);
  console.log(`\nPaired successfully. Config saved to ${getConfigPath()}\n`);
  return config;
}

function dispatch(
  message: BackendToAgentMessage,
  executor: CommandExecutor,
  onHelloAck: (agentId: string) => void
): void {
  switch (message.type) {
    case 'hello_ack':
      console.log(`[local-agent] connected (agentId=${message.agentId})`);
      onHelloAck(message.agentId);
      break;
    case 'heartbeat_ack':
      break;
    case 'command_request':
      void executor.handleCommandRequest(message);
      break;
    case 'command_cancel':
      executor.handleCommandCancel(message.requestId);
      break;
  }
}

async function main(): Promise<void> {
  let config = loadConfig();
  if (!config) {
    config = await runPairingFlow();
  } else {
    console.log(`[local-agent] loaded config from ${getConfigPath()}`);
  }

  const confirmTier2 = createConsoleConfirmer(rl);

  let transportHandle: AgentTransportHandle | undefined;
  const executor = createCommandExecutor({
    workspaceRoot: config.workspaceRoot,
    allowOutsideWorkspace: config.allowOutsideWorkspace,
    confirmTier2,
    send: (message) => transportHandle?.send(message),
  });

  let backoffMs = INITIAL_BACKOFF_MS;
  console.log(`[local-agent] connecting to ${config.backendUrl} ...`);
  for (;;) {
    await new Promise<void>((resolve) => {
      transportHandle = connectAgent({
        backendUrl: config.backendUrl,
        token: config.token,
        agentVersion: AGENT_VERSION,
        deviceName: os.hostname(),
        onMessage: (message) => {
          dispatch(message, executor, () => {
            backoffMs = INITIAL_BACKOFF_MS;
          });
        },
        onClose: (reason) => {
          console.log(`[local-agent] disconnected: ${reason}`);
          transportHandle = undefined;
          resolve();
        },
      });
    });
    console.log(`[local-agent] reconnecting in ${Math.round(backoffMs / 1000)}s...`);
    await delay(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

process.on('SIGINT', () => {
  console.log('\n[local-agent] shutting down.');
  rl.close();
  process.exit(0);
});

main().catch((error) => {
  console.error('[local-agent] fatal error:', error);
  process.exit(1);
});
