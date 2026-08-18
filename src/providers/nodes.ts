import * as vscode from 'vscode';
import { ColumnInfo } from '../clients/MySqlClient';

export class MysqlDatabaseNode extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly database: string,
    expanded = false,
  ) {
    super(database, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'mysqlDatabase';
    this.iconPath = new vscode.ThemeIcon('database');
  }
}

export class MysqlTableNode extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly database: string,
    readonly table: string,
    readonly tableType: 'BASE TABLE' | 'VIEW',
    expanded = false,
  ) {
    super(table, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'mysqlTable';
    this.iconPath = new vscode.ThemeIcon(tableType === 'VIEW' ? 'eye' : 'table');
    this.description = tableType === 'VIEW' ? '视图' : undefined;
  }
}

export class MysqlColumnNode extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly database: string,
    readonly table: string,
    readonly column: ColumnInfo,
  ) {
    const keyIcon = column.key === 'PRI' ? '$(key) ' : column.key === 'UNI' ? '$(star-full) ' : column.key === 'MUL' ? '$(list-flat) ' : '';
    super(keyIcon + column.field, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'mysqlColumn';
    this.description = column.type + (column.extra ? ` ${column.extra}` : '');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${column.field}**  \`${column.type}\``,
        '',
        `- 可空: ${column.nullable ? '是' : '否'}`,
        `- 键: \`${column.key || '-'}\``,
        `- 默认值: \`${column.default ?? 'NULL'}\``,
        column.extra ? `- 附加: \`${column.extra}\`` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}
