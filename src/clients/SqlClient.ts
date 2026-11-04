/**
 * 数据库客户端公共契约。
 *
 * 目前有 MySQL / ClickHouse 两种实现：上层（树视图、查询面板、表格面板、命令）
 * 只依赖这里的接口，不感知具体驱动。
 */

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** 影响行数（INSERT/UPDATE/DELETE） */
  affectedRows?: number;
  /** 自增主键（INSERT） */
  insertId?: number;
  /** 结果集被驱动侧截断（如 ClickHouse 的 max_result_rows 保护），行数不完整 */
  truncated?: boolean;
  durationMs: number;
}

/** 一条待执行的 SQL 语句（分词器切分结果，已去注释与首尾空白） */
export interface SqlStatement {
  /** 该语句在原始文本中的内容（保留注释外的原文，便于执行与展示） */
  text: string;
  /** 语句在原始文本里的起始偏移（含前导空白/注释，用于前端定位光标所属语句） */
  start: number;
  /** 语句文本在原始文本中的结束偏移 */
  end: number;
}

export interface TableInfo {
  name: string;
  type: 'BASE TABLE' | 'VIEW';
}

export interface ColumnInfo {
  field: string;
  type: string;
  nullable: boolean;
  key: string;
  default: unknown;
  extra: string;
}

/** 过滤操作符（值通过预编译参数绑定） */
export type TableFilterOperator =
  | '='
  | '!='
  | '<>'
  | '>'
  | '>='
  | '<'
  | '<='
  | 'LIKE'
  | 'NOT LIKE'
  | 'IN'
  | 'NOT IN'
  | 'BETWEEN'
  | 'NOT BETWEEN'
  | 'REGEXP'
  | 'NOT REGEXP'
  | 'IS NULL'
  | 'IS NOT NULL';

export interface TableFilter {
  field: string;
  operator: TableFilterOperator;
  value?: string;
}

export interface TableQuery {
  sort?: { field: string; direction: 'asc' | 'desc' };
  filters?: TableFilter[];
  /** 单表 SQL WHERE 条件（不含完整 SELECT） */
  sqlFilter?: string;
}

export interface IndexInfo {
  name: string;
  columns: string;
  unique: boolean;
}

/** 单库内执行 SQL 的前缀（避免依赖当前选中库） */
export function qualifiedTable(database: string, table: string): string {
  return `\`${database.replace(/`/g, '``')}\`.${quoteIdentifier(table)}`;
}

export function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

/**
 * 驱动的能力声明：界面据此决定是否开放编辑入口。
 */
export interface ClientCapabilities {
  /** 是否支持表格内增删改 */
  editable: boolean;
  /** 是否支持事务式批量提交 */
  transactions: boolean;
}

export interface SqlClient {
  readonly connected: boolean;
  readonly currentDatabase: string | undefined;
  readonly capabilities: ClientCapabilities;

  connect(database?: string): Promise<void>;
  close(): Promise<void>;

  useDatabase(database: string): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;

  listDatabases(): Promise<string[]>;
  listTables(database: string): Promise<TableInfo[]>;
  describeTable(database: string, table: string): Promise<ColumnInfo[]>;
  showCreateTable(database: string, table: string): Promise<string>;
  showIndexes(database: string, table: string): Promise<IndexInfo[]>;

  /** 无主键概念返回 undefined（表格编辑会自动关闭） */
  getPrimaryKey(database: string, table: string): Promise<string[] | undefined>;

  count(database: string, table: string, query?: TableQuery, columns?: ColumnInfo[]): Promise<number>;
  selectPage(
    database: string,
    table: string,
    offset: number,
    limit: number,
    query?: TableQuery,
    columns?: ColumnInfo[],
  ): Promise<QueryResult>;

  commitChanges(
    database: string,
    table: string,
    ops: {
      inserts: Record<string, string>[];
      updates: { pkValues: string[]; changes: Record<string, string> }[];
      deletes: { pkValues: string[] }[];
    },
    columns: ColumnInfo[],
  ): Promise<{ affected: number }>;
}
