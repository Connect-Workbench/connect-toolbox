import { describe, expect, it } from 'vitest';
import { bindParams, isResultSetSql } from '../src/clients/ClickHouseClient';

describe('bindParams：? → {name:Type} 转换', () => {
  it('无参数时原样返回', () => {
    const result = bindParams('SELECT 1', []);
    expect(result.query).toBe('SELECT 1');
    expect(result.queryParams).toEqual({});
  });

  it('按顺序替换多个占位符', () => {
    const result = bindParams('SELECT * FROM t WHERE a = ? AND b = ?', ['x', 2]);
    expect(result.query).toBe('SELECT * FROM t WHERE a = {p0:String} AND b = {p1:Int64}');
    expect(result.queryParams).toEqual({ p0: 'x', p1: 2 });
  });

  it('字符串字面量里的 ? 不会被替换', () => {
    const result = bindParams("SELECT '?' AS q, ? AS v", [1]);
    expect(result.query).toBe("SELECT '?' AS q, {p0:Int64} AS v");
    expect(result.queryParams).toEqual({ p0: 1 });
  });

  it('双引号与反引号内的 ? 也不会被替换', () => {
    const result = bindParams('SELECT "?" , `weird?name`, ?', ['v']);
    expect(result.query).toBe('SELECT "?" , `weird?name`, {p0:String}');
  });

  it('参数多于占位符时报错', () => {
    expect(() => bindParams('SELECT ?', ['a', 'b'])).toThrow('SQL 占位符数量与传入参数不匹配');
  });

  it('占位符多于参数时报错', () => {
    expect(() => bindParams('SELECT ?, ?', ['a'])).toThrow('SQL 占位符数量多于传入参数');
  });

  it('按 JS 类型推断 ClickHouse 参数类型', () => {
    const result = bindParams('SELECT ?, ?, ?, ?, ?, ?', [1, 1.5, true, 'text', 10n, null]);
    expect(result.query).toBe(
      'SELECT {p0:Int64}, {p1:Float64}, {p2:Bool}, {p3:String}, {p4:Int64}, {p5:String}',
    );
    expect(result.queryParams).toEqual({
      p0: 1,
      p1: 1.5,
      p2: true,
      p3: 'text',
      p4: '10',
      p5: '',
    });
  });

  it('转义字符不会提前结束字符串', () => {
    const result = bindParams("SELECT 'it\\'s ?' AS s, ? AS v", [7]);
    expect(result.query).toBe("SELECT 'it\\'s ?' AS s, {p0:Int64} AS v");
  });
});

describe('isResultSetSql：判断走结果集通道还是 command 通道', () => {
  it.each([
    ['SELECT 1', true],
    ['  select 1', true],
    ['/* hint */ SELECT 1', true],
    ['-- comment\nSHOW TABLES', true],
    ['# comment\nDESCRIBE TABLE t', true],
    ['WITH x AS (SELECT 1) SELECT * FROM x', true],
    ['EXPLAIN SELECT 1', true],
    ['INSERT INTO t VALUES (1)', false],
    ['CREATE TABLE t (id Int32) ENGINE = Memory', false],
    ['DROP TABLE t', false],
    ['ALTER TABLE t UPDATE a = 1', false],
    ['', false],
  ])('%s → %s', (sql, expected) => {
    expect(isResultSetSql(sql)).toBe(expected);
  });
});
