import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EncryptedSecret, MCP_CRYPTO_ALGORITHM } from './types';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** 默认 MCP 主密钥文件路径（跨平台、通用包可用） */
export const DEFAULT_MCP_KEY_PATH = path.join(os.homedir(), '.connect-toolbox', 'mcp.key');

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`MCP 加密密钥长度错误：需要 ${KEY_LENGTH} 字节`);
  }
}

function decodeBase64(value: string, field: string): Buffer {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0) throw new Error('empty');
    return decoded;
  } catch {
    throw new Error(`MCP 配置字段 ${field} 不是有效的 Base64`);
  }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows 使用用户目录自身的 ACL，不依赖 POSIX 权限位。
  }
}

function writeKeyFile(keyPath: string, key: Buffer): void {
  ensurePrivateDirectory(path.dirname(keyPath));
  fs.writeFileSync(keyPath, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Windows 使用用户目录自身的 ACL。
  }
}

/** 读取密钥文件；不存在时生成随机 32 字节密钥并写入 0600 文件。 */
export async function getOrCreateMcpKey(keyPath: string): Promise<Buffer> {
  if (fs.existsSync(keyPath)) {
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    assertKey(key);
    return key;
  }
  const key = crypto.randomBytes(KEY_LENGTH);
  writeKeyFile(keyPath, key);
  return key;
}

/** 读取密钥文件；不存在时报错，提示重新生成 MCP 配置。 */
export async function getMcpKey(keyPath: string): Promise<Buffer> {
  if (!fs.existsSync(keyPath)) {
    throw new Error(`未找到 MCP 加密密钥文件：${keyPath}，请先在插件中重新生成 MCP 配置`);
  }
  const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
  assertKey(key);
  return key;
}

export function encryptSecret(value: string, key: Buffer, keyRef: string, aad: string): EncryptedSecret {
  assertKey(key);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(MCP_CRYPTO_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    algorithm: MCP_CRYPTO_ALGORITHM,
    keyRef,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer, aad: string): string {
  assertKey(key);
  if (secret.algorithm !== MCP_CRYPTO_ALGORITHM) {
    throw new Error(`不支持的 MCP 加密算法：${secret.algorithm}`);
  }
  const iv = decodeBase64(secret.iv, 'iv');
  const authTag = decodeBase64(secret.authTag, 'authTag');
  const ciphertext = decodeBase64(secret.ciphertext, 'ciphertext');
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('MCP 加密配置的 IV 或认证标签长度错误');
  }

  const decipher = crypto.createDecipheriv(
    MCP_CRYPTO_ALGORITHM,
    key,
    iv,
    { authTagLength: AUTH_TAG_LENGTH },
  );
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('MCP 配置解密失败：配置文件可能已被修改，或加密密钥文件不匹配');
  }
}

export function secretAad(connectionId: string): string {
  return `connect-workbench.connect-toolbox:mcp-config:v1:${connectionId}`;
}
