import type { SpurhPlugin } from '../types';

async function digest(algorithm: string, input: string): Promise<string> {
  const value = await crypto.subtle.digest(algorithm, new TextEncoder().encode(input));
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const hashPlugin: SpurhPlugin = {
  id: 'spurh.hash',
  name: 'Hash 摘要',
  description: 'SHA 摘要计算',
  icon: '#',
  version: '0.1.0',
  category: '安全',
  priority: 20,
  actions: [
    { id: 'SHA-256', label: 'SHA-256', description: '256 位摘要' },
    { id: 'SHA-1', label: 'SHA-1', description: '160 位兼容摘要' },
    { id: 'SHA-512', label: 'SHA-512', description: '512 位摘要' },
  ],
  detect(input) {
    if (/^hash:/i.test(input.trim())) return { confidence: 0.86, reason: '检测到 Hash 指令前缀' };
    return null;
  },
  async execute(actionId, input) {
    const content = input.replace(/^hash:\s*/i, '');
    const output = await digest(actionId, content);
    return {
      output,
      language: 'text',
      view: 'hash',
      data: { algorithm: actionId, bits: output.length * 4, digest: output },
      summary: `已计算 ${actionId} 摘要`,
      meta: { 算法: actionId, 位数: output.length * 4, 输入字节: new TextEncoder().encode(content).length },
    };
  },
};
