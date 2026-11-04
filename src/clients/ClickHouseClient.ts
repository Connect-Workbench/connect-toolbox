import { createClient, type ClickHouseClient as ClickHouseNativeClient } from '@clickhouse/client';
import {
  ClientCapabilities,
  ColumnInfo,
  IndexInfo,
  QueryResult,
  SqlClient,
  TableInfo,
  TableQuery,
  qualifiedTable,
} from './SqlClient';
import { buildTableQuery } from './tableQuery';

/** ClickHouse HTTP 接口默认端口（HTTPS 通常为 8443） */
export const CLICKHOUSE_HTTP_PORT = 8123;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * 单次查询返回行数上限（服务端保护）。
 * 注意 `result_overflow_mode: break` 是按 block 粒度断开的，实际行数会略超该值，
 * 因此这里同时用作「是否被截断」的判定阈值。
 */
const MAX_RESULT_ROWS = 100_000;

/**
 * 替换 URL 的目标地址（SSH 隧道场景用），保留 scheme / path / query 参数。
 */
export function rewriteEndpoint(endpoint: string, host: string, port: number): string {
  try {
    const url = new URL(endpoint);
    url.hostname = host;
    url.port = String(port);
    return url.toString();
  } catch {
    // 非标准 URL 时退化为直接拼接，至少保证能连
    return `http://${host}:${port}${endpoint.startsWith('/') ? endpoint : ''}`;
  }
}

/** 这些语句返回结果集，其余走 command 通道 */
const RESULT_SET_KEYWORDS = new Set([
  'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'TABLE', 'VALUES', 'CHECK',
]);

/** 取 SQL 首个关键字（跳过前导空白与注释） */
function firstKeyword(sql: string): string {
  const stripped = sql
    .replace(/^\s+/, '')
    .replace(/^(?:(?:\/\*[\s\S]*?\*\/)|(?:--[^\n]*(?:\n|$))|(?:#[^\n]*(?:\n|$)))\s*/g, '');
  const match = /^[A-Za-z]+/.exec(stripped);
  return match ? match[0].toUpperCase() : '';
}

export function isResultSetSql(sql: string): boolean {
  return RESULT_SET_KEYWORDS.has(firstKeyword(sql));
}

function paramType(value: unknown): string {
  if (typeof value === 'bigint') return 'Int64';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int64' : 'Float64';
  if (typeof value === 'boolean') return 'Bool';
  return 'String';
}

function paramValue(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * ClickHouse HTTP 接口使用 `{name:Type}` 形式的命名参数，与 `?` 占位符不兼容。
 * 这里按顺序把字符串字面量之外的 `?` 替换为命名参数。
 */
export function bindParams(sql: string, params: unknown[]): {
  query: string;
  queryParams: Record<string, unknown>;
} {
  if (params.length === 0) {
    return { query: sql, queryParams: {} };
  }
  const queryParams: Record<string, unknown> = {};
  let out = '';
  let quote: "'" | '"' | '`' | null = null;
  let index = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      out += char;
      if (char === '\\' && quote !== '`') {
        out += sql[i + 1] ?? '';
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '?') {
      if (index >= params.length) {
        throw new Error('SQL 占位符数量多于传入参数');
      }
      const name = `p${index}`;
      queryParams[name] = paramValue(params[index]);
      out += `{${name}:${paramType(params[index])}}`;
      index += 1;
      continue;
    }
    out += char;
  }
  if (index !== params.length) {
    throw new Error('SQL 占位符数量与传入参数不匹配');
  }
  return { query: out, queryParams };
}

function toRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/**
 * ClickHouse 客户端封装（HTTP 协议）。
 *
 * 与 MySQL 的关键差异：
 * - 无连接会话状态，`database` 属于建连参数，因此切库通过重建 client 实现
 * - 无事务，也不支持 MySQL 风格的 UPDATE/DELETE，因此不提供表格编辑能力
 * - 参数绑定是 `{name:Type}` 命名参数，由 bindParams 从 `?` 转换
 */
export class ClickHouseClient implements SqlClient {
  /** ClickHouse 不支持表格编辑与事务 */
  readonly capabilities: ClientCapabilities = { editable: false, transactions: false };

  private client: ClickHouseNativeClient | null = null;
  private database: string | undefined;

  /**
   * @param endpoint 完整 HTTP(S) 地址，例如 http://host:8123 或 https://host:8443/prefix
   */
  constructor(
    private readonly endpoint: string,
    private readonly user = 'default',
    private readonly password?: string,
  ) {}

  get connected(): boolean {
    return this.client !== null;
  }

  get currentDatabase(): string | undefined {
    return this.database;
  }

  async connect(database?: string): Promise<void> {
    if (this.client) {
      return;
    }
    const client = this.buildClient(database);
    try {
      await this.probe(client);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
    this.client = client;
    this.database = database;
  }

  /**
   * 切换当前库：HTTP 无会话状态，直接重建 client。
   * 先用新库探活，成功后再替换，避免把已有连接弄坏。
   */
  async useDatabase(database: string): Promise<void> {
    const next = this.buildClient(database);
    try {
      await this.probe(next);
    } catch (err) {
      await next.close().catch(() => undefined);
      throw err;
    }
    const previous = this.client;
    this.client = next;
    this.database = database;
    if (previous) {
      await previous.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.database = undefined;
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const started = Date.now();
    const client = this.ensureClient();
    const bound = bindParams(sql, params);

    if (!isResultSetSql(bound.query)) {
      const result = await client.command({
        query: bound.query,
        query_params: bound.queryParams,
      });
      return {
        columns: [],
        rows: [],
        affectedRows: Number(result.summary?.written_rows ?? 0),
        durationMs: Date.now() - started,
      };
    }

    const resultSet = await client.query({
      query: bound.query,
      format: 'JSON',
      query_params: bound.queryParams,
    });
    const payload = await resultSet.json<{
      meta?: { name: string; type: string }[];
      data?: unknown;
    }>();
    const rows = toRows(payload?.data);
    const columns =
      payload?.meta?.map(item => item.name) ??
      (rows.length > 0 ? Object.keys(rows[0]) : []);
    return {
      columns,
      rows,
      // 达到阈值即视为被服务端截断：调用方需要提示用户结果不完整
      truncated: rows.length >= MAX_RESULT_ROWS,
      durationMs: Date.now() - started,
    };
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.query(
      `SELECT name FROM system.databases
       WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
       ORDER BY name`,
    );
    return result.rows.map(row => String(row['name']));
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const result = await this.query(
      `SELECT name, if(engine = 'View', 'VIEW', 'BASE TABLE') AS type
       FROM system.tables WHERE database = ? ORDER BY name`,
      [database],
    );
    return result.rows.map(row => ({
      name: String(row['name']),
      type: row['type'] === 'VIEW' ? 'VIEW' : 'BASE TABLE',
    }));
  }

  async describeTable(database: string, table: string): Promise<ColumnInfo[]> {
    const result = await this.query(`DESCRIBE TABLE ${qualifiedTable(database, table)}`);
    return result.rows.map(row => {
      const type = String(row['type'] ?? '');
      return {
        field: String(row['name'] ?? ''),
        type,
        nullable: /^Nullable\(/i.test(type),
        // ClickHouse 的 ORDER BY 是排序键而非唯一约束，不能当主键用
        key: '',
        default: row['default_expression'] ? String(row['default_expression']) : undefined,
        extra: String(row['default_type'] ?? ''),
      };
    });
  }

  /** ClickHouse 没有 MySQL 那种建表语句美化，直接返回官方输出 */
  async showCreateTable(database: string, table: string): Promise<string> {
    const result = await this.query(`SHOW CREATE TABLE ${qualifiedTable(database, table)}`);
    const row = result.rows[0];
    if (!row) {
      throw new Error('未找到建表语句');
    }
    const key = Object.keys(row).find(k => /^statement$/i.test(k)) ?? Object.keys(row)[0];
    return String(row[key] ?? '');
  }

  /** 索引以跳数索引（data skipping index）形式存在 */
  async showIndexes(database: string, table: string): Promise<IndexInfo[]> {
    try {
      const result = await this.query(
        `SELECT name, expr, type FROM system.data_skipping_indices
         WHERE database = ? AND table = ? ORDER BY name`,
        [database, table],
      );
      return result.rows.map(row => ({
        name: String(row['name'] ?? ''),
        columns: String(row['expr'] ?? ''),
        unique: false,
      }));
    } catch {
      return [];
    }
  }

  /** 无主键概念：返回 undefined，表格编辑入口自动关闭 */
  async getPrimaryKey(): Promise<string[] | undefined> {
    return undefined;
  }

  async count(
    database: string,
    table: string,
    query: TableQuery = {},
    columns?: ColumnInfo[],
  ): Promise<number> {
    const tableColumns = columns ?? (await this.describeTable(database, table));
    const built = buildTableQuery(query, tableColumns);
    const result = await this.query(
      `SELECT count() AS cnt FROM ${qualifiedTable(database, table)}${built.whereSql}`,
      built.params,
    );
    return Number(result.rows[0]?.['cnt'] ?? 0);
  }

  async selectPage(
    database: string,
    table: string,
    offset: number,
    limit: number,
    query: TableQuery = {},
    columns?: ColumnInfo[],
  ): Promise<QueryResult> {
    const tableColumns = columns ?? (await this.describeTable(database, table));
    const built = buildTableQuery(query, tableColumns);
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
    return this.query(
      `SELECT * FROM ${qualifiedTable(database, table)}${built.whereSql}${built.orderSql} LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      built.params,
    );
  }

  async commitChanges(): Promise<{ affected: number }> {
    throw new Error('ClickHouse 不支持事务式编辑，请在 SQL 编辑器执行 ALTER TABLE ... UPDATE/DELETE');
  }

  private ensureClient(): ClickHouseNativeClient {
    if (!this.client) {
      throw new Error('ClickHouse 未连接');
    }
    return this.client;
  }

  private buildClient(database?: string): ClickHouseNativeClient {
    return createClient({
      url: this.endpoint,
      username: this.user,
      password: this.password,
      database,
      application: 'connect-toolbox',
      request_timeout: REQUEST_TIMEOUT_MS,
      clickhouse_settings: {
        // UInt64/Int64 一律以字符串返回，避免超出 JS 安全整数范围
        output_format_json_quote_64bit_integers: 1,
        // Decimal 同理：以字符串返回，避免 Decimal128/256 被 double 截断精度
        output_format_json_quote_decimals: 1,
        // 默认给没有 LIMIT 的查询兜底，防止误查全表拖垮扩展宿主
        max_result_rows: String(MAX_RESULT_ROWS),
        result_overflow_mode: 'break',
      },
    });
  }

  private async probe(client: ClickHouseNativeClient): Promise<void> {
    // 必须消费掉响应流：否则连接关闭时会报 "socket was closed before the response was fully read"
    const resultSet = await client.query({ query: 'SELECT 1', format: 'JSON' });
    await resultSet.json();
  }
}
