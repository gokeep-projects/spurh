import { describe, expect, it } from 'vitest';
import { explainRegexTokens, parseLiteral } from './regex';

describe('parseLiteral', () => {
  it('parses pattern flags and text', () => {
    expect(parseLiteral('/\\d+/g 123 abc')).toEqual({ pattern: '\\d+', flags: 'g', text: '123 abc' });
  });
  it('parses multiline literal with trailing text', () => {
    expect(parseLiteral('/foo/i\nbar\nbaz')?.pattern).toBe('foo');
    expect(parseLiteral('/foo/i\nbar\nbaz')?.text).toBe('bar\nbaz');
  });
  it('rejects non-literal input', () => {
    expect(parseLiteral('plain text')).toBeNull();
    expect(parseLiteral('/unclosed')).toBeNull();
  });
});

describe('explainRegexTokens', () => {
  it('explains character classes and escapes', () => {
    const tokens = explainRegexTokens('\\d+[a-z]');
    const meanings = tokens.map((t) => t.meaning).join('|');
    expect(meanings).toContain('数字 [0-9]');
    expect(meanings).toContain('一次或多次');
    expect(meanings).toContain('字符集（匹配其中任意一个字符）');
  });

  it('explains named groups with indentation', () => {
    const tokens = explainRegexTokens('(?<year>\\d{4})');
    expect(tokens[0]).toMatchObject({ token: '(?<year>', meaning: '命名分组 year', indent: 0 });
    expect(tokens[1]).toMatchObject({ token: '\\d', indent: 1 });
    expect(tokens[2]).toMatchObject({ token: '{4}', meaning: '重复 4 次', indent: 1 });
    expect(tokens[3]).toMatchObject({ token: ')', meaning: '分组结束', indent: 0 });
  });

  it('explains anchors, alternation and assertions', () => {
    const tokens = explainRegexTokens('^(?=a)(?!b)a|b$');
    const meanings = tokens.map((t) => t.meaning).join('|');
    expect(meanings).toContain('匹配文本开头');
    expect(meanings).toContain('正向先行断言');
    expect(meanings).toContain('负向先行断言');
    expect(meanings).toContain('或（匹配左边或右边）');
    expect(meanings).toContain('匹配文本结尾');
  });

  it('groups consecutive literal characters into one token', () => {
    const tokens = explainRegexTokens('abc');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ token: '"abc"', meaning: '字面量文本' });
  });

  it('handles backreferences and hex escapes', () => {
    const tokens = explainRegexTokens('(a)\\1\\x41');
    const meanings = tokens.map((t) => t.meaning).join('|');
    expect(meanings).toContain('反向引用第 1 个分组');
    expect(meanings).toContain('十六进制字符 0x41');
  });

  it('handles empty pattern', () => {
    expect(explainRegexTokens('')).toEqual([]);
  });
});