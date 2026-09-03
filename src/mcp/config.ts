import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConnectionConfig } from '../connection/types';
import { decryptSecret, encryptSecret, getMcpKey, getOrCreateMcpKey, secretAad } from './crypto';
import {
  MCP_CONFIG_VERSION,
  EncryptedSecret,
  McpConfig,
  McpConnectionProfile,
  ResolvedMcpConfig,
} from './types';

export type SecretReader = (ref: string) => Promise<string | undefined>;

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows does not use POSIX mode bits.
  }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(temporaryPath, 0o600);
  } catch {
    // Windows ACLs are managed by the user profile.
  }
  fs.renameSync(temporaryPath, filePath);
}

function assertEncryptedSecret(value: unknown): asserts value is EncryptedSecret {
  if (!value || typeof value !== 'object') throw new Error('MCP 配置中的密码密文格式错误');
  const item = value as Record<string, unknown>;
  for (const field of ['algorithm', 'keyRef', 'iv', 'authTag', 'ciphertext']) {
    if (typeof item[field] !== 'string' || !item[field]) {
      throw new Error(`MCP 配置中的密码密文缺少 ${field}`);
    }
  }
}

function assertConfig(value: unknown): asserts value is McpConfig {
  if (!value || typeof value !== 'object') throw new Error('MCP 配置必须是 JSON 对象');
  const config = value as Record<string, unknown>;
  if (config.version !== MCP_CONFIG_VERSION) throw new Error(`不支持的 MCP 配置版本：${String(config.version)}`);
  if (typeof config.keyPath !== 'string' || !config.keyPath) throw new Error('MCP 配置缺少 keyPath');
  if (!Array.isArray(config.connections)) throw new Error('MCP 配置缺少 connections 数组');
  for (const item of config.connections) {
    if (!item || typeof item !== 'object') throw new Error('MCP 连接配置格式错误');
    const connection = item as Record<string, unknown>;
    if (typeof connection.id !== 'string' || !connection.id) throw new Error('MCP 连接缺少 id');
    if (typeof connection.name !== 'string') throw new Error(`MCP 连接 ${connection.id} 缺少 name`);
    if (connection.type !== 'mysql') throw new Error(`MCP 暂不支持连接类型：${String(connection.type)}`);
    if (typeof connection.host !== 'string' || !connection.host) throw new Error(`MCP 连接 ${connection.id} 缺少 host`);
    if (!Number.isInteger(connection.port) || Number(connection.port) < 1 || Number(connection.port) > 65535) {
      throw new Error(`MCP 连接 ${connection.id} 的 port 无效`);
    }
    if (typeof connection.username !== 'string' || !connection.username) throw new Error(`MCP 连接 ${connection.id} 缺少 username`);
    if (connection.password !== undefined) assertEncryptedSecret(connection.password);
  }
}

export async function createMcpConfig(
  connections: ConnectionConfig[],
  readSecret: SecretReader,
  keyPath: string,
): Promise<McpConfig> {
  const key = await getOrCreateMcpKey(keyPath);
  const profiles: McpConnectionProfile[] = [];
  for (const connection of connections) {
    if (connection.type !== 'mysql' || connection.viaSsh) continue;
    const password = connection.passwordRef ? await readSecret(connection.passwordRef) : undefined;
    if (connection.passwordRef && password === undefined) {
      throw new Error(`连接「${connection.name}」的数据库密码不存在，请重新编辑并保存该连接`);
    }
    const profile: McpConnectionProfile = {
      id: connection.id,
      name: connection.name,
      description: connection.description?.trim() || undefined,
      type: 'mysql',
      host: connection.host,
      port: connection.port,
      username: connection.username ?? 'root',
    };
    if (password !== undefined) {
      profile.password = encryptSecret(
        password,
        key,
        'file',
        secretAad(connection.id),
      );
    }
    profiles.push(profile);
  }
  return {
    version: MCP_CONFIG_VERSION,
    generatedAt: new Date().toISOString(),
    keyPath: path.resolve(keyPath),
    connections: profiles,
  };
}

export function writeMcpConfig(filePath: string, config: McpConfig): void {
  writeJsonAtomically(path.resolve(filePath), config);
}

export async function loadMcpConfig(filePath: string): Promise<ResolvedMcpConfig> {
  const resolvedPath = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`读取 MCP 配置失败：${(error as Error).message}`);
  }
  assertConfig(parsed);
  const hasEncryptedPassword = parsed.connections.some(connection => connection.password !== undefined);
  const key = hasEncryptedPassword ? await getMcpKey(parsed.keyPath) : undefined;
  const connections = parsed.connections.map(connection => ({
    id: connection.id,
    name: connection.name,
    description: connection.description,
    type: 'mysql' as const,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password && key
      ? decryptSecret(connection.password, key, secretAad(connection.id))
      : undefined,
  }));
  return {
    version: parsed.version,
    generatedAt: parsed.generatedAt,
    keyPath: path.resolve(parsed.keyPath),
    connections,
  };
}
