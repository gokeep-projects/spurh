import { TOOL_ICONS as ICONS } from '../../icons';
import type { SpurhPlugin } from '../types';

function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(input: string): string {
  const normalized = input.trim().replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  } catch {
    throw new Error('不是有效的 Base64 文本');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    throw new Error('Base64 解码成功但不是 UTF-8 文本，可能是二进制数据');
  }
}

function encodeHex(input: string): string {
  return [...new TextEncoder().encode(input)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeHex(input: string): string {
  const value = input.trim().replace(/\s/g, '');
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) throw new Error('不是有效的 Hex');
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16)));
}

function unicodeEscape(input: string): string {
  return [...input].map((char) => {
    const code = char.codePointAt(0)!;
    if (code > 0xffff) {
      const high = 0xd800 + ((code - 0x10000) >> 10);
      const low = 0xdc00 + ((code - 0x10000) & 0x3ff);
      return `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
    }
    return code > 0x7e || code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }).join('');
}

function unicodeUnescape(input: string): string {
  return input.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function htmlEscape(input: string): string {
  return input
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function htmlUnescape(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, num: string) => {
      const code = Number(num);
      return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export const encoderPlugin: SpurhPlugin = {
  id: 'spurh.encoder',
  name: '编码转换',
  description: 'Base64、URL、Hex 编解码与 SHA 摘要计算',
  icon: ICONS['spurh.encoder'],
  version: '0.1.0',
  category: '编码',
  priority: 65,
  actions: [
    { id: 'base64-encode', label: 'Base64 编码', description: '文本 → Base64' },
    { id: 'base64-decode', label: 'Base64 解码', description: 'Base64 → 文本' },
    { id: 'url-encode', label: 'URL 编码', description: '文本 → URL Component' },
    { id: 'url-decode', label: 'URL 解码', description: '解码百分号转义' },
    { id: 'hex-encode', label: 'Hex 编码', description: '文本 → 十六进制' },
    { id: 'hex-decode', label: 'Hex 解码', description: '十六进制 → 文本' },
    { id: 'unicode-escape', label: 'Unicode 转义', description: '文本 → \\uXXXX 序列' },
    { id: 'unicode-unescape', label: 'Unicode 还原', description: '\\uXXXX → 文本' },
    { id: 'html-encode', label: 'HTML 转义', description: '文本 → HTML 实体' },
    { id: 'html-decode', label: 'HTML 还原', description: 'HTML 实体 → 文本' },
  ],
  options: [],
  detect(input) {
    const value = input.trim().replace(/\s/g, '');
    if (value.length >= 8 && value.length % 4 === 0 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
      try { decodeBase64(value); return { confidence: 0.78, reason: '检测到可解码的 Base64 文本' }; } catch { /* fall through */ }
    }
    if (/%[0-9a-f]{2}/i.test(value)) return { confidence: 0.82, reason: '检测到 URL 百分号编码' };
    if (/^https?:\/\//i.test(value)) return { confidence: 0.55, reason: '检测到 HTTP URL（可解码）' };
    if (value.length >= 16 && /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) return { confidence: 0.5, reason: '内容可能是 Hex 字符串' };
    if (/^(base64|url|hex|hash|sha)[:：]/i.test(input.trim())) return { confidence: 0.86, reason: '检测到编码指令前缀' };
    return null;
  },
  async execute(actionId, input) {
    let output: string; let summary: string;
    switch (actionId) {
      case 'base64-encode': output = encodeBase64(input); summary = 'Base64 编码完成'; break;
      case 'base64-decode': output = decodeBase64(input); summary = 'Base64 解码完成'; break;
      case 'url-encode': output = encodeURIComponent(input); summary = 'URL 编码完成'; break;
      case 'url-decode':
        try { output = decodeURIComponent(input); } catch { throw new Error('URL 编码不完整'); }
        summary = 'URL 解码完成'; break;
      case 'hex-encode': output = encodeHex(input); summary = 'Hex 编码完成'; break;
      case 'hex-decode': output = decodeHex(input); summary = 'Hex 解码完成'; break;
      case 'unicode-escape': output = unicodeEscape(input); summary = 'Unicode 转义完成'; break;
      case 'unicode-unescape': output = unicodeUnescape(input); summary = 'Unicode 还原完成'; break;
      case 'html-encode': output = htmlEscape(input); summary = 'HTML 转义完成'; break;
      case 'html-decode': output = htmlUnescape(input); summary = 'HTML 还原完成'; break;
      default: throw new Error(`未知操作 ${actionId}`);
    }
    return { output, language: 'text', summary, meta: { 输入: input.length, 输出: output.length } as Record<string, string | number | boolean> };
  },
};
