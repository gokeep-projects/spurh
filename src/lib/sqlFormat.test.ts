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
  it('复合运算符 >= <= != <> 不被拆开', () => {
    const out = formatSql('select * from t where a>=10 and b<=20 and c!=30 and d<>40');
    expect(out).toContain('a >= 10');
    expect(out).toContain('b <= 20');
    expect(out).toContain('c != 30');
    expect(out).toContain('d <> 40');
    expect(out).not.toContain('> =');
    expect(out).not.toContain('< =');
    expect(out).not.toContain('! =');
  });

  it('一元正负号不被拆开', () => {
    const out = formatSql('select -1 as neg, +2 as pos from t where a>-1');
    expect(out).toContain('SELECT -1');
    expect(out).toContain('+2');
    expect(out).toContain('a > -1');
    expect(out).not.toContain('- 1');
  });

  it('类型转换 :: 与拼接 || 不被拆开', () => {
    const out = formatSql("select x::int, 'a'||'b' from t where id=:id");
    expect(out).toContain('x :: int');
    expect(out).toContain("'a' || 'b'");
    expect(out).toContain('id = :id');
  });

  it('PostgreSQL JSON 操作符 -> ->> #> 不被拆开', () => {
    const out = formatSql("select data->>'name', meta#>'{a}' from t");
    expect(out).toContain("data ->> 'name'");
    expect(out).toContain("meta #> '{a}'");
  });

  it('乘法与减法仍保持二元运算符间距', () => {
    const out = formatSql('select a*b-c from t');
    expect(out).toContain('a * b - c');
  });
});
