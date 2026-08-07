import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

export function parseLiteral(input: string): { pattern: string; flags: string; text: string } | null {
  const [firstLine, ...rest] = input.split('\n');
  // 允许 /pattern/flags 后同行跟测试文本，也兼容换行后跟文本（多行时同行文本与后续行合并）
  const match = firstLine.match(/^\/(.*)\/([dgimsuvy]*)(?:\s+(.*))?$/);
  if (!match) return null;
  const [, pattern, flags, sameLineText] = match;
  const text = [sameLineText, ...rest].filter(Boolean).join('\n');
  return { pattern, flags, text };
}

export type RegexToken = { token: string; meaning: string; indent: number };

/** 把正则表达式解析为带缩进的 token 序列，逐项解释含义（支持常见结构） */
export function explainRegexTokens(pattern: string): RegexToken[] {
  const out: RegexToken[] = [];
  let i = 0;
  let indent = 0;
  let literalRun = '';
  const flush = () => {
    if (literalRun) {
      out.push({ token: JSON.stringify(literalRun), meaning: '字面量文本', indent });
      literalRun = '';
    }
  };
  const escMeanings: Record<string, string> = {
    d: '数字 [0-9]', D: '非数字', w: '字母、数字或下划线', W: '非单词字符',
    s: '空白字符', S: '非空白字符', b: '单词边界', B: '非单词边界',
    n: '换行符', r: '回车符', t: '制表符', '\\': '反斜杠',
  };
  while (i < pattern.length) {
    const ch = pattern[i];
    const rest = pattern.slice(i + 1);
    if (ch === '\\') {
      flush();
      const esc = pattern[i + 1] ?? '';
      if (esc === 'u') {
        const hex = pattern.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out.push({ token: `\\u${hex}`, meaning: `Unicode 字符 U+${hex.toUpperCase()}`, indent }); i += 6; continue; }
      }
      if (esc === 'x') {
        const hex = pattern.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out.push({ token: `\\x${hex}`, meaning: `十六进制字符 0x${hex}`, indent }); i += 4; continue; }
      }
      if (/[1-9]/.test(esc)) { out.push({ token: `\\${esc}`, meaning: `反向引用第 ${esc} 个分组`, indent }); i += 2; continue; }
      out.push({ token: `\\${esc || '\\'}`, meaning: escMeanings[esc] ?? (esc ? `转义字符 ${esc}` : '转义反斜杠'), indent });
      i += 2;
      continue;
    }
    if (ch === '[') {
      flush();
      let end = i + 1;
      while (end < pattern.length && pattern[end] !== ']') end++;
      if (end < pattern.length) end++;
      out.push({ token: pattern.slice(i, end), meaning: '字符集（匹配其中任意一个字符）', indent });
      i = end;
      continue;
    }
    if (ch === '(') {
      flush();
      if (/^\?<[A-Za-z_]\w*>/.test(rest)) {
        const name = rest.match(/^\?<([A-Za-z_]\w*)>/)?.[1] ?? '';
        out.push({ token: `(?<${name}>`, meaning: `命名分组 ${name}`, indent });
        i += 4 + name.length; // (?<name> 共 4 + name.length 个字符)
        indent += 1;
        continue;
      }
      if (rest.startsWith('?:')) { out.push({ token: '(?:', meaning: '非捕获分组', indent }); i += 3; indent += 1; continue; }
      if (rest.startsWith('?=')) { out.push({ token: '(?=', meaning: '正向先行断言', indent }); i += 3; indent += 1; continue; }
      if (rest.startsWith('?!')) { out.push({ token: '(?!', meaning: '负向先行断言', indent }); i += 3; indent += 1; continue; }
      if (rest.startsWith('?<=')) { out.push({ token: '(?<=', meaning: '正向后行断言', indent }); i += 4; indent += 1; continue; }
      if (rest.startsWith('?<!')) { out.push({ token: '(?<!', meaning: '负向后行断言', indent }); i += 4; indent += 1; continue; }
      out.push({ token: '(', meaning: '捕获分组', indent });
      i += 1;
      indent += 1;
      continue;
    }
    if (ch === ')') {
      flush();
      indent = Math.max(0, indent - 1);
      out.push({ token: ')', meaning: '分组结束', indent });
      i += 1;
      continue;
    }
    if (ch === '{') {
      flush();
      const m = pattern.slice(i).match(/^\{(\d+)(,\d*)?\}/);
      if (m) {
        const min = m[1];
        const max = m[2] ? (m[2] === ',' ? '无限' : m[2].slice(1)) : min;
        out.push({ token: m[0], meaning: `重复 ${min} 次${max === min ? '' : `到 ${max} 次`}`, indent });
        i += m[0].length;
        continue;
      }
      out.push({ token: '{', meaning: '字面量 {', indent });
      i += 1;
      continue;
    }
    if (ch === '?' || ch === '*' || ch === '+') {
      flush();
      const meaning = ch === '?' ? '零次或一次（量词/非贪婪标记）' : ch === '*' ? '零次或多次' : '一次或多次';
      out.push({ token: ch, meaning, indent });
      i += 1;
      continue;
    }
    if (ch === '^' || ch === '$') {
      flush();
      out.push({ token: ch, meaning: ch === '^' ? '匹配文本开头' : '匹配文本结尾', indent });
      i += 1;
      continue;
    }
    if (ch === '.') {
      flush();
      out.push({ token: '.', meaning: '任意字符（除换行）', indent });
      i += 1;
      continue;
    }
    if (ch === '|') {
      flush();
      out.push({ token: '|', meaning: '或（匹配左边或右边）', indent });
      i += 1;
      continue;
    }
    literalRun += ch;
    i += 1;
  }
  flush();
  return out;
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
      ? { confidence: 0.9, reason: '检测到 /pattern/flags 正则表达式', suggestedAction: 'test' }
      : null;
  },
  execute(_actionId, input, options = {}): PluginResult {
    const literal = parseLiteral(input);
    const pattern = options.pattern || literal?.pattern || '';
    const flags = options.flags || literal?.flags || 'g';
    const text = literal ? literal.text : input;
    if (!pattern) throw new Error('请先输入正则表达式');
    // 灾难性回溯会卡死主线程且无法被 Promise 超时打断，限制输入/表达式大小
    if (text.length > 1_000_000) throw new Error('输入文本过大（超过 100 万字符），请缩小范围后重试');
    if (pattern.length > 2_000) throw new Error('正则表达式过长（超过 2000 字符）');
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
        const tokens = explainRegexTokens(pattern);
        const lines = tokens.length
          ? tokens.map((t) => `${'  '.repeat(t.indent)}${t.token}  →  ${t.meaning}`).join('\n')
          : '未检测到特殊结构，整体为字面量匹配';
        return {
          output: `表达式：/${pattern}/${flags}\n\n${lines}`,
          language: 'text',
          summary: '已解释正则结构',
          meta: { 表达式: `/${pattern}/${flags}`, 结构: tokens.length },
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
