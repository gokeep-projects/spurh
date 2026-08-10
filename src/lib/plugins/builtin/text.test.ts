import { describe, expect, it } from 'vitest';
import { runtime } from '../index';

type LogEntryShape = { line: number; time?: string; level?: string; source?: string; message: string; stack?: string[] };

const SAMPLE_LOG = `2026-08-10 09:12:33,451 INFO  com.spurh.api.Startup - 服务启动完成，监听 0.0.0.0:8080
2026-08-10 09:12:34,012 WARN  com.spurh.api.Cache - 缓存命中率低于 80%，建议扩容
2026-08-10 09:12:35,880 ERROR com.spurh.db.Pool - 获取连接超时 - ConnectionPool.java:142
	at com.spurh.db.Pool.acquire(Pool.java:88)
	at com.spurh.api.UserService.load(UserService.java:45)
Caused by: java.sql.SQLTimeoutException: Timeout after 3000ms
	at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:199)
2026-08-10 09:12:36,001 FATAL com.spurh.core.App - 关键服务不可用，进程退出
2026-08-10 09:12:37,200 DEBUG com.spurh.api.Tracer - trace=abc123 span=456`;

describe('text plugin log-parse', () => {
  it('extracts levels, timestamps and counts', async () => {
    const r = await runtime.execute('spurh.text', 'log-parse', SAMPLE_LOG);
    expect(r.view).toBe('log');
    const data = r.data as { entries: LogEntryShape[]; counts: Record<string, number>; rootCause?: string };
    expect(data.entries.length).toBe(5);
    expect(data.counts.INFO).toBe(1);
    expect(data.counts.WARN).toBe(1);
    expect(data.counts.ERROR).toBe(1);
    expect(data.counts.FATAL).toBe(1);
    expect(data.counts.DEBUG).toBe(1);
    const error = data.entries.find((e) => e.level === 'ERROR') as LogEntryShape | undefined;
    expect(error?.source).toContain('ConnectionPool.java:142');
    expect(error?.stack?.length).toBeGreaterThanOrEqual(2);
    expect(error?.stack?.[0]).toContain('at com.spurh.db.Pool.acquire');
  });

  it('extracts root cause from Caused by', async () => {
    const r = await runtime.execute('spurh.text', 'log-parse', SAMPLE_LOG);
    const data = r.data as { rootCause?: string };
    expect(data.rootCause).toContain('java.sql.SQLTimeoutException');
  });

  it('falls back to last error message as root cause', async () => {
    const r = await runtime.execute('spurh.text', 'log-parse', '2026-08-10 10:00:00 ERROR app - boom\n2026-08-10 10:00:01 INFO app - ok');
    const data = r.data as { rootCause?: string; entries: unknown[] };
    expect(data.rootCause).toBe('app - boom');
    expect(data.entries.length).toBe(2);
  });

  it('handles bracket style logs', async () => {
    const r = await runtime.execute('spurh.text', 'log-parse', '[2026-08-10 10:00:00.123] [WARN] disk space low\n[2026-08-10 10:00:01.456] [ERROR] write failed');
    const data = r.data as { entries: LogEntryShape[]; counts: Record<string, number> };
    expect(data.entries[0].time).toContain('2026-08-10');
    expect(data.entries[0].level).toBe('WARN');
    expect(data.entries[1].level).toBe('ERROR');
    expect(data.counts.ERROR).toBe(1);
  });

  it('detects log input', () => {
    const d = runtime.dispatch('2026-08-10 10:00:00 ERROR a - x\n2026-08-10 10:00:01 INFO b - y');
    expect(d.selected?.plugin.id).toBe('spurh.text');
    expect(d.selected?.suggestedAction).toBe('log-parse');
    expect(d.selected?.confidence).toBeGreaterThan(0.7);
  });

  it('detects single-line log and error+stack pair', () => {
    const single = runtime.dispatch('2026-08-10 10:00:00 ERROR single - x');
    expect(single.selected?.plugin.id).toBe('spurh.text');
    expect(single.selected?.suggestedAction).toBe('log-parse');
    const pair = runtime.dispatch('2026-08-10 10:00:00 ERROR a - x\n    at com.foo.Bar.main(Bar.java:42)');
    expect(pair.selected?.plugin.id).toBe('spurh.text');
    expect(pair.selected?.suggestedAction).toBe('log-parse');
  });

  it('keeps timestamp routing for plain timestamps', () => {
    const d = runtime.dispatch('2026-08-10 10:00:00');
    expect(d.selected?.plugin.id).not.toBe('spurh.text');
  });
});