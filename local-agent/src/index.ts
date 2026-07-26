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
import { createFileOpsExecutor, type FileOpsExecutor } from './fileOpsExecutor.js';
import { createSendFileExecutor, type SendFileExecutor } from './sendFileExecutor.js';
import { createReceiveFileExecutor, type ReceiveFileExecutor } from './receiveFileExecutor.js';
import { createShellDetector } from './shellDetection.js';

const AGENT_VERSION = '1.0.0';
const DEFAULT_BACKEND_URL = 'http://localhost:3001';
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const rl = createInterface({ input: process.stdin, output: process.stdout });

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** Strips the `[...]` bracket notation `new URL().hostname` uses for IPv6 literals. */
function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized);
}

/**
 * ARC-03: `transport.ts`'s `toWebSocketUrl` silently downgrades any
 * non-`https:` scheme to plaintext `ws:`. For the documented v1 topology
 * (pairing to the Railway-hosted, HTTPS backend) that never matters — but
 * nothing previously stopped a user from pointing this at a genuinely remote
 * `http://` host, which would send the pairing code, and the durable bearer
 * token this pairing exchange itself returns, in clear text. Loopback hosts
 * (a backend running on this same machine) are exempt: there is no network
 * hop for anything to intercept in that case.
 */
async function checkBackendTransportSecurity(backendUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(backendUrl);
  } catch {
    return; // an invalid URL will surface its own clear error later (fetch/connect)
  }
  if (parsed.protocol === 'https:') return; // upgrades to wss: in transport.ts — safe
  if (isLoopbackHostname(parsed.hostname)) return; // no network to intercept

  console.log('\n' + '='.repeat(70));
  console.log('SECURITY WARNING — PLAINTEXT CONNECTION TO A REMOTE HOST');
  console.log('='.repeat(70));
  console.log(
    `The backend URL you entered ("${backendUrl}") is not "https://", and its\n` +
      `host ("${parsed.hostname}") is not this machine (localhost/127.0.0.1/::1).\n` +
      `That means this agent would connect over plain, unencrypted "ws://" — the\n` +
      `pairing code, and then the long-lived bearer token this pairing exchange\n` +
      `is about to return (reused for every command this agent ever executes),\n` +
      `would be sent in clear text over the network. Anyone positioned to\n` +
      `observe that traffic (a shared network, a compromised router, etc.)\n` +
      `could capture that token and gain the same remote command-execution\n` +
      `access this agent has, until the pairing is explicitly revoked.\n`
  );
  console.log(
    `If this backend is only reachable over "http://" today, prefer serving it\n` +
      `over "https://" instead before pairing. Only continue over plaintext if\n` +
      `you understand and accept this risk (e.g. a private network you\n` +
      `personally control end-to-end).\n`
  );
  console.log('='.repeat(70));
  const ack = (await rl.question('Type "yes, plaintext" to accept this risk and continue, or anything else to cancel: '))
    .trim()
    .toLowerCase();
  if (ack !== 'yes, plaintext') {
    console.log('\nPairing cancelled — plaintext-transport warning was not accepted. No token was saved.');
    process.exit(1);
  }
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
  await checkBackendTransportSecurity(backendUrl);

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
  fileOpsExecutor: FileOpsExecutor,
  sendFileExecutor: SendFileExecutor,
  receiveFileExecutor: ReceiveFileExecutor,
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
    case 'read_file_request':
      void fileOpsExecutor.handleReadFileRequest(message);
      break;
    case 'write_file_request':
      void fileOpsExecutor.handleWriteFileRequest(message);
      break;
    case 'edit_file_request':
      void fileOpsExecutor.handleEditFileRequest(message);
      break;
    case 'delete_file_request':
      void fileOpsExecutor.handleDeleteFileRequest(message);
      break;
    case 'list_directory_request':
      void fileOpsExecutor.handleListDirectoryRequest(message);
      break;
    case 'send_file_request':
      void sendFileExecutor.handleSendFileRequest(message);
      break;
    case 'receive_file_request':
      void receiveFileExecutor.handleReceiveFileRequest(message);
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

  // Detected once, here, at startup — cached for the process lifetime and
  // reused across every reconnect attempt below (never re-detected per
  // connection, and never re-probed per command: `createShellDetector()`'s
  // returned function memoizes its own result).
  const detectShell = createShellDetector();
  const shell = detectShell();
  console.log(`[local-agent] detected shell: ${shell.kind} (${shell.execPath})`);

  let transportHandle: AgentTransportHandle | undefined;
  const executor = createCommandExecutor({
    workspaceRoot: config.workspaceRoot,
    allowOutsideWorkspace: config.allowOutsideWorkspace,
    confirmTier2,
    shell,
    send: (message) => transportHandle?.send(message),
  });
  // Reuses the SAME confirmTier2 instance passed to createCommandExecutor
  // above — never a second confirmer.
  const fileOpsExecutor = createFileOpsExecutor({
    workspaceRoot: config.workspaceRoot,
    allowOutsideWorkspace: config.allowOutsideWorkspace,
    confirmTier2,
    send: (message) => transportHandle?.send(message),
  });
  const sendFileExecutor = createSendFileExecutor({
    workspaceRoot: config.workspaceRoot,
    allowOutsideWorkspace: config.allowOutsideWorkspace,
    backendUrl: config.backendUrl,
    token: config.token,
    send: (message) => transportHandle?.send(message),
  });
  const receiveFileExecutor = createReceiveFileExecutor({
    workspaceRoot: config.workspaceRoot,
    backendUrl: config.backendUrl,
    token: config.token,
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
        platform: process.platform,
        shell,
        onMessage: (message) => {
          dispatch(message, executor, fileOpsExecutor, sendFileExecutor, receiveFileExecutor, () => {
            backoffMs = INITIAL_BACKOFF_MS;
          });
        },
        onClose: (reason) => {
          console.log(`[local-agent] disconnected: ${reason}`);
          transportHandle = undefined;
          // ARC-04: the backend has already given up on every pending
          // request tied to this now-dead connection (rejected on its own
          // side in registry.ts); don't let the matching child processes
          // keep running locally with nothing left to report back to.
          executor.handleDisconnect();
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
