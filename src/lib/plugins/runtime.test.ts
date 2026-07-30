import { describe, expect, it } from 'vitest';
import { cronPlugin } from './builtin/cron';
import { cryptoPlugin } from './builtin/crypto';
import { encoderPlugin } from './builtin/encoder';
import { jsonPlugin } from './builtin/json';
import { regexPlugin } from './builtin/regex';
import { randomPlugin } from './builtin/random';
import { textPlugin } from './builtin/text';
import { timestampPlugin } from './builtin/timestamp';
import { PluginRuntime } from './runtime';
import type { SpurhPlugin } from './types';

const runtime = new PluginRuntime([jsonPlugin, timestampPlugin, textPlugin, randomPlugin, cryptoPlugin, cronPlugin, encoderPlugin, regexPlugin]);

describe('PluginRuntime', () => {
  it('dispatches JSON by content', () => {
    const r = runtime.dispatch('{"name":"spurh"}');
    expect(r.selected?.plugin.id).toBe('spurh.json');
  });

  it('explains cron', async () => {
    await expect(runtime.execute('spurh.cron', 'explain', '*/5 * * * *')).resolves.toMatchObject({ output: '每5分钟' });
  });

  it('formats JSON', async () => {
    const r = await runtime.execute('spurh.json', 'format', '{"ok":true}');
    expect(r.output).toBe('{\n  "ok": true\n}');
  });

  it('JSONPath query', async () => {
    const r = await runtime.execute('spurh.json', 'path', '{"users":[{"name":"A"},{"name":"B"}]}', { path: '$.users[*].name' });
    expect(JSON.parse(r.output)).toEqual(['A', 'B']);
  });

  it('cron next runs', async () => {
    const r = await runtime.execute('spurh.cron', 'next', '*/5 * * * *');
    expect(r.output.split('\n').length).toBeGreaterThanOrEqual(10);
  });

  it('Base64 round-trip', async () => {
    const enc = await runtime.execute('spurh.encoder', 'base64-encode', '你好 Spurh');
    const dec = await runtime.execute('spurh.encoder', 'base64-decode', enc.output);
    expect(dec.output).toBe('你好 Spurh');
  });

  it('JWT generate and verify via crypto', async () => {
    const tok = await runtime.execute('spurh.crypto', 'jwt-gen', '{"sub":"x"}', { secret: 's' });
    const ver = await runtime.execute('spurh.crypto', 'jwt-verify', tok.output, { secret: 's' });
    expect(JSON.parse(ver.output)).toMatchObject({ valid: true, payload: { sub: 'x' } });
  });

  it('regex test and replace', async () => {
    const t = await runtime.execute('spurh.regex', 'test', 'a1 b22', { pattern: '\\d+', flags: 'g' });
    expect(JSON.parse(t.output)).toHaveLength(2);
    const r = await runtime.execute('spurh.regex', 'replace', 'a1 b22', { pattern: '\\d+', flags: 'g', replacement: '#' });
    expect(r.output).toBe('a# b#');
  });

  it('timestamp detection and conversion', async () => {
    expect(runtime.dispatch('1700000000').selected?.plugin.id).toBe('spurh.timestamp');
    const r = await runtime.execute('spurh.timestamp', 'to-date', '1700000000', { unit: 'auto' });
    expect(JSON.parse(r.output).unixSeconds).toBe(1700000000);
  });

  it('cron presets', async () => {
    const r = await runtime.execute('spurh.cron', 'generate', '', { type: 'daily', hour: '09', minute: '30' });
    expect(r.meta?.表达式).toBe('30 9 * * *');
  });

  it('text stats', async () => {
    const r = await runtime.execute('spurh.text', 'stats', '你好 Spurh\n行2');
    expect(r.view).toBe('stats');
    expect((r.data as any)['字符数']).toBeGreaterThan(0);
  });

  it('random values', async () => {
    const r = await runtime.execute('spurh.random', 'string', '', { length: '16', count: '1' });
    expect(r.output).toHaveLength(16);
  });

  it('AES encrypt/decrypt', async () => {
    const enc = await runtime.execute('spurh.crypto', 'aes-encrypt', 'hello', { secret: 'key' });
    expect(enc.output.length).toBeGreaterThan(20);
    const dec = await runtime.execute('spurh.crypto', 'aes-decrypt', enc.output, { secret: 'key' });
    expect(dec.output).toBe('hello');
  });

  it('MD5 hash', async () => {
    const r = await runtime.execute('spurh.crypto', 'MD5', 'hello');
    expect(r.output).toHaveLength(32);
  });

  it('HMAC hash', async () => {
    const r = await runtime.execute('spurh.crypto', 'HMAC-SHA256', 'hello', { secret: 'k' });
    expect(r.output).toHaveLength(64);
  });

  it('detector isolation', () => {
    const broken: SpurhPlugin = {
      id: 'test.broken', name: 'B', description: '', icon: '!', version: '0', category: '开发',
      actions: [{ id: 'r', label: 'R', description: '' }],
      detect: () => { throw new Error('boom'); },
      execute: () => ({ output: '' }),
    };
    const iso = new PluginRuntime([broken, jsonPlugin]);
    expect(iso.dispatch('{}').selected?.plugin.id).toBe('spurh.json');
  });

  it('rejects duplicate ids', () => {
    expect(() => new PluginRuntime([jsonPlugin, jsonPlugin])).toThrow('already');
  });
});
