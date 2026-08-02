'use strict';

// Real stdio MCP server used by the relay integration test
// (scripts/test-mcp-relay.ts). The test's fake local agent spawns this file
// with plain `node` and bridges newline-delimited JSON-RPC between the relay
// and this process's stdin/stdout. Nothing but JSON-RPC may be written to
// stdout: the SDK transport owns that stream.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const server = new Server(
  { name: 'test-echo', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the provided text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  // Test hook: make the echo handler slow so an in-flight call can be
  // observed dying when the process exits (mcp_exited path).
  const slowMs = Number.parseInt(process.env.MCP_ECHO_SLOW_MS || '', 10);
  if (slowMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, slowMs));
  }
  return {
    content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }],
  };
});

// Test hook: exit on a timer so the test can observe a remote process
// disappearing while a call is still in flight.
const exitAfterMs = Number.parseInt(process.env.MCP_ECHO_EXIT_AFTER_MS || '', 10);
if (exitAfterMs > 0) {
  setTimeout(() => process.exit(0), exitAfterMs);
}

// The test's bridge kills this child with SIGTERM on mcp_stop_request; exit
// cleanly instead of leaving a dangling process.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[mcp-echo-server] fatal:', error);
  process.exit(1);
});
