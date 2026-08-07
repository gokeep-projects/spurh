# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
p = Path(r"D:\work\spurh\src\lib\plugins\builtin\regex.ts")
t = p.read_text(encoding="utf-8")
t = t.replace("if (/^\\\\?<[A-Za-z_]\\\\w*>/.test(rest)) {", "if (/^\\?<[A-Za-z_]\\w*>/.test(rest)) {")
t = t.replace("const name = rest.match(/^\\\\?<([A-Za-z_]\\\\w*)>/)?.[1] ?? '';", "const name = rest.match(/^\\?<([A-Za-z_]\\w*)>/)?.[1] ?? '';")
p.write_text(t, encoding="utf-8", newline="")
print("fixed named-group regex")
# 校验
print("line:", [l for l in t.splitlines() if "命名分组" in l])