import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

// Deliberately exceed a typical OS pipe buffer before MCP starts. A client
// that requests stderr:'pipe' without consuming it deadlocks here.
const secret = process.env.HARDENING_SECRET ?? 'fixture-secret';
if (process.env.HARDENING_FLOOD === 'true') {
  process.stderr.write(`startup token=${secret}\n`);
  const noisyLine = `${'diagnostic-noise-'.repeat(32)}\n`;
  for (let index = 0; index < 4_096; index += 1) {
    if (!process.stderr.write(noisyLine)) await once(process.stderr, 'drain');
  }
}

serveStdio(
  () => {
    const server = new McpServer({ name: 'test-hardening', version: '2.0.0' });
    let targetCalls = 0;
    let target = server.registerTool(
      'mutable-target',
      {
        description: 'A tool whose live schema changes during the test.',
        inputSchema: z.object({ value: z.string().min(1) }),
        outputSchema: z.object({ echoed: z.string() }),
      },
      async ({ value }) => {
        targetCalls += 1;
        return {
          content: [{ type: 'text', text: `old:${value}` }],
          structuredContent: { echoed: value },
        };
      },
    );

    server.registerTool(
      'catalog-control',
      {
        description: 'Mutates the fixture tool catalog and reports call counts.',
        inputSchema: z.object({ action: z.enum(['change', 'remove', 'stats']) }),
        outputSchema: z.object({ targetCalls: z.number(), action: z.string() }),
      },
      async ({ action }) => {
        if (action === 'change') {
          target.update({
            paramsSchema: z.object({ count: z.number().int() }),
            outputSchema: z.object({ doubled: z.number() }),
            callback: async ({ count }) => {
              targetCalls += 1;
              if (count === 13) {
                return {
                  content: [{ type: 'text', text: 'invalid-new-output' }],
                  structuredContent: { echoed: 'stale-shape' },
                };
              }
              return {
                content: [{ type: 'text', text: `new:${count}` }],
                structuredContent: { doubled: count * 2 },
              };
            },
          });
        } else if (action === 'remove') {
          target.remove();
        }
        return {
          content: [{ type: 'text', text: `${action}:${targetCalls}` }],
          structuredContent: { targetCalls, action },
        };
      },
    );

    return server;
  },
  {
    legacy: 'reject',
    onerror: (error) => console.error('[mcp-hardening-fixture]', error.message),
  },
);
