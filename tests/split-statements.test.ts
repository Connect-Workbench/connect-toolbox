import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../src/clients/MySqlClient';

const texts = (sql: string): string[] => splitSqlStatements(sql).map(item => item.text);

describe('splitSqlStatements：多语句切分', () => {
  it('按分号切分多条语句', () => {
    expect(texts('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('忽略结尾多余的分号', () => {
    expect(texts('SELECT 1;')).toEqual(['SELECT 1']);
  });

  it('空输入不产生语句', () => {
    expect(texts('   ')).toEqual([]);
    expect(texts(';;')).toEqual([]);
  });

  it('字符串里的分号不切分', () => {
    expect(texts("SELECT 'a;b' AS x")).toEqual(["SELECT 'a;b' AS x"]);
  });

  it('注释里的分号不切分', () => {
    expect(texts('SELECT 1 -- a;b\n; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('保留语句在原文中的偏移', () => {
    const statements = splitSqlStatements('SELECT 1; SELECT 2');
    expect(statements).toHaveLength(2);
    expect(statements[0].start).toBe(0);
    expect(statements[1].start).toBeGreaterThan(statements[0].end - 1);
  });
});
