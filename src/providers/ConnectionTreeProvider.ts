import * as vscode from 'vscode';
import { ConnectionConfig, ConnectionStatus, ConnectionType } from '../connection/types';
import { ConnectionStore } from '../connection/ConnectionStore';
import { ConnectionManager } from '../connection/ConnectionManager';
import { MysqlColumnNode, MysqlDatabaseNode, MysqlTableNode } from './nodes';
import { t } from '../i18n';

/** 连接类型对应的默认图标 */
const TYPE_ICON: Record<ConnectionType, string> = {
  ssh: 'remote',
  mysql: 'database',
  redis: 'database',
};

/** 状态优先图标（null 表示保持类型图标） */
const STATUS_ICON: Record<ConnectionStatus, string | null> = {
  disconnected: null,
  connecting: 'sync~spin',
  connected: 'check',
  error: 'error',
};

const DEFAULT_GROUP_KEY = '__default__';

class GroupNode extends vscode.TreeItem {
  constructor(readonly groupKey: string, groupName: string, expanded: boolean) {
    super(groupName, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'group';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

/** 树节点展开状态 key（持久化用） */
export function nodeExpandKey(el: vscode.TreeItem | undefined): string | undefined {
  if (el instanceof GroupNode) {
    return `group:${el.groupKey}`;
  }
  if (el instanceof ConnectionNode) {
    return `conn:${el.config.id}`;
  }
  if (el instanceof MysqlDatabaseNode) {
    return `db:${el.connectionId}:${el.database}`;
  }
  if (el instanceof MysqlTableNode) {
    return `table:${el.connectionId}:${el.database}:${el.table}`;
  }
  return undefined;
}

export class ConnectionNode extends vscode.TreeItem {
  constructor(
    readonly config: ConnectionConfig,
    status: ConnectionStatus,
  ) {
    // 只显示名称；主机/端口/状态放 tooltip
    super(config.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = `${config.type}Connection${status === 'connected' ? 'Connected' : ''}`;
    this.iconPath = new vscode.ThemeIcon(STATUS_ICON[status] ?? TYPE_ICON[config.type]);
    this.tooltip = new vscode.MarkdownString(
      [
        `**${config.name}**  \`${config.type}\``,
        '',
        `- ${t('host')}: \`${config.host}:${config.port}\``,
        config.username ? `- ${t('user')}: \`${config.username}\`` : '',
        config.viaSsh ? `- ${t('channel')}: ${t('sshTunnel')}` : '',
        `- ${t('status')}: \`${status === 'disconnected'
          ? t('statusDisconnected')
          : status === 'connecting'
            ? t('statusConnecting')
            : status === 'connected'
              ? t('statusConnected')
              : t('statusError')}\``,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

/**
 * 连接树：分组 → 连接 →（MySQL）库 → 表 → 列
 */
export class ConnectionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** 展开状态 key 集合（持久化到 globalState） */
  private expandedKeys = new Set<string>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
  ) {
    manager.onDidChangeStatus(() => this._onDidChangeTreeData.fire());
    this.expandedKeys = new Set(store.getTreeExpanded());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** 展开/折叠事件回调（由 TreeView 订阅） */
  onNodeExpanded(el: vscode.TreeItem, expanded: boolean): void {
    const key = nodeExpandKey(el);
    if (!key) {
      return;
    }
    if (expanded) {
      this.expandedKeys.add(key);
    } else {
      this.expandedKeys.delete(key);
    }
    void this.store.saveTreeExpanded([...this.expandedKeys]);
  }

  private isExpanded(key: string): boolean {
    return this.expandedKeys.has(key);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      const groups = [...new Set(this.store.list().map(c => c.group || DEFAULT_GROUP_KEY))];
      return groups.map(groupKey => new GroupNode(
        groupKey,
        groupKey === DEFAULT_GROUP_KEY ? t('defaultGroup') : groupKey,
        this.isExpanded(`group:${groupKey}`),
      ));
    }
    if (element instanceof GroupNode) {
      return this.store
        .list()
        .filter(c => (c.group || DEFAULT_GROUP_KEY) === element.groupKey)
        .map(c => {
          const status = this.manager.getStatus(c.id);
          const node = new ConnectionNode(c, status);
          // MySQL 已连接时可展开：优先恢复保存的展开状态，首次连接默认展开
          if (c.type === 'mysql' && status === 'connected') {
            node.collapsibleState = this.isExpanded(`conn:${c.id}`)
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.Collapsed;
          }
          return node;
        });
    }
    if (element instanceof ConnectionNode) {
      if (
        element.config.type === 'mysql' &&
        this.manager.getStatus(element.config.id) === 'connected'
      ) {
        return this.getDatabases(element.config.id);
      }
      return [];
    }
    if (element instanceof MysqlDatabaseNode) {
      return this.getTables(element.connectionId, element.database);
    }
    if (element instanceof MysqlTableNode) {
      return this.getColumns(element.connectionId, element.database, element.table);
    }
    return [];
  }

  private async getDatabases(connectionId: string): Promise<vscode.TreeItem[]> {
    const client = this.manager.getMySqlClient(connectionId);
    if (!client) {
      return [errorNode(t('mysqlNotConnectedReconnect'))];
    }
    try {
      const databases = await client.listDatabases();
      const filter = this.store.getTreeFilter(connectionId)?.databases;
      const visible = filter && filter.length > 0 ? databases.filter(db => filter.includes(db)) : databases;
      return visible.map(
        db => new MysqlDatabaseNode(connectionId, db, this.isExpanded(`db:${connectionId}:${db}`)),
      );
    } catch (err) {
      return [errorNode((err as Error).message)];
    }
  }

  private async getTables(connectionId: string, database: string): Promise<vscode.TreeItem[]> {
    const client = this.manager.getMySqlClient(connectionId);
    if (!client) {
      return [errorNode(t('mysqlNotConnectedReconnect'))];
    }
    try {
      const tables = await client.listTables(database);
      const filter = this.store.getTreeFilter(connectionId)?.tablesByDb?.[database];
      const visible = filter && filter.length > 0 ? tables.filter(t => filter.includes(t.name)) : tables;
      return visible.map(
        t =>
          new MysqlTableNode(
            connectionId,
            database,
            t.name,
            t.type,
            this.isExpanded(`table:${connectionId}:${database}:${t.name}`),
          ),
      );
    } catch (err) {
      return [errorNode((err as Error).message)];
    }
  }

  private async getColumns(
    connectionId: string,
    database: string,
    table: string,
  ): Promise<vscode.TreeItem[]> {
    const client = this.manager.getMySqlClient(connectionId);
    if (!client) {
      return [errorNode(t('mysqlNotConnectedReconnect'))];
    }
    try {
      const columns = await client.describeTable(database, table);
      return columns.map(
        c => new MysqlColumnNode(connectionId, database, table, c),
      );
    } catch (err) {
      return [errorNode((err as Error).message)];
    }
  }
}

function errorNode(message: string): vscode.TreeItem {
  const node = new vscode.TreeItem(t('loadFailed', { message }), vscode.TreeItemCollapsibleState.None);
  node.iconPath = new vscode.ThemeIcon('error');
  return node;
}
