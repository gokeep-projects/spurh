# -*- coding: utf-8 -*-
import re, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

p = Path(r"D:\work\spurh\src\App.svelte")
text = p.read_text(encoding="utf-8")

old = """  /** Tab 键插入缩进而不是移出焦点 */
  function handleInputKeys(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.ctrlKey && activePluginId === 'spurh.sql') {
      event.preventDefault();
      runSql();
      return;
    }
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const target = event.currentTarget as HTMLTextAreaElement;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    changeInput(target.value.slice(0, start) + '  ' + target.value.slice(end));
    // 受控组件更新后恢复光标位置
    requestAnimationFrame(() => {
      target.selectionStart = target.selectionEnd = start + 2;
    });
  }"""

new = """  /** 编辑器键位：Tab 缩进（Shift+Tab 反缩进）、Enter 延续缩进、括号/引号自动闭合 */
  function handleInputKeys(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.ctrlKey && activePluginId === 'spurh.sql') {
      event.preventDefault();
      runSql();
      return;
    }
    const target = event.currentTarget as HTMLTextAreaElement;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const value = target.value;

    if (event.key === 'Tab') {
      event.preventDefault();
      if (start === end) {
        // 单点：插入两个空格
        changeInput(value.slice(0, start) + '  ' + value.slice(end));
        requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2; });
        return;
      }
      // 多行选区：整块缩进 / 反缩进
      const lineStart = value.lastIndexOf('\\n', start - 1) + 1;
      const lineEndIdx = value.indexOf('\\n', end);
      const blockEnd = lineEndIdx < 0 ? value.length : lineEndIdx;
      const block = value.slice(lineStart, blockEnd);
      const next = block.split('\\n').map((line) =>
        event.shiftKey
          ? (line.startsWith('  ') ? line.slice(2) : line.startsWith(' ') ? line.slice(1) : line)
          : '  ' + line,
      ).join('\\n');
      changeInput(value.slice(0, lineStart) + next + value.slice(blockEnd));
      requestAnimationFrame(() => { target.selectionStart = lineStart; target.selectionEnd = lineStart + next.length; });
      return;
    }

    if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const lineStart = value.lastIndexOf('\\n', start - 1) + 1;
      const lineText = value.slice(lineStart, start);
      const indentMatch = lineText.match(/^[\\t ]*/);
      const indent = indentMatch ? indentMatch[0] : '';
      // 行尾是开放括号 / 冒号时追加一级缩进（JSON、对象字面量场景）
      const extra = /[{[(]$/.test(lineText.trimEnd()) ? '  ' : '';
      const insert = '\\n' + indent + extra;
      changeInput(value.slice(0, start) + insert + value.slice(end));
      requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + insert.length; });
      return;
    }

    // 括号 / 引号自动闭合
    const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const openChar = PAIRS[event.key];
      if (openChar) {
        event.preventDefault();
        changeInput(value.slice(0, start) + event.key + openChar + value.slice(end));
        requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 1; });
        return;
      }
      const isCloser = Object.values(PAIRS).includes(event.key);
      if (isCloser && value[start] === event.key) {
        // 下一个字符就是配对的闭合符号：跳过而不是重复输入
        event.preventDefault();
        target.selectionStart = target.selectionEnd = start + 1;
        return;
      }
    }
  }"""

if old not in text:
    print("MISS: handleInputKeys pattern not found")
    idx = text.find("function handleInputKeys")
    print("actual idx:", idx)
    if idx >= 0:
        print(repr(text[idx:idx+600]))
else:
    text = text.replace(old, new)
    p.write_text(text, encoding="utf-8", newline="")
    print("OK: handleInputKeys upgraded")