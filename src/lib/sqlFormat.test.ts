import { describe, expect, it } from 'vitest';
import { formatSql } from './sqlFormat';

describe('formatSql', () => {
  it('关键字大写 + 从句换行', () => {
    const out = formatSql('select a,b from users where id=1');
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
    expect(out).toContain('WHERE');
    expect(out.split('\n').length).toBeGreaterThanOrEqual(3);
  });

  it('JOIN 短语保持一行', () => {
    const out = formatSql('select * from a left join b on a.id=b.id');
    expect(out).toContain('LEFT JOIN');
    expect(out).toContain('\nLEFT JOIN');
    expect(out).not.toContain('\nLEFT\nJOIN');
  });

  it('字符串与注释原样保留', () => {
    const out = formatSql("select name from t where note = 'select x' -- 注释");
    expect(out).toContain("'select x'");
    expect(out).toContain('-- 注释');
  });

  it('ORDER BY / GROUP BY 短语', () => {
    const out = formatSql('select a from t group by a order by a desc limit 10');
    expect(out).toContain('\nGROUP BY');
    expect(out).toContain('\nORDER BY');
    expect(out).toContain('\nLIMIT');
  });

  it('AND / OR 缩进两格', () => {
    const out = formatSql('select * from t where a=1 and b=2 or c=3');
    expect(out).toContain('\n  AND');
    expect(out).toContain('\n  OR');
  });

  it('结尾分号保留', () => {
    const out = formatSql('select 1;');
    expect(out.endsWith(';')).toBe(true);
  });
});
