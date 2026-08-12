import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

// A real 2026-07-28 server fixture. Only MCP JSON-RPC is written to stdout.
serveStdio(
  () => {
    const server = new McpServer({ name: 'test-modern', version: '2.0.0' });

    server.registerTool(
      'echo-value',
      {
        title: 'Structured echo',
        description: 'Returns a validated structured echo payload.',
        inputSchema: z.object({ value: z.string().min(1) }),
        outputSchema: z.object({ echoed: z.string() }),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async ({ value }) => ({
        content: [{ type: 'text', text: `echo:${value}` }],
        structuredContent: { echoed: value },
      }),
    );

    server.registerResource(
      'fixture-readme',
      'fixture://readme',
      { title: 'Fixture readme', mimeType: 'text/plain' },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'modern-resource' }],
      }),
    );

    server.registerPrompt(
      'summarize-topic',
      {
        title: 'Summarize a topic',
        description: 'Builds a small summarization prompt.',
        argsSchema: z.object({ topic: z.string().min(1) }),
      },
      ({ topic }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${topic}` } }],
      }),
    );

    return server;
  },
  {
    legacy: 'reject',
    onerror: (error) => console.error('[mcp-modern-fixture]', error.message),
  },
);
