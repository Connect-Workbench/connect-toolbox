#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MySqlClient, TableFilterOperator, TableQuery } from '../clients/MySqlClient';
import { loadMcpConfig } from './config';
import { McpStatusReporter } from './status';
import { ResolvedMcpConnection } from './types';

const SERVER_NAME = 'connect-toolbox-mcp';
const SERVER_VERSION = '0.1.0';
const MAX_QUERY_ROWS = 1000;
const MAX_RESULT_CHARS = 200_000;

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printUsage(): void {
  process.stderr.write([
    'Connect Toolbox MCP Server',
    '',
    'Usage:',
    '  node dist/mcp-server.js --config /path/to/mcp-config.json',
    '',
  ].join('\n'));
}

function jsonResult(value: unknown): { content: [{ type: 'text'; text: string }] } {
  const text = JSON.stringify(value, null, 2);
  if (text.length > MAX_RESULT_CHARS) {
    throw new Error(`查询结果过大，请降低 limit（当前输出超过 ${MAX_RESULT_CHARS} 个字符）`);
  }
  return { content: [{ type: 'text', text }] };
}

function errorResult(error: unknown): { isError: true; content: [{ type: 'text'; text: string }] } {
  return {
    isError: true,
    content: [{ type: 'text', text: (error as Error).message || String(error) }],
  };
}

class DatabaseRuntime {
  private readonly profiles = new Map<string, ResolvedMcpConnection>();
  private readonly clients = new Map<string, MySqlClient>();

  constructor(connections: ResolvedMcpConnection[]) {
    for (const connection of connections) this.profiles.set(connection.id, connection);
  }

  listConnections(): Array<Omit<ResolvedMcpConnection, 'password'>> {
    return [...this.profiles.values()].map(({ password: _password, ...connection }) => connection);
  }

  async getClient(connectionId: string): Promise<MySqlClient> {
    const profile = this.profiles.get(connectionId);
    if (!profile) throw new Error(`MCP 连接不存在：${connectionId}`);
    const existing = this.clients.get(connectionId);
    if (existing) return existing;
    const client = new MySqlClient(profile.host, profile.port, profile.username, profile.password);
    await client.connect();
    this.clients.set(connectionId, client);
    return client;
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map(client => client.close()));
    this.clients.clear();
  }
}

const filterOperator = z.enum([
  '=', '!=', '<>', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE',
  'IN', 'NOT IN', 'BETWEEN', 'NOT BETWEEN', 'REGEXP', 'NOT REGEXP',
  'IS NULL', 'IS NOT NULL',
]);

const connectionIdSchema = z.object({
  connectionId: z.string().min(1),
});

export async function startMcpServer(configPath: string): Promise<void> {
  const config = await loadMcpConfig(configPath);
  const runtime = new DatabaseRuntime(config.connections);
  const status = new McpStatusReporter(config.statusDir, configPath, config.connections.map(c => c.id));
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: 'Connect Toolbox provides read-only MySQL metadata and table query tools.',
    },
  );

  status.start();
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    status.setClient(client ? { name: client.name, version: client.version } : undefined);
  };

  const readOnlyAnnotations = { readOnlyHint: true } as const;

  server.registerTool(
    'list_connections',
    {
      title: 'List MySQL connections',
      description: 'List configured MySQL connections without returning passwords.',
      annotations: readOnlyAnnotations,
    },
    async () => {
      status.heartbeat();
      return jsonResult({ connections: runtime.listConnections() });
    },
  );

  server.registerTool(
    'list_databases',
    {
      title: 'List databases',
      description: 'List databases visible to the selected MySQL account.',
      inputSchema: connectionIdSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ connectionId }) => {
      try {
        const databases = await (await runtime.getClient(connectionId)).listDatabases();
        status.heartbeat();
        return jsonResult({ connectionId, databases });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description: 'List tables and views visible to the selected MySQL account.',
      inputSchema: connectionIdSchema.extend({ database: z.string().min(1) }),
      annotations: readOnlyAnnotations,
    },
    async ({ connectionId, database }) => {
      try {
        const tables = await (await runtime.getClient(connectionId)).listTables(database);
        status.heartbeat();
        return jsonResult({ connectionId, database, tables });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description: 'Return column metadata for a MySQL table or view.',
      inputSchema: connectionIdSchema.extend({
        database: z.string().min(1),
        table: z.string().min(1),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ connectionId, database, table }) => {
      try {
        const columns = await (await runtime.getClient(connectionId)).describeTable(database, table);
        status.heartbeat();
        return jsonResult({ connectionId, database, table, columns });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'query_table',
    {
      title: 'Query table',
      description: 'Run a read-only, parameter-bound query against one MySQL table.',
      inputSchema: connectionIdSchema.extend({
        database: z.string().min(1),
        table: z.string().min(1),
        offset: z.number().int().min(0).max(10_000_000).optional(),
        limit: z.number().int().min(1).max(MAX_QUERY_ROWS).default(100),
        filters: z.array(z.object({
          field: z.string().min(1),
          operator: filterOperator,
          value: z.string().optional(),
        })).max(50).optional(),
        sort: z.object({
          field: z.string().min(1),
          direction: z.enum(['asc', 'desc']),
        }).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ connectionId, database, table, offset, limit, filters, sort }) => {
      try {
        const query: TableQuery = {
          filters: filters as Array<{ field: string; operator: TableFilterOperator; value?: string }> | undefined,
          sort,
        };
        const result = await (await runtime.getClient(connectionId)).selectPage(
          database,
          table,
          offset ?? 0,
          limit,
          query,
        );
        status.heartbeat();
        return jsonResult({
          connectionId,
          database,
          table,
          offset: offset ?? 0,
          limit,
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rows.length,
          durationMs: result.durationMs,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (reason?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reason) process.stderr.write(`[connect-toolbox-mcp] ${reason}\n`);
    status.stop();
    await server.close().catch(() => undefined);
    await runtime.close();
  };

  process.stdin.on('end', () => { void shutdown('stdin closed'); });
  process.on('SIGINT', () => { void shutdown('received SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('received SIGTERM'); });
  process.on('uncaughtException', error => {
    process.stderr.write(`[connect-toolbox-mcp] uncaught exception: ${error.stack ?? error.message}\n`);
    status.stop(error.message);
    process.exitCode = 1;
  });
  process.on('unhandledRejection', reason => {
    process.stderr.write(`[connect-toolbox-mcp] unhandled rejection: ${String(reason)}\n`);
    status.setStatus('error', String(reason));
  });

  await server.connect(transport);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }
  const configPath = readArg('--config');
  if (!configPath) {
    printUsage();
    throw new Error('缺少 --config 参数');
  }
  await startMcpServer(configPath);
}

void main().catch(error => {
  process.stderr.write(`[connect-toolbox-mcp] startup failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
