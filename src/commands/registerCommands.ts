import * as vscode from 'vscode';
import { ConnectionConfig, TYPE_LABELS } from '../connection/types';
import { ConnectionStore } from '../connection/ConnectionStore';
import { ConnectionManager } from '../connection/ConnectionManager';
import { ConnectionNode, ConnectionTreeProvider } from '../providers/ConnectionTreeProvider';
import { MysqlTableNode } from '../providers/nodes';
import { SshTerminal } from '../ssh/SshTerminal';
import { showConnectionForm } from '../webviews/connectionForm';
import { openQueryPanel } from '../webviews/queryPanel';
import { openSettingsPanel } from '../webviews/settingsPanel';
import { openTablePanel } from '../webviews/tablePanel';
import { runFilter } from './filterCommands';
import { showDdl } from '../providers/ddlProvider';
import { rememberPanel } from './panelRegistry';
import { t } from '../i18n';
import { generateMcpConfig } from '../mcp/commands';

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

  register('openSettings', () => openSettingsPanel(context, store));

  register('generateMcpConfig', () => generateMcpConfig(context, store));

  register('addConnection', async () => {
    const config = await showConnectionForm(context, store);
    if (!config) {
      return;
    }
    await store.save(config);
    tree.refresh();
    vscode.window.showInformationMessage(t('connectionAdded', { name: config.name }));
  });

  register('editConnection', async (node?: ConnectionNode) => {
    const config = node ? node.config : await pickConnection(store, t('chooseEditConnection'));
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
    vscode.window.showInformationMessage(t('connectionUpdated', { name: updated.name }));
  });

  register('removeConnection', async (node?: ConnectionNode) => {
    const config = node ? node.config : await pickConnection(store, t('chooseDeleteConnection'));
    if (!config) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      t('deleteConnectionConfirm', { name: config.name }),
      { modal: true },
      t('delete'),
    );
    if (answer !== t('delete')) {
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
    const config = node ? node.config : await pickConnection(store, t('chooseConnectInstance'));
    if (!config) {
      return;
    }
    try {
      await manager.connect(config.id);
      tree.refresh();
      vscode.window.showInformationMessage(t('connected', { name: config.name }));
    } catch (err) {
      vscode.window.showErrorMessage(t('connectionFailed', { message: (err as Error).message }));
      tree.refresh();
    }
  });

  register('disconnect', async (node?: ConnectionNode) => {
    const config = node ? node.config : await pickConnection(store, t('chooseDisconnectConnection'));
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
        : await pickConnection(store, t('chooseSshConnection'), c => c.type === 'ssh');
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
        : await pickConnection(store, t('chooseMysqlConnection'), c => c.type === 'mysql');
    if (!config) {
      return;
    }
    if (manager.getStatus(config.id) !== 'connected') {
      vscode.window.showWarningMessage(t('mysqlNotConnected'));
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
      vscode.window.showWarningMessage(t('mysqlNotConnected'));
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
      vscode.window.showWarningMessage(t('mysqlNotConnected'));
      return;
    }
    try {
      const ddl = await client.showCreateTable(node.database, node.table);
      await showDdl(`${node.database}.${node.table}`, ddl + ';\n');
    } catch (err) {
      vscode.window.showErrorMessage(t('showCreateTableFailed', { message: (err as Error).message }));
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
    vscode.window.showInformationMessage(t('noAvailableConnections'));
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
