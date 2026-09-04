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
  /** 当前已选中的库（执行 USE 后更新；未 USE 则为 undefined） */
  private database: string | undefined;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly user: string,
    private readonly password?: string,
  ) {}

  get connected(): boolean {
    return this.connection !== null;
  }

  /** 当前生效的库（连接层默认库或最近一次 USE 的库），可能为 undefined */
  get currentDatabase(): string | undefined {
    return this.database;
  }

  /**
   * 建立连接。database 可选：传入则连接时直接选定该库（createConnection({ database })），
   * 否则连接处于"未选库"状态（靠 USE 或 SQL 里写全限定名）。
   */
  async connect(database?: string): Promise<void> {
    if (this.connection) {
      return;
    }
    this.connection = await mysql.createConnection({
      host: this.host,
      port: this.port,
      user: this.user,
      password: this.password,
      database,
      supportBigNumbers: true,
      connectTimeout: 10000,
      charset: 'utf8mb4',
    });
    this.database = database;
    this.connection.on('error', () => {
      this.connection = null;
    });
  }

  /** 切换当前库：执行 USE `db`，并更新本连接记录 */
  async useDatabase(database: string): Promise<void> {
    const safe = database.replace(/`/g, '``');
    await this.query(`USE \`${safe}\``);
    this.database = database;
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

/**
 * 把整段 SQL 切成若干条"可独立执行"的语句（保持原始顺序与文本）。
 *
 * 为什么不能朴素 split(';')：分号会出现在字符串、反引号标识符、行/块注释里，
 * 更关键的是 CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT 的函数体内部自带分号结尾，
 * 朴素切分会把一段 routine 定义切碎。因此这里做一个状态机分词器：
 *   - 引号：'...'（含 '' 转义）、"..."、"`...`"（含 `` 转义）
 *   - 注释：-- 到行尾、# 到行尾、/* ... *​/
 *   - 复合体深度：只按 BEGIN(+1)/END(-1) 配对；END IF/END CASE 这类 END<x> 不算
 *     （routine 正文内部的 ; 在 BEGIN..END 之内，不做语句边界）
 * 返回每条语句的 text 与在原文中的 [start,end) 区间（用于光标定位所属语句）。
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const n = sql.length;
  let i = 0;
  let stmtStart = 0; // 当前语句起点（用于定位）
  let pending = false; // 是否已开始收集一条语句正文
  let buffer = ''; // 当前语句正文（注释被替换为空白/换行）
  let depth = 0; // BEGIN..END 复合体深度

  const flush = (end: number) => {
    const text = buffer.trim();
    if (text) {
      statements.push({ text, start: stmtStart, end });
    }
    buffer = '';
    pending = false;
  };

  const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  const peekUpperWord = (): string => {
    let j = i;
    while (j < n && isWordChar(sql[j])) j += 1;
    return sql.slice(i, j).toUpperCase();
  };
  // 跳过一段空白与注释；调用前 i 停留在应跳过的内容
  const skipWsAndComments = (): void => {
    for (;;) {
      while (i < n && /\s/.test(sql[i])) i += 1;
      if (i + 1 < n && sql[i] === '-' && sql[i + 1] === '-') {
        while (i < n && sql[i] !== '\n') i += 1;
        continue;
      }
      if (i < n && sql[i] === '#') {
        while (i < n && sql[i] !== '\n') i += 1;
        continue;
      }
      if (i + 1 < n && sql[i] === '/' && sql[i + 1] === '*') {
        i += 2;
        while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
        i = Math.min(i + 2, n);
        continue;
      }
      break;
    }
  };

  while (i < n) {
    // 一条语句结束、准备开始下一条前：清理空白/注释并定位起点
    if (!pending) {
      skipWsAndComments();
      stmtStart = i;
      if (i >= n) break;
      pending = true;
      continue;
    }

    const c = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';
    // 语句边界：深度为 0 时遇到分号
    if (depth === 0 && c === ';') {
      flush(i);
      i += 1;
      continue;
    }

    // 单引号 / 双引号字符串
    if (c === "'" || c === '"') {
      const quote = c;
      buffer += c;
      i += 1;
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          buffer += sql[i] + sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            buffer += sql[i] + sql[i + 1];
            i += 2;
            continue;
          }
          buffer += quote;
          i += 1;
          break;
        }
        buffer += sql[i];
        i += 1;
      }
      continue;
    }
    // 反引号标识符
    if (c === '`') {
      buffer += c;
      i += 1;
      while (i < n) {
        if (sql[i] === '`') {
          if (i + 1 < n && sql[i + 1] === '`') {
            buffer += '``';
            i += 2;
            continue;
          }
          buffer += '`';
          i += 1;
          break;
        }
        buffer += sql[i];
        i += 1;
      }
      continue;
    }
    // 行/块注释：保留空白结构，不进入语句正文
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      buffer += '\n';
      continue;
    }
    if (c === '#') {
      while (i < n && sql[i] !== '\n') i += 1;
      buffer += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      buffer += ' ';
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }
    // 复合体 BEGIN/END 配对（只影响语句边界，不影响引号/注释判定）
    if (isWordChar(c)) {
      const word = peekUpperWord();
      if (word === 'BEGIN') {
        depth += 1;
      } else if (word === 'END') {
        // END 后紧跟 IF/CASE/LOOP/REPEAT/WHILE 时属于嵌套构造收尾，不计入 BEGIN 配对
        let j = i + word.length;
        while (j < n && /\s/.test(sql[j])) j += 1;
        const after = sql.slice(j).match(/^(IF|CASE|LOOP|REPEAT|WHILE)\b/i);
        if (!after) {
          if (depth > 0) depth -= 1;
        }
      }
      buffer += sql.slice(i, i + word.length);
      i += word.length;
      continue;
    }
    buffer += c;
    i += 1;
  }
  if (pending && buffer.trim()) {
    flush(n);
  }
  return statements;
}
