# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

p = Path(r"D:\work\spurh\src\lib\plugins\builtin\regex.ts")
text = p.read_text(encoding="utf-8")
orig = text

# 1) 新增 token 级解释函数（放在 parseLiteral 之后）
anchor = """export const regexPlugin: SpurhPlugin = {"""
new_fn = """export type RegexToken = { token: string; meaning: string; indent: number };

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
    n: '换行符', r: '回车符', t: '制表符', '\\\\': '反斜杠',
  };
  while (i < pattern.length) {
    const ch = pattern[i];
    const rest = pattern.slice(i + 1);
    if (ch === '\\\\') {
      flush();
      const esc = pattern[i + 1] ?? '';
      if (esc === 'u') {
        const hex = pattern.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out.push({ token: `\\\\u${hex}`, meaning: `Unicode 字符 U+${hex.toUpperCase()}`, indent }); i += 6; continue; }
      }
      if (esc === 'x') {
        const hex = pattern.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out.push({ token: `\\\\x${hex}`, meaning: `十六进制字符 0x${hex}`, indent }); i += 4; continue; }
      }
      if (/[1-9]/.test(esc)) { out.push({ token: `\\\\${esc}`, meaning: `反向引用第 ${esc} 个分组`, indent }); i += 2; continue; }
      out.push({ token: `\\\\${esc || '\\\\'}`, meaning: escMeanings[esc] ?? (esc ? `转义字符 ${esc}` : '转义反斜杠'), indent });
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
      if (/^\\?<[A-Za-z_]\\w*>/.test(rest)) {
        const name = rest.match(/^\\?<([A-Za-z_]\\w*)>/)?.[1] ?? '';
        out.push({ token: `(?<${name}>`, meaning: `命名分组 ${name}`, indent });
        i += 3 + name.length;
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
      const m = pattern.slice(i).match(/^\\{(\\d+)(,\\d*)?\\}/);
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

export const regexPlugin: SpurhPlugin = {"""
assert anchor in text, "plugin anchor not found"
text = text.replace(anchor, new_fn)

# 2) explain 分支改用 token 解析
old_explain = """      if (_actionId === 'explain') {
        const rules: Array<[RegExp, string]> = [
          [/\\\\b/g, '单词边界'], [/\\\\B/g, '非单词边界'],
          [/\\^/g, '匹配文本开头'], [/\\$/g, '匹配文本结尾'],
          [/\\./g, '匹配任意字符（除换行）'], [/\\\\d/g, '匹配数字'], [/\\\\D/g, '匹配非数字'],
          [/\\\\w/g, '匹配字母、数字或下划线'], [/\\\\W/g, '匹配非单词字符'],
          [/\\\\s/g, '匹配空白字符'], [/\\\\S/g, '匹配非空白字符'],
          [/\\\\n/g, '换行符'], [/\\\\r/g, '回车符'], [/\\\\t/g, '制表符'],
          [/\\\\u/g, 'Unicode 字符'], [/\\\\x/g, '十六进制字符'],
          [/\\[[^\\]]*\\]/g, '字符集（如 [a-z]）'], [/\\([^)]*\\)/g, '分组'],
          [/\\?:/g, '非捕获分组'], [/\\?=/g, '正向先行断言'], [/\\?!/g, '负向先行断言'],
          [/\\(\\?<=/g, '正向后行断言'], [/\\(\\?<!/g, '负向后行断言'],
          [/\\|/g, '或（匹配左边或右边）'], [/\\?/g, '可选或非贪婪'],
          [/\\*/g, '重复零次或多次'], [/\\+/g, '重复一次或多次'],
          [/\\{\\d+(,\\d*)?\\}/g, '指定重复次数'], [/\\\\([1-9])/g, '反向引用'],
        ];
        const explained = rules.filter(([rule]) => rule.test(pattern)).map(([, meaning]) => meaning);
        const tokens = explained.length ? [...new Set(explained)].join('、') : '未检测到特殊结构，是字面量匹配';
        return {
          output: `表达式：/${pattern}/${flags}\\n\\n${tokens}`,
          language: 'text',
          summary: '已解释正则结构',
          meta: { 表达式: `/${pattern}/${flags}`, 结构: explained.length },
        };
      }"""
new_explain = """      if (_actionId === 'explain') {
        const tokens = explainRegexTokens(pattern);
        const lines = tokens.length
          ? tokens.map((t) => `${'  '.repeat(t.indent)}${t.token}  →  ${t.meaning}`).join('\\n')
          : '未检测到特殊结构，整体为字面量匹配';
        return {
          output: `表达式：/${pattern}/${flags}\\n\\n${lines}`,
          language: 'text',
          summary: '已解释正则结构',
          meta: { 表达式: `/${pattern}/${flags}`, 结构: tokens.length },
        };
      }"""
assert old_explain in text, "explain branch not found"
text = text.replace(old_explain, new_explain)

p.write_text(text, encoding="utf-8", newline="")
print("regex.ts OK")