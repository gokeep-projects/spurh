import { describe, expect, it } from 'vitest';
import { runtime } from '../index';

describe('random plugin', () => {
  it('honors caseType upper', async () => {
    const r = await runtime.execute('spurh.random', 'string', '', { length: '32', count: '1', caseType: 'upper' });
    expect(r.output).toMatch(/^[A-Z0-9]{32}$/);
    expect(r.output).not.toMatch(/[a-z]/);
  });

  it('honors caseType lower', async () => {
    const r = await runtime.execute('spurh.random', 'string', '', { length: '32', count: '1', caseType: 'lower' });
    expect(r.output).toMatch(/^[a-z0-9]{32}$/);
    expect(r.output).not.toMatch(/[A-Z]/);
  });

  it('honors caseType digits', async () => {
    const r = await runtime.execute('spurh.random', 'string', '', { length: '16', count: '1', caseType: 'digits' });
    expect(r.output).toMatch(/^[23456789]{16}$/);
  });

  it('password respects caseType', async () => {
    const r = await runtime.execute('spurh.random', 'password', '', { length: '24', count: '1', caseType: 'upper' });
    expect(r.output).toMatch(/^[A-Z0-9!@#$%^&*_\-+=]{24}$/);
    expect(r.output).not.toMatch(/[a-z]/);
  });

  it('uuid/hex/color respect caseType', async () => {
    const u = await runtime.execute('spurh.random', 'uuid', '', { count: '1', caseType: 'upper' });
    expect(u.output).toMatch(/^[0-9A-F-]{36}$/);
    expect(u.output).not.toMatch(/[a-f]/);
    const h = await runtime.execute('spurh.random', 'hex', '', { length: '16', count: '1', caseType: 'upper' });
    expect(h.output).toMatch(/^[0-9A-F]{16}$/);
    const l = await runtime.execute('spurh.random', 'hex', '', { length: '16', count: '1', caseType: 'lower' });
    expect(l.output).toMatch(/^[0-9a-f]{16}$/);
    const c = await runtime.execute('spurh.random', 'color', '', { countColor: '1', caseType: 'upper' });
    expect(c.output).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('colors use the colors view with hex data', async () => {
    const r = await runtime.execute('spurh.random', 'color', '', { count: '5' });
    expect(r.view).toBe('colors');
    expect(Array.isArray(r.data)).toBe(true);
    expect((r.data as string[]).length).toBe(5);
    for (const color of r.data as string[]) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});