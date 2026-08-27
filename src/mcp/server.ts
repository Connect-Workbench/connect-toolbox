#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRuntime, type ConnectionConfig } from '@connect_workbench/mcp-core';
import { loadMcpConfig } from './config';
import { McpStatusReporter } from './status';

const SERVER_NAME = 'connect-toolbox-mcp';
const SERVER_VERSION = '0.2.0';
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

function errorResult(error: unknown): { isError: true; content: [{ type: 'text'; text: string }] } {
  return {
    isError: true,
    content: [{ type: 'text', text: (error as Error).message || String(error) }],
  };
}

/** 将连接名转成合法工具名后缀（只保留字母数字下划线连字符）。 */
function safeToolSuffix(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || 'unnamed';
}

export async function startMcpServer(configPath: string): Promise<void> {
  const config = await loadMcpConfig(configPath);

  // 执行层复用 @connect_workbench/mcp-core：解密后的连接信息以明文传入，core 维护连接池/解码/渲染/拦截
  const coreConnections: ConnectionConfig[] = config.connections.map(connection => ({
    name: connection.name,
    description: connection.description ?? connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password ?? '',
    // 插件连接默认明文直连（与原有行为一致），不启用 TLS
    useSsl: false,
  }));
  const runtime = createRuntime({ connections: coreConnections });

  const status = new McpStatusReporter(config.statusDir, configPath, config.connections.map(c => c.id));
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        'Connect Toolbox provides MySQL access via one tool per connection.',
        'Write SQL directly (SELECT / SHOW / DESCRIBE / EXPLAIN ...).',
        'Dangerous statements (DELETE / DROP / TRUNCATE) are blocked.',
      ].join(' '),
    },
  );

  status.start();
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    status.setClient(client ? { name: client.name, version: client.version } : undefined);
  };

  // 动态工具：每个连接注册一个 execute_{name}，AI 直接写 SQL
  for (const connection of config.connections) {
    const toolName = `execute_${safeToolSuffix(connection.name)}`;
    const label = connection.description ?? connection.name;
    server.registerTool(
      toolName,
      {
        title: `Execute SQL on ${label}`,
        description: `MySQL 执行 SQL（${label}）`,
        inputSchema: {
          sql: z.string().min(1).describe('要执行的 SQL 语句'),
          format: z.enum(['json', 'markdown', 'table']).optional().describe('可选，临时覆盖输出格式'),
        },
      },
      async ({ sql, format }) => {
        status.heartbeat();
        try {
          const result = await runtime.execute(connection.name, sql, { format });
          const text = result.contents.join('\n');
          if (text.length > MAX_RESULT_CHARS) {
            throw new Error(`结果过大，请降低 limit（当前输出超过 ${MAX_RESULT_CHARS} 个字符）`);
          }
          return { content: result.contents.map(item => ({ type: 'text' as const, text: item })) };
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

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
