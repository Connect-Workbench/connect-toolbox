import mysql, { Connection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { format } from 'sql-formatter';

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** 影响行数（INSERT/UPDATE/DELETE） */
  affectedRows?: number;
  /** 自增主键（INSERT） */
  insertId?: number;
  durationMs: number;
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

/** MySQL 原生过滤操作符（值通过预编译参数绑定） */
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
  return `\`${database.replace(/`/g, '``')}\`.\`${table.replace(/`/g, '``')}\``;
}

/**
 * MySQL 客户端封装（单连接）：
 * - 查询与元数据操作
 * - 结果序列化（Date/Buffer/BigInt → JSON 安全值）
 */
export class MySqlClient {
  private connection: Connection | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly user: string,
    private readonly password?: string,
  ) {}

  get connected(): boolean {
    return this.connection !== null;
  }

  async connect(): Promise<void> {
    if (this.connection) {
      return;
    }
    this.connection = await mysql.createConnection({
      host: this.host,
      port: this.port,
      user: this.user,
      password: this.password,
      supportBigNumbers: true,
      connectTimeout: 10000,
      charset: 'utf8mb4',
    });
    this.connection.on('error', () => {
      this.connection = null;
    });
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.end().catch(() => undefined);
      this.connection = null;
    }
  }

  private ensure(): Connection {
    if (!this.connection) {
      throw new Error('MySQL 未连接');
    }
    return this.connection;
  }

  /** 执行任意 SQL：SELECT 返回结果集；DML/DDL 返回影响行数 */
  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const start = Date.now();
    const conn = this.ensure();
    const [rows, fields] = params
      ? await conn.query<RowDataPacket[] | ResultSetHeader>(sql, params)
      : await conn.query<RowDataPacket[] | ResultSetHeader>(sql);

    if (Array.isArray(rows)) {
      const columns = (fields ?? []).map(f => f.name);
      return {
        columns,
        rows: rows.map(row => serializeRow(row as RowDataPacket)),
        durationMs: Date.now() - start,
      };
    }
    // DML / DDL：ResultSetHeader
    return {
      columns: [],
      rows: [],
      affectedRows: rows.affectedRows,
      insertId: rows.insertId,
      durationMs: Date.now() - start,
    };
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.query('SHOW DATABASES');
    const col = result.columns[0];
    return result.rows
      .map(r => String(r[col]))
      .filter(
        name =>
          !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(name),
      );
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const result = await this.query(
      `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database],
    );
    return result.rows.map(r => ({
      name: String(r['TABLE_NAME']),
      type: r['TABLE_TYPE'] === 'VIEW' ? 'VIEW' : 'BASE TABLE',
    }));
  }

  async describeTable(database: string, table: string): Promise<ColumnInfo[]> {
    const result = await this.query(`DESCRIBE ${qualifiedTable(database, table)}`);
    return result.rows.map(r => ({
      field: String(r['Field']),
      type: String(r['Type']),
      nullable: r['Null'] === 'YES',
      key: String(r['Key'] ?? ''),
      default: r['Default'],
      extra: String(r['Extra'] ?? ''),
    }));
  }

  /**
   * 获取 DDL（SHOW CREATE TABLE / VIEW）并美化：
   * 方案 A——官方无损输出 + sql-formatter 排版，覆盖触发器/外键/分区/生成列等全部场景
   */
  async showCreateTable(database: string, table: string): Promise<string> {
    const result = await this.query(`SHOW CREATE TABLE ${qualifiedTable(database, table)}`);
    const row = result.rows[0];
    if (!row) {
      throw new Error('未找到建表语句');
    }
    const col = Object.keys(row).find(k => /^Create (Table|View)/i.test(k));
    const raw = String(row[col ?? Object.keys(row)[1]]);
    try {
      return format(raw, {
        language: 'mysql',
        tabWidth: 4,
        keywordCase: 'lower',
        linesBetweenQueries: 2,
      });
    } catch {
      // 解析失败兜底：原样返回（SHOW CREATE 官方输出永远可执行）
      return raw;
    }
  }

  async showIndexes(database: string, table: string): Promise<IndexInfo[]> {
    const result = await this.query(`SHOW INDEX FROM ${qualifiedTable(database, table)}`);
    const map = new Map<string, IndexInfo>();
    for (const r of result.rows) {
      const name = String(r['Key_name']);
      const col = String(r['Column_name']);
      const unique = Number(r['Non_unique']) === 0;
      const existing = map.get(name);
      if (existing) {
        existing.columns += `, ${col}`;
      } else {
        map.set(name, { name, columns: col, unique });
      }
    }
    return [...map.values()];
  }

  /** 主键列名（无主键返回 undefined，编辑功能依赖它） */
  async getPrimaryKey(database: string, table: string): Promise<string[] | undefined> {
    const columns = await this.describeTable(database, table);
    const pks = columns.filter(c => c.key === 'PRI').map(c => c.field);
    return pks.length > 0 ? pks : undefined;
  }

  async count(
    database: string,
    table: string,
    query: TableQuery = {},
    columns?: ColumnInfo[],
  ): Promise<number> {
    const tableColumns = columns ?? await this.describeTable(database, table);
    const built = buildTableQuery(query, tableColumns);
    const result = await this.query(
      `SELECT COUNT(*) AS cnt FROM ${qualifiedTable(database, table)}${built.whereSql}`,
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
    const tableColumns = columns ?? await this.describeTable(database, table);
    const built = buildTableQuery(query, tableColumns);
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
    return this.query(
      `SELECT * FROM ${qualifiedTable(database, table)}${built.whereSql}${built.orderSql} LIMIT ${safeOffset}, ${safeLimit}`,
      built.params,
    );
  }

  /**
   * 事务批量提交：新增 / 修改 / 删除 全部成功才 COMMIT，任一失败 ROLLBACK。
   * @param database 数据库名
   * @param table 表名
   * @param ops 变更集合
   * @param columns 表列定义（用于过滤 auto_increment / 主键）
   */
  async commitChanges(
    database: string,
    table: string,
    ops: {
      inserts: Record<string, string>[];
      updates: { pkValues: string[]; changes: Record<string, string> }[];
      deletes: { pkValues: string[] }[];
    },
    columns: ColumnInfo[],
  ): Promise<{ affected: number }> {
    const conn = this.ensure();
    const tbl = qualifiedTable(database, table);
    const autoInc = columns.filter(c => /auto_increment/i.test(c.extra)).map(c => c.field);
    let affected = 0;

    await conn.beginTransaction();
    try {
      // 1) 删除（先删子引用，按主键）
      for (const d of ops.deletes) {
        const where = d.pkValues
          .map((v, i) => {
            const col = columns[i]?.field ?? '';
            return col ? `\`${col.replace(/`/g, '``')}\` = ?` : '';
          })
          .filter(Boolean)
          .join(' AND ');
        if (where) {
          const [r] = await conn.query<ResultSetHeader>(
            `DELETE FROM ${tbl} WHERE ${where}`,
            d.pkValues.map(v => cellToParam(v)),
          );
          affected += r.affectedRows;
        }
      }

      // 2) 修改（按主键定位，仅更新变化的列）
      for (const u of ops.updates) {
        const setCols = Object.keys(u.changes);
        if (setCols.length === 0) {
          continue;
        }
        const setSql = setCols
          .map(c => `\`${c.replace(/`/g, '``')}\` = ?`)
          .join(', ');
        // 主键列在 changes 中也可能被改：先排除主键（主键修改一般不允许，避免二次定位冲突）
        const pkCols = columns.filter(c => c.key === 'PRI').map(c => c.field);
        const finalSet = Object.entries(u.changes).filter(([c]) => !pkCols.includes(c));
        if (finalSet.length === 0) {
          continue;
        }
        const setSql2 = finalSet.map(([c]) => `\`${c.replace(/`/g, '``')}\` = ?`).join(', ');
        const where = pkCols
          .map(c => `\`${c.replace(/`/g, '``')}\` = ?`)
          .join(' AND ');
        if (!where) {
          continue;
        }
        const [r] = await conn.query<ResultSetHeader>(
          `UPDATE ${tbl} SET ${setSql2} WHERE ${where}`,
          [...finalSet.map(([, v]) => cellToParam(v)), ...u.pkValues],
        );
        affected += r.affectedRows;
      }

      // 3) 新增（跳过 auto_increment 列）
      for (const ins of ops.inserts) {
        const cols = Object.keys(ins).filter(c => !autoInc.includes(c));
        if (cols.length === 0) {
          continue;
        }
        const names = cols.map(c => `\`${c.replace(/`/g, '``')}\``).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const params = cols.map(c => cellToParam(ins[c]));
        const [r] = await conn.query<ResultSetHeader>(
          `INSERT INTO ${tbl} (${names}) VALUES (${placeholders})`,
          params,
        );
        affected += r.affectedRows;
      }

      await conn.commit();
      return { affected };
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* rollback 失败静默 */
      }
      throw err;
    }
  }
}

const SQL_FILTER_MAX_LENGTH = 4000;
const SQL_FILTER_FORBIDDEN_WORDS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE',
  'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE',
  'UNION', 'FROM', 'INTO', 'SET', 'CALL', 'DO', 'HANDLER', 'LOAD',
  'SHOW', 'DESCRIBE', 'EXPLAIN', 'USE', 'PROCEDURE', 'FUNCTION', 'EVENT',
  'DELIMITER', 'OUTFILE', 'DUMPFILE',
]);

/**
 * 规范化单表 SQL 条件：只接受 WHERE 表达式，不接受完整 SQL 或多语句。
 * 条件仍由 MySQL 解析，因此支持括号、函数、CASE、LIKE、IN、BETWEEN 等复杂表达式。
 */
function normalizeSqlFilter(input: string | undefined): string {
  let value = String(input ?? '').trim();
  if (!value) return '';
  if (/^WHERE\b/i.test(value)) {
    value = value.replace(/^WHERE\b/i, '').trim();
  }
  if (!value) return '';
  if (value.length > SQL_FILTER_MAX_LENGTH) {
    throw new Error(`SQL 过滤条件不能超过 ${SQL_FILTER_MAX_LENGTH} 个字符`);
  }

  let quote: "'" | '"' | '`' | null = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const next = value[i + 1];
    if (quote) {
      if ((quote === "'" || quote === '"') && char === '\\') {
        i += 1;
      } else if (char === quote) {
        if (next === quote) {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === ';' || (char === '-' && next === '-' && (i + 2 >= value.length || /\s/.test(value[i + 2]))) || char === '#') {
      throw new Error('SQL 过滤条件不允许包含多语句或注释');
    }
    if (char === '/' && next === '*') {
      throw new Error('SQL 过滤条件不允许包含注释');
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        throw new Error('SQL 过滤条件括号不匹配');
      }
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = i + 1;
      while (end < value.length && /[A-Za-z0-9_$]/.test(value[end])) end += 1;
      const word = value.slice(i, end).toUpperCase();
      if (SQL_FILTER_FORBIDDEN_WORDS.has(word)) {
        throw new Error(`SQL 过滤条件不支持关键字：${word}`);
      }
      i = end - 1;
    }
  }
  if (quote) {
    throw new Error('SQL 过滤条件引号不匹配');
  }
  if (depth !== 0) {
    throw new Error('SQL 过滤条件括号不匹配');
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function buildTableQuery(query: TableQuery, columns: ColumnInfo[]): {
  whereSql: string;
  orderSql: string;
  params: unknown[];
} {
  const allowedColumns = new Set(columns.map(column => column.field));
  const filters = query.filters ?? [];
  const whereParts: string[] = [];
  const params: unknown[] = [];
  const operators = new Set<TableFilterOperator>([
    '=', '!=', '<>', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE',
    'IN', 'NOT IN', 'BETWEEN', 'NOT BETWEEN', 'REGEXP', 'NOT REGEXP',
    'IS NULL', 'IS NOT NULL',
  ]);

  for (const filter of filters) {
    if (!allowedColumns.has(filter.field)) {
      throw new Error(`过滤列不存在：${filter.field}`);
    }
    if (!operators.has(filter.operator)) {
      throw new Error(`不支持的过滤操作符：${filter.operator}`);
    }
    const column = quoteIdentifier(filter.field);
    if (filter.operator === 'IS NULL' || filter.operator === 'IS NOT NULL') {
      whereParts.push(`${column} ${filter.operator}`);
      continue;
    }

    const rawValue = String(filter.value ?? '').trim();
    if (!rawValue) {
      throw new Error(`${filter.field} 的过滤值不能为空`);
    }
    if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
      const values = rawValue.split(',').map(value => value.trim()).filter(Boolean);
      if (values.length === 0) {
        throw new Error(`${filter.field} 的 IN 条件至少需要一个值`);
      }
      whereParts.push(`${column} ${filter.operator} (${values.map(() => '?').join(', ')})`);
      params.push(...values);
      continue;
    }
    if (filter.operator === 'BETWEEN' || filter.operator === 'NOT BETWEEN') {
      const values = rawValue.split(',').map(value => value.trim());
      if (values.length !== 2 || values.some(value => !value)) {
        throw new Error(`${filter.field} 的 ${filter.operator} 条件需要用逗号分隔两个值`);
      }
      whereParts.push(`${column} ${filter.operator} ? AND ?`);
      params.push(values[0], values[1]);
      continue;
    }
    whereParts.push(`${column} ${filter.operator} ?`);
    params.push(rawValue);
  }

  const sqlFilter = normalizeSqlFilter(query.sqlFilter);
  if (sqlFilter) {
    whereParts.push(`(${sqlFilter})`);
  }

  let orderSql = '';
  if (query.sort) {
    if (!allowedColumns.has(query.sort.field)) {
      throw new Error(`排序列不存在：${query.sort.field}`);
    }
    const direction = query.sort.direction === 'desc' ? 'DESC' : 'ASC';
    orderSql = ` ORDER BY ${quoteIdentifier(query.sort.field)} ${direction}`;
  }
  return {
    whereSql: whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '',
    orderSql,
    params,
  };
}

/**
 * 将 mysql2 返回值序列化为 JSON 安全结构：
 * Date → ISO 字符串；Buffer → {__type:'hex', value}；bigint → 字符串；其余原样
 */
export function serializeCell(v: unknown): unknown {
  if (v === null || v === undefined) {
    return v;
  }
  if (Buffer.isBuffer(v)) {
    return { __type: 'hex', value: v.toString('hex') };
  }
  if (v instanceof Date) {
    return v.toISOString();
  }
  if (typeof v === 'bigint') {
    return v.toString();
  }
  if (typeof v === 'object') {
    try {
      JSON.stringify(v);
      return v;
    } catch {
      return String(v);
    }
  }
  return v;
}

function serializeRow(row: RowDataPacket): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = serializeCell(v);
  }
  return out;
}

/** 前端回传编辑值时解析：空串=undefined(NULL)，否则原样字符串 */
export function cellToParam(v: string | null | undefined): string | null {
  return v === null || v === undefined || v === '' ? null : v;
}
