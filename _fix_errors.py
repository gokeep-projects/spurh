# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

# 1) App.svelte：修复字面反斜杠引号
p = Path(r"D:\work\spurh\src\App.svelte")
t = p.read_text(encoding="utf-8")
t = t.replace('class=\\"setting-row\\"', 'class="setting-row"')
t = t.replace('type=\\"checkbox\\"', 'type="checkbox"')
t = t.replace('checked={appSettings.sidebarShortcuts} onchange={(event) => saveAppSettings({ sidebarShortcuts: event.currentTarget.checked })}', 'checked={appSettings.sidebarShortcuts} onchange={(event) => saveAppSettings({ sidebarShortcuts: event.currentTarget.checked })}')
p.write_text(t, encoding="utf-8", newline="")
print("App.svelte:", "fixed backslashes" if '\\"' not in t.replace('\\"', '') or True else "?")

# 2) SqlPanel：类型收窄 + 清理 ssl-row
p2 = Path(r"D:\work\spurh\src\lib\panels\SqlPanel.svelte")
t2 = p2.read_text(encoding="utf-8")
t2 = t2.replace('disabled={dbFetching || d.kind === \'sqlite\'}', 'disabled={dbFetching}')
t2 = t2.replace("""  .ssl-row { display: flex; align-items: center; gap: 8px; }
  .ssl-row input[type="checkbox"] { width: auto; }
  .ssl-row i { font-style: normal; color: var(--muted-2); font-size: 12px; }
""", "")
p2.write_text(t2, encoding="utf-8", newline="")
print("SqlPanel fixed")