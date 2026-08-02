/**
 * End-to-end integration test for the MCP 'relay' transport.
 *
 * The backend never spawns relay-hosted MCP servers itself: it asks the user's
 * paired local agent (simulated here by FakeRelayConnection) to spawn the
 * server as a stdio child and bridges newline-delimited JSON-RPC between the
 * relay and the child. This test drives that loop with a REAL stdio MCP server
 * fixture (scripts/fixtures/mcp-echo-server.cjs) and a REAL
 * @modelcontextprotocol/sdk Client on the backend side.
 *
 * Covers: offline gating, full round trip (list + call), session pooling
 * (refcount releases), teardown (stop request + respawn), disconnect cleanup
 * (disconnect hook + closeRelaySessionsForUser), resolveToolsFromIds gating
 * and presence, and the mcp_exited path (remote child dies mid-call).
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDbPath = path.join(os.tmpdir(), `mcp-relay-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = testDbPath;

const { default: db, migrate } = await import('../server/db.js');
const { registerAgentConnection, unregisterAgentConnection } = await import('../server/agentRelay/registry.js');
const {
  closeRelaySessionsForUser,
  getOrCreateRelaySession,
  teardownRelaySession,
} = await import('../server/mcp/relaySessions.js');
const { callMcpToolDetailed, listMcpTools } = await import('../server/mcp/client.js');
const { resolveToolsFromIds } = await import('../server/tools/resolve.js');

type AgentToBackendMessage = import('../server/agentRelay/protocol.js').AgentToBackendMessage;
type BackendToAgentMessage = import('../server/agentRelay/protocol.js').BackendToAgentMessage;
type AgentConnection = import('../server/agentRelay/registry.js').AgentConnection;
type McpConfigStdio = import('../server/mcp/types.js').McpConfigStdio;

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'mcp-echo-server.cjs',
);
const RELAY_CONFIG: McpConfigStdio = { command: process.execPath, args: [FIXTURE_PATH] };

/**
 * Simulates the LOCAL AGENT side of the relay: when it receives an
 * mcp_start_request it spawns the configured command as a real stdio child and
 * bridges JSON-RPC in both directions:
 *   - mcp_message (backend -> child): JSON.stringify(payload) + '\n' on stdin
 *   - child stdout line -> mcp_message (child -> backend)
 *   - mcp_stop_request -> SIGTERM the child -> mcp_stop_response
 *   - child exit -> mcp_exited
 */
class FakeRelayConnection implements AgentConnection {
  readonly sent: BackendToAgentMessage[] = [];
  private callbacks: Array<(message: AgentToBackendMessage) => void> = [];
  private connected = true;
  private readonly channels = new Map<string, { child: ChildProcess; buffer: string; stopped: boolean }>();
  onClosed: (() => void) | undefined;

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(callback: (message: AgentToBackendMessage) => void): void {
    this.callbacks.push(callback);
  }

  receive(message: AgentToBackendMessage): void {
    for (const callback of this.callbacks) callback(message);
  }

  send(message: BackendToAgentMessage): void {
    this.sent.push(message);
    if (message.type === 'mcp_start_request') {
      void this.startChild(message);
    } else if (message.type === 'mcp_stop_request') {
      this.stopChild(message);
    } else if (message.type === 'mcp_message') {
      const channel = this.channels.get(message.channelId);
      if (channel && !channel.child.killed && channel.child.stdin?.writable) {
        channel.child.stdin.write(`${JSON.stringify(message.payload)}\n`);
      }
    }
  }

  close(): void {
    if (!this.connected) return;
    this.connected = false;
    this.onClosed?.();
  }

  /** Kill every still-running child (test cleanup). */
  killAll(): void {
    for (const { child } of this.channels.values()) {
      child.kill('SIGKILL');
    }
    this.channels.clear();
  }

  private async startChild(
    message: Extract<BackendToAgentMessage, { type: 'mcp_start_request' }>,
  ): Promise<void> {
    const { requestId, channelId, config } = message;
    let child: ChildProcess;
    try {
      child = spawn(config.command, config.args ?? [], {
        env: { ...process.env, ...(config.env ?? {}) },
        cwd: config.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.receive({
        type: 'mcp_start_response',
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const channel = { child, buffer: '', stopped: false };
    this.channels.set(channelId, channel);
    child.stderr?.on('data', () => {
      // The fixture may log errors to stderr; the relay ignores that stream.
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      channel.buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = channel.buffer.indexOf('\n')) !== -1) {
        const line = channel.buffer.slice(0, newlineIndex).trim();
        channel.buffer = channel.buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          this.receive({ type: 'mcp_message', channelId, payload: JSON.parse(line) });
        } catch (error) {
          console.error('[relay-bridge] failed to parse child JSON-RPC line:', line, error);
        }
      }
    });
    child.on('error', (error) => {
      if (this.channels.get(channelId) === channel) this.channels.delete(channelId);
      this.receive({ type: 'mcp_start_response', requestId, ok: false, error: error.message });
    });
    child.on('exit', (exitCode) => {
      if (this.channels.get(channelId) === channel) this.channels.delete(channelId);
      // A deliberate stop (mcp_stop_request) suppresses the exit notification:
      // the backend already tore the session down, and a later stale mcp_exited
      // for the same channelId would kill a respawned session.
      if (!channel.stopped) {
        this.receive({ type: 'mcp_exited', channelId, exitCode });
      }
    });
    // Respond before the child's event loop starts: the OS pipe buffers
    // anything the backend sends while the child boots.
    this.receive({ type: 'mcp_start_response', requestId, ok: true });
  }

  private stopChild(
    message: Extract<BackendToAgentMessage, { type: 'mcp_stop_request' }>,
  ): void {
    const channel = this.channels.get(message.channelId);
    if (channel) {
      this.channels.delete(message.channelId);
      channel.stopped = true;
      channel.child.kill('SIGTERM');
    }
    this.receive({ type: 'mcp_stop_response', requestId: message.requestId, ok: true });
  }
}

/** Registered fake connections, tracked for final cleanup. */
const bridges: Array<{ userId: string; bridge: FakeRelayConnection }> = [];

function connect(userId: string): FakeRelayConnection {
  const bridge = new FakeRelayConnection();
  bridge.onClosed = () => unregisterAgentConnection(userId, bridge);
  bridges.push({ userId, bridge });
  registerAgentConnection(userId, bridge);
  return bridge;
}

function insertRelayServer(userId: string, serverId: string, config: McpConfigStdio = RELAY_CONFIG): void {
  db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .run(userId, `${userId}@example.com`, 'test');
  db.prepare('INSERT INTO mcp_servers (id, user_id, name, transport, config) VALUES (?, ?, ?, ?, ?)')
    .run(serverId, userId, `relay-${serverId}`, 'relay', JSON.stringify(config));
}

let checks = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    checks += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}`);
    throw error;
  }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    checks += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}`);
    throw error;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

async function main(): Promise<void> {
  migrate();

  // 1. Gating offline: no agent registered -> start rejected, no mcp tools.
  {
    const userId = 'mcp-relay-offline';
    const serverId = 'mcp-relay-offline-server';
    insertRelayServer(userId, serverId);

    await checkAsync('offline: getOrCreateRelaySession rejects with "local agent is not connected"', async () => {
      await assert.rejects(getOrCreateRelaySession(userId, serverId, RELAY_CONFIG), /local agent is not connected/);
    });

    await checkAsync('offline: resolveToolsFromIds returns no mcp tools', async () => {
      const result = await resolveToolsFromIds([], [serverId], userId);
      assert.equal(result.resolvedTools.length, 0);
      assert.equal(result.mcpClients.size, 0);
    });
  }

  // 2. Full round trip + session pooling (refcount releases do not kill it).
  {
    const userId = 'mcp-relay-roundtrip';
    const serverId = 'mcp-relay-roundtrip-server';
    insertRelayServer(userId, serverId);
    const bridge = connect(userId);

    const connection = await getOrCreateRelaySession(userId, serverId, RELAY_CONFIG);
    const tools = await listMcpTools(connection.client, 'test_');
    check('roundtrip: listMcpTools exposes the echo tool', () => {
      assert.ok(tools.some((tool) => tool.mcpToolName === 'echo'));
    });

    const result = await callMcpToolDetailed(connection.client, 'echo', { text: 'hola' });
    check('roundtrip: callMcpToolDetailed returns echo:hola', () => {
      assert.match(result.output, /echo:hola/);
    });

    const second = await getOrCreateRelaySession(userId, serverId, RELAY_CONFIG);
    check('roundtrip: second acquire returns the SAME pooled client', () => {
      assert.equal(second.client, connection.client);
    });
    await connection.close();
    await second.close();
    check('roundtrip: releases do not kill the pooled session', () => {
      const startRequests = bridge.sent.filter((message) => message.type === 'mcp_start_request');
      assert.equal(startRequests.length, 1, 'only one child should ever have been spawned');
    });

    const third = await getOrCreateRelaySession(userId, serverId, RELAY_CONFIG);
    const again = await callMcpToolDetailed(third.client, 'echo', { text: 'again' });
    check('roundtrip: session still serves calls after both releases', () => {
      assert.match(again.output, /echo:again/);
    });
    await third.close();
  }

  // 3. Teardown stops the child; the next acquire spawns a fresh one.
  {
    const userId = 'mcp-relay-teardown';
    const serverId = 'mcp-relay-teardown-server';
    insertRelayServer(userId, serverId);
    const bridge = connect(userId);

    const connection = await getOrCreateRelaySession(userId, serverId, RELAY_CONFIG);
    const pre = await callMcpToolDetailed(connection.client, 'echo', { text: 'pre' });
    assert.match(pre.output, /echo:pre/);
    await connection.close();

    await teardownRelaySession(userId, serverId);
    await waitFor(
      () => bridge.sent.some((message) => message.type === 'mcp_stop_request' && message.channelId === serverId),
      2_000,
      'mcp_stop_request to reach the local agent',
    );
    check('teardown: mcp_stop_request was sent to the local agent', () => {
      assert.ok(bridge.sent.some((message) => message.type === 'mcp_stop_request' && message.channelId === serverId));
    });

    const respawned = await getOrCreateRelaySession(userId, serverId, RELAY_CONFIG);
    const post = await callMcpToolDetailed(respawned.client, 'echo', { text: 'post' });
    check('teardown: fresh acquire spawns a NEW child that works', () => {
      assert.match(post.output, /echo:post/);
      const startRequests = bridge.sent.filter((message) => message.type === 'mcp_start_request');
      assert.equal(startRequests.length, 2, 'a second child should have been spawned');
    });
    await respawned.close();
  }

  // 4a. Disconnect cleanup: unregistering the agent tears the session down
  //     via the disconnect hook (closeRelaySessionsForUser).
  {
    const userId = 'mcp-relay-disconnect';
    const serverId = 'mcp-relay-disconnect-server';
    insertRelayServer(userId, serverId);
    const bridge = connect(userId);

    const connection = await getOrCreateRelaySession(userId, serverId, RELAY_CONFIG);
    const pre = await callMcpToolDetailed(connection.client, 'echo', { text: 'hi' });
    assert.match(pre.output, /echo:hi/);
    await connection.close();

    unregisterAgentConnection(userId, bridge);

    let rejected = false;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        const pooled = await getOrCreateRelaySession(userId, serverId, RELAY_CONFIG);
        await pooled.close();
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch (error) {
        assert.match(String(error instanceof Error ? error.message : error), /local agent is not connected/);
        rejected = true;
        break;
      }
    }
    check('disconnect: session is torn down and further acquires reject', () => {
      assert.ok(rejected, 'getOrCreateRelaySession should reject once the agent disconnects');
    });

    await checkAsync('disconnect: teardownRelaySession on the gone session is a no-op', async () => {
      await teardownRelaySession(userId, serverId); // must resolve, not throw
    });
  }

  // 4b. closeRelaySessionsForUser sends mcp_stop_request and allows respawn.
  {
    const userId = 'mcp-relay-closeforuser';
    const serverId = 'mcp-relay-closeforuser-server';
    insertRelayServer(userId, serverId);
    const bridge = connect(userId);

    const connection = await getOrCreateRelaySession(userId, serverId, RELAY_CONFIG);
    await callMcpToolDetailed(connection.client, 'echo', { text: 'bye' });
    await closeRelaySessionsForUser(userId);
    await waitFor(
      () => bridge.sent.some((message) => message.type === 'mcp_stop_request' && message.channelId === serverId),
      2_000,
      'mcp_stop_request after closeRelaySessionsForUser',
    );
    check('closeRelaySessionsForUser: mcp_stop_request reached the local agent', () => {
      assert.ok(bridge.sent.some((message) => message.type === 'mcp_stop_request' && message.channelId === serverId));
    });

    // The agent is still connected here, so a fresh acquire respawns.
    const fresh = await getOrCreateRelaySession(userId, serverId, RELAY_CONFIG);
    const respawn = await callMcpToolDetailed(fresh.client, 'echo', { text: 'respawn' });
    check('closeRelaySessionsForUser: next acquire spawns a working child', () => {
      assert.match(respawn.output, /echo:respawn/);
    });
    await fresh.close();
    unregisterAgentConnection(userId, bridge);
  }

  // 5. resolveToolsFromIds gating + presence.
  {
    const userId = 'mcp-relay-resolve';
    const serverId = 'mcp-relay-resolve-server';
    insertRelayServer(userId, serverId);

    const offline = await resolveToolsFromIds([], [serverId], userId);
    check('resolve: no mcp tools while the agent is disconnected', () => {
      assert.equal(offline.resolvedTools.length, 0);
    });

    const bridge = connect(userId);
    const online = await resolveToolsFromIds([], [serverId], userId);
    check('resolve: echo tool present while the agent is connected', () => {
      const mcpTools = online.resolvedTools.filter((tool) => tool.type === 'mcp');
      assert.ok(mcpTools.length > 0, 'expected at least one mcp tool');
      assert.ok(
        mcpTools.some((tool) => (tool.config as { mcp_tool_name?: string }).mcp_tool_name === 'echo'),
        'expected the echo tool to be resolved',
      );
    });
    for (const connection of online.mcpClients.values()) {
      await connection.close();
    }

    unregisterAgentConnection(userId, bridge);
    const offlineAgain = await resolveToolsFromIds([], [serverId], userId);
    check('resolve: tools hidden again after the agent disconnects', () => {
      assert.equal(offlineAgain.resolvedTools.length, 0);
    });
  }

  // 6. mcp_exited: the remote child dies while a call is in flight.
  {
    const userId = 'mcp-relay-exited';
    const serverId = 'mcp-relay-exited-server';
    const exitConfig: McpConfigStdio = {
      ...RELAY_CONFIG,
      env: { MCP_ECHO_SLOW_MS: '3000', MCP_ECHO_EXIT_AFTER_MS: '800' },
    };
    insertRelayServer(userId, serverId, exitConfig);
    const bridge = connect(userId);

    const connection = await getOrCreateRelaySession(userId, serverId, exitConfig);
    const tools = await listMcpTools(connection.client, 'exit_');
    assert.ok(tools.some((tool) => tool.mcpToolName === 'echo'));

    const startedAt = Date.now();
    await checkAsync('exited: in-flight call rejects when the remote child dies', async () => {
      await assert.rejects(
        callMcpToolDetailed(connection.client, 'echo', { text: 'doomed' }, 5_000),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return /disconnected|Connection closed/i.test(message);
        },
      );
      assert.ok(Date.now() - startedAt < 5_000, 'the in-flight call must fail fast, not hang');
    });

    // The exit path tears the dead session down itself: poll until the next
    // acquire spawns a brand-new child (pool must no longer hold the dead one).
    await waitForRespawn(bridge, userId, serverId, exitConfig);
    check('exited: dead session was removed from the pool (next acquire respawns)', () => {
      assert.ok(true);
    });
    unregisterAgentConnection(userId, bridge);
  }
}

async function waitForRespawn(
  bridge: FakeRelayConnection,
  userId: string,
  serverId: string,
  config: McpConfigStdio,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const before = bridge.sent.filter((message) => message.type === 'mcp_start_request').length;
    const connection = await getOrCreateRelaySession(userId, serverId, config);
    const after = bridge.sent.filter((message) => message.type === 'mcp_start_request').length;
    await connection.close();
    if (after === before + 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('expected the next acquire to spawn a fresh child after the remote exit');
}

main().then(
  // Cleanup after main() resolves: stop every child, unregister every fake
  // connection (which triggers the disconnect hook -> session teardown), and
  // remove the temp database.
  async () => {
    for (const { bridge } of bridges) bridge.killAll();
    for (const { userId, bridge } of bridges) unregisterAgentConnection(userId, bridge);
    await new Promise((resolve) => setTimeout(resolve, 50));
    db.close();
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${testDbPath}${suffix}`); } catch { /* already absent */ }
    }
    console.log(`mcp relay integration tests passed (${checks} checks)`);
    process.exit(0);
  },
  (error) => {
    console.error('mcp relay integration tests failed:', error);
    for (const { bridge } of bridges) {
      try { bridge.killAll(); } catch { /* best effort */ }
    }
    process.exit(1);
  },
);
