import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * MCP 的用户级数据目录（与宿主无关：VS Code / CodeBuddy / Cursor 共用同一份配置）。
 * 放在固定用户目录下，MCP server 无需 --config 也能定位配置文件与密钥，
 * 也避免把配置写在可能随扩展升级而变化的 globalStorage/扩展目录里。
 */
export const MCP_USER_DIR = path.join(os.homedir(), '.connect-toolbox');

/** MCP 配置文件默认位置（MCP server 无 --config 时读取） */
export const DEFAULT_MCP_CONFIG_PATH = path.join(MCP_USER_DIR, 'mcp-config.json');

/** MCP server 软链接默认位置（generateMcpConfig 自动创建，缩短 mcpServers 片段路径） */
export const DEFAULT_MCP_SERVER_LINK = path.join(MCP_USER_DIR, 'mcp-server.js');

/** 确保用户数据目录存在（0700）。 */
export function ensureMcpUserDir(): void {
  fs.mkdirSync(MCP_USER_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(MCP_USER_DIR, 0o700);
  } catch {
    // Windows 使用用户目录自身的 ACL，不依赖 POSIX 权限位。
  }
}

/**
 * 刷新指向 MCP server 入口的软链接。
 * 扩展升级后 dist/mcp-server.js 的真实路径会变化（版本号目录），
 * 因此每次生成配置时重建链接，保证 snippet 里的短路径始终可用。
 * Windows 无符号链接权限时返回 null，调用方回退到真实路径。
 */
export function refreshMcpServerLink(extensionServerPath: string): string | null {
  try {
    ensureMcpUserDir();
    fs.rmSync(DEFAULT_MCP_SERVER_LINK, { force: true });
    fs.symlinkSync(extensionServerPath, DEFAULT_MCP_SERVER_LINK, 'file');
    return DEFAULT_MCP_SERVER_LINK;
  } catch {
    return null;
  }
}
