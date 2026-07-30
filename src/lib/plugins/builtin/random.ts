import type { PluginResult, SpurhPlugin } from '../types';

const ALPHANUMERIC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD = `${ALPHANUMERIC}!@#$%^&*_-+=`;
const HEX = '0123456789abcdef';

function secureString(length: number, alphabet: string): string {
  const result: string[] = [];
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.max(16, length - result.length)));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      result.push(alphabet[byte % alphabet.length]);
      if (result.length === length) break;
    }
  }
  return result.join('');
}

export const randomPlugin: SpurhPlugin = {
  id: 'spurh.random',
  name: '随机生成',
  description: '安全生成密码、随机字符、UUID 与十六进制',
  icon: 'Rn',
  version: '0.1.0',
  category: '开发',
  priority: 77,
  actions: [
    { id: 'password', label: '安全密码', description: '生成包含特殊字符的安全密码' },
    { id: 'string', label: '随机字符', description: '生成易于复制的字母数字字符串' },
    { id: 'uuid', label: 'UUID', description: '生成 UUID v4' },
    { id: 'hex', label: '十六进制', description: '生成十六进制随机值' },
  ],
  options: [
    { id: 'length', label: '长度', type: 'text', defaultValue: '24', placeholder: '4-512', actions: ['password', 'string', 'hex'] },
    { id: 'count', label: '数量', type: 'text', defaultValue: '1', placeholder: '1-100' },
  ],
  detect(input) {
    if (/^(random|随机|uuid):/i.test(input.trim())) return { confidence: 0.9, reason: '检测到随机生成指令' };
    return null;
  },
  execute(actionId, _input, options = {}): PluginResult {
    const length = Number.parseInt(options.length || '24', 10);
    const count = Math.min(100, Math.max(1, Number.parseInt(options.count || '1', 10) || 1));
    if (!Number.isFinite(length) || length < 4 || length > 512) throw new Error('长度请输入 4 到 512');
    const values = Array.from({ length: count }, () => {
      if (actionId === 'uuid') return crypto.randomUUID();
      if (actionId === 'hex') return secureString(length, HEX);
      return secureString(length, actionId === 'password' ? PASSWORD : ALPHANUMERIC);
    });
    return {
      output: values.join('\n'),
      language: 'text',
      view: 'list',
      data: values,
      summary: `已安全生成 ${values.length} 个结果`,
      meta: { 数量: values.length, ...(actionId === 'uuid' ? {} : { 长度: length }), 随机源: 'Web Crypto' },
    };
  },
};
