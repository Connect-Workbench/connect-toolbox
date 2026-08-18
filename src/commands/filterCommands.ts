import * as vscode from 'vscode';
import { ConnectionStore, TreeFilter } from '../connection/ConnectionStore';
import { ConnectionManager } from '../connection/ConnectionManager';
import { ConnectionNode, ConnectionTreeProvider } from '../providers/ConnectionTreeProvider';
import { MysqlDatabaseNode, MysqlTableNode } from '../providers/nodes';

type Target = MysqlDatabaseNode | MysqlTableNode | ConnectionNode;

/**
 * 过滤数据库 / 过滤表（多选 QuickPick，支持搜索；空选择 = 不过滤显示全部）。
 * 选择持久化到 globalState（按连接 id），树刷新后只显示选中的项。
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
    vscode.window.showWarningMessage('MySQL 尚未连接，请先连接');
    return;
  }

  try {
    const current: TreeFilter = store.getTreeFilter(connectionId) ?? {};
    if (kind === 'database') {
      const all = await client.listDatabases();
      const picked = await multiPick(all, current.databases ?? [], '选择要显示的数据库（可搜索，留空=显示全部）');
      if (picked === undefined) {
        return;
      }
      await store.setTreeFilter(connectionId, { ...current, databases: picked });
    } else if (kind === 'table' && database) {
      const all = (await client.listTables(database)).map(t => t.name);
      const picked = await multiPick(
        all,
        current.tablesByDb?.[database] ?? [],
        `选择要显示的表（${database}，留空=显示全部）`,
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
    vscode.window.showErrorMessage(`过滤失败：${(err as Error).message}`);
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

async function multiPick(
  all: string[],
  selected: string[],
  placeHolder: string,
): Promise<string[] | undefined> {
  const pick = await vscode.window.showQuickPick(
    all.map(name => ({ label: name, picked: selected.includes(name) })),
    {
      placeHolder,
      canPickMany: true,
      matchOnDescription: true,
      ignoreFocusOut: true,
    },
  );
  if (pick === undefined) {
    return undefined;
  }
  return pick.map(p => p.label);
}
