import { describe, expect, it } from 'vitest';
import { analyzeLogs } from './log';

describe('log analysis', () => {
  it('parses common log lines with time, level, source and message', () => {
    const r = analyzeLogs('2026-08-07 10:00:00 INFO  myapp 服务启动成功');
    expect(r.format).toBe('common');
    expect(r.entries).toHaveLength(1);
    const entry = r.entries[0];
    expect(entry.level).toBe('INFO');
    expect(entry.time).toBe('2026-08-07 10:00:00');
    expect(entry.source).toBe('myapp');
    expect(entry.message).toBe('服务启动成功');
    expect(r.counts.INFO).toBe(1);
  });

  it('maps level aliases to canonical levels', () => {
    const r = analyzeLogs('10:00:01 WARNING 磁盘即将满\n10:00:02 CRITICAL 服务不可用\n10:00:03 NOTICE 已重试');
    expect(r.counts.WARN).toBe(1);
    expect(r.counts.FATAL).toBe(1);
    expect(r.counts.INFO).toBe(1);
  });

  it('parses JSON log lines', () => {
    const r = analyzeLogs('{"time":"2026-08-07T10:00:00Z","level":"ERROR","msg":"连接失败"}');
    expect(r.format).toBe('json');
    expect(r.entries[0].level).toBe('ERROR');
    expect(r.entries[0].message).toBe('连接失败');
    expect(r.counts.ERROR).toBe(1);
  });

  it('parses JSON log lines with numeric timestamps and logger field', () => {
    const r = analyzeLogs('{"ts":1754524800,"lvl":"WARN","message":"慢查询","logger":"sql.exec"}');
    expect(r.entries[0].level).toBe('WARN');
    expect(r.entries[0].source).toBe('sql.exec');
    expect(r.entries[0].message).toBe('慢查询');
  });

  it('merges stack trace lines into preceding ERROR entry', () => {
    const r = analyzeLogs('10:00:00 ERROR 空指针\n\tat com.example.App.main(App.java:12)\n\tat com.example.App.run(App.java:8)');
    const error = r.entries.find((entry) => entry.level === 'ERROR');
    expect(error?.stack).toHaveLength(2);
    expect(r.format).toBe('common');
  });

  it('detects stack-only logs and extracts root cause', () => {
    const r = analyzeLogs('Traceback (most recent call last):\n  File "app.py", line 10\nValueError: bad value');
    expect(r.format).toBe('stack');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].stack).toHaveLength(2);
    expect(r.rootCause).toContain('ValueError');
  });

  it('extracts root cause from Caused by lines', () => {
    const r = analyzeLogs('10:00:00 ERROR 外层错误\nCaused by: java.lang.IllegalStateException: 内部异常');
    expect(r.rootCause).toContain('IllegalStateException');
  });

  it('detects bracket source and treats plain text as unknown', () => {
    const r = analyzeLogs('10:00:00 [worker-3] 任务完成');
    expect(r.entries[0].source).toBe('worker-3');
    expect(analyzeLogs('').format).toBe('unknown');
    expect(analyzeLogs('plain text without markers').format).toBe('unknown');
  });

  it('normalizes CRLF and ranks top sources by count', () => {
    const r = analyzeLogs('10:00:00 ERROR a 失败\r\n10:00:01 WARN  b 警告\r\n10:00:02 ERROR a 再次失败');
    expect(r.entries).toHaveLength(3);
    expect(r.topSources[0]).toMatchObject({ source: 'a', count: 2 });
    expect(r.counts.ERROR).toBe(2);
  });

  it('classifies json logs with stack traces as mixed', () => {
    const r = analyzeLogs('{"level":"ERROR","msg":"json 异常"}\n\tat App.main(App.java:1)');
    expect(r.format).toBe('mixed');
    // JSON 与普通行数量相同时仍按 JSON 处理（主格式），不误判为 mixed
    const balanced = analyzeLogs('{"level":"INFO","msg":"json 行"}\n10:00:01 WARN 普通行');
    expect(balanced.format).toBe('json');
  });

  it('rejects unrelated lines so raw text does not pollute entries', () => {
    const r = analyzeLogs('随便一行文字\n10:00:00 INFO 正常日志');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].message).toBe('正常日志');
  });
});
