import * as vscode from 'vscode';

/**
 * 单元格编辑器（右键"编辑"）：基于 FileSystemProvider 的可写虚拟文件。
 *
 * 为什么不用 TextDocumentContentProvider：该 API 创建的是只读文档，无法编辑也无法保存。
 * FileSystemProvider 是官方推荐的可读可写方案 —— 在真实 VSCode 编辑器中打开
 * （高亮 / 撤销 / 多光标），Cmd+S 保存不弹另存为，writeFile 回调把内容写回
 * webview 本地暂存（配合「提交变更」统一落库）。
 */
const SCHEME = 'connecttoolbox-cell';

interface CellFile {
  content: string;
  mtime: number;
  /** 保存时回调：把新内容写回对应的 webview 面板 */
  onSave?: (value: string) => void;
}

const files = new Map<string, CellFile>();
const emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

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
  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
    const key = uri.toString();
    const f = files.get(key);
    if (!f && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (f && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    const value = Buffer.from(content).toString('utf8');
    files.set(key, { content: value, mtime: Date.now(), onSave: f?.onSave });
    // 保存完成 → 写回 webview 本地暂存
    f?.onSave?.(value);
    emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  },
  delete(uri: vscode.Uri): void {
    files.delete(uri.toString());
  },
  rename(): void {
    throw vscode.FileSystemError.Unavailable('not supported');
  },
};

/** 打开单元格编辑器；保存（Cmd+S）时回调 onSave，把新值写回本地暂存 */
export async function openCellEditor(params: {
  title: string;
  value: string;
  language?: string;
  onSave?: (value: string) => void;
}): Promise<void> {
  const uri = vscode.Uri.from({
    scheme: SCHEME,
    path: `/${safeName(params.title)}.txt`,
    // 时间戳保证每次打开都是新文档（同 cell 重复编辑不冲突，preview 模式自动替换旧 tab）
    query: `v=${Date.now()}`,
  });
  files.set(uri.toString(), { content: params.value, mtime: Date.now(), onSave: params.onSave });
  const doc = await vscode.workspace.openTextDocument(uri);
  if (params.language && params.language !== 'plaintext') {
    try {
      await vscode.languages.setTextDocumentLanguage(doc, params.language);
    } catch {
      // 语言设置失败不影响编辑
    }
  }
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

/** 简单语言推断：JSON / XML / 纯文本，给编辑器选高亮 */
export function detectLanguage(value: string): string {
  const t = value.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    return 'json';
  }
  if (t.startsWith('<')) {
    return 'xml';
  }
  return 'plaintext';
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'cell';
}

export function registerCellEditor(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true }),
    vscode.commands.registerCommand('connectToolbox.editCell', (params: Parameters<typeof openCellEditor>[0]) =>
      openCellEditor(params),
    ),
    // 关闭编辑器时清理内存文件，避免泄漏
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SCHEME) {
        files.delete(doc.uri.toString());
      }
    }),
  );
}
