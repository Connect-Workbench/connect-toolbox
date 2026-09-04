import * as vscode from 'vscode';
import { ConnectionStore } from './connection/ConnectionStore';
import { ConnectionManager } from './connection/ConnectionManager';
import { SshTunnelManager } from './ssh/SshTunnelManager';
import { ConnectionTreeProvider, nodeExpandKey } from './providers/ConnectionTreeProvider';
import { registerDdlProvider } from './providers/ddlProvider';
import { registerCellEditor } from './providers/cellEditor';
import { registerSqlEditor } from './webviews/sqlEditor';
import { registerQueryRunnerCommands } from './webviews/queryRunner';
import { registerCommands } from './commands/registerCommands';
// import { restorePanels } from './commands/panelRegistry';
import { initLogger, info, error } from './utils/logger';

let manager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  info('extension activated');
  const store = new ConnectionStore(context);
  const tunnels = new SshTunnelManager();
  manager = new ConnectionManager(store, tunnels);
  const tree = new ConnectionTreeProvider(store, manager);

  // createTreeView 才能拿到展开/折叠事件（用于持久化布局）
  const treeView = vscode.window.createTreeView('connectToolbox.connections', {
    treeDataProvider: tree,
  });
  context.subscriptions.push(treeView);
  treeView.onDidExpandElement(e => tree.onNodeExpanded(e.element, true));
  treeView.onDidCollapseElement(e => {
    tree.onNodeExpanded(e.element, false);
    // 折叠时同步收起其子节点在保存状态中的展开记录，避免幽灵展开
    const key = nodeExpandKey(e.element);
    if (key) {
      void store.saveTreeExpanded(
        store.getTreeExpanded().filter(k => !k.startsWith(key + ':')),
      );
    }
  });

  registerDdlProvider(context);
  registerCellEditor(context);
  registerSqlEditor(context);
  registerQueryRunnerCommands(context, store, manager);
  registerCommands(context, store, manager, tree);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('connectToolbox.language')) {
        tree.refresh();
      }
    }),
  );

  // 恢复最近打开的窗口：暂时屏蔽（reload 后不自动打开之前的窗口，还原逻辑待修复）
  // void restorePanels(context, store, manager).catch(err => error('restorePanels failed', err));
}

export function deactivate(): void {
  info('extension deactivated');
  void manager?.disconnectAll();
  manager = undefined;
}
