import { describe, it, expect } from 'vitest';
import { runtime } from './index';

const POOL = [
  '', 'a', ' ', '\t', '\n', '\r\n', '0', '42', '9999999999', '2026-08-07 03:35:00',
  '{}', '[]', '{"a":1}', '[1,2,3]', 'null', 'true', 'undefined',
  '"quoted"', "'single'", 'a,b,c', 'a"b', 'a\\b', 'a/b', '\\u4e2d', '中文',
  '=SUM(A1)', '+1', '@cmd', "-1", '0x1F600', '😀', 'null\u0000byte',
  'json: {"a":1}', 'xml: <root/>', 'base64: hello', 'sha512: hello', 'md5: x',
  'text: stats', 'random: 12', 'uuid: 3', 'hash: md5 hello', 'hmac: sha256',
  '*/5 * * * *', '/\\d+/g 12 34', 'cron: */10 * * * *',
  'https://example.com/path?q=1', '127.0.0.1', 'not-json{', '<root><a>',
  'a'.repeat(100_000), 'x'.repeat(3000),
];

describe('fuzz plugin execute stability', () => {
  for (const plugin of runtime.list()) {
    it(`${plugin.id} never crashes on hostile input`, { timeout: 30_000 }, async () => {
      for (const action of plugin.actions) {
        for (const input of POOL) {
          try {
            const result = await plugin.execute(action.id, input);
            expect(typeof result.output).toBe('string');
            expect(Number.isFinite(result.output.length)).toBe(true);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            const message = error instanceof Error ? error.message : String(error);
            expect(message.trim().length).toBeGreaterThan(0);
            expect(message).not.toContain('undefined is not');
            expect(message).not.toMatch(/Cannot read propert/);
            expect(message).not.toMatch(/is not a function/);
          }
        }
      }
    });
  }
});
