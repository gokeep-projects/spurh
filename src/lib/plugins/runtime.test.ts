import { describe, expect, it } from 'vitest';
import { cronPlugin } from './builtin/cron';
import { base64Plugin } from './builtin/base64';
import { hashPlugin } from './builtin/hash';
import { httpPlugin } from './builtin/http';
import { jsonPlugin } from './builtin/json';
import { jwtPlugin } from './builtin/jwt';
import { regexPlugin } from './builtin/regex';
import { randomPlugin } from './builtin/random';
import { textPlugin } from './builtin/text';
import { timestampPlugin } from './builtin/timestamp';
import { urlPlugin } from './builtin/url';
import { PluginRuntime } from './runtime';
import type { SpurhPlugin } from './types';

const runtime = new PluginRuntime([jsonPlugin, timestampPlugin, textPlugin, httpPlugin, randomPlugin, jwtPlugin, cronPlugin, base64Plugin, urlPlugin, hashPlugin, regexPlugin]);

describe('PluginRuntime', () => {
  it('selects JSON by content rather than an explicit tool choice', () => {
    const result = runtime.dispatch('{"name":"spurh"}');
    expect(result.selected?.plugin.id).toBe('spurh.json');
    expect(result.selected?.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes and explains a cron expression', async () => {
    const result = runtime.dispatch('*/5 * * * *');
    expect(result.selected?.plugin.id).toBe('spurh.cron');
    await expect(runtime.execute('spurh.cron', 'explain', '*/5 * * * *')).resolves.toMatchObject({
      output: '每 5 分钟执行一次',
    });
  });

  it('formats JSON through a registered plugin action', async () => {
    const result = await runtime.execute('spurh.json', 'format', '{"ok":true}');
    expect(result.output).toBe('{\n  "ok": true\n}');
  });

  it('keeps advanced actions inside the same plugin contract', async () => {
    const path = await runtime.execute('spurh.json', 'path', '{"users":[{"name":"Ada"},{"name":"Lin"}]}', {
      path: '$.users[*].name',
    });
    expect(JSON.parse(path.output)).toEqual(['Ada', 'Lin']);

    const next = await runtime.execute('spurh.cron', 'next', '*/5 * * * *');
    expect(next.output.split('\n')).toHaveLength(5);
  });

  it('round-trips unicode through Base64', async () => {
    const encoded = await runtime.execute('spurh.base64', 'encode', '你好 Spurh');
    const decoded = await runtime.execute('spurh.base64', 'decode', encoded.output);
    expect(decoded.output).toBe('你好 Spurh');
  });

  it('generates and verifies an HMAC JWT locally', async () => {
    const token = await runtime.execute('spurh.jwt', 'generate', '{"sub":"spurh"}', { secret: 'local-secret' });
    const verified = await runtime.execute('spurh.jwt', 'verify', token.output, { secret: 'local-secret' });
    expect(JSON.parse(verified.output)).toMatchObject({ valid: true, payload: { sub: 'spurh' } });
  });

  it('tests and replaces regex matches with plugin-specific options', async () => {
    const tested = await runtime.execute('spurh.regex', 'test', 'a1 b22', { pattern: '\\d+', flags: 'g' });
    expect(JSON.parse(tested.output)).toHaveLength(2);
    const replaced = await runtime.execute('spurh.regex', 'replace', 'a1 b22', {
      pattern: '\\d+', flags: 'g', replacement: '#',
    });
    expect(replaced.output).toBe('a# b#');
  });

  it('detects seconds and milliseconds timestamps', async () => {
    expect(runtime.dispatch('1700000000').selected?.plugin.id).toBe('spurh.timestamp');
    expect(runtime.dispatch('1700000000000').selected?.plugin.id).toBe('spurh.timestamp');
    const converted = await runtime.execute('spurh.timestamp', 'to-date', '1700000000', { unit: 'auto' });
    expect(JSON.parse(converted.output)).toMatchObject({ unixSeconds: 1700000000, unixMilliseconds: 1700000000000 });
  });

  it('converts dates back to Unix timestamps', async () => {
    const converted = await runtime.execute('spurh.timestamp', 'to-unix', '2023-11-14T22:13:20.000Z');
    expect(JSON.parse(converted.output)).toMatchObject({ unixSeconds: 1700000000 });
  });

  it('generates Cron expressions from presets and Chinese descriptions', async () => {
    const preset = await runtime.execute('spurh.cron', 'generate', '', { scheduleType: 'daily', time: '09:30' });
    expect(preset.output).toBe('30 9 * * *');
    const natural = await runtime.execute('spurh.cron', 'generate', '每 15 分钟', { scheduleType: 'natural' });
    expect(natural.output).toBe('*/15 * * * *');
  });

  it('generates HTTP request code without sending a network call', async () => {
    const result = await runtime.execute('spurh.http', 'code', '{"ok":true}', {
      method: 'POST', url: 'https://example.com/api', headers: 'Accept: application/json',
      contentType: 'application/json', authType: 'bearer', token: 'test-token', codeLanguage: 'javascript',
    });
    expect(result.output).toContain('fetch("https://example.com/api"');
    expect(result.output).toContain('Bearer test-token');
  });

  it('presents text statistics as structured data', async () => {
    const result = await runtime.execute('spurh.text', 'stats', '你好 Spurh\n第二行');
    expect(result.view).toBe('stats');
    expect(result.data).toMatchObject({ 字符数: 12, 行数: 2 });
  });

  it('generates cryptographically sourced random values', async () => {
    const result = await runtime.execute('spurh.random', 'string', '', { length: '16', count: '3' });
    expect(result.view).toBe('list');
    expect(result.output.split('\n')).toHaveLength(3);
    expect(result.output.split('\n').every((value) => value.length === 16)).toBe(true);
  });

  it('isolates detector failures', () => {
    const broken: SpurhPlugin = {
      id: 'test.broken',
      name: 'Broken',
      description: '',
      icon: '!',
      version: '0.0.0',
      category: '开发',
      actions: [{ id: 'run', label: 'Run', description: '' }],
      detect: () => { throw new Error('boom'); },
      execute: () => ({ output: '' }),
    };
    const isolated = new PluginRuntime([broken, jsonPlugin]);
    expect(isolated.dispatch('{}').selected?.plugin.id).toBe('spurh.json');
  });

  it('rejects duplicate plugin ids', () => {
    expect(() => new PluginRuntime([jsonPlugin, jsonPlugin])).toThrow('already registered');
  });
});
