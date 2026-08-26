import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStore } from '../connection/ConnectionStore';
import { LocalePreference, locale, t } from '../i18n';
import { defaultMcpConfigPath, generateMcpConfig } from '../mcp/commands';
import { DEFAULT_MCP_KEY_PATH } from '../mcp/crypto';
import { readMcpStatuses } from '../mcp/status';
import { McpStatusView } from '../mcp/types';

let currentPanel: vscode.WebviewPanel | undefined;

interface SettingsPayload {
  language: LocalePreference;
  keyPath: string;
  configPath: string;
  statuses: McpStatusView[];
}

/** 打开设置面板（单例）：常规设置 + MCP 管理，全部使用自写 Webview。 */
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

  const statusDir = path.join(context.globalStorageUri.fsPath, 'mcp', 'status');

  const buildPayload = (): SettingsPayload => ({
    language: vscode.workspace.getConfiguration('connectToolbox').get<LocalePreference>('language', 'auto'),
    keyPath: DEFAULT_MCP_KEY_PATH,
    configPath: defaultMcpConfigPath(context),
    statuses: readMcpStatuses(statusDir),
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
        case 'refreshStatus': {
          send('status', buildPayload().statuses);
          break;
        }
        case 'generateConfig': {
          const result = await generateMcpConfig(context, store);
          send('status', buildPayload().statuses);
          if (result) {
            send('configChanged', {
              configPath: result.configPath,
              snippet: result.snippet,
              configText: result.configText,
            });
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
  select, input[type=text] {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: var(--radius);
    padding: 5px 8px; font-family: inherit; font-size: 13px; outline: none;
  }
  select:focus, input:focus { border-color: var(--vscode-focusBorder); }
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
  .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; word-break: break-all; }
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
  .status-list { display: flex; flex-direction: column; gap: 6px; }
  .status-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius); background: var(--vscode-editor-background); }
  .status-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.running { background: var(--vscode-testing-iconPassed, #89d185); }
  .status-dot.stopped { background: var(--vscode-descriptionForeground); }
  .status-dot.error { background: var(--vscode-errorForeground); }
  .status-main { flex: 1; min-width: 0; }
  .status-name { font-weight: 600; }
  .status-detail { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; word-break: break-all; }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; }
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
    <div class="section">
      <div class="section-title">${t('settingsMcpStatus')}</div>
      <div class="row">
        <label>${t('settingsMcpKeyPath')}</label>
        <input type="text" id="keyPath" readonly>
      </div>
      <div class="row">
        <label>${t('settingsConfigPath')}</label>
        <input type="text" id="configPath" readonly>
      </div>
      <div class="hint">${t('settingsMcpGenerateHint')}</div>
      <div class="actions" style="margin-top:10px">
        <button id="generateConfig">${t('settingsGenerateConfig')}</button>
        <button class="secondary" id="refreshStatus">${t('settingsRefresh')}</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">${t('settingsAgentSnippet')}</div>
      <pre id="agentSnippet" class="code-preview">${t('settingsNoConfigYet')}</pre>
      <div class="actions" style="margin-top:10px">
        <button class="secondary" id="copySnippet">${t('settingsCopyAgentConfig')}</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">${t('settingsMcpConfigContent')}</div>
      <pre id="configText" class="code-preview">${t('settingsNoConfigYet')}</pre>
      <div class="hint">${t('settingsMcpConfigHint')}</div>
      <div class="actions" style="margin-top:10px">
        <button class="secondary" id="copyConfig">${t('settingsCopyConfig')}</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">${t('settingsMcpInstances')}</div>
      <div class="status-list" id="statusList"></div>
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

  function statusLabel(status) {
    var kind = status.status;
    if (kind === 'running' || kind === 'starting') {
      return status.alive ? '${t('settingsInstanceRunning')}' : '${t('settingsInstanceStopped')}';
    }
    if (kind === 'error') { return '${t('settingsInstanceError')}'; }
    return '${t('settingsInstanceStopped')}';
  }

  function dotClass(status) {
    if (status.status === 'error') { return 'error'; }
    if (status.status === 'running' || status.status === 'starting') {
      return status.alive ? 'running' : 'stopped';
    }
    return 'stopped';
  }

  function renderStatuses(statuses) {
    var list = $('statusList');
    list.innerHTML = '';
    if (!statuses || statuses.length === 0) {
      list.innerHTML = '<div class="empty">${t('settingsMcpNoInstances')}</div>';
      return;
    }
    statuses.forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'status-item';
      var detail = [
        'PID ' + s.pid,
        (s.client && s.client.name) ? (s.client.name + (s.client.version ? ' v' + s.client.version : '')) : '${t('settingsAgentUnknown')}',
        s.lastHeartbeat
      ].join(' · ');
      item.innerHTML = '<span class="status-dot ' + dotClass(s) + '"></span>' +
        '<div class="status-main"><div class="status-name">' + statusLabel(s) + '</div>' +
        '<div class="status-detail">' + escapeHtml(detail) + '</div></div>';
      list.appendChild(item);
    });
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderSnippet(snippet) {
    $('agentSnippet').textContent = snippet ? snippet : '${t('settingsNoConfigYet')}';
  }

  function renderConfigText(configText) {
    $('configText').textContent = configText ? configText : '${t('settingsNoConfigYet')}';
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
  $('copyConfig').addEventListener('click', function () {
    notice('', '');
    vscode.postMessage({ type: 'copyText', payload: $('configText').textContent });
  });
  $('refreshStatus').addEventListener('click', function () {
    vscode.postMessage({ type: 'refreshStatus' });
  });
  $('openNative').addEventListener('click', function () {
    vscode.postMessage({ type: 'openNativeSettings' });
  });

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (msg.type === 'init') {
      var p = msg.payload;
      $('language').value = p.language || 'auto';
      $('keyPath').value = p.keyPath || '';
      $('configPath').value = p.configPath || '';
      renderSnippet(p.snippet);
      renderConfigText(p.configText);
      renderStatuses(p.statuses);
    } else if (msg.type === 'languageChanged') {
      $('language').value = msg.payload.language;
    } else if (msg.type === 'status') {
      renderStatuses(msg.payload);
    } else if (msg.type === 'configChanged') {
      $('configPath').value = msg.payload.configPath || '';
      renderSnippet(msg.payload.snippet);
      renderConfigText(msg.payload.configText);
    } else if (msg.type === 'notice') {
      notice(msg.payload.kind, msg.payload.message);
    }
  });

  vscode.postMessage({ type: 'getInit' });
  vscode.postMessage({ type: 'refreshStatus' });
})();
</script>
</body>
</html>`;
}
