import * as vscode from 'vscode';
import { ClientChannel } from 'ssh2';
import { ConnectionConfig } from '../connection/types';
import { ConnectionManager } from '../connection/ConnectionManager';

/**
 * 基于 Pseudoterminal API 的 SSH 远程终端：
 * ssh2 shell 流的 ANSI 输出直通给 VSCode 内置终端渲染，
 * 按键输入由 VSCode 编码后写入 shell 流。
 */
export class SshTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;

  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidClose = this.closeEmitter.event;

  private stream: ClientChannel | null = null;
  private disposed = false;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly config: ConnectionConfig,
  ) {}

  async open(initialDimensions?: vscode.TerminalDimensions): Promise<void> {
    const cols = initialDimensions?.columns ?? 80;
    const rows = initialDimensions?.rows ?? 24;
    try {
      if (!this.manager.getSshSession(this.config.id)?.connected) {
        this.writeEmitter.fire('\x1b[90m正在建立 SSH 连接...\x1b[0m\r\n');
        await this.manager.connect(this.config.id);
        this.writeEmitter.fire(`\x1b[90m已连接 ${this.config.host}\x1b[0m\r\n\r\n`);
      }
      if (this.disposed) {
        return;
      }
      const session = this.manager.getSshSession(this.config.id);
      if (!session) {
        throw new Error('SSH 会话不存在');
      }
      const stream = await session.openShell(cols, rows);
      this.stream = stream;

      stream.on('data', (data: Buffer) => {
        if (!this.disposed) {
          this.writeEmitter.fire(data.toString('utf8'));
        }
      });
      stream.stderr?.on('data', (data: Buffer) => {
        if (!this.disposed) {
          this.writeEmitter.fire(data.toString('utf8'));
        }
      });
      stream.on('close', () => {
        if (!this.disposed) {
          this.writeEmitter.fire('\r\n\x1b[90m[SSH 连接已关闭]\x1b[0m');
          this.closeEmitter.fire(0);
        }
      });
    } catch (err) {
      this.writeEmitter.fire(`\r\n\x1b[31mSSH 连接失败: ${(err as Error).message}\x1b[0m`);
      this.closeEmitter.fire(1);
    }
  }

  handleInput(data: string): void {
    this.stream?.write(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.stream?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
  }

  close(): void {
    this.disposed = true;
    this.stream?.close();
    // 终端关闭即断开会话，释放资源；如需隧道常驻可后续调整
    this.manager.disconnect(this.config.id);
  }
}
