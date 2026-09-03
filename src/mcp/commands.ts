import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStore } from '../connection/ConnectionStore';
import { t } from '../i18n';
import { createMcpConfig, writeMcpConfig } from './config';
import { DEFAULT_MCP_KEY_PATH } from './crypto';
import { DEFAULT_MCP_CONFIG_PATH, refreshMcpServerLink } from './paths';
import { detectNodeCommand } from './node-detection';

export interface GenerateMcpConfigResult {
  configPath: string;
  configText: string;
  snippet: string;
  skipped: number;
  /** snippet 中 command 使用的 node 命令（'node' 或绝对路径） */
  nodeCommand: string;
  /** node 探测说明（便于展示/排查） */
  nodeReason: string;
}

/**
 * 构建 Agent 侧 MCP stdio 配置片段（粘贴到 AI 编码助手的 mcpServers 配置）。
 * 配置文件路径由 MCP server 内部按约定自动拼接（~/.connect-toolbox/mcp-config.json），
 * 因此 snippet 无需携带 --config，只需指向 server 入口与合适的 node。
 */
export function buildAgentSnippet(serverPath: string, nodeCommand: string): string {
  return JSON.stringify({
    mcpServers: {
      'connect-toolbox': {
        type: 'stdio',
        command: nodeCommand,
        args: [serverPath],
      },
    },
  }, null, 2);
}

/**
 * 生成 MCP 配置：自动保存到固定用户目录（~/.connect-toolbox/mcp-config.json），
 * 并把 MCP server 入口软链到固定短路径（~/.connect-toolbox/mcp-server.js），
 * 返回配置内容供设置面板展示；Agent 侧配置片段可直接复制粘贴。
 */
export async function generateMcpConfig(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
): Promise<GenerateMcpConfigResult | undefined> {
  const connections = store.list();
  const mysqlConnections = connections.filter(connection => connection.type === 'mysql' && !connection.viaSsh);
  const skipped = connections.length - mysqlConnections.length;
  if (mysqlConnections.length === 0) {
    vscode.window.showWarningMessage(t('mcpNoDirectMysqlConnections'));
    return undefined;
  }

  try {
    const config = await createMcpConfig(
      mysqlConnections,
      ref => store.getSecret(ref),
      DEFAULT_MCP_KEY_PATH,
    );
    const configPath = DEFAULT_MCP_CONFIG_PATH;
    writeMcpConfig(configPath, config);
    const configText = JSON.stringify(config, null, 2);
    const extensionServerPath = path.join(context.extensionPath, 'dist', 'mcp-server.js');
    // 软链到固定短路径（每次生成时重建，保证扩展升级后链接仍指向最新入口）；
    // Windows 无符号链接权限时返回 null，回退使用真实路径。
    const serverPath = refreshMcpServerLink(extensionServerPath) ?? extensionServerPath;
    // 探测合适的 node（默认 >=18，否则取 nvm 中 >=18 的最高版本绝对路径）
    const { nodeCommand, reason: nodeReason } = detectNodeCommand();
    const snippet = buildAgentSnippet(serverPath, nodeCommand);
    return { configPath, configText, snippet, skipped, nodeCommand, nodeReason };
  } catch (error) {
    vscode.window.showErrorMessage(t('mcpGenerateFailed', { message: (error as Error).message }));
    return undefined;
  }
}

