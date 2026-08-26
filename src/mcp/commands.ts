import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStore } from '../connection/ConnectionStore';
import { t } from '../i18n';
import { createMcpConfig, writeMcpConfig } from './config';
import { DEFAULT_MCP_KEY_PATH } from './crypto';
import { readMcpStatuses } from './status';

export interface GenerateMcpConfigResult {
  configPath: string;
  configText: string;
  snippet: string;
  skipped: number;
}

/** 构建 Agent 侧 MCP stdio 配置片段（粘贴到 AI 编码助手的 mcpServers 配置） */
export function buildAgentSnippet(serverPath: string, configPath: string): string {
  return JSON.stringify({
    mcpServers: {
      'connect-toolbox': {
        type: 'stdio',
        command: 'node',
        args: [serverPath, '--config', configPath],
      },
    },
  }, null, 2);
}

/** MCP 配置的默认建议保存路径（snippet 中 --config 的引用路径） */
export function defaultMcpConfigPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'mcp', 'mcp-config.json');
}

/**
 * 生成 MCP 配置：自动保存到默认路径（不弹保存框），并返回配置内容供设置面板展示。
 * Agent 侧配置片段中的 --config 即指向该自动保存的文件。
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
    const statusDir = path.join(context.globalStorageUri.fsPath, 'mcp', 'status');
    const config = await createMcpConfig(
      mysqlConnections,
      ref => store.getSecret(ref),
      statusDir,
      DEFAULT_MCP_KEY_PATH,
    );
    const configPath = defaultMcpConfigPath(context);
    writeMcpConfig(configPath, config);
    const configText = JSON.stringify(config, null, 2);
    const serverPath = path.join(context.extensionPath, 'dist', 'mcp-server.js');
    const snippet = buildAgentSnippet(serverPath, configPath);
    return { configPath, configText, snippet, skipped };
  } catch (error) {
    vscode.window.showErrorMessage(t('mcpGenerateFailed', { message: (error as Error).message }));
    return undefined;
  }
}

export async function showMcpStatus(context: vscode.ExtensionContext): Promise<void> {
  const statusDir = path.join(context.globalStorageUri.fsPath, 'mcp', 'status');
  const statuses = readMcpStatuses(statusDir);
  if (statuses.length === 0) {
    vscode.window.showInformationMessage(t('mcpNoInstances'));
    return;
  }
  const items = statuses.map(status => ({
    label: `${status.alive ? '$(pass)' : '$(circle-slash)'} ${status.client?.name ?? t('mcpUnknownAgent')}`,
    description: `${status.status} · PID ${status.pid}`,
    detail: [
      status.client?.version ? `${t('mcpAgentVersion')}: ${status.client.version}` : '',
      `${t('mcpLastHeartbeat')}: ${status.lastHeartbeat}`,
      `${t('mcpConfigPath')}: ${status.configPath}`,
      status.lastError ? `${t('mcpLastError')}: ${status.lastError}` : '',
    ].filter(Boolean).join(' · '),
  }));
  await vscode.window.showQuickPick(items, {
    title: t('mcpStatusTitle'),
    placeHolder: t('mcpStatusPlaceholder'),
    matchOnDescription: true,
    matchOnDetail: true,
  });
}

