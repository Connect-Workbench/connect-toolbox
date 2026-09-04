import * as vscode from 'vscode';
import { ConnectionConfig } from '../connection/types';

/**
 * SQL 编辑器虚拟文档（真实 VS Code 编辑器承载可执行 SQL）。
 *
 * 复刻 cellEditor.ts 的做法：注册一个可读写 FileSystemProvider（scheme=connecttoolbox-sql），
 * 用真实 VSCode 文本编辑器打开 SQL（语法高亮/多光标/撤销均来自 VSCode 内置 sql 语言），
 * 文档内容自动保存到内存虚拟文件。连接与当前库编码在 URI 上，供 run 命令定位执行上下文。
 */

const SCHEME = 'connecttoolbox-sql';

/** 每个虚拟文档的文件内容 + 执行上下文（连接 + 当前库） */
export interface SqlDocContext {
  connId: string;
  database?: string;
  content: string;
  mtime: number;
}

const files = new Map<string, SqlDocContext>();
const emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
/** 每个虚拟文档串行自动保存，避免快速输入时保存请求交叉 */
const autoSaveQueues = new Map<string, Promise<void>>();
/** 延迟清理，避免语言模式切换导致文档短暂关闭时误删内存文件 */
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const sqlScheme = SCHEME;

const provider: vscode.FileSystemProvider = {
  onDidChangeFile: emitter.event,
  watch: () => new vscode.Disposable(() => undefined),
  stat(uri: vscode.Uri): vscode.FileStat {
    const f = files.get(uri.toString());
    if (!f) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      type: vscode.FileType.File,
      ctime: f.mtime,
      mtime: f.mtime,
      size: Buffer.byteLength(f.content, 'utf8'),
    };
  },
  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.Unavailable('not supported');
  },
  createDirectory(): void {
    throw vscode.FileSystemError.Unavailable('not supported');
  },
  readFile(uri: vscode.Uri): Uint8Array {
    const f = files.get(uri.toString());
    if (!f) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return Buffer.from(f.content, 'utf8');
  },
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const key = uri.toString();
    const prev = files.get(key);
    if (!prev) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    files.set(key, { ...prev, content: Buffer.from(content).toString('utf8'), mtime: Date.now() });
  },
  delete(uri: vscode.Uri): void {
    files.delete(uri.toString());
  },
  rename(): void {
    throw vscode.FileSystemError.Unavailable('not supported');
  },
};

/** 从虚拟文档 URI 反解执行上下文 */
export function contextFromUri(uri: vscode.Uri): { connId: string; database?: string } | undefined {
  const f = files.get(uri.toString());
  if (!f) {
    return undefined;
  }
  return { connId: f.connId, database: f.database };
}

/**
 * 打开一个新的 SQL 编辑器（真实 VSCode 编辑器），绑定某连接与可选初始库。
 * 每次打开都是新文档（时间戳保证不冲突），preview 模式自动替换旧标签。
 */
export async function openSqlEditor(
  config: ConnectionConfig,
  database: string | undefined,
  initialSql = '',
): Promise<void> {
  const name = safeName(`${config.name}_${database ?? 'adhoc'}`);
  const uri = vscode.Uri.from({
    scheme: SCHEME,
    path: `/${name}.sql`,
    query: `v=${Date.now()}&conn=${encodeURIComponent(config.id)}`,
  });
  files.set(uri.toString(), {
    connId: config.id,
    database,
    content: initialSql,
    mtime: Date.now(),
  });
  const doc = await vscode.workspace.openTextDocument(uri);
  // 文件名为 .sql，VSCode 自动关联内置 sql 语言（语法高亮/折叠）；无需手动 setLanguage
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
}

function safeName(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/[_-]+/g, '_')
      .replace(/^[_.-]+|[_.-]+$/g, '')
      .slice(0, 60) || 'query'
  );
}

function autoSaveDocument(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const previous = autoSaveQueues.get(key) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await document.save();
    })
    .catch(() => undefined);
  autoSaveQueues.set(key, next);
  void next.then(
    () => {
      if (autoSaveQueues.get(key) === next) autoSaveQueues.delete(key);
    },
    () => {
      if (autoSaveQueues.get(key) === next) autoSaveQueues.delete(key);
    },
  );
}

function scheduleCleanup(uri: vscode.Uri): void {
  const key = uri.toString();
  const previous = cleanupTimers.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    cleanupTimers.delete(key);
    const stillOpen = vscode.workspace.textDocuments.some(doc => doc.uri.toString() === key);
    if (!stillOpen) {
      files.delete(key);
      autoSaveQueues.delete(key);
    }
  }, 250);
  cleanupTimers.set(key, timer);
}

/** 注册 sql 虚拟文档 FileSystemProvider 及自动保存/清理钩子 */
export function registerSqlEditor(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === SCHEME && event.contentChanges.length > 0) {
        autoSaveDocument(event.document);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== SCHEME) return;
      const timer = cleanupTimers.get(doc.uri.toString());
      if (timer) {
        clearTimeout(timer);
        cleanupTimers.delete(doc.uri.toString());
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SCHEME) scheduleCleanup(doc.uri);
    }),
  );
}
