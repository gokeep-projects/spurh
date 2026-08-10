import { describe, expect, it } from 'vitest';
import { explainCron, nextRuns, parseCron } from './cron';

describe('cron 解析与范围校验', () => {
  it('合法表达式正常解析', () => {
    expect(parseCron('0 9 * * *').hours).toBe('9');
    expect(parseCron('*/5 * * * *').minutes).toBe('*/5');
    expect(parseCron('30 9 * * 1-5').dow).toBe('1-5');
    expect(parseCron('0 0 1 * *').dom).toBe('1');
    expect(parseCron('0 0 1 JAN *').month).toBe('JAN');
    expect(parseCron('0 0 * * MON-FRI').dow).toBe('MON-FRI');
    expect(parseCron('0 0 L * *').dom).toBe('L');
    // 6 段 = 秒 + 5 字段；7 段 = 秒 + 5 字段 + 年
    expect(parseCron('10 0 0 1 1 *').hasSeconds).toBe(true);
    expect(parseCron('0 0 0 1 * * 2026').year).toBe('2026');
  });

  it('越界数值抛出可读错误', () => {
    expect(() => parseCron('99 99 * * *')).toThrow(/分字段取值超出范围/);
    expect(() => parseCron('0 24 * * *')).toThrow(/时字段取值超出范围/);
    expect(() => parseCron('0 0 32 * *')).toThrow(/日字段取值超出范围/);
    expect(() => parseCron('0 0 1 13 *')).toThrow(/月字段取值超出范围/);
    expect(() => parseCron('0 0 * * 8')).toThrow(/周字段取值超出范围/);
    expect(() => parseCron('0 0 0 1 * * 1800')).toThrow(/年字段取值超出范围/);
    expect(() => parseCron('0 0 * * * 2026-01-01')).toThrow(/周字段无法识别/);
  });

  it('非法步进与未知字符抛出可读错误', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/步进必须为正整数/);
    expect(() => parseCron('abc * * * *')).toThrow(/分字段无法识别/);
    expect(() => parseCron('0 0 0 * *')).toThrow(/日字段取值超出范围/);
  });

  it('无效表达式不会生成执行时间或误导性描述', () => {
    expect(() => explainCron('99 99 * * *')).toThrow();
    expect(() => nextRuns('99 99 * * *')).toThrow();
    const runs = nextRuns('*/5 * * * *', 3);
    expect(runs).toHaveLength(3);
    expect(explainCron('0 9 * * *')).toContain('09:00');
  });
});