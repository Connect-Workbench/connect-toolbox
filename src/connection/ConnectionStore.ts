import * as vscode from 'vscode';
import { ConnectionConfig } from './types';

export interface TreeFilter {
  /** 数据库白名单（连接级） */
  databases?: string[];
  /** 表白名单（按库名） */
  tablesByDb?: Record<string, string[]>;
}

/** 最近打开的 Webview 面板（用于插件加载后恢复） */
export interface RecentPanel {
  type: 'query' | 'table';
  connId: string;
  connName: string;
  database?: string;
  table?: string;
}

/**
 * 连接配置持久化：
 * - 非敏感配置存 globalState
 * - 密码/口令存 SecretStorage（系统密钥链）
 */
export class ConnectionStore {
  private static readonly CONNECTIONS_KEY = 'connectToolbox.connections';
  private static readonly TREE_FILTERS_KEY = 'connectToolbox.treeFilters';
  private static readonly TREE_EXPANDED_KEY = 'connectToolbox.treeExpanded';
  private static readonly RECENT_PANELS_KEY = 'connectToolbox.recentPanels';
  private static readonly SECRET_PREFIX = 'connectToolbox.secret.';

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionConfig[] {
    return this.context.globalState.get<ConnectionConfig[]>(ConnectionStore.CONNECTIONS_KEY, []);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find(c => c.id === id);
  }

  async save(config: ConnectionConfig): Promise<void> {
    const list = this.list();
    const idx = list.findIndex(c => c.id === config.id);
    if (idx >= 0) {
      list[idx] = config;
    } else {
      list.push(config);
    }
    await this.context.globalState.update(ConnectionStore.CONNECTIONS_KEY, list);
  }

  async remove(id: string): Promise<void> {
    const list = this.list().filter(c => c.id !== id);
    await this.context.globalState.update(ConnectionStore.CONNECTIONS_KEY, list);
  }

  // ---- 树过滤（按连接 id 存储） ----
  // databases: 数据库白名单（连接级，全局生效）
  // tablesByDb: 表白名单（按库名，互不影响）

  getTreeFilter(connectionId: string): TreeFilter | undefined {
    const all = this.context.globalState.get<Record<string, TreeFilter>>(
      ConnectionStore.TREE_FILTERS_KEY,
      {},
    );
    return all[connectionId];
  }

  async setTreeFilter(connectionId: string, filter: TreeFilter): Promise<void> {
    const all = this.context.globalState.get<Record<string, TreeFilter>>(
      ConnectionStore.TREE_FILTERS_KEY,
      {},
    );
    all[connectionId] = filter;
    await this.context.globalState.update(ConnectionStore.TREE_FILTERS_KEY, all);
  }

  // ---- 树展开状态（节点 key 数组） ----

  getTreeExpanded(): string[] {
    return this.context.globalState.get<string[]>(ConnectionStore.TREE_EXPANDED_KEY, []);
  }

  async saveTreeExpanded(keys: string[]): Promise<void> {
    await this.context.globalState.update(ConnectionStore.TREE_EXPANDED_KEY, keys);
  }

  // ---- 最近打开的窗口（面板恢复） ----

  getRecentPanels(): RecentPanel[] {
    return this.context.globalState.get<RecentPanel[]>(ConnectionStore.RECENT_PANELS_KEY, []);
  }

  async saveRecentPanels(panels: RecentPanel[]): Promise<void> {
    await this.context.globalState.update(ConnectionStore.RECENT_PANELS_KEY, panels);
  }

  // ---- SecretStorage ----

  async setSecret(ref: string, value: string): Promise<void> {
    await this.context.secrets.store(ConnectionStore.SECRET_PREFIX + ref, value);
  }

  async getSecret(ref: string): Promise<string | undefined> {
    return this.context.secrets.get(ConnectionStore.SECRET_PREFIX + ref);
  }

  async deleteSecret(ref: string): Promise<void> {
    await this.context.secrets.delete(ConnectionStore.SECRET_PREFIX + ref);
  }
}
