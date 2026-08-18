/**
 * Webview ↔ 插件主进程消息桥接（acquireVsCodeApi 封装）。
 * 与主进程 tablePanel.ts 的 postMessage/onDidReceiveMessage 协议对应。
 */

interface VscodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

let api: VscodeApi | undefined;

export function getVscode(): VscodeApi {
  if (!api) {
    // vite dev 模式（浏览器预览）时 acquireVsCodeApi 不存在，降级为 no-op
    const g = globalThis as unknown as { acquireVsCodeApi?: () => VscodeApi };
    api = typeof g.acquireVsCodeApi === 'function' ? g.acquireVsCodeApi() : { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
  }
  return api;
}

export function postMessage(msg: unknown): void {
  getVscode().postMessage(msg);
}

/** 订阅主进程消息，返回取消函数 */
export function onMessage<T = unknown>(handler: (msg: T) => void): () => void {
  const listener = (e: MessageEvent) => handler(e.data as T);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
