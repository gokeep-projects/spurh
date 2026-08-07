# -*- coding: utf-8 -*-
from pathlib import Path
p = Path(r"D:\work\spurh\src\App.svelte")
t = p.read_text(encoding="utf-8")
old = "  let hideInputPane = $derived(activePluginId === 'spurh.timestamp' && activeSession.actionId === 'to-unix' || activeSession.actionId === 'now');"
new = "  // 时间戳面板自带紧凑输入控件，所有模式都隐藏通用大输入框\n  let hideInputPane = $derived(activePluginId === 'spurh.timestamp');"
assert old in t, "not found"
p.write_text(t.replace(old, new), encoding="utf-8", newline="")
print("OK")