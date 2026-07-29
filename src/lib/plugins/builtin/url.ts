import type { SpurhPlugin } from '../types';

export const urlPlugin: SpurhPlugin = {
  id: 'spurh.url',
  name: 'URL 编码',
  description: 'URL 与查询参数编解码',
  icon: '%',
  version: '0.1.0',
  category: '编码',
  priority: 65,
  actions: [
    { id: 'decode', label: '解码', description: '解码百分号转义' },
    { id: 'encode', label: '编码', description: '编码为 URL Component' },
  ],
  detect(input) {
    const value = input.trim();
    if (/^https?:\/\//i.test(value)) return { confidence: 0.88, reason: '检测到 HTTP URL' };
    if (/%[0-9a-f]{2}/i.test(value)) return { confidence: 0.82, reason: '检测到 URL 百分号编码' };
    return null;
  },
  execute(actionId, input) {
    try {
      const output = actionId === 'encode' ? encodeURIComponent(input) : decodeURIComponent(input);
      return {
        output,
        language: 'text',
        summary: actionId === 'encode' ? '已编码 URL Component' : '已解码 URL',
        meta: { 输入字符: input.length, 输出字符: output.length },
      };
    } catch {
      throw new Error('URL 编码不完整或包含无效转义');
    }
  },
};
