
import { describe, it, expect } from 'vitest';
import { generateRegexSamples } from './regexgen';

function samples(pattern: string, flags = '', count = 6): string[] {
  return generateRegexSamples(pattern, flags, count);
}

describe('generateRegexSamples', () => {
  it('ignores anchors and generates the core content', () => {
    expect(samples('^ab$')).toEqual(['ab']);
    expect(samples('^ab$', 'i')).toEqual(['ab']);
  });

  it('renders literal chars verbatim (no escape-table mangling)', () => {
    expect(samples('abc')).toEqual(['abc']);
    expect(samples('a.b')).toEqual(['a.b']);
    expect(samples('ab')).toEqual(['ab']);
  });

  it('does not leak group content into the top-level token stream', () => {
    for (const sample of samples('(ab)c')) {
      expect(sample).toBe('abc');
    }
    for (const sample of samples('(a|b)c')) {
      expect(sample).toMatch(/^[ab]c$/);
    }
    for (const sample of samples('(a(bc))+d')) {
      expect(sample).toMatch(/^(abc)+d$/);
    }
  });

  it('handles lookahead and lookbehind assertions', () => {
    for (const sample of samples('(?=abc)def')) {
      expect(sample).toBe('abcdef');
    }
    for (const sample of samples('(?<=abc)def')) {
      expect(sample).toBe('abcdef');
    }
    for (const sample of samples('x(?=y)')) {
      expect(sample).toBe('xy');
    }
  });

  it('renders negative assertions as zero-width', () => {
    for (const sample of samples('x(?!y)')) {
      expect(sample).toBe('x');
    }
    for (const sample of samples('(?<!abc)def')) {
      expect(sample).toBe('def');
    }
  });

  it('respects quantifier ranges', () => {
    for (const sample of samples('a{2,4}')) {
      expect(sample).toMatch(/^a{2,4}$/);
    }
    for (const sample of samples('a+')) {
      expect(sample).toMatch(/^a+$/);
    }
    for (const sample of samples('ab*')) {
      expect(sample).toMatch(/^ab*$/);
    }
    for (const sample of samples('a?b')) {
      expect(sample).toMatch(/^a?b$/);
    }
  });

  it('handles character classes and escapes', () => {
    for (const sample of samples('[a-c]')) {
      expect(sample).toMatch(/^[a-c]$/);
    }
    for (const sample of samples('[^a]')) {
      expect(sample).toMatch(/^[^a]$/);
    }
    for (const sample of samples('\\d+')) {
      expect(sample).toMatch(new RegExp('^\\d+$'));
    }
    for (const sample of samples('[\\w]{3}')) {
      expect(sample).toMatch(new RegExp('^\\w{3}$'));
    }
  });

  it('returns [] for empty or invalid patterns', () => {
    expect(samples('')).toEqual([]);
    expect(samples('(unclosed')).toEqual([]);
    expect(samples('a[')).toEqual([]);
  });

  it('caps sample count and deduplicates', () => {
    expect(samples('\\d+', '', 6).length).toBeLessThanOrEqual(6);
    expect(samples('ab')).toEqual(['ab']);
  });

  it('generates only strings that actually match the pattern (battery)', () => {
    const battery: Array<[string, string]> = [
      ['^\\d{2,4}$', 'g'],
      ['(ab)c', 'g'],
      ['(a|b)+x', 'g'],
      ['^[a-z]{3}$', 'g'],
      ['https?://\\S+', 'g'],
      ['^\\w+@\\w+\\.\\w+$', 'g'],
      ['(\\d{4})-(\\d{2})', 'g'],
      ['^a{1,3}b$', 'g'],
      ['[A-Z][a-z]*', 'g'],
      ['^(?!admin).*$', 'g'],
      ['^(?=.*\\d).{6,}$', 'g'],
      ['(?<=@)[\\w.]+', 'g'],
    ];
    for (const [pattern, flags] of battery) {
      const list = samples(pattern, flags);
      expect(list.length, pattern).toBeGreaterThan(0);
      for (const sample of list) {
        // fresh RegExp per sample: the g flag keeps lastIndex across test() calls
        const re = new RegExp(pattern, flags);
        expect(re.test(sample), pattern + ' !~ ' + JSON.stringify(sample)).toBe(true);
      }
    }
  });
});
