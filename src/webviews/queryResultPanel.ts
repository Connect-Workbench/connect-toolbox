import * as vscode from 'vscode';
import { ConnectionConfig } from '../connection/types';
import { ConnectionManager } from '../connection/ConnectionManager';
import { QueryResult, splitSqlStatements } from '../clients/MySqlClient';
import { getReactPanelHtml } from './reactWebview';
import { info, error } from '../utils/logger';
import { t } from '../i18n';

/**
 * 查询结果面板：每个连接最多一个复用 Webview（React，`?panel=query`）。
 *
 * 角色：本模块是"执行 + 展示"的唯一编排者。SQL 文本由真实 .sql 编辑器持有，
 * run 命令从编辑器取文本后调用 {@link runAndShow}；结果面板只负责
 * - 顶部：连接名（库上下文由 .sql 编辑器文件名指示，不做库切换）
 * - 主体：多结果集 resultTabs（一次 Run 的每条语句一个 tab，SQLTools 风格）
 * - 出错：遇错即停，展示失败语句序号与原因
 *
 * host -> webview:
 *   { type:'init', payload:{ connectionName } }
 *   { type:'results', payload:{ tabs, sql, error? } }
 * webview -> host:
 *   { type:'ready' }
 */

const panels = new Map<string, vscode.WebviewPanel>();
/** 每个面板是否已就绪（webview 发来 ready 后才推送结果/init，避免首帧消息丢失） */
const panelReady = new Map<string, boolean>();
/** 待推送的 results（面板尚未就绪时暂存，就绪后补发） */
const pendingResults = new Map<string, { type: 'results'; payload: unknown }>();

export interface ResultTab extends QueryResult {
  /** 该结果对应的原始 SQL 语句 */
  statement: string;
  /** 失败标记（仅当该语句执行失败且停在这里） */
  failed?: boolean;
}

interface WebMsg {
  type: string;
  payload?: { database?: string };
}

/** 安全地向某连接面板推消息：就绪则直发，未就绪则暂存 */
function post(connId: string, msg: { type: string; payload?: unknown }): void {
  const panel = panels.get(connId);
  if (!panel) return;
  if (!panelReady.get(connId)) {
    pendingResults.set(connId, msg as { type: 'results'; payload: unknown });
    return;
  }
  void panel.webview.postMessage(msg).then(
    () => undefined,
    (err) => error('postMessage failed', connId, (err as Error).message),
  );
}

/**
 * 在某连接上执行一段 SQL 并把结果送到该连接的结果面板（不存在则先创建）。
 * - 按分词器切分后逐条顺序执行；**遇错即停**。
 * - 已成功语句的结果按序保留在 resultTabs；失败语句以 error 附带在第几条处停下。
 * @param sql 整段 SQL（可能含多条）
 * @param preferDatabase 执行前优先 USE 的库；未传则用连接当前已选库
 */
export async function runAndShow(
  context: vscode.ExtensionContext,
  manager: ConnectionManager,
  config: ConnectionConfig,
  sql: string,
  preferDatabase?: string,
): Promise<void> {
  info('query run requested', config.name, String(sql).slice(0, 120));
  const client = manager.getMySqlClient(config.id);
  const panel = openQueryResultPanel(context, manager, config);

  if (!client) {
    postError(config.id, t('mysqlNotConnectedShort'), 0, sql);
    return;
  }
  try {
    if (preferDatabase && preferDatabase !== client.currentDatabase) {
      await client.useDatabase(preferDatabase);
    }
  } catch (err) {
    error('useDatabase failed', (err as Error).message);
    postError(config.id, (err as Error).message, 0, sql);
    return;
  }

  const statements = splitSqlStatements(sql);
  const tabs: ResultTab[] = [];
  let runError: { message: string; statementIndex?: number; statementText?: string } | undefined;

  for (let i = 0; i < statements.length; i += 1) {
    const stmt = statements[i];
    try {
      const r = await client.query(stmt.text);
      tabs.push({ ...r, statement: stmt.text });
    } catch (err) {
      error('statement failed', String(i + 1), (err as Error).message);
      runError = {
        message: (err as Error).message,
        statementIndex: i + 1,
        statementText: stmt.text,
      };
      break; // 遇错即停
    }
  }

  info('query done', config.name, 'statements=', String(statements.length), 'tabs=', String(tabs.length));
  post(config.id, { type: 'results', payload: { tabs, sql, error: runError } });
}

function postError(
  connId: string,
  message: string,
  statementIndex?: number,
  statementText?: string,
): void {
  post(connId, {
    type: 'results',
    payload: { tabs: [], sql: '', error: { message, statementIndex, statementText } },
  });
}

/** 打开（或复用并聚焦）某连接的结果面板 */
export function openQueryResultPanel(
  context: vscode.ExtensionContext,
  manager: ConnectionManager,
  config: ConnectionConfig,
): vscode.WebviewPanel {
  let panel = panels.get(config.id);
  if (panel) {
    panel.reveal(vscode.ViewColumn.Two);
    return panel;
  }

  panel = vscode.window.createWebviewPanel(
    `connectToolbox.queryResult.${config.id}`,
    t('queryPanelTitle', { name: config.name }),
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview-dist')],
    },
  );
  panel.webview.html = getReactPanelHtml(context, panel, 'query', {
    conn: config.id,
    connName: config.name,
  });
  panels.set(config.id, panel);
  panelReady.set(config.id, false);

  // 面板消息：就绪握手 → 补发 init（连接名）与就绪前暂存的结果
  panel.webview.onDidReceiveMessage(async (msg: WebMsg) => {
    if (msg.type !== 'ready') {
      return;
    }
    panelReady.set(config.id, true);
    post(config.id, { type: 'init', payload: { connectionName: config.name } });
    const pending = pendingResults.get(config.id);
    if (pending) {
      pendingResults.delete(config.id);
      post(config.id, pending);
    }
  });

  panel.onDidDispose(() => {
    if (panels.get(config.id) === panel) {
      panels.delete(config.id);
      panelReady.delete(config.id);
      pendingResults.delete(config.id);
    }
  });
  return panel;
}
