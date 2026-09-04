import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { locale } from '../i18n';

const DEV_SERVER = 'http://localhost:5173';

/**
 * 生成加载 React webview 产物（webview-dist）的 HTML，并按 panel 注入 URL 参数。
 * 供表数据 / 查询结果等所有 React 面板复用（生产走 webview-dist，开发走 vite dev server）。
 * @param panel 'table' | 'query' 等，透传进入口脚本 ?panel=...
 * @param params 其余面板参数（db/table/conn...），均作为查询串传给前端
 */
export function getReactPanelHtml(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  viewId: string,
  params: Record<string, string>,
): string {
  const isDev = !!process.env.CT_WEBVIEW_DEV;
  const qs = new URLSearchParams({ panel: viewId, lang: locale(), ...params });
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
<script>window.__connectToolboxLocale = ${JSON.stringify(locale())}; window.__connectToolboxPanel = ${JSON.stringify(viewId)};</script>
<script type="module" src="${DEV_SERVER}/src/main.tsx?${qs.toString()}"></script>
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
    return `<html lang="${locale()}"><body style="color:var(--vscode-errorForeground);padding:16px">Frontend assets are not built. Run \`npm run build:webview\` first.</body></html>`;
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
    (m, src: string) => `<script>window.__connectToolboxLocale = ${JSON.stringify(locale())}; window.__connectToolboxPanel = ${JSON.stringify(viewId)};</script>\n<script type="module" src="${src}?${qs.toString()}"></script>`,
  );

  return html
    .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('</head>', `<style>body{margin:0}</style></head>`);
}
