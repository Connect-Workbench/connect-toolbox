import mysql, {
  FieldPacket,
  Pool,
  PoolConnection,
  RowDataPacket,
  ResultSetHeader,
} from 'mysql2/promise';
import { format } from 'sql-formatter';

// 公共类型定义在 SqlClient.ts，这里重新导出以兼容原有导入路径
export type {
  ColumnInfo,
  IndexInfo,
  QueryResult,
  SqlStatement,
  TableFilter,
  TableFilterOperator,
  TableInfo,
  TableQuery,
} from './SqlClient';
export { qualifiedTable } from './SqlClient';

import {
  ClientCapabilities,
  ColumnInfo,
  IndexInfo,
  QueryResult,
  SqlClient,
  SqlStatement,
  TableInfo,
  TableQuery,
  qualifiedTable,
  quoteIdentifier,
} from './SqlClient';
import { buildTableQuery } from './tableQuery';

/** 池大小刻意保守，避免给目标实例带来额外的连接压力 */
const POOL_CONNECTION_LIMIT = 3;
/** 空闲连接回收时间：越短，被服务端悄悄 kill 的连接被复用的窗口越小 */
const POOL_IDLE_TIMEOUT_MS = 30_000;
/** 池中最多保留的空闲连接数 */
const POOL_MAX_IDLE = 2;
const CONNECT_TIMEOUT_MS = 10_000;

/** 出现这些错误说明连接已不可用，换一条连接即可恢复 */
const RETRYABLE_CONNECTION_ERRORS = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

/** 只有只读语句允许自动重试；写语句重试可能造成重复写入 */
const READ_ONLY_KEYWORDS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES']);

function isRetryableConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_CONNECTION_ERRORS.has(code);
}

/** 取 SQL 首个关键字（跳过前导空白与注释） */
function firstKeyword(sql: string): string {
  const stripped = sql
    .replace(/^\s+/, '')
    .replace(/^(?:(?:\/\*[\s\S]*?\*\/)|(?:--[^\n]*(?:\n|$))|(?:#[^\n]*(?:\n|$)))\s*/g, '');
  const match = /^[A-Za-z]+/.exec(stripped);
  return match ? match[0].toUpperCase() : '';
}

function isReadOnlySql(sql: string): boolean {
  return READ_ONLY_KEYWORDS.has(firstKeyword(sql));
}

/**
 * MySQL 客户端封装（连接池）：
 * - 调用方持有的是「池」，底层连接断了由池换一条新的，使用层感知不到单条连接的生命周期
 * - 查询与元数据操作
 * - 结果序列化（Date/Buffer/BigInt → JSON 安全值）
 */
export class MySqlClient implements SqlClient {
  /** MySQL 支持表格编辑与事务式批量提交 */
  readonly capabilities: ClientCapabilities = { editable: true, transactions: true };

  private pool: Pool | null = null;
  /** 当前期望的库（执行 USE 后更新；未 USE 则为 undefined） */
  private database: string | undefined;
  /**
   * 每条池化连接当前实际所在的库。
   * 连接归还后会继续被其它调用方取走，USE 语义不会被池保留，
   * 因此每次取连接都要核对，必要时重新 USE。
   */
  private readonly connectionDatabase = new WeakMap<PoolConnection, string>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly user: string,
    private readonly password?: string,
  ) {}

  get connected(): boolean {
    return this.pool !== null;
  }

  /** 当前生效的库（连接层默认库或最近一次 USE 的库），可能为 undefined */
  get currentDatabase(): string | undefined {
    return this.database;
  }

  /**
   * 建立连接池。database 可选：传入则新建连接直接选定该库。
   * createPool 本身是惰性的，这里主动取一条连接 ping 一次，
   * 保证「连接成功」是确实连上过，而不是创建了一个空池就宣布成功。
   */
  async connect(database?: string): Promise<void> {
    if (this.pool) {
      return;
    }
    const pool = mysql.createPool({
      host: this.host,
      port: this.port,
      user: this.user,
      password: this.password,
      database,
      connectionLimit: POOL_CONNECTION_LIMIT,
      maxIdle: POOL_MAX_IDLE,
      idleTimeout: POOL_IDLE_TIMEOUT_MS,
      waitForConnections: true,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      supportBigNumbers: true,
      connectTimeout: CONNECT_TIMEOUT_MS,
      charset: 'utf8mb4',
    });
    if (database) {
      // 新建连接会带上建池时的默认库，先登记，省掉首次查询那次多余的 USE
      pool.on('connection', conn => {
        this.connectionDatabase.set(conn as unknown as PoolConnection, database);
      });
    }
    try {
      const probe = await pool.getConnection();
      try {
        await probe.ping();
      } finally {
        probe.release();
      }
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
    this.pool = pool;
    this.database = database;
  }

  /**
   * 切换当前库：在一条连接上执行 USE 校验权限，成功后记录为期望库。
   * 其它池化连接不在这里逐个切换，取用时按需对齐。
   */
  async useDatabase(database: string): Promise<void> {
    const conn = await this.ensurePool().getConnection();
    try {
      await conn.query(`USE ${quoteIdentifier(database)}`);
      this.connectionDatabase.set(conn, database);
    } finally {
      conn.release();
    }
    this.database = database;
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.database = undefined;
    if (pool) {
      await pool.end().catch(() => undefined);
    }
  }

  private ensurePool(): Pool {
    if (!this.pool) {
      throw new Error('MySQL 未连接');
    }
    return this.pool;
  }

  /**
   * 取一条连接执行操作，保证：
   * - 该连接所在库与期望库一致（不一致先 USE）
   * - 无论成功失败都归还连接
   */
  private async withConnection<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.ensurePool().getConnection();
    try {
      const target = this.database;
      if (target && this.connectionDatabase.get(conn) !== target) {
        await conn.query(`USE ${quoteIdentifier(target)}`);
        this.connectionDatabase.set(conn, target);
      }
      return await fn(conn);
    } finally {
      conn.release();
    }
  }

  /** 执行任意 SQL：SELECT 返回结果集；DML/DDL 返回影响行数 */
  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const start = Date.now();
    const [rows, fields] = await this.queryWithRetry(sql, params);

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

  /**
   * 池里的连接可能已被服务端回收（wait_timeout / 网络中断）而池尚未感知，
   * 此时首次查询会失败。只读语句换一条连接重试一次，对调用方完全透明；
   * 写语句不重试，避免重复写入。
   */
  private async queryWithRetry(
    sql: string,
    params?: unknown[],
  ): Promise<[RowDataPacket[] | ResultSetHeader, FieldPacket[]]> {
    const run = () =>
      this.withConnection<[RowDataPacket[] | ResultSetHeader, FieldPacket[]]>(conn =>
        params
          ? conn.query<RowDataPacket[] | ResultSetHeader>(sql, params)
          : conn.query<RowDataPacket[] | ResultSetHeader>(sql),
      );
    try {
      return await run();
    } catch (err) {
      if (!isRetryableConnectionError(err) || !isReadOnlySql(sql)) {
        throw err;
      }
      return await run();
    }
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
    const tbl = qualifiedTable(database, table);
    const autoInc = columns.filter(c => /auto_increment/i.test(c.extra)).map(c => c.field);
    let affected = 0;

    // 事务必须全程在同一条连接上完成，因此这里持有一条连接直到提交/回滚
    return this.withConnection(async conn => {
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
          // 主键列在 changes 中也可能被改：先排除主键（主键修改一般不允许，避免二次定位冲突）
          const pkCols = columns.filter(c => c.key === 'PRI').map(c => c.field);
          const finalSet = Object.entries(u.changes).filter(([c]) => !pkCols.includes(c));
          if (finalSet.length === 0) {
            continue;
          }
          const setSql = finalSet.map(([c]) => `\`${c.replace(/`/g, '``')}\` = ?`).join(', ');
          const where = pkCols
            .map(c => `\`${c.replace(/`/g, '``')}\` = ?`)
            .join(' AND ');
          if (!where) {
            continue;
          }
          const [r] = await conn.query<ResultSetHeader>(
            `UPDATE ${tbl} SET ${setSql} WHERE ${where}`,
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
    });
  }
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
