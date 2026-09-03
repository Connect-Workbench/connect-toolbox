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
  /** 连接描述（可选）：用于 MCP 工具描述 */
  description?: string;
  type: 'mysql';
  host: string;
  port: number;
  username: string;
  password?: EncryptedSecret;
}

export interface McpConfig {
  version: typeof MCP_CONFIG_VERSION;
  generatedAt: string;
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
