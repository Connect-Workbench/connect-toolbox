import * as vscode from 'vscode';
import { ConnectionConfig, ConnectionStatus } from './types';
import { ConnectionStore } from './ConnectionStore';
import { SshSession } from '../ssh/SshSession';
import { SshTunnelManager } from '../ssh/SshTunnelManager';
import { MySqlClient } from '../clients/MySqlClient';
import { info, error } from '../utils/logger';

interface MySqlSession {
  client: MySqlClient;
  /** 走隧道时的远端目标（用于断开时释放隧道） */
  tunnelInfo?: { sshId: string; host: string; port: number };
}

/**
 * 连接生命周期管理：
 * - SSH 连接建立会话（远程终端/隧道）
 * - MySQL 连接建立客户端（直连或经 SSH 隧道）
 * - Redis 留待 M3
 */
export class ConnectionManager {
  private readonly sshSessions = new Map<string, SshSession>();
  private readonly mySqlSessions = new Map<string, MySqlSession>();
  private readonly statuses = new Map<string, ConnectionStatus>();

  private readonly _onDidChangeStatus = new vscode.EventEmitter<string>();
  /** 连接状态变化事件，参数为连接 id */
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(
    private readonly store: ConnectionStore,
    readonly tunnels: SshTunnelManager,
  ) {}

  getStatus(id: string): ConnectionStatus {
    return this.statuses.get(id) ?? 'disconnected';
  }

  getSshSession(id: string): SshSession | undefined {
    return this.sshSessions.get(id);
  }

  getMySqlClient(id: string): MySqlClient | undefined {
    return this.mySqlSessions.get(id)?.client;
  }

  private setStatus(id: string, status: ConnectionStatus): void {
    this.statuses.set(id, status);
    this._onDidChangeStatus.fire(id);
  }

  async connect(id: string): Promise<void> {
    const config = this.store.get(id);
    if (!config) {
      throw new Error('连接不存在');
    }
    info('connect requested', config.name, config.type);
    if (config.type === 'ssh') {
      await this.connectSsh(config);
      return;
    }
    if (config.type === 'mysql') {
      await this.connectMySql(config);
      return;
    }
    throw new Error('Redis 客户端将在后续里程碑（M3）提供');
  }

  private async connectSsh(config: ConnectionConfig): Promise<void> {
    if (this.sshSessions.has(config.id)) {
      return;
    }
    this.setStatus(config.id, 'connecting');
    const session = new SshSession(config, ref => this.store.getSecret(ref));
    try {
      await session.connect();
      this.sshSessions.set(config.id, session);
      this.setStatus(config.id, 'connected');
      info('ssh connected', config.name);
    } catch (err) {
      session.disconnect();
      this.setStatus(config.id, 'error');
      error('ssh connect failed', config.name, (err as Error).message);
      throw err;
    }
  }

  private async connectMySql(config: ConnectionConfig): Promise<void> {
    if (this.mySqlSessions.has(config.id)) {
      return;
    }
    this.setStatus(config.id, 'connecting');
    try {
      let host = config.host;
      let port = config.port;
      let tunnelInfo: MySqlSession['tunnelInfo'];

      if (config.viaSsh) {
        if (!config.sshConnectionId) {
          throw new Error('未配置 SSH 隧道连接');
        }
        const sshConfig = this.store.get(config.sshConnectionId);
        if (!sshConfig || sshConfig.type !== 'ssh') {
          throw new Error('隧道引用的 SSH 连接不存在');
        }
        // SSH 未连接则先连接
        if (!this.sshSessions.has(sshConfig.id)) {
          await this.connectSsh(sshConfig);
        }
        const session = this.sshSessions.get(sshConfig.id)!;
        const localPort = await this.tunnels.acquire(session, sshConfig.id, config.host, config.port);
        host = '127.0.0.1';
        port = localPort;
        tunnelInfo = { sshId: sshConfig.id, host: config.host, port: config.port };
      }

      const password = config.passwordRef
        ? await this.store.getSecret(config.passwordRef)
        : undefined;
      const client = new MySqlClient(host, port, config.username ?? 'root', password);
      await client.connect();

      this.mySqlSessions.set(config.id, { client, tunnelInfo });
      this.setStatus(config.id, 'connected');
      info('mysql connected', config.name, 'via', config.viaSsh ? `ssh tunnel -> ${config.host}:${config.port}` : `direct ${config.host}:${config.port}`);
    } catch (err) {
      // 失败时清理本次建立的隧道与客户端
      await this.disconnect(config.id);
      this.setStatus(config.id, 'error');
      error('mysql connect failed', config.name, (err as Error).message);
      throw err;
    }
  }

  async disconnect(id: string): Promise<void> {
    const config = this.store.get(id);
    // SSH
    this.sshSessions.get(id)?.disconnect();
    this.sshSessions.delete(id);
    // MySQL
    const mysqlSession = this.mySqlSessions.get(id);
    if (mysqlSession) {
      await mysqlSession.client.close();
      if (mysqlSession.tunnelInfo) {
        await this.tunnels.release(
          mysqlSession.tunnelInfo.sshId,
          mysqlSession.tunnelInfo.host,
          mysqlSession.tunnelInfo.port,
        );
      }
      this.mySqlSessions.delete(id);
    }
    if (config) {
      this.setStatus(id, 'disconnected');
    }
  }

  async disconnectAll(): Promise<void> {
    for (const session of this.sshSessions.values()) {
      session.disconnect();
    }
    this.sshSessions.clear();
    for (const [, mysqlSession] of this.mySqlSessions) {
      await mysqlSession.client.close();
    }
    this.mySqlSessions.clear();
    this.statuses.clear();
    await this.tunnels.closeAll();
  }
}
