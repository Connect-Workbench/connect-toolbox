import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ColumnInfo, qualifiedTable, TableQuery } from '../clients/MySqlClient';
import { ConnectionConfig } from '../connection/types';
import { ConnectionManager } from '../connection/ConnectionManager';
import { detectLanguage } from '../providers/cellEditor';
import { info, error } from '../utils/logger';
import { locale, t } from '../i18n';

const PAGE_SIZE = 50;

interface PanelMessage {
  type: 'loadPage' | 'updateCell' | 'deleteRow' | 'addRow' | 'commit' | 'dirty' | 'editCell';
  payload: {
    page?: number;
    pkValues?: unknown[];
    column?: string;
    newValue?: string;
    values?: Record<string, string>;
    count?: number;
    query?: TableQuery;
    commit?: {
      inserts: Record<string, string>[];
      updates: { pkValues: string[]; changes: Record<string, string> }[];
      deletes: { pkValues: string[] }[];
    };
    rowKey?: string;
    field?: string;
    value?: string;
  };
}

interface PagePayload {
  connectionName: string;
  database: string;
  table: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  hasPk: boolean;
  pkColumns: string[];
  query: TableQuery;
}

const DEV_SERVER = 'http://localhost:5173';

/**
 * 表数据面板（vite + React + antd 前端）。
 * - 开发模式：加载 vite dev server（HMR 热更新）
 * - 生产模式：加载 webview-dist 构建产物
 */
export function openTablePanel(
  context: vscode.ExtensionContext,
  manager: ConnectionManager,
  config: ConnectionConfig,
  database: string,
  table: string,
): void {
  const panel = vscode.window.createWebviewPanel(
    `connectToolbox.table.${config.id}.${database}.${table}`,
    t('tablePanelTitle', { database, table }),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'webview-dist'),
      ],
    },
  );

  info('open table panel', database + '.' + table, 'dev=' + !!process.env.CT_WEBVIEW_DEV);
  panel.webview.html = getPanelHtml(context, panel, database, table);

  // 未提交变更数（前端实时上报，关闭面板时提醒）
  let dirtyCount = 0;

  panel.onDidDispose(() => {
    if (dirtyCount > 0) {
      void vscode.window.showWarningMessage(
        t('panelClosedWithChanges', { count: dirtyCount }),
        { modal: true },
      );
    }
  });

  const sendError = (message: string) => panel.webview.postMessage({ type: 'error', message });
  let currentQuery: TableQuery = { filters: [] };
  let pageRequestSerial = 0;
  const sendPage = async (page: number, query: TableQuery = currentQuery) => {
    const client = manager.getMySqlClient(config.id);
    if (!client) {
      sendError(t('mysqlNotConnected'));
      return;
    }
    const normalizedQuery: TableQuery = {
      sort: query.sort,
      filters: query.filters ?? [],
      sqlFilter: query.sqlFilter?.trim() || undefined,
    };
    currentQuery = normalizedQuery;
    const requestSerial = ++pageRequestSerial;
    try {
      const columns = await client.describeTable(database, table);
      const pkColumns = columns.filter(column => column.key === 'PRI').map(column => column.field);
      const total = await client.count(database, table, normalizedQuery, columns);
      const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const safePage = Math.min(Math.max(1, Math.floor(page) || 1), maxPage);
      const result = await client.selectPage(
        database,
        table,
        (safePage - 1) * PAGE_SIZE,
        PAGE_SIZE,
        normalizedQuery,
        columns,
      );
      if (requestSerial !== pageRequestSerial) return;
      const payload: PagePayload = {
        connectionName: config.name,
        database,
        table,
        columns,
        rows: result.rows,
        total,
        page: safePage,
        pageSize: PAGE_SIZE,
        hasPk: pkColumns.length > 0,
        pkColumns,
        query: normalizedQuery,
      };
      panel.webview.postMessage({ type: 'page', payload });
    } catch (err) {
      if (requestSerial === pageRequestSerial) {
        sendError((err as Error).message);
      }
    }
  };

  panel.webview.onDidReceiveMessage(async (msg: PanelMessage) => {
    info('webview msg', msg.type, JSON.stringify(msg.payload ?? {}).slice(0, 200));
    if (msg.type === 'dirty') {
      dirtyCount = msg.payload.count ?? 0;
      return;
    }
    const client = manager.getMySqlClient(config.id);
    if (!client) {
      sendError(t('mysqlNotConnected'));
      return;
    }
    try {
      switch (msg.type) {
        case 'loadPage':
          await sendPage(msg.payload.page ?? 1, msg.payload.query ?? currentQuery);
          return;
        case 'updateCell': {
          const { pkValues, column, newValue } = msg.payload;
          if (!column || !pkValues || pkValues.length === 0) {
            sendError(t('missingPrimaryKey'));
            return;
          }
          const [pkColumns, allColumns] = await Promise.all([
            client.getPrimaryKey(database, table),
            client.describeTable(database, table),
          ]);
          if (!pkColumns || pkColumns.length === 0) {
            sendError(t('noPrimaryKeyEdit'));
            return;
          }
          const colInfo = allColumns.find(c => c.field === column);
          if (!colInfo) {
            sendError(t('columnNotFound', { column }));
            return;
          }
          const setSql = `UPDATE ${qualifiedTable(database, table)} SET \`${column.replace(/`/g, '``')}\` = ? ${whereSql(pkColumns)}`;
          await client.query(setSql, [toParam(newValue), ...pkValues]);
          await sendPage(msg.payload.page ?? 1, currentQuery);
          return;
        }
        case 'deleteRow': {
          const { pkValues, page } = msg.payload;
          const pkColumns = await client.getPrimaryKey(database, table);
          if (!pkColumns || pkColumns.length === 0) {
            sendError(t('noPrimaryKeyDelete'));
            return;
          }
          await client.query(
            `DELETE FROM ${qualifiedTable(database, table)} ${whereSql(pkColumns)}`,
            pkValues,
          );
          await sendPage(page ?? 1, currentQuery);
          return;
        }
        case 'addRow': {
          const { values, page } = msg.payload;
          const columns = await client.describeTable(database, table);
          const insertable = columns.filter(c => !/auto_increment/i.test(c.extra));
          const names = insertable.map(c => `\`${c.field.replace(/`/g, '``')}\``).join(', ');
          const placeholders = insertable.map(() => '?').join(', ');
          const params = insertable.map(c => toParam(values?.[c.field]));
          await client.query(
            `INSERT INTO ${qualifiedTable(database, table)} (${names}) VALUES (${placeholders})`,
            params,
          );
          await sendPage(page ?? 1, currentQuery);
          return;
        }
        case 'editCell': {
          // 右键"编辑"：用 VSCode 真实编辑器打开单元格，自动保存时写回本地暂存
          const { rowKey, field, value, pkValues } = msg.payload;
          if (!rowKey || !field) {
            sendError(t('missingCellLocator'));
            return;
          }
          await vscode.commands.executeCommand('connectToolbox.editCell', {
            title: `${database}.${table}_${field}`,
            value: value ?? '',
            language: detectLanguage(value ?? ''),
            onSave: (newValue: string) => {
              // 面板可能已关闭，postMessage 会 reject，忽略即可
              panel.webview.postMessage({
                type: 'cellEdited',
                payload: { rowKey, field, value: newValue, originalValue: value, pkValues },
              }).then(() => undefined, () => undefined);
            },
          });
          return;
        }
        case 'commit': {
          const { commit, page } = msg.payload;
          if (!commit) {
            sendError(t('missingCommitData'));
            return;
          }
          try {
            const columns = await client.describeTable(database, table);
            const { affected } = await client.commitChanges(database, table, commit, columns);
            panel.webview.postMessage({ type: 'commitResult', ok: true, message: t('commitSuccessRows', { count: affected }) });
            await sendPage(page ?? 1, currentQuery);
          } catch (err) {
            panel.webview.postMessage({ type: 'commitResult', ok: false, message: (err as Error).message });
          }
          return;
        }
        default:
          return;
      }
    } catch (err) {
      sendError((err as Error).message);
    }
  });

  void sendPage(1);
}

/** 获取面板 HTML：开发模式 → dev server；生产模式 → webview-dist 产物 */
function getPanelHtml(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  database: string,
  table: string,
): string {
  const isDev = !!process.env.CT_WEBVIEW_DEV;
  if (isDev) {
    return `<!DOCTYPE html>
<html lang="${locale()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' http://localhost:5173; script-src http://localhost:5173 'unsafe-inline'; connect-src http://localhost:5173 ws://localhost:5173; img-src http://localhost:5173 data:; font-src http://localhost:5173;">
</head>
<body>
<div id="root"></div>
<script type="module" src="${DEV_SERVER}/@vite/client"></script>
<script type="module">
import RefreshRuntime from '${DEV_SERVER}/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>
<script>window.__connectToolboxLocale = ${JSON.stringify(locale())}; window.__connectToolboxPanel = ${JSON.stringify('table')};</script>
<script type="module" src="${DEV_SERVER}/src/main.tsx?panel=table&db=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}&lang=${encodeURIComponent(locale())}"></script>
</body>
</html>`;
  }

  // 生产：读取 vite 构建产物 index.html，注入 panel 参数
  const distRoot = vscode.Uri.joinPath(context.extensionUri, 'webview-dist');
  const htmlPath = path.join(distRoot.fsPath, 'index.html');
  let html: string;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch {
    return `<html lang="${locale()}"><body style="color:var(--vscode-errorForeground);padding:16px">${t('frontendNotBuilt')}</body></html>`;
  }

  const csp = [
    `default-src 'none'`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `img-src ${panel.webview.cspSource} data:`,
  ].join('; ');

  // 替换相对资源为 asWebviewUri（vite base='./' 产物）
  html = html.replace(
    /(src|href)="(\.\/[^"]+)"/g,
    (m, attr: string, p: string) => {
      const uri = panel.webview.asWebviewUri(vscode.Uri.joinPath(distRoot, p.replace(/^\.\//, '')));
      return `${attr}="${uri}"`;
    },
  );

  // 注入 panel 参数到入口脚本
  html = html.replace(
    /<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/,
    (m, src: string) => `<script>window.__connectToolboxLocale = ${JSON.stringify(locale())}; window.__connectToolboxPanel = ${JSON.stringify('table')};</script>\n<script type="module" src="${src}?panel=table&db=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}&lang=${encodeURIComponent(locale())}"></script>`,
  );

  return html
    .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('</head>', `<style>body{margin:0}</style></head>`);
}

function whereSql(pkColumns: string[]): string {
  return ' WHERE ' + pkColumns.map(c => `\`${c.replace(/`/g, '``')}\` = ?`).join(' AND ');
}

function toParam(v: string | undefined): string | null {
  return v === undefined || v === '' ? null : v;
}
