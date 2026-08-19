import * as vscode from 'vscode';
import { ConnectionConfig } from '../connection/types';
import { ConnectionManager } from '../connection/ConnectionManager';
import { QueryResult } from '../clients/MySqlClient';
import { locale, t } from '../i18n';

interface ExecuteMessage {
  type: 'execute';
  payload: { sql: string };
}

/**
 * MySQL 查询面板：上方 SQL 编辑器 + 下方结果表格（多结果集分页签）。
 */
export function openQueryPanel(
  context: vscode.ExtensionContext,
  manager: ConnectionManager,
  config: ConnectionConfig,
): void {
  const panel = vscode.window.createWebviewPanel(
    `connectToolbox.query.${config.id}`,
    t('queryPanelTitle', { name: config.name }),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  panel.webview.html = renderHtml(panel.webview);
  panel.webview.postMessage({ type: 'init', payload: { connectionName: config.name } });

  panel.webview.onDidReceiveMessage(async (msg: ExecuteMessage) => {
    if (msg.type !== 'execute') {
      return;
    }
    const client = manager.getMySqlClient(config.id);
    if (!client) {
      panel.webview.postMessage({ type: 'error', message: t('mysqlNotConnected') });
      return;
    }
    try {
      const result = await client.query(msg.payload.sql);
      panel.webview.postMessage({ type: 'result', payload: result });
    } catch (err) {
      panel.webview.postMessage({ type: 'error', message: (err as Error).message });
    }
  });
}

function renderHtml(webview: vscode.Webview): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${locale()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { padding: 0; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); display: flex; flex-direction: column; height: 100vh; }
  .editor-bar { padding: 8px 10px 0; }
  #sqlEditor {
    width: 100%; box-sizing: border-box; min-height: 90px; resize: vertical;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
    padding: 8px; outline: none; line-height: 1.5;
  }
  #sqlEditor:focus { border-color: var(--vscode-focusBorder); }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 5px 14px; cursor: pointer; font-size: 13px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .status { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .status.error { color: var(--vscode-errorForeground); }
  .results { flex: 1; overflow: auto; border-top: 1px solid var(--vscode-panel-border); }
  .tabs { display: flex; gap: 2px; padding: 6px 10px 0; position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 2; }
  .tab {
    padding: 4px 12px; cursor: pointer; border: 1px solid var(--vscode-panel-border);
    border-bottom: none; border-radius: 4px 4px 0 0; font-size: 12px;
    background: var(--vscode-editorWidget-background, transparent);
    color: var(--vscode-descriptionForeground);
  }
  .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tab:hover:not(.active) { background: var(--vscode-list-hoverBackground); }
  .result-meta { padding: 4px 12px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .table-wrap { overflow: auto; padding: 0 10px 10px; }
  table { border-collapse: collapse; font-size: 12px; min-width: 100%; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; white-space: nowrap; text-align: left; }
  th { position: sticky; top: 0; background: var(--vscode-editor-background); font-weight: 600; z-index: 1; }
  tr:nth-child(even) td { background: var(--vscode-sideBar-background, transparent); }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  td.hex { color: var(--vscode-symbolIcon-colorForeground, #d19a66); }
  .empty { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); }
  .sql-hint { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 2px 10px 0; }
</style>
</head>
<body>
<div class="editor-bar">
  <textarea id="sqlEditor" placeholder="${t('querySqlPlaceholder')}" spellcheck="false"></textarea>
  <div class="sql-hint">${t('queryShortcutHint')}</div>
</div>
<div class="toolbar">
  <button id="runBtn">${t('execute')}</button>
  <span class="status" id="status"></span>
</div>
<div class="results" id="results"></div>

<script>
(function () {
  var vscode = acquireVsCodeApi();
  var $ = function (id) { return document.getElementById(id); };
  var results = [];   // 多结果集
  var activeTab = 0;
  var resultTabTemplate = ${JSON.stringify(t('resultTab'))};
  var resultRowsTemplate = ${JSON.stringify(t('resultRows'))};
  var resultAffectedTemplate = ${JSON.stringify(t('resultAffected'))};

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderCell(v) {
    if (v === null || v === undefined) { return '<td class="null">NULL</td>'; }
    if (v && v.__type === 'hex') {
      var hex = v.value;
      var preview = hex.length > 24 ? hex.slice(0, 24) + '…' : hex;
      return '<td class="hex" title="hex: 0x' + hex + '">0x' + escapeHtml(preview) + '</td>';
    }
    return '<td>' + escapeHtml(v) + '</td>';
  }

  function renderResults() {
    var box = $('results');
    if (results.length === 0) {
      box.innerHTML = '<div class="empty">${t('queryEmpty')}</div>';
      return;
    }
    var html = '<div class="tabs">';
    results.forEach(function (r, i) {
      html += '<div class="tab' + (i === activeTab ? ' active' : '') + '" data-idx="' + i + '">' + resultTabTemplate.replace('{index}', String(i + 1)) + '</div>';
    });
    html += '</div>';

    var r = results[activeTab];
    var meta = '';
    if (r.columns.length > 0) {
      meta = resultRowsTemplate.replace('{count}', String(r.rows.length)).replace('{duration}', String(r.durationMs));
    } else {
      meta = resultAffectedTemplate.replace('{count}', String(r.affectedRows !== undefined ? r.affectedRows : 0)).replace('{duration}', String(r.durationMs));
    }
    html += '<div class="result-meta">' + escapeHtml(meta) + '</div>';

    if (r.columns.length === 0) {
      html += '<div class="empty">${t('executeSuccess')}</div>';
    } else {
      html += '<div class="table-wrap"><table><thead><tr>';
      r.columns.forEach(function (c) { html += '<th>' + escapeHtml(c) + '</th>'; });
      html += '</tr></thead><tbody>';
      r.rows.forEach(function (row) {
        html += '<tr>';
        r.columns.forEach(function (c) { html += renderCell(row[c]); });
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    }
    box.innerHTML = html;

    box.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        activeTab = Number(t.dataset.idx);
        renderResults();
      });
    });
  }

  function setStatus(text, isError) {
    var el = $('status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  function run() {
    var sql = $('sqlEditor').value.trim();
    if (!sql) { setStatus('${t('enterSql')}', true); return; }
    setStatus('${t('executing')}');
    vscode.postMessage({ type: 'execute', payload: { sql: sql } });
  }

  $('runBtn').addEventListener('click', run);
  $('sqlEditor').addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      var s = this.selectionStart, t = this.selectionEnd;
      this.value = this.value.slice(0, s) + '  ' + this.value.slice(t);
      this.selectionStart = this.selectionEnd = s + 2;
    }
  });

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (msg.type === 'result') {
      results = [msg.payload];
      activeTab = 0;
      setStatus('');
      renderResults();
    } else if (msg.type === 'error') {
      setStatus(msg.message, true);
    }
  });
})();
</script>
</body>
</html>`;
}
