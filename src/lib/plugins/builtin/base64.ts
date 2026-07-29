import type { SpurhPlugin } from '../types';

function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(input: string): string {
  try {
    const normalized = input.trim().replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    throw new Error('内容不是有效的 UTF-8 Base64');
  }
}

function encodeHex(input: string): string {
  return [...new TextEncoder().encode(input)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeHex(input: string): string {
  const value = input.trim().replace(/\s/g, '');
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) throw new Error('内容不是有效的 Hex 字节序列');
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16)));
}

export const base64Plugin: SpurhPlugin = {
  id: 'spurh.base64',
  name: 'Base64 编码',
  description: 'Unicode 安全编码与解码',
  icon: '64',
  version: '0.1.0',
  category: '编码',
  priority: 40,
  actions: [
    { id: 'encode', label: '编码', description: '文本转 Base64' },
    { id: 'decode', label: '解码', description: 'Base64 转文本' },
    { id: 'hex-encode', label: '转 Hex', description: '文本转十六进制' },
    { id: 'hex-decode', label: 'Hex 解码', description: '十六进制转文本' },
  ],
  detect(input) {
    const value = input.trim().replace(/\s/g, '');
    if (value.length >= 8 && value.length % 4 === 0 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
      try {
        decodeBase64(value);
        return { confidence: 0.78, reason: '检测到可解码的 Base64 文本' };
      } catch { return null; }
    }
    return null;
  },
  execute(actionId, input) {
    const output = actionId === 'decode' ? decodeBase64(input)
      : actionId === 'hex-encode' ? encodeHex(input)
      : actionId === 'hex-decode' ? decodeHex(input)
      : encodeBase64(input);
    return {
      output,
      language: 'text',
      summary: actionId === 'decode' ? '已解码 Base64' : actionId === 'hex-encode' ? '已编码为 Hex' : actionId === 'hex-decode' ? '已解码 Hex' : '已编码为 Base64',
      meta: { 输入字符: input.length, 输出字符: output.length },
    };
  },
};
