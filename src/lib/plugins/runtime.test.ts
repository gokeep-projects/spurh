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

  it('prefers customExpr in custom mode for next/explain', async () => {
    // 路由输入与面板自定义表达式不一致时，以面板表达式为准（用户编辑后结果实时跟随）
    const options = { type: 'custom', customExpr: '0 0 12 * * *' };
    const result = await runtime.execute('spurh.cron', 'next', '*/5 * * * *', options);
    expect(result.meta?.['表达式']).toBe('0 0 12 * * *');
    expect(result.summary).toContain('每天 12:00');
    const explained = await runtime.execute('spurh.cron', 'explain', '*/5 * * * *', options);
    expect(explained.output).toBe('每天 12:00');
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
    // JWT 令牌应建议 jwt-decode；安全指令前缀映射到对应动作
    expect(runtime.dispatch(tok.output).selected?.suggestedAction).toBe('jwt-decode');
    expect(runtime.dispatch('md5:hello').selected?.suggestedAction).toBe('MD5');
    expect(runtime.dispatch('encrypt:secret').selected?.suggestedAction).toBe('aes-encrypt');
    expect(runtime.dispatch('rsa:gen').selected?.suggestedAction).toBe('rsa-gen');
    // 指令前缀剥离：md5:hello 应哈希 hello 而非整串
    const md5pre = await runtime.execute('spurh.crypto', 'MD5', 'md5:hello', {});
    expect(md5pre.output).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('MD5 matches RFC 1321 test vectors', async () => {
    // 标准测试向量：RFC 1321 与广泛参考值
    const cases: Array<[string, string]> = [
      ['', 'd41d8cd98f00b204e9800998ecf8427e'],
      ['a', '0cc175b9c0f1b6a831c399e269772661'],
      ['abc', '900150983cd24fb0d6963f7d28e17f72'],
      ['hello', '5d41402abc4b2a76b9719d911017c592'],
      ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
    ];
    for (const [input, expected] of cases) {
      const r = await runtime.execute('spurh.crypto', 'MD5', input, {});
      expect(r.output, `MD5(${JSON.stringify(input)})`).toBe(expected);
    }
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
    // 纯数字时间戳应建议 to-date，日期串应建议 to-unix
    expect(runtime.dispatch('1700000000').selected?.suggestedAction).toBe('to-date');
    expect(runtime.dispatch('1700000000123').selected?.suggestedAction).toBe('to-date');
    expect(runtime.dispatch('2024-01-15 10:30').selected?.suggestedAction).toBe('to-unix');
    const r = await runtime.execute('spurh.timestamp', 'to-date', '1700000000', { unit: 'auto' });
    expect(JSON.parse(r.output).unixSeconds).toBe(1700000000);
  });

  it('rejects invalid calendar dates instead of overflowing', async () => {
    // JS Date 会把 2026-02-30 静默溢出为 2026-03-02，必须拒绝
    await expect(runtime.execute('spurh.timestamp', 'to-unix', '2026-02-30 10:00', {})).rejects.toThrow(/\u65e0\u6548\u65e5\u671f/);
    await expect(runtime.execute('spurh.timestamp', 'to-unix', '2026-13-01 00:00', {})).rejects.toThrow(/\u65e0\u6548\u65e5\u671f/);
    await expect(runtime.execute('spurh.timestamp', 'to-unix', '2026-00-10 00:00', {})).rejects.toThrow(/\u65e0\u6548\u65e5\u671f/);
    await expect(runtime.execute('spurh.timestamp', 'to-unix', '2026-04-31 12:00', {})).rejects.toThrow(/\u65e0\u6548\u65e5\u671f/);
    // 合法日期（含闰年 2/29）与边界仍正常工作
    const leap = await runtime.execute('spurh.timestamp', 'to-unix', '2024-02-29 00:00', {});
    expect(leap.output).toContain('2024-02-29');
    const valid = await runtime.execute('spurh.timestamp', 'to-unix', '2026-02-28 23:59', {});
    expect(valid.output).toContain('2026-02-28 23:59:00');
    // picker 路径同样拒绝无效日期
    await expect(runtime.execute('spurh.timestamp', 'to-unix', '', { pickDateTime: '2026-02-30T10:00' })).rejects.toThrow();
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

  it('timestamp to-unix prefers typed input over picker default', async () => {
    // 回归：粘贴日期后点“日期→时间戳”，应使用文本框内容而非 picker 默认值
    const r = await runtime.execute('spurh.timestamp', 'to-unix', '2024-01-15 10:30:00', { pickDateTime: '2024-06-01T12:30' });
    const data = JSON.parse(r.output);
    expect(data.unixMilliseconds).toBe(new Date(2024, 0, 15, 10, 30, 0).getTime());
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

  it('all plugin views are covered by ResultView branches', async () => {
    // ResultView 显式分支 + 最终 else 兜底(code/text):防 view 值遗漏导致结果区空白
    const supported = new Set(['timestamp', 'http', 'jwt', 'stats', 'matches', 'list', 'hash', 'sql', 'log', 'code', 'text', '']);
    const seen = new Set<string>();
    for (const plugin of runtime.list()) {
      for (const action of plugin.actions) {
        try {
          const result = await runtime.execute(plugin.id, action.id, '', {});
          seen.add(result.view ?? '');
        } catch { /* 无输入时部分动作抛错,跳过 */ }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const view of seen) {
      expect(supported.has(view)).toBe(true);
    }
  });

  it('random values', async () => {
    const r = await runtime.execute('spurh.random', 'string', '', { length: '16', count: '1' });
    expect(r.output).toHaveLength(16);
    expect((await runtime.execute('spurh.random', 'uuid', '', {})).output).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('honors count/length from random/uuid prefixes', async () => {
    const uuids = await runtime.execute('spurh.random', 'uuid', 'uuid: 5');
    expect(uuids.output.split('\n')).toHaveLength(5);
    for (const id of uuids.output.split('\n')) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
    const password = await runtime.execute('spurh.random', 'password', 'random: 12');
    expect(password.output).toHaveLength(12);
  });

  it('random number within range', async () => {
    const r = await runtime.execute('spurh.random', 'number', '', { min: '5', max: '9' });
    const value = Number(r.output);
    expect(value).toBeGreaterThanOrEqual(5);
    expect(value).toBeLessThanOrEqual(9);
    await expect(runtime.execute('spurh.random', 'number', '', { min: '9', max: '5' })).rejects.toThrow('范围无效');
  });

  it('random number 大范围（span > 2^32）能生成超过 32 位的值', async () => {
    const r = await runtime.execute('spurh.random', 'number', '', { min: '0', max: '5000000000' });
    const value = BigInt(r.output);
    expect(value).toBeGreaterThanOrEqual(0n);
    expect(value).toBeLessThanOrEqual(5000000000n);
  });

  it('text unescape 往返保持字面反斜杠（Windows 路径不再损坏）', async () => {
    const samples = ['a\nb', 'C:\\temp\\new\\file', 'a\\b', 'a\\u4f60b', 'a\"b'];
    for (const sample of samples) {
      const escaped = (await runtime.execute('spurh.text', 'escape', sample)).output;
      const restored = (await runtime.execute('spurh.text', 'unescape', escaped)).output;
      expect(restored).toBe(sample);
    }
  });

  it('text unescape 还原真实转义', async () => {
    // 单个反斜杠 + n 是换行转义
    const r = await runtime.execute('spurh.text', 'unescape', 'a\\nb');
    expect(r.output).toBe('a\nb');
    // 两个反斜杠 + n 是字面反斜杠 + 字母 n
    const r2 = await runtime.execute('spurh.text', 'unescape', 'a\\\\nb');
    expect(r2.output).toBe('a\\nb');
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

  it('SHA/HMAC known-answer tests', async () => {
    expect((await runtime.execute('spurh.crypto', 'SHA-1', 'hello')).output).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    expect((await runtime.execute('spurh.crypto', 'SHA-256', '')).output).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect((await runtime.execute('spurh.crypto', 'SHA-512', '')).output).toBe('cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e');
    // RFC 4231 test case 2: key="Jefe", data="what do ya want for nothing?"
    expect((await runtime.execute('spurh.crypto', 'HMAC-SHA256', 'what do ya want for nothing?', { secret: 'Jefe' })).output)
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });


  it('JSONPath recursive descent collects nested keys', async () => {
    const input = '{"a":{"name":"root","b":{"name":"child"}},"list":[{"name":"item"},{"x":{"name":"deep"}}]}';
    const r = await runtime.execute('spurh.json', 'path', input, { path: '$..name' });
    expect(r.output).toBe('[\n  "root",\n  "child",\n  "item",\n  "deep"\n]');
    const deep = await runtime.execute('spurh.json', 'path', input, { path: '$..b.name' });
    expect(deep.output).toBe('"child"');
    const wild = await runtime.execute('spurh.json', 'path', input, { path: '$..list[*].name' });
    expect(wild.output).toBe('[\n  "item"\n]');
    await expect(runtime.execute('spurh.json', 'path', input, { path: '$.a[?(@.name)]' })).rejects.toThrow('当前支持');
  });
  it('JSONPath queries arrays, bracket keys and wildcards', async () => {
    const input = '{"users":[{"name":"alice"}],"meta":{"x":1}}';
    expect((await runtime.execute('spurh.json', 'path', input, { path: '$.users[0].name' })).output).toBe('"alice"');
    expect((await runtime.execute('spurh.json', 'path', input, { path: "$['meta']['x']" })).output).toBe('1');
    expect((await runtime.execute('spurh.json', 'path', input, { path: '$.users[*].name' })).output).toBe('[\n  "alice"\n]');
    await expect(runtime.execute('spurh.json', 'path', input, { path: 'users' })).rejects.toThrow('$');
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

  it('suggests decode action for base64 input', () => {
    const r = runtime.dispatch('aGVsbG8gd29ybGQ=');
    expect(r.selected?.plugin.id).toBe('spurh.encoder');
    expect(r.selected?.suggestedAction).toBe('base64-decode');
  });

  it('suggests format action for json and xml', () => {
    const j = runtime.dispatch('{"a":1}');
    expect(j.selected?.suggestedAction).toBe('format');
    const x = runtime.dispatch('<root><a>1</a></root>');
    expect(x.selected?.suggestedAction).toBe('xml-format');
  });

  it('suggests next action for cron expression', () => {
    const r = runtime.dispatch('*/15 * * * *');
    expect(r.selected?.plugin.id).toBe('spurh.cron');
    expect(r.selected?.suggestedAction).toBe('next');
  });

  it('suggests test action for regex literal', () => {
    const r = runtime.dispatch('/ab+c/gi');
    expect(r.selected?.plugin.id).toBe('spurh.regex');
    expect(r.selected?.suggestedAction).toBe('test');
  });

  it('parses regex literal with same-line test text', async () => {
    const r = runtime.dispatch('/\\w+@\\w+\\.com/gi 联系 test@b.com');
    expect(r.selected?.plugin.id).toBe('spurh.regex');
    const result = await runtime.execute('spurh.regex', 'test', '/\\w+@\\w+\\.com/gi 联系 test@b.com');
    expect(result.meta?.['匹配数']).toBe(1);
    expect(result.data).toMatchObject([{ value: 'test@b.com' }]);
  });

  it('keeps newline test text after regex literal', async () => {
    const result = await runtime.execute('spurh.regex', 'test', '/\\d+/g\n12 34');
    expect(result.meta?.['匹配数']).toBe(2);
  });

  it('suggests uuid action for uuid prefix', () => {
    const r = runtime.dispatch('uuid: 4');
    expect(r.selected?.plugin.id).toBe('spurh.random');
    expect(r.selected?.suggestedAction).toBe('uuid');
  });

  it('routes hash/sha prefixes to crypto not encoder', () => {
    const hash = runtime.dispatch('hash: hello');
    expect(hash.selected?.plugin.id).toBe('spurh.crypto');
    expect(hash.selected?.suggestedAction).toBe('SHA-256');
    const sha512 = runtime.dispatch('sha512: hello');
    expect(sha512.selected?.plugin.id).toBe('spurh.crypto');
    expect(sha512.selected?.suggestedAction).toBe('SHA-512');
    const md5 = runtime.dispatch('md5: hello');
    expect(md5.selected?.plugin.id).toBe('spurh.crypto');
    expect(md5.selected?.suggestedAction).toBe('MD5');
  });

  it('strips crypto command prefixes before hashing', async () => {
    // sha512: hello 必须对 hello 取摘要，而不是把前缀一起算进去
    expect((await runtime.execute('spurh.crypto', 'SHA-512', 'sha512: hello')).output)
      .toBe('9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043');
    expect((await runtime.execute('spurh.crypto', 'SHA-256', 'hash: hello')).output)
      .toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect((await runtime.execute('spurh.crypto', 'MD5', 'md5: hello')).output)
      .toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('keeps base64/url/hex prefixes in encoder', () => {
    expect(runtime.dispatch('base64: hello').selected?.plugin.id).toBe('spurh.encoder');
    expect(runtime.dispatch('hex: ff').selected?.suggestedAction).toBe('hex-encode');
  });

  it('strips encoder command prefixes before encoding', async () => {
    expect((await runtime.execute('spurh.encoder', 'base64-encode', 'base64: hello')).output).toBe('aGVsbG8=');
    expect((await runtime.execute('spurh.encoder', 'hex-encode', 'hex: hello')).output).toBe('68656c6c6f');
    expect((await runtime.execute('spurh.encoder', 'url-encode', 'url: hello world')).output).toBe('hello%20world');
    expect((await runtime.execute('spurh.encoder', 'base64-decode', 'base64: aGVsbG8=')).output).toBe('hello');
    expect(runtime.dispatch('html: <b>x</b>').selected?.suggestedAction).toBe('html-encode');
    expect((await runtime.execute('spurh.encoder', 'html-encode', 'html: <b>x</b>')).output).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it('routes json/xml prefixes and strips them before formatting', async () => {
    const j = runtime.dispatch('json: {"a":1}');
    expect(j.selected?.plugin.id).toBe('spurh.json');
    expect(j.selected?.suggestedAction).toBe('format');
    const x = runtime.dispatch('xml: <root><a>1</a></root>');
    expect(x.selected?.plugin.id).toBe('spurh.json');
    expect(x.selected?.suggestedAction).toBe('xml-format');
    const fmt = await runtime.execute('spurh.json', 'format', 'json: {"a":1}');
    expect(fmt.output).toContain('"a": 1');
    const xml = await runtime.execute('spurh.json', 'xml-format', 'xml: <root><a>1</a></root>');
    expect(xml.output).toBe('<root>\n  <a>\n    1\n  </a>\n</root>');
  });
});
