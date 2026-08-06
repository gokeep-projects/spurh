import { describe, expect, it } from 'vitest';
import { highlightSql } from './sqlHighlight';

describe('highlightSql', () => {
  it('高亮关键字', () => {
    expect(highlightSql('SELECT * FROM users')).toContain('sql-hl-keyword');
  });

  it('高亮字符串', () => {
    expect(highlightSql("WHERE name = 'spurh'")).toContain('sql-hl-string');
  });

  it('字符串内的关键字不再高亮', () => {
    const out = highlightSql("'SELECT'");
    expect(out).toContain('sql-hl-string');
    expect(out).not.toContain('sql-hl-keyword');
  });

  it('高亮行注释且注释内关键字不生效', () => {
    const out = highlightSql('-- SELECT * FROM users');
    expect(out).toContain('sql-hl-comment');
    expect(out).not.toContain('sql-hl-keyword');
  });

  it('高亮数字', () => {
    expect(highlightSql('LIMIT 100 OFFSET 20')).toContain('sql-hl-number');
  });

  it('HTML 转义防注入', () => {
    const out = highlightSql('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('连续单引号转义仍完整', () => {
    const out = highlightSql("WHERE note = 'it''s'");
    expect(out).toContain('sql-hl-string');
  });
});
