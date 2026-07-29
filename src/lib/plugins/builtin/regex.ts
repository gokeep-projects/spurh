import type { PluginResult, SpurhPlugin } from '../types';

function parseLiteral(input: string): { pattern: string; flags: string; text: string } | null {
  const [firstLine, ...rest] = input.split('\n');
  const match = firstLine.match(/^\/(.*)\/([dgimsuvy]*)$/);
  return match ? { pattern: match[1], flags: match[2], text: rest.join('\n') } : null;
}

export const regexPlugin: SpurhPlugin = {
  id: 'spurh.regex',
  name: '正则表达式',
  description: '实时测试正则表达式',
  icon: '.*',
  version: '0.1.0',
  category: '开发',
  priority: 70,
  actions: [
    { id: 'test', label: '测试', description: '列出所有匹配结果' },
    { id: 'replace', label: '替换', description: '替换所有匹配内容' },
    { id: 'explain', label: '解释', description: '解释常见正则结构' },
  ],
  options: [
    { id: 'pattern', label: '表达式', type: 'text', placeholder: '例如: (?<name>\\w+)', defaultValue: '' },
    {
      id: 'flags', label: '标志', type: 'select', defaultValue: 'g',
      choices: [
        { value: 'g', label: 'g' }, { value: 'gi', label: 'gi' },
        { value: 'gm', label: 'gm' }, { value: 'gim', label: 'gim' },
      ],
    },
    { id: 'replacement', label: '替换为', type: 'text', placeholder: '$1', defaultValue: '', actions: ['replace'] },
  ],
  detect(input) {
    return parseLiteral(input.trim())
      ? { confidence: 0.9, reason: '检测到 /pattern/flags 正则表达式' }
      : null;
  },
  execute(_actionId, input, options = {}): PluginResult {
    const literal = parseLiteral(input);
    const pattern = options.pattern || literal?.pattern || '';
    const flags = options.flags || literal?.flags || 'g';
    const text = literal ? literal.text : input;
    if (!pattern) throw new Error('请先输入正则表达式');
    try {
      const normalizedFlags = flags.includes('g') ? flags : `${flags}g`;
      const regex = new RegExp(pattern, normalizedFlags);
      if (_actionId === 'replace') {
        const output = text.replace(regex, options.replacement ?? '');
        return {
          output, language: 'text', summary: '已实时替换全部匹配内容',
          meta: { 表达式: `/${pattern}/${flags}`, 输出字符: output.length },
        };
      }
      if (_actionId === 'explain') {
        const explanations = [
          ['^', '匹配文本开头'], ['$', '匹配文本结尾'], ['.', '匹配任意字符'],
          ['\\d', '匹配数字'], ['\\w', '匹配字母、数字或下划线'], ['\\s', '匹配空白'],
          ['+', '重复一次或多次'], ['*', '重复零次或多次'], ['?', '可选或非贪婪'],
        ].filter(([token]) => pattern.includes(token)).map(([token, meaning]) => `${token}  ${meaning}`);
        return {
          output: explanations.length ? explanations.join('\n') : '这是一个字面量匹配表达式，没有检测到需要解释的特殊结构。',
          language: 'text', summary: '已解释常见正则结构', meta: { 表达式: `/${pattern}/${flags}` },
        };
      }
      const matches = [...text.matchAll(regex)].map((match) => ({
        value: match[0],
        index: match.index,
        groups: match.groups ?? {},
      }));
      return {
        output: JSON.stringify(matches, null, 2),
        language: 'json',
        view: 'matches',
        data: matches,
        summary: matches.length ? `找到 ${matches.length} 个匹配` : '没有匹配结果',
        meta: { 表达式: `/${pattern}/${flags}`, 匹配数: matches.length },
      };
    } catch (error) {
      throw new Error(`正则语法错误：${error instanceof Error ? error.message : '未知错误'}`);
    }
  },
};
