#!/usr/bin/env node
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createRuntime, type ConnectionConfig } from '@connect_workbench/mcp-core';
import { loadMcpConfig } from './config';
import { DEFAULT_MCP_CONFIG_PATH } from './paths';

const SERVER_NAME = 'connect-toolbox-mcp';
const SERVER_VERSION = '0.3.0';
const MAX_RESULT_CHARS = 200_000;

/** 父进程存活轮询间隔：检测到父进程退出后最迟 5s 内自行退出，避免孤儿残留 */
const PARENT_WATCH_INTERVAL_MS = 5_000;
/** 优雅关闭超时：超时强制退出，避免 close 挂起导致进程永不退出 */
const SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * 监控启动本进程的父进程（IDE / MCP 宿主）是否存活。
 *
 * MCP 宿主异常退出（崩溃、被 kill -9）时子进程会被 init/launchd 收养，PPID 变为 1；
 * 此时 stdin 不一定能收到 EOF（stdio 走 socketpair，对端可能被其他进程持有），
 * 仅靠 'end' 事件会漏判，进程将变成孤儿常驻。
 * macOS 无 PR_SET_PDEATHSIG，轮询 PPID 变化是最可靠的跨平台兜底。
 */
function watchParentProcess(onOrphaned: () => void): void {
  const parentPid = process.ppid;
  // 手动在终端启动（父进程本就是 shell/init）时不做自杀判断，只认 PPID 变化
  const timer = setInterval(() => {
    if (process.ppid !== parentPid) {
      onOrphaned();
    }
  }, PARENT_WATCH_INTERVAL_MS);
  // 不因该定时器本身阻止进程正常退出
  timer.unref();
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printUsage(): void {
  process.stderr.write([
    'Connect Toolbox MCP Server',
    '',
    'Usage:',
    '  node dist/mcp-server.js [--config /path/to/mcp-config.json]',
    '',
    `默认读取配置文件：${DEFAULT_MCP_CONFIG_PATH}`,
    '（在 VS Code 插件中执行「生成 MCP 配置」会自动写入该位置）',
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

  // 动态工具：每个连接注册一个 execute_{name}，AI 直接写 SQL
  for (const connection of config.connections) {
    const toolName = `execute_${safeToolSuffix(connection.name)}`;
    const label = connection.description ?? connection.name;
    server.registerTool(
      toolName,
      {
        title: `Execute SQL on ${label}`,
        description: `MySQL 执行 SQL（${label}）`,
        inputSchema: z.object({
          sql: z.string().min(1).describe('要执行的 SQL 语句'),
          format: z.enum(['json', 'markdown', 'table']).optional().describe('可选，临时覆盖输出格式'),
        }),
      },
      async ({ sql, format }) => {
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
  /**
   * 优雅退出。
   *
   * 这里刻意**不写 stderr**：由 client 断开触发的退出，在两种场景下都没有日志价值 ——
   * - client 正常退出（关 stdin / 发 SIGTERM）：client 是发起方，本就知道自己关掉了 server，日志冗余；
   * - client 异常退出（崩溃 / 被 kill）：stderr 随宿主一同断开，写入必然 EPIPE。
   * 因此退出路径不依赖任何 IO：日志该写的地方（server 自身故障）另行记录。
   */
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // 兜底：优雅关闭若挂起（连接池/传输层未及时释放），超时后强制退出，不留残留进程
    const forceExit = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void (async () => {
      await server.close().catch(() => undefined);
      await runtime.close().catch(() => undefined);
    })().then(
      () => process.exit(exitCode),
      () => process.exit(exitCode),
    );
  };

  process.stdin.on('end', () => shutdown());
  // 宿主强杀时对端 socket 可能只触发 close（不触发 end），同样视为连接断开
  process.stdin.on('close', () => shutdown());
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  process.on('SIGHUP', () => shutdown());

  // 宿主消失后 stdout/stderr 变成"对端已不存在"的 socket（lsof 显示 ->(none)），写入会 EPIPE。
  // 若不接管该错误，EPIPE 会升级为 uncaughtException；而处理器内若再写同一个 fd 又失败，
  // 就形成异常风暴并不断格式化错误栈 —— 实测单核 100% 忙循环（CPU 满载发热）。
  // 注意：即使退出路径不写日志，这里也必须接管 —— SDK 的 transport.send() 仍会往 stdout
  // 写协议响应，client 突然断开时同样会 EPIPE。
  const onStdioError = (error: NodeJS.ErrnoException) => {
    if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') {
      // 管道断开即宿主已离开，直接退出，不写日志（写了也会失败）
      shutdown();
      return;
    }
    process.stderr.write(`[connect-toolbox-mcp] stdio error: ${error?.message ?? String(error)}\n`);
  };
  process.stdout.on('error', onStdioError);
  process.stderr.on('error', onStdioError);

  process.on('uncaughtException', error => {
    // server 自身故障：此时 client 可能仍然存活，这条日志有排查价值（best-effort，失败由 'error' 监听器兜住）
    process.stderr.write(`[connect-toolbox-mcp] uncaught exception: ${error.stack ?? error.message}\n`);
    // uncaughtException 后进程状态已不可信：必须退出，否则会变成既不工作也不退出的残留进程
    shutdown(1);
  });
  process.on('unhandledRejection', reason => {
    process.stderr.write(`[connect-toolbox-mcp] unhandled rejection: ${String(reason)}\n`);
  });

  // IDE 异常退出时 stdin 未必收到 EOF，靠 PPID 轮询兜底自杀
  watchParentProcess(() => shutdown());

  await server.connect(transport);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }
  // --config 可选：未指定时使用固定用户目录下的默认配置（~/.connect-toolbox/mcp-config.json）
  const configPath = readArg('--config') ?? DEFAULT_MCP_CONFIG_PATH;
  if (!fs.existsSync(configPath)) {
    printUsage();
    throw new Error(
      `未找到 MCP 配置文件：${configPath}\n请在 VS Code 插件中执行「生成 MCP 配置」，或通过 --config 指定路径。`,
    );
  }
  await startMcpServer(configPath);
}

void main().catch(error => {
  process.stderr.write(`[connect-toolbox-mcp] startup failed: ${(error as Error).message}\n`);
  // 启动失败必须退出：此时 stdin 监听可能已注册，仅设 exitCode 会让进程空转常驻
  process.exit(1);
});
