# -*- coding: utf-8 -*-
import sys, re
sys.stdout.reconfigure(encoding='utf-8')
raw = open(r"D:\work\spurh\src\lib\panels\RemotePanel.svelte", encoding='utf-8').read()
for fn in ['function addSession', 'function cancelDraft', 'function saveDraft']:
    m = re.search(re.escape(fn) + r'[\s\S]*?\n  \}', raw)
    if m: print(m.group(0)[:800], "\n---")
