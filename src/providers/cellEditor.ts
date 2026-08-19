import * as vscode from 'vscode';

/**
 * 单元格编辑器（右键"编辑"）：基于 FileSystemProvider 的可写虚拟文件。
 *
 * 为什么不用 TextDocumentContentProvider：该 API 创建的是只读文档，无法编辑也无法保存。
 * FileSystemProvider 是官方推荐的可读可写方案 —— 在真实 VSCode 编辑器中打开
 * （高亮 / 撤销 / 多光标），输入内容自动保存到内存虚拟文件，writeFile 回调把内容写回
 * webview 本地暂存（配合「提交变更」统一落库）。关闭编辑器不弹未保存提示。
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
/** 每个虚拟文档串行自动保存，避免快速输入时保存请求交叉 */
const autoSaveQueues = new Map<string, Promise<void>>();
/** 延迟清理，避免语言模式切换导致文档短暂关闭时误删内存文件 */
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    // 保存完成 → 写回 webview 本地暂存。
    // 这是编辑器自身发起的写入，不再额外广播 Changed，避免 VSCode 将刚保存的文档重新标记为 dirty。
    f?.onSave?.(value);
  },
  delete(uri: vscode.Uri): void {
    files.delete(uri.toString());
  },
  rename(): void {
    throw vscode.FileSystemError.Unavailable('not supported');
  },
};

/** 打开单元格编辑器；自动保存时回调 onSave，把新值写回本地暂存 */
export async function openCellEditor(params: {
  title: string;
  value: string;
  language?: string;
  onSave?: (value: string) => void;
}): Promise<void> {
  const extension = languageExtension(params.language);
  const uri = vscode.Uri.from({
    scheme: SCHEME,
    // 通过真实扩展名让 VSCode 自动识别语言，避免 setTextDocumentLanguage 触发文档关闭/重建
    path: `/${safeName(params.title)}.${extension}`,
    // 时间戳保证每次打开都是新文档（同 cell 重复编辑不冲突，preview 模式自动替换旧 tab）
    query: `v=${Date.now()}`,
  });
  files.set(uri.toString(), { content: params.value, mtime: Date.now(), onSave: params.onSave });
  const doc = await vscode.workspace.openTextDocument(uri);
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
  return (
    s
      // 文件名使用纯 ASCII，避免中点、箭头等字符造成标签显示异常
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/[_-]+/g, '_')
      .replace(/^[_.-]+|[_.-]+$/g, '')
      .slice(0, 60) || 'cell'
  );
}

function languageExtension(language?: string): string {
  switch (language) {
    case 'json':
      return 'json';
    case 'xml':
      return 'xml';
    default:
      return 'txt';
  }
}

function autoSaveDocument(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const previous = autoSaveQueues.get(key) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      // 不依赖 isDirty 的瞬时状态：变更事件触发后直接保存，确保关闭标签前文档变为 clean。
      // 保存到 FileSystemProvider 的内存文件，不会写入磁盘，也不会弹另存为。
      await document.save();
    })
    .catch(() => undefined);
  autoSaveQueues.set(key, next);
  void next.then(
    () => { if (autoSaveQueues.get(key) === next) autoSaveQueues.delete(key); },
    () => { if (autoSaveQueues.get(key) === next) autoSaveQueues.delete(key); },
  );
}

function scheduleCleanup(uri: vscode.Uri): void {
  const key = uri.toString();
  const previous = cleanupTimers.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    cleanupTimers.delete(key);
    // setTextDocumentLanguage 或重新打开同一 URI 期间不要清理
    const stillOpen = vscode.workspace.textDocuments.some(doc => doc.uri.toString() === key);
    if (!stillOpen) {
      files.delete(key);
      autoSaveQueues.delete(key);
    }
  }, 250);
  cleanupTimers.set(key, timer);
}

export function registerCellEditor(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true }),
    vscode.commands.registerCommand('connectToolbox.editCell', (params: Parameters<typeof openCellEditor>[0]) =>
      openCellEditor(params),
    ),
    // 每次输入立即自动保存，关闭编辑器时不再出现未保存提示
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === SCHEME && event.contentChanges.length > 0) {
        autoSaveDocument(event.document);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== SCHEME) return;
      const key = doc.uri.toString();
      const timer = cleanupTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        cleanupTimers.delete(key);
      }
    }),
    // 关闭事件可能由语言模式切换触发，延迟确认后再清理内存文件
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SCHEME) scheduleCleanup(doc.uri);
    }),
  );
}
