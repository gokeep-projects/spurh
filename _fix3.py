# -*- coding: utf-8 -*-
from pathlib import Path
p = Path(r"D:\work\spurh\src\lib\panels\TimestampPanel.svelte")
t = p.read_text(encoding="utf-8")
old = "  .ts-now svg { width: 13px; height: 13px; }"
new = "  :global(.ts-now svg) { width: 13px; height: 13px; }"
assert old in t
p.write_text(t.replace(old, new), encoding="utf-8", newline="")
print("OK")