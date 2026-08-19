import * as vscode from 'vscode';
import { t } from '../i18n';

const SCHEME = 'connecttoolbox-ddl';
const contents = new Map<string, string>();

/**
 * 只读 DDL 文档：由 TextDocumentContentProvider 提供内容，
 * VSCode 对这类文档强制只读（无法编辑），无需保存，关闭即消失。
 */
export function registerDdlProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: uri =>
        contents.get(uri.toString()) ?? t('ddlExpired'),
    }),
  );
}

/** 以只读虚拟文档打开 DDL（SQL 高亮 + 预览模式） */
export async function showDdl(table: string, ddl: string): Promise<void> {
  const uri = vscode.Uri.from({
    scheme: SCHEME,
    path: `/${table}.sql`,
    // 时间戳保证每次查看都是新文档（同名表重复查看也不冲突）
    query: `v=${Date.now()}`,
  });
  contents.set(uri.toString(), ddl);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'sql');
  await vscode.window.showTextDocument(doc, { preview: true });
}
