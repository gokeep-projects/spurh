# -*- coding: utf-8 -*-
from pathlib import Path
p = Path(r"D:\work\spurh\src\lib\plugins\builtin\regex.ts")
t = p.read_text(encoding="utf-8")
old = "        i += 3 + name.length;"
new = "        i += 4 + name.length; // (?<name> 共 4 + name.length 个字符"
assert old in t
t = t.replace(old, new + ")")
p.write_text(t, encoding="utf-8", newline="")
print("fixed")