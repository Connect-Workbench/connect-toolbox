import * as vscode from 'vscode';
import { ConnectionConfig, ConnectionStatus } from './types';
import { ConnectionStore } from './ConnectionStore';
import { SshSession } from '../ssh/SshSession';
import { SshTunnelManager } from '../ssh/SshTunnelManager';
import { SqlClient } from '../clients/SqlClient';
import { MySqlClient } from '../clients/MySqlClient';
import { ClickHouseClient, rewriteEndpoint } from '../clients/ClickHouseClient';
import { info, error } from '../utils/logger';

interface SqlSession {
  client: SqlClient;
  /** 走隧道时的远端目标（用于断开时释放隧道） */
  tunnelInfo?: { sshId: string; host: string; port: number };
}

/**
 * 连接生命周期管理：
 * - SSH 连接建立会话（远程终端/隧道）
 * - SQL 类连接（MySQL / ClickHouse）建立客户端（直连或经 SSH 隧道）
 * - Redis 留待 M3
 */
export class ConnectionManager {
  private readonly sshSessions = new Map<string, SshSession>();
  private readonly sqlSessions = new Map<string, SqlSession>();
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

  /** 按连接 id 取 SQL 客户端（MySQL / ClickHouse 统一入口） */
  getSqlClient(id: string): SqlClient | undefined {
    return this.sqlSessions.get(id)?.client;
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
      await this.connectSql(config, async (host, port) => {
        const password = config.passwordRef
          ? await this.store.getSecret(config.passwordRef)
          : undefined;
        return new MySqlClient(host, port, config.username ?? 'root', password);
      });
      return;
    }
    if (config.type === 'clickhouse') {
      await this.connectSql(config, async (host, port) => {
        const password = config.passwordRef
          ? await this.store.getSecret(config.passwordRef)
          : undefined;
        // 走隧道时 host/port 已被替换为本地转发端口，URL 里的目标地址同步改写
        const endpoint = config.url
          ? rewriteEndpoint(config.url, host, port)
          : `http://${host}:${port}`;
        return new ClickHouseClient(endpoint, config.username ?? 'default', password);
      });
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

  /**
   * SQL 类连接的通用建立流程：必要时先建隧道，再创建具体客户端。
   * 失败时清理本次建立的隧道与客户端。
   */
  private async connectSql(
    config: ConnectionConfig,
    createClient: (host: string, port: number) => Promise<SqlClient>,
  ): Promise<void> {
    if (this.sqlSessions.has(config.id)) {
      return;
    }
    this.setStatus(config.id, 'connecting');
    try {
      let host = config.host;
      let port = config.port;
      let tunnelInfo: SqlSession['tunnelInfo'];

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

      const client = await createClient(host, port);
      await client.connect();

      this.sqlSessions.set(config.id, { client, tunnelInfo });
      this.setStatus(config.id, 'connected');
      info(
        `${config.type} connected`,
        config.name,
        'via',
        config.viaSsh
          ? `ssh tunnel -> ${config.host}:${config.port}`
          : `direct ${config.host}:${config.port}`,
      );
    } catch (err) {
      await this.disconnect(config.id);
      this.setStatus(config.id, 'error');
      error(`${config.type} connect failed`, config.name, (err as Error).message);
      throw err;
    }
  }

  async disconnect(id: string): Promise<void> {
    const config = this.store.get(id);
    // SSH
    this.sshSessions.get(id)?.disconnect();
    this.sshSessions.delete(id);
    // SQL
    const sqlSession = this.sqlSessions.get(id);
    if (sqlSession) {
      await sqlSession.client.close();
      if (sqlSession.tunnelInfo) {
        await this.tunnels.release(
          sqlSession.tunnelInfo.sshId,
          sqlSession.tunnelInfo.host,
          sqlSession.tunnelInfo.port,
        );
      }
      this.sqlSessions.delete(id);
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
    for (const [, sqlSession] of this.sqlSessions) {
      await sqlSession.client.close();
    }
    this.sqlSessions.clear();
    this.statuses.clear();
    await this.tunnels.closeAll();
  }
}
