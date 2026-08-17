/**
 * MCP smoke test against a running server.
 *
 * Uses the real MCP SDK client rather than hand-rolled HTTP, because the handshake has
 * subtleties (session id propagation, SSE framing) that a curl-style test gets wrong in
 * ways that look like server bugs. This is the same path Copilot Studio takes.
 *
 * Usage: node scripts/mcp-smoke.mjs [url]
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] ?? 'http://127.0.0.1:8787/mcp';

const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(url));

await client.connect(transport);
console.log(`connected: ${url}`);

const { tools } = await client.listTools();
console.log(`\ntools (${tools.length}):`);
for (const tool of tools) console.log(`  - ${tool.name}`);

// Exercise a real tool call end to end, not just discovery.
const result = await client.callTool({
  name: 'get_headline_kpis',
  arguments: {
    organization: 'contoso',
    project: 'Contoso Payments',
    period: 'last 90 days',
  },
});

const text = result.content?.[0]?.text ?? '';
console.log('\nget_headline_kpis returned:');
console.log(text.split('\n').slice(0, 12).join('\n'));

// The governance guard must hold over MCP, not only over REST.
const blocked = await client.callTool({
  name: 'get_kpis',
  arguments: {
    organization: 'contoso',
    project: 'Contoso Payments',
    team: 'Payments Core',
    kpiIds: ['team.utilization_rate'],
  },
});
console.log(`\nteam-level query ok: ${!blocked.isError}`);

await client.close();
console.log('\nOK');
