import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** MCP server 按 esbuild target node20 构建（MCP SDK v2 要求 node >= 20），运行 node 主版本需 >= 20 */
const MIN_NODE_MAJOR = 20;

export interface NodeDetection {
  /** snippet 里 command 字段：'node' 或 nvm 中的绝对路径 */
  nodeCommand: string;
  /** 探测说明（可展示给用户，便于排查） */
  reason: string;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
}

function parseNodeVersion(output: string): Version | undefined {
  const match = output.trim().match(/^v(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** 执行 cmd --version 获取版本；命令不存在/解析失败返回 undefined。 */
function getNodeVersion(cmd: string): Version | undefined {
  try {
    const output = execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 5000 });
    return parseNodeVersion(output);
  } catch {
    return undefined;
  }
}

function compareVersion(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** 在 nvm 安装目录中查找 >= minMajor 的最高版本 node 可执行文件路径。 */
function findNvmNodePath(minMajor: number): string | undefined {
  const nvmDirs = [
    process.env.NVM_DIR,
    path.join(os.homedir(), '.nvm'),
  ].filter((dir): dir is string => !!dir);

  const nodeBinName = process.platform === 'win32' ? 'node.exe' : 'node';
  let best: { version: Version; nodePath: string } | undefined;

  for (const nvmDir of nvmDirs) {
    const versionsRoot = path.join(nvmDir, 'versions', 'node');
    if (!fs.existsSync(versionsRoot)) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(versionsRoot);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // nvm 版本目录名格式为 vX.Y.Z
      const version = parseNodeVersion(entry);
      if (!version || version.major < minMajor) continue;
      if (best && compareVersion(version, best.version) <= 0) continue;
      const nodePath = path.join(versionsRoot, entry, 'bin', nodeBinName);
      if (fs.existsSync(nodePath)) {
        best = { version, nodePath };
      }
    }
  }
  return best?.nodePath;
}

/**
 * 探测 MCP 配置片段应使用的 node 命令：
 * 1. PATH 默认 node >= 20 → 直接用 'node'
 * 2. 否则在 nvm 安装目录找 >= 20 的最高版本 → 返回其绝对路径
 * 3. 都没有 → 回退 'node'（可能因版本过低启动失败）
 */
export function detectNodeCommand(): NodeDetection {
  const defaultVersion = getNodeVersion('node');
  if (defaultVersion && defaultVersion.major >= MIN_NODE_MAJOR) {
    return {
      nodeCommand: 'node',
      reason: `默认 node v${defaultVersion.major} 满足 >=${MIN_NODE_MAJOR}`,
    };
  }
  const defaultHint = defaultVersion
    ? `v${defaultVersion.major}（<${MIN_NODE_MAJOR}）`
    : '未找到';
  const nvmNode = findNvmNodePath(MIN_NODE_MAJOR);
  if (nvmNode) {
    return {
      nodeCommand: nvmNode,
      reason: `默认 node ${defaultHint}，改用 nvm：${nvmNode}`,
    };
  }
  return {
    nodeCommand: 'node',
    reason: `默认 node ${defaultHint} 且 nvm 无 >=${MIN_NODE_MAJOR} 版本，回退 node`,
  };
}
