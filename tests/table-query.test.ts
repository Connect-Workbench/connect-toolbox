import { describe, expect, it } from 'vitest';
import { buildTableQuery } from '../src/clients/tableQuery';
import type { ColumnInfo } from '../src/clients/SqlClient';

const columns: ColumnInfo[] = [
  { field: 'id', type: 'int', nullable: false, key: 'PRI', default: null, extra: 'auto_increment' },
  { field: 'name', type: 'varchar(64)', nullable: true, key: '', default: null, extra: '' },
  { field: 'age', type: 'int', nullable: true, key: '', default: null, extra: '' },
];

describe('buildTableQuery：单表条件构建', () => {
  it('无条件时不生成 WHERE / ORDER BY', () => {
    expect(buildTableQuery({}, columns)).toEqual({ whereSql: '', orderSql: '', params: [] });
  });

  it('等值过滤生成占位符', () => {
    const built = buildTableQuery({ filters: [{ field: 'name', operator: '=', value: 'x' }] }, columns);
    expect(built.whereSql).toBe(' WHERE `name` = ?');
    expect(built.params).toEqual(['x']);
  });

  it('IN 过滤展开为多个占位符', () => {
    const built = buildTableQuery({ filters: [{ field: 'id', operator: 'IN', value: '1, 2,3' }] }, columns);
    expect(built.whereSql).toBe(' WHERE `id` IN (?, ?, ?)');
    expect(built.params).toEqual(['1', '2', '3']);
  });

  it('BETWEEN 生成两个占位符', () => {
    const built = buildTableQuery(
      { filters: [{ field: 'age', operator: 'BETWEEN', value: '18, 30' }] },
      columns,
    );
    expect(built.whereSql).toBe(' WHERE `age` BETWEEN ? AND ?');
    expect(built.params).toEqual(['18', '30']);
  });

  it('IS NULL 不产生参数', () => {
    const built = buildTableQuery({ filters: [{ field: 'name', operator: 'IS NULL' }] }, columns);
    expect(built.whereSql).toBe(' WHERE `name` IS NULL');
    expect(built.params).toEqual([]);
  });

  it('多个过滤条件用 AND 连接', () => {
    const built = buildTableQuery(
      {
        filters: [
          { field: 'name', operator: 'LIKE', value: '%a%' },
          { field: 'age', operator: '>=', value: '18' },
        ],
      },
      columns,
    );
    expect(built.whereSql).toBe(' WHERE `name` LIKE ? AND `age` >= ?');
    expect(built.params).toEqual(['%a%', '18']);
  });

  it('排序列生成 ORDER BY', () => {
    const built = buildTableQuery({ sort: { field: 'id', direction: 'desc' } }, columns);
    expect(built.orderSql).toBe(' ORDER BY `id` DESC');
  });

  it('未知列报错', () => {
    expect(() =>
      buildTableQuery({ filters: [{ field: 'nope', operator: '=', value: '1' }] }, columns),
    ).toThrow('过滤列不存在：nope');
  });

  it('未知排序列报错', () => {
    expect(() =>
      buildTableQuery({ sort: { field: 'nope', direction: 'asc' } }, columns),
    ).toThrow('排序列不存在：nope');
  });

  it('sqlFilter 去掉多余的 WHERE 前缀并包在括号里', () => {
    const built = buildTableQuery({ sqlFilter: 'WHERE age > 10' }, columns);
    expect(built.whereSql).toBe(' WHERE (age > 10)');
  });

  it('sqlFilter 禁止多语句', () => {
    expect(() => buildTableQuery({ sqlFilter: '1=1; DROP TABLE x' }, columns)).toThrow(
      'SQL 过滤条件不允许包含多语句或注释',
    );
  });

  it('sqlFilter 禁止子查询关键字', () => {
    expect(() => buildTableQuery({ sqlFilter: 'id IN (SELECT id FROM t)' }, columns)).toThrow(
      'SQL 过滤条件不支持关键字：SELECT',
    );
  });

  it('sqlFilter 允许函数与括号', () => {
    const built = buildTableQuery({ sqlFilter: "length(name) > 3 AND name LIKE 'a%'" }, columns);
    expect(built.whereSql).toBe(" WHERE (length(name) > 3 AND name LIKE 'a%')");
  });
});
