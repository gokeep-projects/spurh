# -*- coding: utf-8 -*-
import sys, re
sys.stdout.reconfigure(encoding='utf-8')
p = r"D:\work\spurh\src\App.svelte"
raw = open(p, encoding='utf-8').read()

# 1) Tab 深度感知 + 2) 自动闭合：插在 handleInputKeys 开头（isComposing 检查之后）
old = """    const target = event.currentTarget as HTMLTextAreaElement;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const value = target.value;

    if (event.key === 'Tab') {
      event.preventDefault();
      if (start === end) {
        // 单点：插入两个空格
        changeInput(value.slice(0, start) + '  ' + value.slice(end));
        flushSync();
        target.selectionStart = target.selectionEnd = start + 2;
        return;
      }"""
new = """    const target = event.currentTarget as HTMLTextAreaElement;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const value = target.value;

    // 括号/引号自动闭合（JSON 工具）：输入 { [ ( 自动补配对符并居中，引号在单词后不补
    if (event.key.length === 1 && start === end && !event.ctrlKey && !event.metaKey && !event.altKey && activePluginId === 'spurh.json') {
      const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')', '"': '"', "'": "'" };
      const closer = PAIRS[event.key];
      if (closer) {
        const nextChar = value[end] ?? '';
        const prevChar = value[start - 1] ?? '';
        if (event.key === '"' || event.key === "'") {
          if (/[\\w\\u4e00-\\u9fff]/.test(prevChar)) return; // 单词/中文后不自动补引号
          if (nextChar === closer) { // 已配对：跳过闭合符
            event.preventDefault();
            target.selectionStart = target.selectionEnd = end + 1;
            return;
          }
        } else if (nextChar === closer) {
          return; // 已有闭合符（如补全后再次输入）不重复补
        }
        event.preventDefault();
        changeInput(value.slice(0, start) + event.key + closer + value.slice(end));
        flushSync();
        target.selectionStart = target.selectionEnd = start + 1;
        return;
      }
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      if (start === end) {
        // 单点：行首按结构深度对齐，行中插入两个空格
        const lineStart = value.lastIndexOf('\\n', start - 1) + 1;
        const linePrefix = value.slice(lineStart, start);
        if (/^[\\t ]*$/.test(linePrefix) && (activePluginId === 'spurh.json' || activePluginId === 'spurh.sql')) {
          const depthOf = (src: string): number => {
            let d = 0;
            for (const ch of src) {
              if (ch === '{' || ch === '[' || ch === '(') d++;
              else if (ch === '}' || ch === ']' || ch === ')') d = Math.max(0, d - 1);
            }
            return d;
          };
          const stripStr = (src: string): string => src.replace(/"(\\\\.|[^"\\\\])*"/g, '');
          const dLine = depthOf(stripStr(value.slice(0, lineStart)));
          const targetIndent = '  '.repeat(dLine + 1);
          if (linePrefix.length !== targetIndent.length) {
            changeInput(value.slice(0, lineStart) + targetIndent + value.slice(start));
            flushSync();
            target.selectionStart = target.selectionEnd = lineStart + targetIndent.length;
            return;
          }
        }
        changeInput(value.slice(0, start) + '  ' + value.slice(end));
        flushSync();
        target.selectionStart = target.selectionEnd = start + 2;
        return;
      }"""
assert old in raw, "tab block not found"
raw = raw.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='\n').write(raw)
print("editor auto-close + smart tab added")
