import { SshSession } from '../ssh/SshSession';

/**
 * SSH 隧道管理：按 (sshId, remoteHost, remotePort) 复用已有隧道，
 * 避免多个客户端为同一目标重复建隧道。
 */
export class SshTunnelManager {
  private tunnels = new Map<string, import('../ssh/SshSession').Tunnel>();

  private key(sshId: string, host: string, port: number): string {
    return `${sshId}:${host}:${port}`;
  }

  /** 获取（或创建）隧道，返回本地端口 */
  async acquire(session: SshSession, sshId: string, remoteHost: string, remotePort: number): Promise<number> {
    const key = this.key(sshId, remoteHost, remotePort);
    const existing = this.tunnels.get(key);
    if (existing) {
      return existing.localPort;
    }
    const tunnel = await session.createTunnel(remoteHost, remotePort);
    this.tunnels.set(key, tunnel);
    return tunnel.localPort;
  }

  async release(sshId: string, remoteHost: string, remotePort: number): Promise<void> {
    const key = this.key(sshId, remoteHost, remotePort);
    const tunnel = this.tunnels.get(key);
    if (tunnel) {
      await tunnel.close();
      this.tunnels.delete(key);
    }
  }

  async closeAll(): Promise<void> {
    const all = [...this.tunnels.values()];
    this.tunnels.clear();
    await Promise.all(all.map(t => t.close()));
  }
}
