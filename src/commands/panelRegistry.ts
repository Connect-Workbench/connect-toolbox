import * as vscode from 'vscode';
import { RecentPanel, ConnectionStore } from '../connection/ConnectionStore';
import { ConnectionManager } from '../connection/ConnectionManager';
import { openSqlEditor } from '../webviews/sqlEditor';
import { openTablePanel } from '../webviews/tablePanel';
import { t } from '../i18n';

const MAX_PANELS = 10;

/** 面板唯一 key（去重） */
function panelKey(p: RecentPanel): string {
  return p.type === 'query'
    ? `query:${p.connId}`
    : `table:${p.connId}:${p.database}:${p.table}`;
}

/** 打开面板时记录（去重置顶，保留最近 MAX_PANELS 个） */
export async function rememberPanel(store: ConnectionStore, panel: RecentPanel): Promise<void> {
  const list = store.getRecentPanels().filter(p => panelKey(p) !== panelKey(panel));
  list.unshift(panel);
  await store.saveRecentPanels(list.slice(0, MAX_PANELS));
}

/**
 * 插件加载后恢复最近窗口：
 * - 逐个自动重连对应连接（失败跳过并汇总提示）
 * - 重新打开查询 / 表数据面板
 */
export async function restorePanels(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  manager: ConnectionManager,
): Promise<void> {
  const list = store.getRecentPanels();
  if (list.length === 0) {
    return;
  }
  const failed: string[] = [];
  for (const p of list) {
    try {
      if (manager.getStatus(p.connId) !== 'connected') {
        await manager.connect(p.connId);
      }
      const config = store.get(p.connId);
      if (!config) {
        continue;
      }
      if (p.type === 'query') {
        await openSqlEditor(config, p.database);
      } else if (p.type === 'table' && p.database && p.table) {
        openTablePanel(context, manager, config, p.database, p.table);
      }
    } catch {
      failed.push(p.connName);
    }
  }
  if (failed.length > 0) {
    vscode.window.showWarningMessage(
      t('panelsRestoreFailed', { names: failed.join('、') }),
    );
  }
}
