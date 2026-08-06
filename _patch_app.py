# -*- coding: utf-8 -*-
import re, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

p = Path(r"D:\work\spurh\src\App.svelte")
text = p.read_text(encoding="utf-8")
orig = text
ok = []
miss = []

def rep_re(pat, new, tag, flags=0):
    global text
    text, n = re.subn(pat, new, text, flags=flags)
    if n: ok.append(f"{tag} x{n}")
    else: miss.append(tag)

# fallback 增加 sidebarShortcuts（保留原中文用 [^']+ 匹配）
rep_re(r"(      fontSize: 14, fontFamily: '[^']+',)\n    \};",
       r"\1\n      sidebarShortcuts: false,\n    };", "fallback sidebarShortcuts")
# 删除 status-bar（含中文内容，用 DOTALL 非贪婪）
rep_re(r"\n      <footer class=\"status-bar\">.*?</footer>\n", "\n", "remove status-bar", flags=re.S)
# 删除 diag-inline
rep_re(r'<small class="diag-inline">.*?</small></div>', "</div>", "remove diag-inline")
# 删除 output-empty diag
rep_re(r'<small class="diag">.*?</small></div>', "</div>", "remove output-empty diag")
# hideInputPane 扩展
rep_re(r"activeSession\.actionId === 'to-unix' && !activeSession\.input\.trim\(\)",
       "activeSession.actionId === 'to-unix' || activeSession.actionId === 'now'",
       "hideInputPane timestamp")
# 工具栏两个条件块加 timestamp 排除
rep_re(r"activePluginId !== 'spurh\.cron' && activePluginId !== 'spurh\.crypto' && activePluginId !== 'spurh\.regex'",
       "activePluginId !== 'spurh.cron' && activePluginId !== 'spurh.crypto' && activePluginId !== 'spurh.regex' && activePluginId !== 'spurh.timestamp'",
       "tool-controls timestamp exclusion")
# 设置：菜单栏快捷键开关（插在剪贴板历史行后，用 ASCII 锚点保留中文）
rep_re(r"(<label class=\"setting-row\"><div class=\"setting-copy\"><b>剪贴板历史</b>.*?</label>)",
       r"\1\n              <label class=\"setting-row\"><div class=\"setting-copy\"><b>菜单栏显示快捷键</b><small>在左侧工具列表显示 Alt+1..9 快捷提示（默认隐藏）</small></div><input type=\"checkbox\" checked={appSettings.sidebarShortcuts} onchange={(event) => saveAppSettings({ sidebarShortcuts: event.currentTarget.checked })} /><i></i></label>",
       "settings sidebarShortcuts", flags=re.S)

if text != orig:
    p.write_text(text, encoding="utf-8", newline="")
print("OK:", ok)
print("MISS:", miss)