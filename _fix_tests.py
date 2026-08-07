# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

p = Path(r"D:\work\spurh\src\lib\plugins\runtime.test.ts")
t = p.read_text(encoding="utf-8")

# 1) 适配 token 级解释：纯字面量现在输出 字面量文本
old = """    const plain = await runtime.execute('spurh.regex', 'explain', 'abc', { pattern: 'abc', flags: 'g' });
    expect(plain.output).toContain('未检测到特殊结构');
  });"""
new = """    const plain = await runtime.execute('spurh.regex', 'explain', 'abc', { pattern: 'abc', flags: 'g' });
    expect(plain.output).toContain('字面量文本');
    // 命名分组与量词逐项解释
    const named = await runtime.execute('spurh.regex', 'explain', 'abc', { pattern: '(?<year>\\\\d{4})', flags: 'g' });
    expect(named.output).toContain('命名分组 year');
    expect(named.output).toContain('重复 4 次');
  });"""
assert old in t, "explain test not found"
t = t.replace(old, new)

# 2) ResultView 覆盖清单加 colors
old2 = "    const supported = new Set(['timestamp', 'http', 'jwt', 'stats', 'matches', 'list', 'hash', 'sql', 'log', 'code', 'text', '']);"
new2 = "    const supported = new Set(['timestamp', 'http', 'jwt', 'stats', 'matches', 'list', 'hash', 'sql', 'log', 'colors', 'code', 'text', '']);"
assert old2 in t, "views test not found"
t = t.replace(old2, new2)

p.write_text(t, encoding="utf-8", newline="")
print("runtime.test.ts OK")