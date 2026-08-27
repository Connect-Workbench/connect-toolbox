import * as vscode from 'vscode';
import { ConnectionStore } from '../connection/ConnectionStore';
import { LocalePreference, locale, t } from '../i18n';
import { generateMcpConfig } from '../mcp/commands';

let currentPanel: vscode.WebviewPanel | undefined;

interface SettingsPayload {
  language: LocalePreference;
}

/** 打开设置面板（单例）：常规设置 + MCP 配置生成与展示。 */
export function openSettingsPanel(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
): vscode.WebviewPanel {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    return currentPanel;
  }

  const panel = vscode.window.createWebviewPanel(
    'connectToolbox.settings',
    t('settingsPanelTitle'),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );
  currentPanel = panel;

  panel.webview.html = renderHtml(panel.webview);

  const buildPayload = (): SettingsPayload => ({
    language: vscode.workspace.getConfiguration('connectToolbox').get<LocalePreference>('language', 'auto'),
  });

  const send = (type: string, payload?: unknown) => {
    if (!panel.webview) return;
    void Promise.resolve(panel.webview.postMessage({ type, payload })).catch(() => undefined);
  };

  send('init', buildPayload());

  const configListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('connectToolbox.language')) {
      send('languageChanged', {
        language: vscode.workspace.getConfiguration('connectToolbox').get<LocalePreference>('language', 'auto'),
      });
    }
  });
  panel.onDidDispose(() => {
    configListener.dispose();
    currentPanel = undefined;
  });

  panel.webview.onDidReceiveMessage(async (msg: { type: string; payload?: unknown }) => {
    try {
      switch (msg.type) {
        case 'getInit': {
          send('init', buildPayload());
          break;
        }
        case 'setLanguage': {
          const language = String(msg.payload);
          await vscode.workspace
            .getConfiguration('connectToolbox')
            .update('language', language, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'generateConfig': {
          const result = await generateMcpConfig(context, store);
          if (result) {
            send('configChanged', { snippet: result.snippet });
            const skippedText = result.skipped > 0 ? ` ${t('mcpSkippedConnections', { count: result.skipped })}` : '';
            send('notice', { kind: 'ok', message: `${t('settingsConfigGenerated')}${skippedText}` });
          }
          break;
        }
        case 'copyText': {
          const text = String(msg.payload ?? '');
          if (text) {
            await vscode.env.clipboard.writeText(text);
            send('notice', { kind: 'ok', message: t('settingsCopied') });
          }
          break;
        }
        case 'openNativeSettings': {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            `@ext:${context.extension.id}`,
          );
          break;
        }
        default:
          break;
      }
    } catch (error) {
      send('notice', { kind: 'error', message: (error as Error).message });
    }
  });

  return panel;
}

function renderHtml(webview: vscode.Webview): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${locale()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { --radius: 4px; }
  body { padding: 20px 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .wrap { max-width: 760px; margin: 0 auto; }
  .tabs { display: flex; gap: 6px; margin-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab {
    background: none; border: none; color: var(--vscode-descriptionForeground);
    padding: 8px 14px; cursor: pointer; font-size: 13px;
    border-bottom: 2px solid transparent;
  }
  .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .tab:hover { color: var(--vscode-foreground); }
  .page { display: none; }
  .page.active { display: block; }
  .section { margin-bottom: 16px; padding: 14px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); }
  .section-title { font-size: 12px; font-weight: 600; margin-bottom: 10px; color: var(--vscode-descriptionForeground); }
  .row { margin-bottom: 12px; }
  .row label { display: block; margin-bottom: 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  select {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: var(--radius);
    padding: 5px 8px; font-family: inherit; font-size: 13px; outline: none;
  }
  select:focus { border-color: var(--vscode-focusBorder); }
  select option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: var(--radius); padding: 6px 14px; cursor: pointer; font-size: 13px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .code-preview {
    margin: 0;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
    padding: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 280px;
    overflow: auto;
  }
  #notice { margin-top: 12px; font-size: 12px; display: none; }
  #notice.show { display: block; }
  #notice.ok { color: var(--vscode-testing-iconPassed, #89d185); }
  #notice.error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<div class="wrap">
  <div class="tabs">
    <button class="tab active" id="tabGeneral">${t('settingsGeneral')}</button>
    <button class="tab" id="tabMcp">${t('settingsMcp')}</button>
  </div>

  <div class="page active" id="pageGeneral">
    <div class="section">
      <div class="section-title">${t('settingsGeneral')}</div>
      <div class="row">
        <label>${t('settingsLanguage')}</label>
        <select id="language">
          <option value="auto">${t('settingsLanguageAuto')}</option>
          <option value="zh-CN">${t('settingsLanguageZh')}</option>
          <option value="en-US">${t('settingsLanguageEn')}</option>
        </select>
        <div class="hint">${t('settingsLanguageHint')}</div>
      </div>
      <div class="actions">
        <button class="secondary" id="openNative">${t('settingsOpenNative')}</button>
      </div>
    </div>
  </div>

  <div class="page" id="pageMcp">
    <div class="actions">
      <button id="generateConfig">${t('settingsGenerateConfig')}</button>
    </div>
    <div class="hint">${t('settingsMcpGenerateHint')}</div>

    <div class="section">
      <div class="section-title">${t('settingsAgentSnippet')}</div>
      <pre id="agentSnippet" class="code-preview">${t('settingsNoConfigYet')}</pre>
      <div class="actions" style="margin-top:10px">
        <button class="secondary" id="copySnippet">${t('settingsCopyAgentConfig')}</button>
      </div>
    </div>
  </div>

  <div id="notice"></div>
</div>

<script>
(function () {
  var vscode = acquireVsCodeApi();
  function $(id) { return document.getElementById(id); }

  function showTab(name) {
    $('tabGeneral').classList.toggle('active', name === 'general');
    $('tabMcp').classList.toggle('active', name === 'mcp');
    $('pageGeneral').classList.toggle('active', name === 'general');
    $('pageMcp').classList.toggle('active', name === 'mcp');
  }

  function notice(kind, msg) {
    var el = $('notice');
    el.textContent = msg;
    el.classList.toggle('show', !!msg);
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('error', kind === 'error');
  }

  function renderSnippet(snippet) {
    $('agentSnippet').textContent = snippet ? snippet : '${t('settingsNoConfigYet')}';
  }

  $('tabGeneral').addEventListener('click', function () { showTab('general'); });
  $('tabMcp').addEventListener('click', function () { showTab('mcp'); });

  $('language').addEventListener('change', function () {
    vscode.postMessage({ type: 'setLanguage', payload: $('language').value });
  });

  $('generateConfig').addEventListener('click', function () {
    notice('', '');
    vscode.postMessage({ type: 'generateConfig' });
  });
  $('copySnippet').addEventListener('click', function () {
    notice('', '');
    vscode.postMessage({ type: 'copyText', payload: $('agentSnippet').textContent });
  });
  $('openNative').addEventListener('click', function () {
    vscode.postMessage({ type: 'openNativeSettings' });
  });

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (msg.type === 'init') {
      var p = msg.payload;
      $('language').value = p.language || 'auto';
    } else if (msg.type === 'languageChanged') {
      $('language').value = msg.payload.language;
    } else if (msg.type === 'configChanged') {
      renderSnippet(msg.payload.snippet);
    } else if (msg.type === 'notice') {
      notice(msg.payload.kind, msg.payload.message);
    }
  });

  vscode.postMessage({ type: 'getInit' });
})();
</script>
</body>
</html>`;
}
