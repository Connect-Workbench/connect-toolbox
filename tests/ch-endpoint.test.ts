import { describe, expect, it } from 'vitest';
import { rewriteEndpoint } from '../src/clients/ClickHouseClient';

describe('rewriteEndpoint：隧道场景下的地址改写', () => {
  it('替换 host:port，保留 scheme', () => {
    expect(rewriteEndpoint('http://ch.example.com:8123', '127.0.0.1', 40001)).toBe(
      'http://127.0.0.1:40001/',
    );
  });

  it('保留 https', () => {
    expect(rewriteEndpoint('https://ch.example.com:8443', '127.0.0.1', 40001)).toBe(
      'https://127.0.0.1:40001/',
    );
  });

  it('保留路径前缀', () => {
    expect(rewriteEndpoint('http://host:8123/clickhouse', '127.0.0.1', 40001)).toBe(
      'http://127.0.0.1:40001/clickhouse',
    );
  });

  it('保留 query 参数', () => {
    expect(rewriteEndpoint('http://host:8123/db?compress=1', '127.0.0.1', 40002)).toBe(
      'http://127.0.0.1:40002/db?compress=1',
    );
  });

  it('非法地址退化为直接拼接', () => {
    expect(rewriteEndpoint('not a url', '127.0.0.1', 40003)).toBe('http://127.0.0.1:40003');
  });
});
