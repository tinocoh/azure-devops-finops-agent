#!/usr/bin/env node
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KpiEngine } from './kpi/engine.js';
import { loadReferenceData } from './kpi/reference.js';
import { DemoProvider } from './providers/demo.js';
import { AzureDevOpsProvider } from './providers/azure-devops.js';
import { NoNetworkTokenProvider, OnBehalfOfTokenProvider, WorkloadIdentityTokenProvider } from './auth/tokens.js';
import { registerTools } from './tools/index.js';
import { registerRestApi } from './rest.js';
import { loadCatalog } from './catalog.js';
import type { MetricProvider } from './types.js';

/**
 * Entry point.
 *
 * Three transports are supported:
 *   - `http`  — Streamable HTTP, the transport Copilot Studio requires for MCP servers.
 *   - `stdio` — for local tooling and IDE clients.
 *   - the REST API is always mounted alongside HTTP for the dashboard.
 */

const MODE = (process.env.DATA_MODE ?? 'demo').toLowerCase();
const TRANSPORT = (process.env.MCP_TRANSPORT ?? 'http').toLowerCase();
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

function buildProvider(userAssertion?: string): MetricProvider {
  if (MODE === 'demo') {
    return new DemoProvider(Number(process.env.DEMO_SEED ?? 20260814));
  }

  const organization = process.env.ADO_ORGANIZATION;
  if (!organization) {
    throw new Error('DATA_MODE=live requires ADO_ORGANIZATION to be set.');
  }

  const reference = loadReferenceData();
  const tokens = userAssertion
    ? new OnBehalfOfTokenProvider({
        tenantId: requireEnv('AZURE_TENANT_ID'),
        clientId: requireEnv('AZURE_CLIENT_ID'),
        userAssertion,
        getClientAssertion: readFederatedAssertion,
      })
    : new WorkloadIdentityTokenProvider();

  return new AzureDevOpsProvider({
    organization,
    tokens,
    conventions: reference.conventions,
    analyticsVersion: (process.env.ANALYTICS_VERSION as 'v2.0') ?? 'v2.0',
    maxRows: Number(process.env.MAX_ROWS ?? 20000),
    costSubscriptionIds: (process.env.AZURE_COST_SUBSCRIPTIONS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is required in live mode.`);
  return value;
}

async function readFederatedAssertion(): Promise<string> {
  const file = process.env.AZURE_FEDERATED_TOKEN_FILE;
  if (!file) {
    throw new Error(
      'AZURE_FEDERATED_TOKEN_FILE is not set. This service uses workload identity federation ' +
        'and never stores a client secret.',
    );
  }
  const { readFile } = await import('node:fs/promises');
  return (await readFile(file, 'utf8')).trim();
}

function buildEngine(userAssertion?: string): KpiEngine {
  return new KpiEngine({
    provider: buildProvider(userAssertion),
    reference: loadReferenceData(undefined, process.env.DEFAULT_PROJECT_KEY),
  });
}

function createMcpServer(engine: KpiEngine): McpServer {
  const server = new McpServer(
    {
      name: 'ado-kpi-mcp-server',
      version: '1.0.0',
    },
    {
      instructions:
        'Azure DevOps FinOps, delivery performance and project profitability KPIs. Start with ' +
        'get_scorecard for broad questions, get_headline_kpis when brevity matters, and ' +
        'list_kpis / describe_kpi to explain what can be measured and how it is calculated. ' +
        'Never present a KPI value without the period it covers. Some KPIs require finance or ' +
        'Azure cost reference data and will report precisely what is missing rather than ' +
        'estimating.',
    },
  );
  registerTools(server, engine);
  return server;
}

async function startStdio(): Promise<void> {
  const engine = buildEngine();
  const server = createMcpServer(engine);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`ado-kpi-mcp-server ready on stdio (mode=${MODE})\n`);
}

async function startHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Security headers. The dashboard is served from the same origin in the local demo.
  app.use((_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    next();
  });

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type, authorization, mcp-session-id');
      res.setHeader('access-control-expose-headers', 'mcp-session-id');
      res.setHeader('vary', 'origin');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // The REST API always runs with the service identity (or demo data).
  const restEngine = buildEngine();
  registerRestApi(app, restEngine);

  // MCP endpoint. Each session gets its own engine so a user-delegated token is never
  // shared between callers.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.all('/mcp', async (req, res) => {
    try {
      const existingId = req.header('mcp-session-id');
      let transport = existingId ? sessions.get(existingId) : undefined;

      if (!transport) {
        const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
        const engine = buildEngine(MODE === 'live' ? bearer : undefined);
        const server = createMcpServer(engine);

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });

        transport.onclose = () => {
          if (transport?.sessionId) sessions.delete(transport.sessionId);
        };

        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: (error as Error).message },
          id: null,
        });
      }
    }
  });

  // Static dashboard, when a build is present next to the server.
  const dashboardDir = process.env.DASHBOARD_DIR;
  if (dashboardDir) {
    app.use(express.static(dashboardDir));
    app.get('*', (_req, res) => res.sendFile('index.html', { root: dashboardDir }));
  }

  await new Promise<void>((resolve) => {
    app.listen(PORT, HOST, () => {
      const catalog = loadCatalog();
      process.stdout.write(
        [
          '',
          '  Azure DevOps FinOps & Delivery Intelligence — KPI server',
          `  mode        ${MODE}${MODE === 'demo' ? ' (deterministic seeded data, no network calls)' : ''}`,
          `  catalog     ${catalog.kpis.length} KPIs across ${catalog.domains.length} domains`,
          `  MCP         http://${HOST}:${PORT}/mcp  (Streamable HTTP)`,
          `  REST        http://${HOST}:${PORT}/api/health`,
          dashboardDir ? `  dashboard   http://${HOST}:${PORT}/` : '',
          '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      resolve();
    });
  });
}

async function main(): Promise<void> {
  if (MODE === 'demo') {
    // Guarantee the demo path cannot reach the network even if misconfigured.
    void new NoNetworkTokenProvider();
  }
  if (TRANSPORT === 'stdio') {
    await startStdio();
  } else {
    await startHttp();
  }
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${(error as Error).message}\n`);
  process.exit(1);
});
