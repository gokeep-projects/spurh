import { TOOL_ICONS as ICONS } from '../../icons';
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

const LENGTH_CHOICES = ['8', '12', '16', '20', '24', '32', '48', '64', '128'].map((value) => ({ value, label: `${value} 位` }));
const COUNT_CHOICES = ['1', '2', '3', '4', '5', '10', '20', '50'].map((value) => ({ value, label: `${value} 个` }));

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID：48 位时间戳 + 80 位随机，Crockford Base32 编码 */
function ulid(): string {
  const time = BigInt(Date.now());
  const timestamp = time.toString(2).padStart(48, '0');
  const randomBits: string[] = [];
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (const byte of bytes) randomBits.push(byte.toString(2).padStart(8, '0'));
  const binary = (timestamp + randomBits.join('')).padEnd(128, '0').slice(0, 128);
  let result = '';
  for (let index = 0; index < 26; index++) {
    const chunk = binary.slice(index * 5, index * 5 + 5);
    result += CROCKFORD[Number.parseInt(chunk.padEnd(5, '0'), 2)];
  }
  return result;
}

export const randomPlugin: SpurhPlugin = {
  id: 'spurh.random',
  name: '随机生成',
  description: '安全生成密码、随机字符、UUID 与十六进制',
  icon: ICONS['spurh.random'],
  version: '0.1.0',
  category: '开发',
  priority: 77,
  actions: [
    { id: 'password', label: '安全密码', description: '生成包含特殊字符的安全密码' },
    { id: 'string', label: '随机字符', description: '生成易于复制的字母数字字符串' },
    { id: 'uuid', label: 'UUID', description: '生成 UUID v4' },
    { id: 'ulid', label: 'ULID', description: '生成按时间排序的 ULID' },
    { id: 'number', label: '随机数字', description: '生成指定范围内的整数' },
    { id: 'hex', label: '十六进制', description: '生成十六进制随机值' },
    { id: 'color', label: '随机颜色', description: '生成 #RRGGBB 颜色值' },
  ],
  options: [
    { id: 'length', label: '长度', type: 'select', defaultValue: '24', actions: ['password', 'string', 'hex'], choices: LENGTH_CHOICES },
    { id: 'count', label: '数量', type: 'select', defaultValue: '1', choices: COUNT_CHOICES },
    { id: 'min', label: '最小值', type: 'text', defaultValue: '0', placeholder: '0', actions: ['number'] },
    { id: 'max', label: '最大值', type: 'text', defaultValue: '100', placeholder: '100', actions: ['number'] },
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
      if (actionId === 'ulid') return ulid();
      if (actionId === 'hex') return secureString(length, HEX);
      if (actionId === 'color') {
        const bytes = crypto.getRandomValues(new Uint8Array(3));
        return '#' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      }
      if (actionId === 'number') {
        const min = Number.parseInt(options.min || '0', 10);
        const max = Number.parseInt(options.max || '100', 10);
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error('数字范围无效，请确认最小值 ≤ 最大值');
        const span = BigInt(max) - BigInt(min) + 1n;
        if (span > 1n << 53n) throw new Error('数字范围过大');
        // 均匀采样，避免取模偏差
        const limit = Math.floor(Number(span));
        const bytes = crypto.getRandomValues(new Uint32Array(1));
        return String(min + (bytes[0] % limit));
      }
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