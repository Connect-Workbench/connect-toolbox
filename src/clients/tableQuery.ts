import { ColumnInfo, TableFilterOperator, TableQuery, quoteIdentifier } from './SqlClient';

/**
 * 单表查询条件构建（与具体驱动无关）。
 * 生成的 WHERE / ORDER BY 使用 ANSI 风格 + 反引号标识符，MySQL 与 ClickHouse 均可执行。
 * 值一律走 `?` 占位符，由各驱动自行绑定。
 */

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
 * 条件仍由数据库解析，因此支持括号、函数、CASE、LIKE、IN、BETWEEN 等复杂表达式。
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

export function buildTableQuery(query: TableQuery, columns: ColumnInfo[]): {
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
