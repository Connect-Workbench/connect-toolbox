import * as vscode from 'vscode';
import { ConnectionStore, TreeFilter } from '../connection/ConnectionStore';
import { ConnectionManager } from '../connection/ConnectionManager';
import { ConnectionNode, ConnectionTreeProvider } from '../providers/ConnectionTreeProvider';
import { MysqlDatabaseNode, MysqlTableNode } from '../providers/nodes';
import { t } from '../i18n';

type Target = MysqlDatabaseNode | MysqlTableNode | ConnectionNode;

/**
 * 过滤数据库 / 过滤表（多选 QuickPick，支持搜索；空选择 = 不过滤显示全部）。
 * 选择持久化到 globalState（按连接 id），树刷新后只显示选中的项。
 * QuickPick 失去焦点时也会保存当前选择并关闭，和 Webview 的列设置面板保持一致。
 */
export async function runFilter(
  store: ConnectionStore,
  manager: ConnectionManager,
  tree: ConnectionTreeProvider,
  target: Target | undefined,
): Promise<void> {
  const { connectionId, kind, database } = resolveTarget(target);
  if (!connectionId) {
    return;
  }
  const client = manager.getMySqlClient(connectionId);
  if (!client) {
    vscode.window.showWarningMessage(t('filterMysqlNotConnected'));
    return;
  }

  try {
    const current: TreeFilter = store.getTreeFilter(connectionId) ?? {};
    if (kind === 'database') {
      const all = await client.listDatabases();
      const picked = await multiPick(all, current.databases ?? [], t('chooseDatabases'));
      if (picked === undefined) {
        return;
      }
      await store.setTreeFilter(connectionId, { ...current, databases: picked });
    } else if (kind === 'table' && database) {
      const all = (await client.listTables(database)).map(t => t.name);
      const picked = await multiPick(
        all,
        current.tablesByDb?.[database] ?? [],
        t('chooseTables', { database }),
      );
      if (picked === undefined) {
        return;
      }
      await store.setTreeFilter(connectionId, {
        ...current,
        tablesByDb: { ...current.tablesByDb, [database]: picked },
      });
    }
    tree.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(t('filterFailed', { message: (err as Error).message }));
  }
}

function resolveTarget(
  target: Target | undefined,
): { connectionId?: string; kind: 'database' | 'table'; database?: string } {
  // 数据库节点：过滤该库的表
  if (target instanceof MysqlDatabaseNode) {
    return { connectionId: target.connectionId, kind: 'table', database: target.database };
  }
  // 表节点：过滤所在库的表
  if (target instanceof MysqlTableNode) {
    return { connectionId: target.connectionId, kind: 'table', database: target.database };
  }
  // MySQL 连接节点：过滤数据库
  if (target instanceof ConnectionNode && target.config.type === 'mysql') {
    return { connectionId: target.config.id, kind: 'database' };
  }
  return { kind: 'database' };
}

function multiPick(
  all: string[],
  selected: string[],
  placeHolder: string,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem>();
    let settled = false;

    const available = new Set(all);
    const remembered = selected.filter((name, index) => (
      available.has(name) && selected.indexOf(name) === index
    ));
    const rememberedSet = new Set(remembered);
    const items = [
      ...remembered,
      ...all.filter(name => !rememberedSet.has(name)),
    ].map(label => ({ label }));

    pick.canSelectMany = true;
    pick.items = items;
    pick.selectedItems = items.filter(item => rememberedSet.has(item.label));
    pick.placeholder = placeHolder;
    pick.matchOnDescription = true;
    // 失去焦点即隐藏；onDidHide 会把当前勾选结果保存下来
    pick.ignoreFocusOut = false;

    const finish = (value: string[]) => {
      if (settled) return;
      settled = true;
      resolve(value);
      pick.hide();
      pick.dispose();
    };

    pick.onDidAccept(() => {
      finish(pick.selectedItems.map(item => item.label));
    });
    pick.onDidHide(() => {
      // QuickPick 没有区分“失去焦点”和 Escape 的关闭原因；两者统一按关闭即保存处理。
      finish(pick.selectedItems.map(item => item.label));
    });

    pick.show();
  });
}
