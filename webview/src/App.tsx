import React from 'react';
import TablePanel from './panels/tablePanel';
import { t } from './i18n';

/**
 * 面板入口：当前启动的 webview 面板类型由主进程通过 URL 参数指定。
 * 注意：使用静态 import（避免动态 chunk 在 webview 资源替换中的路径问题）。
 */
export default function App(): React.JSX.Element {
  const params = new URLSearchParams(window.location.search);
  const panel = params.get('panel') || 'table';
  switch (panel) {
    case 'table':
      return <TablePanel />;
    default:
      return <div>{t('unknownPanel', { panel })}</div>;
  }
}
