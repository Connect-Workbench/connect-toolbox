import * as vscode from 'vscode';
import { ConnectionConfig, TYPE_LABELS } from '../connection/types';
import { ConnectionStore } from '../connection/ConnectionStore';
import { ConnectionManager } from '../connection/ConnectionManager';
import { ConnectionNode, ConnectionTreeProvider } from '../providers/ConnectionTreeProvider';
import { MysqlTableNode } from '../providers/nodes';
import { SshTerminal } from '../ssh/SshTerminal';
import { showConnectionForm } from '../webviews/connectionForm';
import { openQueryPanel } from '../webviews/queryPanel';
import { openTablePanel } from '../webviews/tablePanel';
import { runFilter } from './filterCommands';
import { showDdl } from '../providers/ddlProvider';
import { rememberPanel } from './panelRegistry';

export function registerCommands(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  manager: ConnectionManager,
  tree: ConnectionTreeProvider,
): void {
  const register = (id: string, fn: (...args: any[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(`connectToolbox.${id}`, fn));
  };

  register('refresh', () => tree.refresh());

  register('addConnection', async () => {
    const config = await showConnectionForm(context, store);
    if (!config) {
      return;
    }
    await store.save(config);
    tree.refresh();
    vscode.window.showInformationMessage(`已添加连接「${config.name}」`);
  });

  register('editConnection', async (node?: ConnectionNode) => {
    const config = node ? node.config : await pickConnection(store, '选择要编辑的连接');
    if (!config) {
      return;
    }
    const updated = await showConnectionForm(context, store, config);
    if (!updated) {
      return;
    }
    await manager.disconnect(config.id);
    await store.save(updated);
    tree.refresh();
    vscode.window.showInformationMessage(`已更新连接「${updated.name}」`);
  });

  register('removeConnection', async (node?: ConnectionNode) => {
    const config = node ? node.config : await pickConnection(store, '选择要删除的连接');
    if (!config) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `确定删除连接「${config.name}」？`,
      { modal: true },
      '删除',
    );
    if (answer !== '删除') {
      return;
    }
    await manager.disconnect(config.id);
    if (config.passwordRef) {
      await store.deleteSecret(config.passwordRef);
    }
    if (config.passphraseRef) {
      await store.deleteSecret(config.passphraseRef);
    }
    await store.remove(config.id);
    tree.refresh();
  });

  register('connect', async (node?: ConnectionNode) => {
    const config = node ? node.config : await pickConnection(store, '选择要连接的实例');
    if (!config) {
      return;
    }
    try {
      await manager.connect(config.id);
      tree.refresh();
      vscode.window.showInformationMessage(`已连接：${config.name}`);
    } catch (err) {
      vscode.window.showErrorMessage(`连接失败：${(err as Error).message}`);
      tree.refresh();
    }
  });

  register('disconnect', async (node?: ConnectionNode) => {
    const config = node ? node.config : await pickConnection(store, '选择要断开的连接');
    if (!config) {
      return;
    }
    await manager.disconnect(config.id);
    tree.refresh();
  });

  register('openTerminal', async (node?: ConnectionNode) => {
    const config =
      node && node.config.type === 'ssh'
        ? node.config
        : await pickConnection(store, '选择 SSH 连接', c => c.type === 'ssh');
    if (!config) {
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `SSH: ${config.name}`,
      pty: new SshTerminal(manager, config),
    });
    terminal.show();
  });

  // ---------- MySQL ----------

  register('openQueryPanel', async (node?: ConnectionNode) => {
    const config =
      node && node.config.type === 'mysql'
        ? node.config
        : await pickConnection(store, '选择 MySQL 连接', c => c.type === 'mysql');
    if (!config) {
      return;
    }
    if (manager.getStatus(config.id) !== 'connected') {
      vscode.window.showWarningMessage('MySQL 尚未连接，请先在连接树中连接');
      return;
    }
    void rememberPanel(store, { type: 'query', connId: config.id, connName: config.name });
    openQueryPanel(context, manager, config);
  });

  register('openTableData', async (node?: MysqlTableNode) => {
    if (!node) {
      return;
    }
    const config = store.get(node.connectionId);
    if (!config) {
      return;
    }
    if (manager.getStatus(node.connectionId) !== 'connected') {
      vscode.window.showWarningMessage('MySQL 尚未连接，请先在连接树中连接');
      return;
    }
    void rememberPanel(store, {
      type: 'table',
      connId: config.id,
      connName: config.name,
      database: node.database,
      table: node.table,
    });
    openTablePanel(context, manager, config, node.database, node.table);
  });

  register('filterTree', async (node?: unknown) => {
    await runFilter(store, manager, tree, node as never);
  });

  register('showCreateTable', async (node?: MysqlTableNode) => {
    if (!node) {
      return;
    }
    const client = manager.getMySqlClient(node.connectionId);
    if (!client) {
      vscode.window.showWarningMessage('MySQL 尚未连接，请先在连接树中连接');
      return;
    }
    try {
      const ddl = await client.showCreateTable(node.database, node.table);
      await showDdl(`${node.database}.${node.table}`, ddl + ';\n');
    } catch (err) {
      vscode.window.showErrorMessage(`获取建表语句失败：${(err as Error).message}`);
    }
  });
}

// ---------- 通用选择 ----------

async function pickConnection(
  store: ConnectionStore,
  title: string,
  filter?: (c: ConnectionConfig) => boolean,
): Promise<ConnectionConfig | undefined> {
  const list = store.list().filter(filter ?? (() => true));
  if (list.length === 0) {
    vscode.window.showInformationMessage('暂无可用连接，请先新建连接');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map(c => ({
      label: c.name,
      description: `${c.host}:${c.port}`,
      detail: TYPE_LABELS[c.type],
    })),
    { placeHolder: title },
  );
  if (!picked) {
    return undefined;
  }
  return list.find(c => c.name === picked.label);
}
