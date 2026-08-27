export type ConnectionType = 'mysql' | 'redis' | 'ssh';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * 连接配置。mysql/redis 既支持直连，也支持通过某个 SSH 连接（sshConnectionId）建立隧道。
 * 密码/私钥口令不直接落盘，只存 SecretStorage 引用（passwordRef / passphraseRef）。
 */
export interface ConnectionConfig {
  id: string;
  name: string;
  /** 描述（可选）：用于连接树/MCP 工具描述等展示 */
  description?: string;
  type: ConnectionType;
  /** 目标主机 */
  host: string;
  /** 目标端口 */
  port: number;
  username?: string;
  /** 密码在 SecretStorage 中的引用 key */
  passwordRef?: string;
  /** 私钥路径（ssh 类型专用），支持 ~ 展开 */
  privateKeyPath?: string;
  /** 私钥口令在 SecretStorage 中的引用 key */
  passphraseRef?: string;
  /** 是否通过 SSH 隧道连接（mysql/redis 专用） */
  viaSsh: boolean;
  /** viaSsh=true 时指向的 SSH 连接 id */
  sshConnectionId?: string;
  /** 分组名（树视图第一层） */
  group?: string;
}

export const DEFAULT_PORTS: Record<ConnectionType, number> = {
  mysql: 3306,
  redis: 6379,
  ssh: 22,
};

export const TYPE_LABELS: Record<ConnectionType, string> = {
  ssh: 'SSH',
  mysql: 'MySQL',
  redis: 'Redis',
};
