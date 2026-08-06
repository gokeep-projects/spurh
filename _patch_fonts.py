# -*- coding: utf-8 -*-
import re, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

def bump_fonts(text):
    # 按降序提升字号，避免连锁
    steps = [("11.5px", "12.5px"), ("10.5px", "11.5px"), ("9.5px", "11px")]
    for a, b in steps:
        text = text.replace(a, b)
    text = re.sub(r"(?<![\d.])9px", "10.5px", text)
    text = re.sub(r"(?<![\d.])8.5px", "10px", text)
    return text

# 1) styles.css
p = Path(r"D:\work\spurh\src\styles.css")
text = p.read_text(encoding="utf-8")
before = text
text = text.replace(".dispatch-matches { position: absolute; z-index: 10;", ".dispatch-matches { position: absolute; z-index: 1000;")
text = text.replace(".app-bar {\n  min-width: 0;", ".app-bar {\n  position: relative;\n  z-index: 100;\n  min-width: 0;")
text = bump_fonts(text)
p.write_text(text, encoding="utf-8", newline="")
print("styles.css:", "changed" if text != before else "NO CHANGE", "| z10->1000:", "z-index: 1000" in text)

# 2) 所有 .svelte 面板组件
root = Path(r"D:\work\spurh\src")
changed_files = []
for f in root.rglob("*.svelte"):
    t = f.read_text(encoding="utf-8")
    t2 = bump_fonts(t)
    if t2 != t:
        f.write_text(t2, encoding="utf-8", newline="")
        changed_files.append(str(f))
print("bumped files:", len(changed_files))
for f in changed_files: print("  ", f)