import type { PluginResult, SpurhPlugin } from '../types';

function countWords(input: string): number {
  const latinWords = input.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return latinWords.length;
}

function wrapText(input: string, width: number): string {
  return input.split('\n').flatMap((line) => {
    if (!line) return [''];
    const chunks: string[] = [];
    const characters = [...line];
    for (let index = 0; index < characters.length; index += width) {
      chunks.push(characters.slice(index, index + width).join(''));
    }
    return chunks;
  }).join('\n');
}

function unescapeText(input: string): string {
  return input
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, value: string) => String.fromCharCode(Number.parseInt(value, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

export const textPlugin: SpurhPlugin = {
  id: 'spurh.text',
  name: '文本处理',
  description: '统计、换行、清理与特殊字符处理',
  icon: 'Aa',
  version: '0.1.0',
  category: '数据',
  priority: 78,
  actions: [
    { id: 'stats', label: '字符统计', description: '统计字符、单词、行数与字节' },
    { id: 'wrap', label: '自动换行', description: '按指定字符宽度自动换行' },
    { id: 'trim', label: '清理空白', description: '清理首尾空格和多余空行' },
    { id: 'dedupe', label: '行去重', description: '保持顺序去除重复行' },
    { id: 'escape', label: '特殊字符转义', description: '转义换行、制表符、引号等字符' },
    { id: 'unescape', label: '还原特殊字符', description: '把转义序列还原成真实字符' },
    { id: 'upper', label: '大写', description: '转换为大写文本' },
    { id: 'lower', label: '小写', description: '转换为小写文本' },
  ],
  options: [
    { id: 'width', label: '每行字符', type: 'text', defaultValue: '80', placeholder: '80', actions: ['wrap'] },
    { id: 'aiPrompt', label: 'AI 提示语', type: 'text', defaultValue: '', placeholder: '例如：润色语气，并保持原意' },
  ],
  detect(input) {
    if (/^text:/i.test(input.trim())) return { confidence: 0.82, reason: '检测到文本处理指令' };
    return null;
  },
  execute(actionId, input, options = {}): PluginResult {
    const content = input.replace(/^text:\s*/i, '');
    if (actionId === 'stats') {
      const stats = {
        字符数: [...content].length,
        不含空格: [...content.replace(/\s/g, '')].length,
        单词数: countWords(content),
        行数: content.length ? content.split(/\r?\n/).length : 0,
        段落数: content.trim() ? content.trim().split(/\n\s*\n/).length : 0,
        UTF8字节: new TextEncoder().encode(content).length,
      };
      return {
        output: Object.entries(stats).map(([key, value]) => `${key}: ${value}`).join('\n'),
        language: 'text',
        view: 'stats',
        data: stats,
        summary: '文本统计已实时更新',
        meta: { 字符: stats.字符数, 行数: stats.行数 },
      };
    }

    let output = content;
    if (actionId === 'wrap') {
      const width = Number.parseInt(options.width || '80', 10);
      if (!Number.isFinite(width) || width < 1 || width > 500) throw new Error('每行字符数请输入 1 到 500');
      output = wrapText(content, width);
    } else if (actionId === 'trim') {
      output = content.split(/\r?\n/).map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    } else if (actionId === 'dedupe') {
      output = [...new Set(content.split(/\r?\n/))].join('\n');
    } else if (actionId === 'escape') {
      output = JSON.stringify(content).slice(1, -1);
    } else if (actionId === 'unescape') {
      output = unescapeText(content);
    } else if (actionId === 'upper') {
      output = content.toLocaleUpperCase();
    } else if (actionId === 'lower') {
      output = content.toLocaleLowerCase();
    }
    return {
      output,
      language: 'text',
      view: 'text',
      summary: '文本处理完成',
      meta: { 输入字符: [...content].length, 输出字符: [...output].length },
    };
  },
};
