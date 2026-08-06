# -*- coding: utf-8 -*-
import sys, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

# 1) types.ts：view 联合类型加 colors
p = Path(r"D:\work\spurh\src\lib\plugins\types.ts")
t = p.read_text(encoding="utf-8")
old = "  view?: 'code' | 'text' | 'timestamp' | 'jwt' | 'hash' | 'matches' | 'stats' | 'list' | 'http' | 'sql' | 'log';"
new = "  view?: 'code' | 'text' | 'timestamp' | 'jwt' | 'hash' | 'matches' | 'stats' | 'list' | 'http' | 'sql' | 'log' | 'colors';"
assert old in t, "types view not found"
p.write_text(t.replace(old, new), encoding="utf-8", newline="")
print("types.ts OK")

# 2) App.svelte：清除设置行残留的字面反斜杠引号
p2 = Path(r"D:\work\spurh\src\App.svelte")
t2 = p2.read_text(encoding="utf-8")
t2 = t2.replace('\\"', '"')
p2.write_text(t2, encoding="utf-8", newline="")
print("App.svelte backslashes cleared:", '\\"' not in t2)