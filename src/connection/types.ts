export type ConnectionType = 'mysql' | 'clickhouse' | 'redis' | 'ssh';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * 连接配置。mysql/clickhouse/redis 既支持直连，也支持通过某个 SSH 连接（sshConnectionId）建立隧道。
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
  /**
   * 完整连接地址（仅 clickhouse 使用）：
   * ClickHouse 走 HTTP 端点，URL 才能表达 scheme / path 前缀 / query 参数。
   * host/port 由该 URL 解析回填，隧道改址时只替换其中的 host:port。
   */
  url?: string;
  username?: string;
  /** 密码在 SecretStorage 中的引用 key */
  passwordRef?: string;
  /** 私钥路径（ssh 类型专用），支持 ~ 展开 */
  privateKeyPath?: string;
  /** 私钥口令在 SecretStorage 中的引用 key */
  passphraseRef?: string;
  /** 是否通过 SSH 隧道连接（mysql/clickhouse/redis 专用） */
  viaSsh: boolean;
  /** viaSsh=true 时指向的 SSH 连接 id */
  sshConnectionId?: string;
  /** 分组名（树视图第一层） */
  group?: string;
}

export const DEFAULT_PORTS: Record<ConnectionType, number> = {
  mysql: 3306,
  clickhouse: 8123,
  redis: 6379,
  ssh: 22,
};

export const TYPE_LABELS: Record<ConnectionType, string> = {
  ssh: 'SSH',
  mysql: 'MySQL',
  clickhouse: 'ClickHouse',
  redis: 'Redis',
};

/** 支持 SQL 查询与库表浏览的类型（树视图据此决定是否可展开） */
export const SQL_CONNECTION_TYPES: ConnectionType[] = ['mysql', 'clickhouse'];

export function isSqlConnectionType(type: ConnectionType): boolean {
  return SQL_CONNECTION_TYPES.includes(type);
}
