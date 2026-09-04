import React from 'react';
import TablePanel from './panels/tablePanel';
import QueryResultPanel from './panels/queryPanel';
import { t } from './i18n';

declare global {
  interface Window {
    /** host 注入的面板类型（'table' | 'query'），见 reactWebview.ts 的 document 内联脚本 */
    __connectToolboxPanel?: string;
  }
}

/**
 * 面板入口：由主进程注入到 document 的 window.__connectToolboxPanel 决定
 * （放在 document 级内联脚本里，而不是入口 JS 的 query string —— query string
 *  挂在 JS bundle URL 上，window.location.search 读不到）。
 * 注意：使用静态 import（避免动态 chunk 在 webview 资源替换中的路径问题）。
 */
export default function App(): React.JSX.Element {
  const params = new URLSearchParams(window.location.search);
  const panel = window.__connectToolboxPanel || params.get('panel') || 'table';
  switch (panel) {
    case 'table':
      return <TablePanel />;
    case 'query':
      return <QueryResultPanel />;
    default:
      return <div>{t('unknownPanel', { panel })}</div>;
  }
}
