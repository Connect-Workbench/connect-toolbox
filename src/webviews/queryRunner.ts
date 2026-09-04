import * as vscode from 'vscode';
import { ConnectionStore } from '../connection/ConnectionStore';
import { ConnectionManager } from '../connection/ConnectionManager';
import { splitSqlStatements } from '../clients/MySqlClient';
import { sqlScheme, contextFromUri } from './sqlEditor';
import { runAndShow } from './queryResultPanel';
import { t } from '../i18n';

/**
 * 在真实 .sql 编辑器上执行 SQL（复用 VS Code 能力）：
 * - runSelectedOrStatement：有选中跑选中；无选中跑光标所在语句
 * - runAll：跑整篇（多条则逐条顺序执行，遇错即停）
 * SQL 文本来自当前活动的本扩展 scheme (.sql) 文档；执行上下文（连接/库）绑定在文档 URI。
 */

function activeSqlEditor(): { document: vscode.TextDocument; selection: vscode.Selection } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== sqlScheme) {
    return undefined;
  }
  return { document: editor.document, selection: editor.selection };
}

/** 取当前活动文档要执行的 SQL：无选中→光标所在语句；有选中→选中文本 */
function resolveSql(editor: { document: vscode.TextDocument; selection: vscode.Selection }): string | undefined {
  const text = editor.document.getText();
  if (!editor.selection.isEmpty) {
    const sel = editor.document.getText(editor.selection);
    return sel.trim();
  }
  // 光标定位：所属语句
  const offset = editor.document.offsetAt(editor.selection.active);
  const statements = splitSqlStatements(text);
  for (const s of statements) {
    if (offset >= s.start && offset <= s.end) {
      return s.text;
    }
  }
  return undefined;
}

async function runCurrent(store: ConnectionStore, manager: ConnectionManager, all: boolean): Promise<void> {
  const editor = activeSqlEditor();
  if (!editor) {
    vscode.window.showWarningMessage(t('runSqlRequiresEditor'));
    return;
  }
  const ctx = contextFromUri(editor.document.uri);
  if (!ctx) {
    vscode.window.showWarningMessage(t('runSqlRequiresEditor'));
    return;
  }
  const config = store.get(ctx.connId);
  if (!config) {
    vscode.window.showWarningMessage(t('runSqlRequiresEditor'));
    return;
  }
  if (manager.getStatus(config.id) !== 'connected') {
    vscode.window.showWarningMessage(t('mysqlNotConnected'));
    return;
  }

  const sql = all
    ? editor.document.getText().trim()
    : resolveSql(editor);

  if (!sql) {
    vscode.window.showWarningMessage(t('enterSql'));
    return;
  }
  if (!currentContext) return;
  await runAndShow(currentContext, manager, config, sql, ctx.database);
}

let currentContext: vscode.ExtensionContext | undefined;

/** 注册 run 命令（host），把当前活动 sql 编辑器的文本交给结果面板执行 */
export function registerQueryRunnerCommands(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  manager: ConnectionManager,
): void {
  currentContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('connectToolbox.runSql', () => runCurrent(store, manager, false)),
    vscode.commands.registerCommand('connectToolbox.runAllSql', () => runCurrent(store, manager, true)),
  );
}
