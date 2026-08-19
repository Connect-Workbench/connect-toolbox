import * as crypto from 'crypto';
import * as vscode from 'vscode';
import mysql from 'mysql2/promise';
import { ConnectionConfig, ConnectionType } from '../connection/types';
import { ConnectionStore } from '../connection/ConnectionStore';
import { SshSession } from '../ssh/SshSession';
import { locale, t } from '../i18n';

interface FormInitPayload {
  config?: ConnectionConfig;
  sshConnections: { id: string; name: string; host: string; port: number }[];
  hasPassword: boolean;
  hasPassphrase: boolean;
}

interface FormSavePayload {
  name: string;
  type: ConnectionType;
  host: string;
  port: number;
  username: string;
  /** ssh 专用 */
  authMethod: 'password' | 'privateKey';
  privateKeyPath: string;
  /** 新输入的密码/口令，留空表示保持原有 */
  password: string;
  passphrase: string;
  /** mysql/redis 专用 */
  viaSsh: boolean;
  sshConnectionId: string;
  group: string;
}

/**
 * 连接表单 Webview：一屏填写所有字段，编辑时预填。
 * resolve 返回保存后的 ConnectionConfig；取消/关闭面板则 resolve(undefined)。
 */
export function showConnectionForm(
  context: vscode.ExtensionContext,
  store: ConnectionStore,
  existing?: ConnectionConfig,
): Promise<ConnectionConfig | undefined> {
  return new Promise(resolve => {
    const panel = vscode.window.createWebviewPanel(
      'connectToolbox.connectionForm',
      existing ? t('connectionFormEditTitle', { name: existing.name }) : t('connectionFormNewTitle'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    panel.webview.html = renderHtml(panel.webview);

    const sshConnections = store
      .list()
      .filter(c => c.type === 'ssh' && c.id !== existing?.id)
      .map(c => ({ id: c.id, name: c.name, host: c.host, port: c.port }));

    const init: FormInitPayload = {
      config: existing,
      sshConnections,
      hasPassword: !!existing?.passwordRef,
      hasPassphrase: !!existing?.passphraseRef,
    };
    panel.webview.postMessage({ type: 'init', payload: init });

    let done = false;
    const finish = (value: ConnectionConfig | undefined) => {
      if (!done) {
        done = true;
        panel.dispose();
        resolve(value);
      }
    };

    panel.webview.onDidReceiveMessage(async (msg: { type: string; payload: FormSavePayload }) => {
      if (msg.type === 'cancel') {
        finish(undefined);
        return;
      }
      if (msg.type === 'test') {
        panel.webview.postMessage({ type: 'testResult', testing: true });
        try {
          const result = await testConnection(store, existing, msg.payload);
          panel.webview.postMessage({ type: 'testResult', ...result });
        } catch (err) {
          panel.webview.postMessage({
            type: 'testResult',
            ok: false,
            message: (err as Error).message,
          });
        }
        return;
      }
      if (msg.type !== 'save') {
        return;
      }
      try {
        const config = await buildConfig(store, existing, msg.payload);
        finish(config);
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: (err as Error).message });
      }
    });

    panel.onDidDispose(() => finish(undefined));
  });
}

async function buildConfig(
  store: ConnectionStore,
  existing: ConnectionConfig | undefined,
  p: FormSavePayload,
): Promise<ConnectionConfig> {
  let passwordRef = existing?.passwordRef;
  let passphraseRef = existing?.passphraseRef;

  if (p.type === 'ssh') {
    if (p.authMethod === 'privateKey') {
      passwordRef = undefined;
      if (p.passphrase) {
        passphraseRef = existing?.passphraseRef ?? `passphrase.${crypto.randomUUID()}`;
        await store.setSecret(passphraseRef, p.passphrase);
      } else if (!passphraseRef) {
        passphraseRef = undefined;
      }
    } else {
      passphraseRef = undefined;
      if (p.password) {
        passwordRef = existing?.passwordRef ?? `password.${crypto.randomUUID()}`;
        await store.setSecret(passwordRef, p.password);
      } else if (!passwordRef) {
        throw new Error(t('passwordRequired'));
      }
    }
  } else {
    if (p.password) {
      passwordRef = existing?.passwordRef ?? `password.${crypto.randomUUID()}`;
      await store.setSecret(passwordRef, p.password);
    } else if (!passwordRef && !p.viaSsh) {
      // 直连且无密码：允许（部分本地库无密码）
      passwordRef = undefined;
    }
  }

  return {
    id: existing?.id ?? crypto.randomUUID(),
    name: p.name,
    type: p.type,
    host: p.host,
    port: p.port,
    username: p.username.trim() || undefined,
    passwordRef,
    privateKeyPath: p.type === 'ssh' && p.authMethod === 'privateKey' ? p.privateKeyPath || undefined : undefined,
    passphraseRef,
    viaSsh: p.type !== 'ssh' && p.viaSsh,
    sshConnectionId: p.type !== 'ssh' && p.viaSsh ? p.sshConnectionId || undefined : undefined,
    group: p.group.trim() || undefined,
  };
}

/**
 * 测试连接（不保存配置）：
 * - SSH：建立会话后立即断开
 * - MySQL：直连或经 SSH 隧道执行 SELECT 1
 * - Redis：M3 支持
 */
async function testConnection(
  store: ConnectionStore,
  existing: ConnectionConfig | undefined,
  p: FormSavePayload,
): Promise<{ ok: boolean; message: string }> {
  if (!p.host.trim() || !p.port) {
    return { ok: false, message: t('fillHostPort') };
  }

  const passwordOverride = p.password || undefined;
  const passphraseOverride = p.passphrase || undefined;

  if (p.type === 'ssh') {
    if (!p.username.trim()) {
      return { ok: false, message: t('sshNeedsUsername') };
    }
    const tempConfig: ConnectionConfig = {
      id: 'test',
      name: 'test',
      type: 'ssh',
      host: p.host,
      port: p.port,
      username: p.username,
      passwordRef: existing?.passwordRef,
      privateKeyPath: p.authMethod === 'privateKey' ? p.privateKeyPath : undefined,
      passphraseRef: existing?.passphraseRef,
      viaSsh: false,
    };
    const session = new SshSession(tempConfig, ref => store.getSecret(ref), {
      password: passwordOverride,
      passphrase: passphraseOverride,
    });
    await session.connect();
    session.disconnect();
    return { ok: true, message: t('sshConnectionSuccess') };
  }

  if (p.type === 'mysql') {
    let host = p.host;
    let port = p.port;
    let session: SshSession | undefined;
    let tunnel: import('../ssh/SshSession').Tunnel | undefined;
    try {
      if (p.viaSsh) {
        if (!p.sshConnectionId) {
          return { ok: false, message: t('selectTunnelConnection') };
        }
        const sshConfig = store.get(p.sshConnectionId);
        if (!sshConfig) {
          return { ok: false, message: t('tunnelConnectionMissing') };
        }
        session = new SshSession(sshConfig, ref => store.getSecret(ref));
        await session.connect();
        tunnel = await session.createTunnel(p.host, p.port);
        host = '127.0.0.1';
        port = tunnel.localPort;
      }
      const password =
        passwordOverride ??
        (existing?.passwordRef ? await store.getSecret(existing.passwordRef) : undefined);
      const conn = await mysql.createConnection({
        host,
        port,
        user: p.username.trim() || 'root',
        password,
        connectTimeout: 8000,
        supportBigNumbers: true,
      });
      await conn.query('SELECT 1');
      await conn.end();
      return { ok: true, message: t('mysqlConnectionSuccess') };
    } finally {
      if (tunnel) {
        await tunnel.close();
      }
      session?.disconnect();
    }
  }

  return { ok: false, message: t('redisTestUnsupported') };
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
  body {
    padding: 20px 16px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .form { max-width: 520px; margin: 0 auto; }
  .row { margin-bottom: 14px; }
  .row label { display: block; margin-bottom: 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .inline { display: flex; gap: 10px; }
  .inline > div { flex: 1; }
  input[type=text], input[type=password], select {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--radius);
    padding: 5px 8px;
    font-family: inherit; font-size: 13px;
    outline: none;
  }
  input:focus, select:focus { border-color: var(--vscode-focusBorder); }
  input.invalid { border-color: var(--vscode-errorForeground); }
  .field-error { display: none; color: var(--vscode-errorForeground); font-size: 11px; margin-top: 3px; }
  .field-error.show { display: block; }
  .seg { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .seg label {
    display: flex; align-items: center; gap: 5px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: var(--radius);
    padding: 5px 12px; cursor: pointer; user-select: none;
    background: var(--vscode-input-background);
  }
  .seg label.checked { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .seg input[type=radio] { display: none; }
  .section { margin: 14px 0; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); }
  .section-title { font-size: 12px; font-weight: 600; margin-bottom: 10px; color: var(--vscode-descriptionForeground); }
  .pwd-wrap { position: relative; }
  .pwd-wrap input { padding-right: 56px; }
  .eye {
    position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer;
    color: var(--vscode-descriptionForeground); font-size: 12px; padding: 4px 6px;
  }
  .eye:hover { color: var(--vscode-foreground); }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  .footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: var(--radius); padding: 6px 16px; cursor: pointer; font-size: 13px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .hidden { display: none !important; }
  #globalError { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 10px; display: none; }
  #globalError.show { display: block; }
  #testStatus { font-size: 12px; margin-top: 10px; display: none; }
  #testStatus.show { display: block; }
  #testStatus.ok { color: var(--vscode-testing-iconPassed, #89d185); }
  #testStatus.fail { color: var(--vscode-errorForeground); }
  #testStatus.testing { color: var(--vscode-descriptionForeground); }
  select option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
</style>
</head>
<body>
<div class="form">
  <div class="row" id="typeRow">
    <label>${t('connectionType')}</label>
    <div class="seg" id="typeSeg">
      <label><input type="radio" name="type" value="ssh">SSH</label>
      <label><input type="radio" name="type" value="mysql">MySQL</label>
      <label><input type="radio" name="type" value="redis">Redis</label>
    </div>
  </div>

  <div class="row"><label>${t('name')}</label><input type="text" id="name"><div class="field-error" data-for="name">${t('enterConnectionName')}</div></div>

  <div class="inline">
    <div class="row"><label>${t('hostRequired')}</label><input type="text" id="host"><div class="field-error" data-for="host">${t('enterHost')}</div></div>
    <div class="row" style="flex:0 0 110px"><label>${t('portRequired')}</label><input type="text" id="port"><div class="field-error" data-for="port">${t('portRange')}</div></div>
  </div>

  <div class="row"><label id="usernameLabel">${t('username')}</label><input type="text" id="username"><div class="field-error" data-for="username">${t('sshUsernameRequired')}</div></div>

  <!-- SSH 认证区 -->
  <div class="section" id="authSection">
    <div class="section-title">${t('sshAuthMethod')}</div>
    <div class="seg" id="authSeg">
      <label><input type="radio" name="auth" value="password">${t('password')}</label>
      <label><input type="radio" name="auth" value="privateKey">${t('privateKey')}</label>
    </div>
    <div class="row" id="passwordRow" style="margin-top:12px">
      <label>${t('password')} *</label>
      <div class="pwd-wrap">
        <input type="password" id="sshPassword">
        <button class="eye" id="sshPasswordEye" title="${t('show')}/${t('hide')}">${t('show')}</button>
      </div>
      <div class="hint" id="sshPasswordHint"></div>
      <div class="field-error" data-for="sshPassword">${t('passwordRequired')}</div>
    </div>
    <div class="row hidden" id="keyPathRow" style="margin-top:12px">
      <label>${t('privateKeyPath')}</label>
      <input type="text" id="privateKeyPath" placeholder="~/.ssh/id_rsa">
      <div class="field-error" data-for="privateKeyPath">${t('enterPrivateKeyPath')}</div>
    </div>
    <div class="row hidden" id="passphraseRow">
      <label>${t('passphrase')}</label>
      <div class="pwd-wrap">
        <input type="password" id="passphrase">
        <button class="eye" id="passphraseEye" title="${t('show')}/${t('hide')}">${t('show')}</button>
      </div>
      <div class="hint" id="passphraseHint"></div>
    </div>
  </div>

  <!-- MySQL / Redis 连接方式 -->
  <div class="section" id="connSection">
    <div class="section-title">${t('connectionMethod')}</div>
    <div class="seg" id="connSeg">
      <label><input type="radio" name="conn" value="direct">${t('direct')}</label>
      <label><input type="radio" name="conn" value="tunnel">${t('sshTunnelOption')}</label>
    </div>
    <div class="row hidden" id="sshSelectRow" style="margin-top:12px">
      <label>${t('sshConnectionRequired')}</label>
      <select id="sshSelect"></select>
      <div class="field-error" data-for="sshSelect">${t('selectSshTunnel')}</div>
    </div>
    <div class="row" id="dbPasswordRow" style="margin-top:12px">
      <label>${t('databasePasswordOptional')}</label>
      <div class="pwd-wrap">
        <input type="password" id="dbPassword">
        <button class="eye" id="dbPasswordEye" title="${t('show')}/${t('hide')}">${t('show')}</button>
      </div>
      <div class="hint" id="dbPasswordHint"></div>
    </div>
  </div>

  <div class="row"><label>${t('groupOptional')}</label><input type="text" id="group"></div>

  <div id="globalError"></div>
  <div id="testStatus"></div>
  <div class="footer">
    <button class="secondary" id="testBtn">${t('testConnection')}</button>
    <span style="flex:1"></span>
    <button class="secondary" id="cancelBtn">${t('cancel')}</button>
    <button id="saveBtn">${t('save')}</button>
  </div>
</div>

<script>
(function () {
  var vscode = acquireVsCodeApi();
  var state = { hasPassword: false, hasPassphrase: false };

  function $(id) { return document.getElementById(id); }

  function setErr(id, show) {
    var el = document.querySelector('.field-error[data-for="' + id + '"]');
    if (el) { el.classList.toggle('show', !!show); }
    var input = $(id);
    if (input) { input.classList.toggle('invalid', !!show); }
  }

  function showGlobal(msg) {
    var el = $('globalError');
    el.textContent = msg;
    el.classList.toggle('show', !!msg);
  }

  function showTest(text, kind) {
    var el = $('testStatus');
    el.textContent = text;
    el.classList.toggle('show', !!text);
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('fail', kind === 'fail');
    el.classList.toggle('testing', kind === 'testing');
  }

  function runTest() {
    showGlobal('');
    if (!validate()) { return; }
    showTest('${t('testingConnection')}', 'testing');
    vscode.postMessage({ type: 'test', payload: payload() });
  }

  function currentType() {
    var sel = document.querySelector('input[name=type]:checked');
    return sel ? sel.value : 'ssh';
  }

  function refreshVisibility() {
    var type = currentType();
    var isSsh = type === 'ssh';
    $('authSection').classList.toggle('hidden', !isSsh);
    $('connSection').classList.toggle('hidden', isSsh);

    var auth = document.querySelector('input[name=auth]:checked');
    var useKey = auth && auth.value === 'privateKey';
    $('passwordRow').classList.toggle('hidden', isSsh && useKey);
    $('keyPathRow').classList.toggle('hidden', isSsh && !useKey);
    $('passphraseRow').classList.toggle('hidden', isSsh && !useKey);
    $('usernameLabel').textContent = isSsh ? '${t('username')} *' : '${t('usernameOptional')}';

    var conn = document.querySelector('input[name=conn]:checked');
    var viaTunnel = conn && conn.value === 'tunnel';
    $('sshSelectRow').classList.toggle('hidden', isSsh || !viaTunnel);

    // 分段按钮选中态
    document.querySelectorAll('.seg label').forEach(function (l) {
      l.classList.toggle('checked', !!l.querySelector('input:checked'));
    });
  }

  function toggleEye(inputId, eyeId) {
    var input = $(inputId);
    var eye = $(eyeId);
    if (input.type === 'password') { input.type = 'text'; eye.textContent = '${t('hide')}'; }
    else { input.type = 'password'; eye.textContent = '${t('show')}'; }
  }

  function validate() {
    var ok = true;
    var type = currentType();
    var need = function (id, cond, errId) {
      var bad = !cond;
      setErr(errId, bad);
      if (bad) { ok = false; }
    };
    need('name', $('name').value.trim() !== '', 'name');
    need('host', $('host').value.trim() !== '', 'host');
    var port = Number($('port').value);
    need('port', Number.isInteger(port) && port >= 1 && port <= 65535, 'port');
    if (type === 'ssh') {
      need('username', $('username').value.trim() !== '', 'username');
      var useKey = document.querySelector('input[name=auth]:checked').value === 'privateKey';
      if (useKey) {
        need('privateKeyPath', $('privateKeyPath').value.trim() !== '', 'privateKeyPath');
      } else {
        need('sshPassword', $('sshPassword').value !== '' || state.hasPassword, 'sshPassword');
      }
    } else {
      var viaTunnel = document.querySelector('input[name=conn]:checked').value === 'tunnel';
      if (viaTunnel) {
        need('sshSelect', $('sshSelect').value !== '', 'sshSelect');
      }
    }
    return ok;
  }

  function payload() {
    var type = currentType();
    var auth = document.querySelector('input[name=auth]:checked').value;
    var conn = document.querySelector('input[name=conn]:checked').value;
    return {
      name: $('name').value.trim(),
      type: type,
      host: $('host').value.trim(),
      port: Number($('port').value),
      username: $('username').value.trim(),
      authMethod: auth,
      privateKeyPath: $('privateKeyPath').value.trim(),
      password: type === 'ssh' ? $('sshPassword').value : $('dbPassword').value,
      passphrase: $('passphrase').value,
      viaSsh: conn === 'tunnel',
      sshConnectionId: $('sshSelect').value,
      group: $('group').value.trim()
    };
  }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (msg.type === 'init') {
      var p = msg.payload;
      state.hasPassword = p.hasPassword;
      state.hasPassphrase = p.hasPassphrase;
      var c = p.config;
      if (c) {
        // 编辑时类型锁定，不允许切换
        $('typeRow').classList.add('hidden');
      }
      var type = c ? c.type : 'ssh';
      document.querySelector('input[name=type][value="' + type + '"]').checked = true;
      $('name').value = c ? c.name : '';
      $('host').value = c ? c.host : '';
      $('port').value = c ? String(c.port) : (type === 'ssh' ? '22' : type === 'mysql' ? '3306' : '6379');
      $('username').value = c && c.username ? c.username : (type === 'ssh' ? 'root' : '');
      $('group').value = c && c.group ? c.group : '';

      var auth = !c || !c.privateKeyPath ? 'password' : 'privateKey';
      document.querySelector('input[name=auth][value="' + auth + '"]').checked = true;
      $('privateKeyPath').value = c && c.privateKeyPath ? c.privateKeyPath : '';
      $('sshPasswordHint').textContent = state.hasPassword ? '${t('savedSecretHint')}' : '';
      $('passphraseHint').textContent = state.hasPassphrase ? '${t('savedSecretHint')}' : '';
      $('dbPasswordHint').textContent = state.hasPassword ? '${t('savedSecretHint')}' : '';

      var connMode = c && c.viaSsh ? 'tunnel' : 'direct';
      document.querySelector('input[name=conn][value="' + connMode + '"]').checked = true;
      var sel = $('sshSelect');
      p.sshConnections.forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name + ' (' + s.host + ':' + s.port + ')';
        sel.appendChild(opt);
      });
      if (c && c.sshConnectionId) { sel.value = c.sshConnectionId; }
      refreshVisibility();
    } else if (msg.type === 'error') {
      showGlobal(msg.message);
    } else if (msg.type === 'testResult') {
      if (msg.testing) {
        showTest('${t('testingConnection')}', 'testing');
      } else if (msg.ok) {
        showTest('✓ ' + msg.message, 'ok');
      } else {
        showTest('✗ ' + msg.message, 'fail');
      }
    }
  });

  document.querySelectorAll('input[name=type], input[name=auth], input[name=conn]').forEach(function (r) {
    r.addEventListener('change', function () {
      if (r.name === 'type') {
        var type = r.value;
        if ($('port').value === '22' || $('port').value === '3306' || $('port').value === '6379') {
          $('port').value = type === 'ssh' ? '22' : type === 'mysql' ? '3306' : '6379';
        }
        if (!$('username').value) { $('username').value = type === 'ssh' ? 'root' : ''; }
      }
      refreshVisibility();
    });
  });

  $('sshPasswordEye').addEventListener('click', function () { toggleEye('sshPassword', 'sshPasswordEye'); });
  $('passphraseEye').addEventListener('click', function () { toggleEye('passphrase', 'passphraseEye'); });
  $('dbPasswordEye').addEventListener('click', function () { toggleEye('dbPassword', 'dbPasswordEye'); });

  ['name', 'host', 'port', 'username', 'sshPassword', 'privateKeyPath', 'sshSelect'].forEach(function (id) {
    $(id).addEventListener('input', function () { setErr(id, false); showGlobal(''); });
    $(id).addEventListener('change', function () { setErr(id, false); showGlobal(''); });
  });

  $('cancelBtn').addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });
  $('testBtn').addEventListener('click', runTest);
  $('saveBtn').addEventListener('click', function () {
    showGlobal('');
    if (!validate()) { return; }
    vscode.postMessage({ type: 'save', payload: payload() });
  });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { $('saveBtn').click(); }
  });
})();
</script>
</body>
</html>`;
}
