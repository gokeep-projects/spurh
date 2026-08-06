# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

p = Path(r"D:\work\spurh\src\lib\plugins\builtin\random.ts")
text = p.read_text(encoding="utf-8")
orig = text

# 1) options 增加大小写选项（密码/随机字符）
old_opts = """    { id: 'length', label: '长度', type: 'select', defaultValue: '24', actions: ['password', 'string', 'hex'], choices: LENGTH_CHOICES },
    { id: 'count', label: '数量', type: 'select', defaultValue: '1', choices: COUNT_CHOICES },"""
new_opts = """    { id: 'length', label: '长度', type: 'select', defaultValue: '24', actions: ['password', 'string', 'hex'], choices: LENGTH_CHOICES },
    { id: 'count', label: '数量', type: 'select', defaultValue: '1', choices: COUNT_CHOICES },
    { id: 'caseType', label: '大小写', type: 'select', defaultValue: 'mixed', actions: ['password', 'string'], choices: [
      { value: 'mixed', label: '大小写混合' },
      { value: 'upper', label: '仅大写' },
      { value: 'lower', label: '仅小写' },
      { value: 'digits', label: '仅数字' },
    ] },"""
assert old_opts in text, "opts not found"
text = text.replace(old_opts, new_opts)

# 2) execute：按 caseType 选择字符集
old_exec = """    const values = Array.from({ length: count }, () => {
      if (actionId === 'uuid') return crypto.randomUUID();
      if (actionId === 'ulid') return ulid();
      if (actionId === 'hex') return secureString(length, HEX);
      if (actionId === 'color') {
        const bytes = crypto.getRandomValues(new Uint8Array(3));
        return '#' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      }"""
new_exec = """    // 大小写策略：控制密码 / 随机字符的字符集
    const caseType = options.caseType || 'mixed';
    const baseAlphabet = actionId === 'password' ? PASSWORD : ALPHANUMERIC;
    const alphabet = caseType === 'upper'
      ? baseAlphabet.replace(/[a-z]/g, '')
      : caseType === 'lower'
        ? baseAlphabet.replace(/[A-Z]/g, '')
        : caseType === 'digits'
          ? '23456789'
          : baseAlphabet;
    const values = Array.from({ length: count }, () => {
      if (actionId === 'uuid') return crypto.randomUUID();
      if (actionId === 'ulid') return ulid();
      if (actionId === 'hex') return secureString(length, HEX);
      if (actionId === 'color') {
        const bytes = crypto.getRandomValues(new Uint8Array(3));
        return '#' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      }"""
assert old_exec in text, "exec not found"
text = text.replace(old_exec, new_exec)

# 3) 生成主体：color 收集为数组；其余用 alphabet；返回 colors 视图
old_gen = """      return secureString(length, actionId === 'password' ? PASSWORD : ALPHANUMERIC);
    });
    return {
      output: values.join('\\n'),
      language: 'text',
      view: 'list',
      data: values,
      summary: `已安全生成 ${values.length} 个结果`,
      meta: { 数量: values.length, ...(actionId === 'uuid' ? {} : { 长度: length }), 随机源: 'Web Crypto' },
    };"""
new_gen = """      return secureString(length, alphabet);
    });
    const isColors = actionId === 'color';
    return {
      output: values.join('\\n'),
      language: 'text',
      view: isColors ? 'colors' : 'list',
      data: values,
      summary: isColors
        ? `已生成 ${values.length} 个颜色值`
        : `已安全生成 ${values.length} 个结果`,
      meta: { 数量: values.length, ...(actionId === 'uuid' || isColors ? {} : { 长度: length }), 随机源: 'Web Crypto' },
    };"""
assert old_gen in text, "gen not found"
text = text.replace(old_gen, new_gen)

p.write_text(text, encoding="utf-8", newline="")
print("random.ts OK")