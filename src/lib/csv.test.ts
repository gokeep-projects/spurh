import { describe, expect, it } from 'vitest';
import { csvEscape, toCsv } from './csv';

describe('csv', () => {
  it('writes header and rows joined with CRLF', () => {
    expect(toCsv(['a', 'b'], [[1, 'x'], [2, 'y']])).toBe('a,b\r\n1,x\r\n2,y');
  });

  it('quotes fields containing comma, quote or newline and doubles quotes', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('a\rb')).toBe('"a\rb"');
  });

  it('renders null and undefined as empty cells', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape(false)).toBe('false');
    expect(csvEscape(0)).toBe('0');
  });

  it('guards formula injection for = + @ tab and CR prefixes', () => {
    expect(csvEscape('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvEscape('+1+1')).toBe("'+1+1");
    expect(csvEscape('@cmd')).toBe("'@cmd");
    expect(csvEscape('\tvalue')).toBe("'\tvalue");
    // \r 前缀防护后仍含回车，引号包裹与防注入同时生效
    expect(csvEscape('\rvalue')).toBe("\"'\rvalue\"");
  });

  it('does not guard negative numbers or normal text', () => {
    expect(csvEscape('-42')).toBe('-42');
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('  =leading space')).toBe('  =leading space');
  });

  it('produces empty body for header-only export', () => {
    expect(toCsv(['a'], [])).toBe('a');
  });
});
