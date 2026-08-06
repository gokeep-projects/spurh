import { describe, expect, it } from 'vitest';
import { runtime } from './index';

function pick(input: string) {
  const r = runtime.dispatch(input);
  return { plugin: r.selected?.plugin.id ?? null, action: r.selected?.suggestedAction ?? null };
}

describe('dispatch command prefixes', () => {
  const cases: Array<[string, string, string]> = [
    ['cron: */5 * * * *', 'spurh.cron', 'next'],
    ['cron：0 9 * * *', 'spurh.cron', 'next'],
    ['json: {"a":1}', 'spurh.json', 'format'],
    ['json：{"a":1}', 'spurh.json', 'format'],
    ['xml: <a></a>', 'spurh.json', 'xml-format'],
    ['base64: aGVsbG8=', 'spurh.encoder', 'base64-encode'],
    ['url: https://a.com?x=1', 'spurh.encoder', 'url-encode'],
    ['hex: 68656c6c6f', 'spurh.encoder', 'hex-encode'],
    ['html: <b>hi</b>', 'spurh.encoder', 'html-encode'],
    ['YWJjZGVmZ2hpag', 'spurh.encoder', 'base64-decode'],
    ['random: 16', 'spurh.random', 'password'],
    ['uuid: 5', 'spurh.random', 'uuid'],
    ['ulid: 3', 'spurh.random', 'ulid'],
    ['随机：8', 'spurh.random', 'password'],
    ['sha: hello', 'spurh.crypto', 'SHA-256'],
    ['sha512: hello', 'spurh.crypto', 'SHA-512'],
    ['md5: hello', 'spurh.crypto', 'MD5'],
    ['encrypt: hello', 'spurh.crypto', 'aes-encrypt'],
    ['decrypt: xyz', 'spurh.crypto', 'aes-decrypt'],
    ['timestamp: 2026-02-30 10:00', 'spurh.timestamp', 'to-unix'],
    ['timestamp: 1760000000', 'spurh.timestamp', 'to-date'],
    ['时间戳：2026-03-01 08:30', 'spurh.timestamp', 'to-unix'],
    ['text: hello world', 'spurh.text', 'stats'],
    ['*/5 * * * *', 'spurh.cron', 'next'],
  ];
  it.each(cases)('routes %s', (input, plugin, action) => {
    expect(pick(input), `input=${input}`).toEqual({ plugin, action });
  });

  it('cron prefix executes next-run without including the prefix', async () => {
    const r = await runtime.execute('spurh.cron', 'next', 'cron: */5 * * * *', {}, 5000);
    expect((r.data as string[]).length).toBe(10);
  });

  it('cron prefix works when the panel syncs it into customExpr', async () => {
    const r = await runtime.execute('spurh.cron', 'next', 'cron: */5 * * * *', { type: 'custom', customExpr: 'cron: */5 * * * *' }, 5000);
    expect((r.data as string[]).length).toBe(10);
  });

  it('ulid prefix generates multiple ulids', async () => {
    const r = await runtime.execute('spurh.random', 'ulid', 'ulid: 3', {});
    expect((r.data as string[]).length).toBe(3);
    expect((r.data as string[]).every((v) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v))).toBe(true);
  });

  it('unpadded base64 is detected and decodes', async () => {
    expect(pick('YWJjZGVmZ2hpag').plugin).toBe('spurh.encoder');
    const r = await runtime.execute('spurh.encoder', 'base64-decode', 'YWJjZGVmZ2hpag', {});
    expect(r.output).toBe('abcdefghij');
  });

  it('timestamp prefix converts date to unix', async () => {
    const r = await runtime.execute('spurh.timestamp', 'to-unix', 'timestamp: 2026-02-28 10:00', {});
    const data = r.data as Record<string, unknown>;
    expect(typeof data.unixSeconds).toBe('number');
    expect(new Date((data.unixSeconds as number) * 1000).toISOString().startsWith('2026-02-28T02:00')).toBe(true);
  });

  it('invalid date after timestamp prefix is rejected', async () => {
    await expect(runtime.execute('spurh.timestamp', 'to-unix', 'timestamp: 2026-02-30 10:00', {})).rejects.toThrow(/无效日期/);
  });
});
