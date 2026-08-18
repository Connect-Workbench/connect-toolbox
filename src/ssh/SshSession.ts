import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import { Client, ConnectConfig, ClientChannel } from 'ssh2';
import { ConnectionConfig } from '../connection/types';

export interface Tunnel {
  /** 本地监听端口 */
  localPort: number;
  close(): Promise<void>;
}

/**
 * 单个 SSH 会话（ssh2 Client 封装）：
 * - 连接/断开
 * - 打开交互式 shell（供远程终端使用）
 * - 本地端口转发（供 MySQL/Redis 隧道使用）
 */
export class SshSession {
  private client: Client | null = null;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly getSecret: (ref: string) => Promise<string | undefined>,
    /** 测试连接时使用：优先于 SecretStorage 中的密码/口令 */
    private readonly authOverride?: { password?: string; passphrase?: string },
  ) {}

  get connected(): boolean {
    return this.client !== null;
  }

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }
    const sshConfig: ConnectConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username || 'root',
      readyTimeout: 10000,
      keepaliveInterval: 10000,
    };

    if (this.config.privateKeyPath) {
      const keyPath = this.config.privateKeyPath.replace(/^~(?=$|[/\\])/, os.homedir());
      sshConfig.privateKey = fs.readFileSync(keyPath);
      const passphrase =
        this.authOverride?.passphrase ??
        (this.config.passphraseRef
          ? await this.getSecret(this.config.passphraseRef)
          : undefined);
      if (passphrase) {
        sshConfig.passphrase = passphrase;
      }
    } else if (this.config.passwordRef || this.authOverride?.password) {
      const password =
        this.authOverride?.password ??
        (this.config.passwordRef
          ? await this.getSecret(this.config.passwordRef)
          : undefined);
      if (!password) {
        throw new Error('未找到保存的密码，请编辑连接重新输入');
      }
      sshConfig.password = password;
    } else {
      throw new Error('未配置认证方式，请编辑连接');
    }

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect(sshConfig);
    });
    // 连接建立后：错误不再向外抛，连接断开时清空引用
    client.on('error', () => { /* 保持安静，由 close 事件收尾 */ });
    client.on('close', () => {
      this.client = null;
    });
    this.client = client;
  }

  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  /** 打开交互式 shell，返回双向流 */
  openShell(cols: number, rows: number): Promise<ClientChannel> {
    if (!this.client) {
      return Promise.reject(new Error('SSH 未连接'));
    }
    return new Promise((resolve, reject) => {
      this.client!.shell(
        { term: 'xterm-256color', cols, rows },
        (err, stream) => (err ? reject(err) : resolve(stream)),
      );
    });
  }

  /**
   * 建立本地端口转发隧道：127.0.0.1:<随机端口> → remoteHost:remotePort
   */
  async createTunnel(remoteHost: string, remotePort: number): Promise<Tunnel> {
    if (!this.client) {
      throw new Error('SSH 未连接');
    }
    const client = this.client;
    const server = net.createServer(socket => {
      client.forwardOut(
        '127.0.0.1',
        socket.localPort ?? 0,
        remoteHost,
        remotePort,
        (err, stream) => {
          if (err) {
            socket.destroy();
            return;
          }
          socket.on('error', () => stream.destroy());
          stream.on('error', () => socket.destroy());
          socket.pipe(stream).pipe(socket);
        },
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const localPort = (server.address() as net.AddressInfo).port;
    return {
      localPort,
      close: () =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        }),
    };
  }
}
