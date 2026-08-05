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

  it('formats XML', async () => {
    const r = await runtime.execute('spurh.json', 'xml-format', '<root><a>1</a><b x="y"/></root>');
    expect(r.output.split('\n').length).toBeGreaterThan(3);
    expect(r.output).toContain('<b x="y"/>');
    expect(r.output).toContain('</root>');
  });

  it('minifies XML', async () => {
    const r = await runtime.execute('spurh.json', 'xml-minify', '<root>\n  <a>1</a>\n</root>');
    expect(r.output).toBe('<root><a>1</a></root>');
  });

  it('minifies XML preserves cdata content', async () => {
    const r = await runtime.execute('spurh.json', 'xml-minify', '<a>\n  <![CDATA[x >\n y]]>\n</a>');
    expect(r.output).toBe('<a><![CDATA[x >\n y]]></a>');
  });

  it('minifies XML rejects unterminated input', async () => {
    await expect(runtime.execute('spurh.json', 'xml-minify', '<a>1</a><b')).rejects.toThrow('未闭合');
  });

  it('rejects mismatched xml closing tag', async () => {
    await expect(runtime.execute('spurh.json', 'xml-format', '<a></b>')).rejects.toThrow('标签不匹配');
    // 语法错误时仍匹配但置信度降低（0.6 兜底），不按合法 XML（0.92）处理
    const d = runtime.dispatch('<a></b>');
    expect(d.selected?.plugin.id).toBe('spurh.json');
    expect(d.selected!.confidence).toBeLessThan(0.9);
  });

  it('formats XML with cdata and comment', async () => {
    const r = await runtime.execute('spurh.json', 'xml-format', '<root><!-- a > b --><![CDATA[x > y]]><a href="x?a>b">t</a></root>');
    expect(r.output).toContain('<!-- a > b -->');
    expect(r.output).toContain('<![CDATA[x > y]]>');
    expect(r.output).toContain('<a href="x?a>b">');
  });

  it('dispatches XML by content', () => {
    expect(runtime.dispatch('<root><a/></root>').selected?.plugin.id).toBe('spurh.json');
    expect(runtime.dispatch('<root><a></root>').selected?.plugin.id).toBe('spurh.json');
  });

  it('JSONPath query', async () => {
    const r = await runtime.execute('spurh.json', 'path', '{"users":[{"name":"A"},{"name":"B"}]}', { path: '$.users[*].name' });
    expect(JSON.parse(r.output)).toEqual(['A', 'B']);
  });

  it('cron next runs', async () => {
    const r = await runtime.execute('spurh.cron', 'next', '*/5 * * * *');
    expect(r.output.split('\n').length).toBeGreaterThanOrEqual(10);
  });

  it('cron next runs respects count for second fields', async () => {
    const r = await runtime.execute('spurh.cron', 'next', '* * * * * *', {}, 5000);
    expect((r.data as string[]).length).toBe(10);
  });

  it('cron next runs never returns past times', async () => {
    const before = Date.now() - 1500;
    const r = await runtime.execute('spurh.cron', 'next', '* * * * * *');
    const runs = (r.data as string[]).map((s) => new Date(s.replace(/\//g, '-')).getTime());
    expect(runs.length).toBe(10);
    expect(runs[0]).toBeGreaterThan(before);
    expect(runs.every((t, i) => i === 0 || t > runs[i - 1])).toBe(true);
  });

  it('cron explain keeps second info', async () => {
    const r = await runtime.execute('spurh.cron', 'explain', '45 30 9 * * *');
    expect(r.output).toContain('45');
  });

  it('cron detect rejects plain words', () => {
    expect(runtime.dispatch('hello world foo bar baz').selected?.plugin.id).not.toBe('spurh.cron');
    expect(runtime.dispatch('one two six ten and').selected?.plugin.id).not.toBe('spurh.cron');
    expect(runtime.dispatch('mon tue wed thu fri').selected?.plugin.id).not.toBe('spurh.cron');
    expect(runtime.dispatch('*/5 * * * *').selected?.plugin.id).toBe('spurh.cron');
    expect(runtime.dispatch('0 30 9 * * 1-5').selected?.plugin.id).toBe('spurh.cron');
    expect(runtime.dispatch('0 0 1 JAN *').selected?.plugin.id).toBe('spurh.cron');
    expect(runtime.dispatch('L 9 * * *').selected?.plugin.id).not.toBe('spurh.cron');
  });

  it('cron dow wrap range 6-7 covers weekend', async () => {
    const r = await runtime.execute('spurh.cron', 'next', '0 0 * * 6-7', {}, 5000);
    expect((r.data as string[]).length).toBe(10);
    const days = (r.data as string[]).map((s) => new Date(s.replace(/\//g, '-')).getDay());
    expect(days.every((d) => d === 6 || d === 0)).toBe(true);
  });

  it('Base64 round-trip', async () => {
    const enc = await runtime.execute('spurh.encoder', 'base64-encode', '你好 Spurh');
    expect(enc.output).toBe('5L2g5aW9IFNwdXJo');
    const dec = await runtime.execute('spurh.encoder', 'base64-decode', enc.output);
    expect(dec.output).toBe('你好 Spurh');
  });

  it('unicode and html entity round-trips', async () => {
    const uni = await runtime.execute('spurh.encoder', 'unicode-escape', '中文 A');
    expect(uni.output).toContain('\\u4e2d\\u6587');
    expect((await runtime.execute('spurh.encoder', 'unicode-unescape', uni.output)).output).toBe('中文 A');
    const html = await runtime.execute('spurh.encoder', 'html-encode', '<b>&"\'</b>');
    expect(html.output).toBe('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
    expect((await runtime.execute('spurh.encoder', 'html-decode', html.output)).output).toBe('<b>&"\'</b>');
    expect((await runtime.execute('spurh.encoder', 'html-decode', '&#65;&#x42;')).output).toBe('AB');
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

  it('regex explain detects real structures only', async () => {
    const lookbehind = await runtime.execute('spurh.regex', 'explain', 'abc', { pattern: '(?<=a)b', flags: 'g' });
    expect(lookbehind.output).toContain('正向后行断言');
    const anchor = await runtime.execute('spurh.regex', 'explain', 'abc', { pattern: '^abc', flags: 'g' });
    expect(anchor.output).toContain('匹配文本开头');
    const plain = await runtime.execute('spurh.regex', 'explain', 'abc', { pattern: 'abc', flags: 'g' });
    expect(plain.output).toContain('未检测到特殊结构');
  });

  it('timestamp detection and conversion', async () => {
    expect(runtime.dispatch('1700000000').selected?.plugin.id).toBe('spurh.timestamp');
    const r = await runtime.execute('spurh.timestamp', 'to-date', '1700000000', { unit: 'auto' });
    expect(JSON.parse(r.output).unixSeconds).toBe(1700000000);
  });

  it('timestamp converts log lines with embedded datetimes', async () => {
    const r = await runtime.execute('spurh.timestamp', 'to-unix', '2024-01-15 10:30:00 ERROR db timeout', {});
    const data = JSON.parse(r.output);
    const expected = new Date(2024, 0, 15, 10, 30, 0).getTime();
    expect(Math.abs(data.unixMilliseconds - expected)).toBeLessThan(1000);
    // 日志行直接走 to-date 也应提取到日期而非报错
    const r2 = await runtime.execute('spurh.timestamp', 'to-date', '[2024/1/5 8:05] INFO started', {});
    expect(JSON.parse(r2.output).unixMilliseconds).toBe(new Date(2024, 0, 5, 8, 5, 0).getTime());
  });

  it('timestamp to-unix honors picked datetime without input', async () => {
    const r = await runtime.execute('spurh.timestamp', 'to-unix', '', { pickDateTime: '2024-06-01T12:30' });
    const data = JSON.parse(r.output);
    expect(data.unixMilliseconds).toBe(new Date(2024, 5, 1, 12, 30, 0).getTime());
  });

  it('cron rejects zero-step ranges instead of hanging', async () => {
    await expect(runtime.execute('spurh.cron', 'next', '0 0 * * 6-7/0', {})).rejects.toThrow('字段值域非法');
  });

  it('cron 0-7 weekday matches every day', async () => {
    // 0-7 覆盖一周七天（7 与 0 同义）
    const r = await runtime.execute('spurh.cron', 'next', '0 0 * * 0-7', {});
    expect(r.output.split('\n').length).toBeGreaterThanOrEqual(10);
  });

  it('cron single value with step wraps like quartz (6/2)', async () => {
    // 6/2：周六起每 2 天（6,0,2,4 → 六、日、二、四）
    const r = await runtime.execute('spurh.cron', 'next', '0 0 * * 6/2', {});
    const days = (r.data as string[]).map((s) => new Date(s.replace(/\.\d{3}Z$/, 'Z')).getDay());
    expect(days.every((d) => [6, 0, 2, 4].includes(d))).toBe(true);
  });

  it('cron weekday ranges never leak into other days', async () => {
    // 1-5 工作日不得匹配周六/周日；3-3 仅周三
    const workdays = (r: Awaited<ReturnType<typeof runtime.execute>>) =>
      (r.data as string[]).map((s) => new Date(s.replace(/\.\d{3}Z$/, 'Z')).getDay());
    const wd = workdays(await runtime.execute('spurh.cron', 'next', '0 0 * * 1-5', {}));
    expect(wd.every((d) => d >= 1 && d <= 5)).toBe(true);
    const wed = workdays(await runtime.execute('spurh.cron', 'next', '0 0 * * 3-3', {}));
    expect(wed.every((d) => d === 3)).toBe(true);
  });

  it('cron wrap ranges (5-1) pass validation and match', async () => {
    const r = await runtime.execute('spurh.cron', 'next', '0 0 * * 5-1', {});
    const days = (r.data as string[]).map((s) => new Date(s.replace(/\.\d{3}Z$/, 'Z')).getDay());
    expect(days.every((d) => [5, 6, 0, 1].includes(d))).toBe(true);
  });

  it('cron presets', async () => {
    const r = await runtime.execute('spurh.cron', 'generate', '', { type: 'daily', hour: '09', minute: '30' });
    expect(r.meta?.表达式).toBe('0 30 9 * * *');
  });

  it('cron seconds field in timed presets', async () => {
    const r = await runtime.execute('spurh.cron', 'generate', '', { type: 'daily', hour: '09', minute: '30', second: '45' });
    expect(r.meta?.表达式).toBe('45 30 9 * * *');
  });

  it('cron seconds interval', async () => {
    const r = await runtime.execute('spurh.cron', 'generate', '', { type: 'seconds', secondInterval: '15' });
    expect(r.meta?.表达式).toBe('*/15 * * * * *');
    const fallback = await runtime.execute('spurh.cron', 'generate', '', { type: 'seconds' });
    expect(fallback.meta?.表达式).toBe('*/10 * * * * *');
    const invalid = await runtime.execute('spurh.cron', 'generate', '', { type: 'seconds', secondInterval: '0' });
    expect(invalid.meta?.表达式).toBe('*/10 * * * * *');
  });

  it('text stats', async () => {
    const r = await runtime.execute('spurh.text', 'stats', '你好 Spurh\n行2');
    expect(r.view).toBe('stats');
    expect((r.data as any)['字符数']).toBeGreaterThan(0);
  });

  it('text case conversions', async () => {
    expect((await runtime.execute('spurh.text', 'camel', 'hello world foo_bar', {})).output).toBe('helloWorldFooBar');
    expect((await runtime.execute('spurh.text', 'snake', 'helloWorld FooBar', {})).output).toBe('hello_world_foo_bar');
    expect((await runtime.execute('spurh.text', 'kebab', 'helloWorld', {})).output).toBe('hello-world');
  });

  it('text line operations', async () => {
    expect((await runtime.execute('spurh.text', 'lines-reverse', 'a\nb\nc', {})).output).toBe('c\nb\na');
    expect((await runtime.execute('spurh.text', 'reverse', 'abc', {})).output).toBe('cba');
    expect((await runtime.execute('spurh.text', 'sort-lines', 'c\na\nb', {})).output).toBe('a\nb\nc');
    expect((await runtime.execute('spurh.text', 'remove-empty', 'a\n\n  \nb', {})).output).toBe('a\nb');
  });

  it('random values', async () => {
    const r = await runtime.execute('spurh.random', 'string', '', { length: '16', count: '1' });
    expect(r.output).toHaveLength(16);
    expect((await runtime.execute('spurh.random', 'uuid', '', {})).output).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('random number within range', async () => {
    const r = await runtime.execute('spurh.random', 'number', '', { min: '5', max: '9' });
    const value = Number(r.output);
    expect(value).toBeGreaterThanOrEqual(5);
    expect(value).toBeLessThanOrEqual(9);
    await expect(runtime.execute('spurh.random', 'number', '', { min: '9', max: '5' })).rejects.toThrow('范围无效');
  });

  it('random color and ulid', async () => {
    const color = await runtime.execute('spurh.random', 'color', '', {});
    expect(color.output).toMatch(/^#[0-9a-f]{6}$/i);
    const ulid = await runtime.execute('spurh.random', 'ulid', '', {});
    expect(ulid.output).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
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
