# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding='utf-8')
p = r"D:\work\spurh\src\lib\panels\SqlPanel.svelte"
raw = open(p, encoding='utf-8').read()
old = """            <label class="ssl-cell"><span>SSL 加密</span><span class="sql-secret ssl-secret"><label class="ssl-inline" title="SSL 加密连接（远程数据库建议开启）"><input type="checkbox" bind:checked={d.ssl} /><span>启用</span></label></span></label>"""
new = """            <div class="ssl-cell"><span>SSL 加密</span><span class="sql-secret ssl-secret"><label class="ssl-inline" title="SSL 加密连接（远程数据库建议开启）"><input type="checkbox" bind:checked={d.ssl} /><span>启用</span></label></span></div>"""
assert old in raw, "ssl label not found"
raw = raw.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='\n').write(raw)
print("ssl label fixed")
