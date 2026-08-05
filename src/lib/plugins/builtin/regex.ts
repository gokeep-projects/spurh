import { TOOL_ICONS as ICONS } from '../../icons';
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
  icon: ICONS['spurh.regex'],
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
        const rules: Array<[RegExp, string]> = [
          [/\\b/g, '单词边界'], [/\\B/g, '非单词边界'],
          [/\^/g, '匹配文本开头'], [/\$/g, '匹配文本结尾'],
          [/\./g, '匹配任意字符（除换行）'], [/\\d/g, '匹配数字'], [/\\D/g, '匹配非数字'],
          [/\\w/g, '匹配字母、数字或下划线'], [/\\W/g, '匹配非单词字符'],
          [/\\s/g, '匹配空白字符'], [/\\S/g, '匹配非空白字符'],
          [/\\n/g, '换行符'], [/\\r/g, '回车符'], [/\\t/g, '制表符'],
          [/\\u/g, 'Unicode 字符'], [/\\x/g, '十六进制字符'],
          [/\[[^\]]*\]/g, '字符集（如 [a-z]）'], [/\([^)]*\)/g, '分组'],
          [/\?:/g, '非捕获分组'], [/\?=/g, '正向先行断言'], [/\?!/g, '负向先行断言'],
          [/\(\?<=/g, '正向后行断言'], [/\(\?<!/g, '负向后行断言'],
          [/\|/g, '或（匹配左边或右边）'], [/\?/g, '可选或非贪婪'],
          [/\*/g, '重复零次或多次'], [/\+/g, '重复一次或多次'],
          [/\{\d+(,\d*)?\}/g, '指定重复次数'], [/\\([1-9])/g, '反向引用'],
        ];
        const explained = rules.filter(([rule]) => rule.test(pattern)).map(([, meaning]) => meaning);
        const tokens = explained.length ? [...new Set(explained)].join('、') : '未检测到特殊结构，是字面量匹配';
        return {
          output: `表达式：/${pattern}/${flags}\n\n${tokens}`,
          language: 'text',
          summary: '已解释正则结构',
          meta: { 表达式: `/${pattern}/${flags}`, 结构: explained.length },
        };
      }      const matches = [...text.matchAll(regex)].map((match) => ({
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
