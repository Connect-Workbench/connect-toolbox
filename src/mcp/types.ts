export const MCP_CONFIG_VERSION = 1 as const;
export const MCP_CRYPTO_ALGORITHM = 'aes-256-gcm' as const;

export interface EncryptedSecret {
  algorithm: typeof MCP_CRYPTO_ALGORITHM;
  keyRef: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface McpConnectionProfile {
  id: string;
  name: string;
  type: 'mysql';
  host: string;
  port: number;
  username: string;
  password?: EncryptedSecret;
}

export interface McpConfig {
  version: typeof MCP_CONFIG_VERSION;
  generatedAt: string;
  statusDir: string;
  /** MCP 加密主密钥文件路径（权限受限，仅当前用户可读写） */
  keyPath: string;
  connections: McpConnectionProfile[];
}

export interface ResolvedMcpConnection extends Omit<McpConnectionProfile, 'password'> {
  password?: string;
}

export interface ResolvedMcpConfig extends Omit<McpConfig, 'connections'> {
  connections: ResolvedMcpConnection[];
}

export type McpProcessStatus = 'starting' | 'running' | 'stopped' | 'error';

export interface McpClientInfo {
  name: string;
  version?: string;
}

export interface McpStatusRecord {
  version: 1;
  instanceId: string;
  pid: number;
  parentPid: number;
  status: McpProcessStatus;
  startedAt: string;
  lastHeartbeat: string;
  stoppedAt?: string;
  client?: McpClientInfo;
  configPath: string;
  connectionIds: string[];
  lastError?: string;
}

export interface McpStatusView extends McpStatusRecord {
  alive: boolean;
  stale: boolean;
}
