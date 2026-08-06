import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToUtf8, decodeExecResult, escPath } from './remoteExec';

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('decodeExecResult', () => {
  it('解码普通输出', () => {
    const raw = b64('hello');
    expect(decodeExecResult(raw).text).toBe('hello');
    expect(decodeExecResult(raw).truncated).toBe(false);
    expect(decodeExecResult(raw).stderr).toBe('');
  });

  it('分离 stderr 标记', () => {
    const raw = b64('out') + '__STDERR__' + b64('err msg');
    const decoded = decodeExecResult(raw);
    expect(decoded.text).toBe('out');
    expect(decoded.stderr).toBe('err msg');
  });

  it('识别截断标记', () => {
    const raw = b64('partial') + '__TRUNCATED__';
    const decoded = decodeExecResult(raw);
    expect(decoded.text).toBe('partial');
    expect(decoded.truncated).toBe(true);
  });

  it('同时处理 stderr 与截断', () => {
    const raw = b64('out') + '__STDERR__' + b64('err') + '__TRUNCATED__';
    const decoded = decodeExecResult(raw);
    expect(decoded.text).toBe('out');
    expect(decoded.stderr).toBe('err');
    expect(decoded.truncated).toBe(true);
  });
});

describe('远程文件下载回归（曾双重 atob 导致损坏）', () => {
  it('ssh_exec 返回外层 base64(内层 base64(file))，解码一次即得原始字节', () => {
    const fileContent = 'C:\\temp\\new\\file\n中文内容\u0000end';
    const inner = b64(fileContent); // 远端 base64 命令输出（可能带换行）
    const outer = b64(inner); // ssh_exec 再套一层
    const decoded = decodeExecResult(outer);
    // 修复前代码会再 atob(decoded.text) 一次 → 抛错或损坏
    const bytes = base64ToBytes(decoded.text);
    expect(bytesToUtf8(bytes)).toBe(fileContent);
  });

  it('base64 输入带换行也能解码（GNU/BSD base64 默认折行）', () => {
    const content = 'x'.repeat(200);
    const inner = b64(content).replace(/(.{76})/g, '$1\n');
    const bytes = base64ToBytes(inner);
    expect(bytesToUtf8(bytes)).toBe(content);
  });
});

describe('escPath', () => {
  it('转义单引号防止注入', () => {
    expect(escPath("a'b")).toBe("a'\\''b");
    expect(escPath('plain')).toBe('plain');
  });
});
