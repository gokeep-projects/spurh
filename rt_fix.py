# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding='utf-8')
p = r"D:\work\spurh\src\lib\panels\RemotePanel.svelte"
raw = open(p, encoding='utf-8').read()
old1 = """          <span class="rs-copy"><b>{item.name || (item.user || 'root') + '@' + item.host}</b><small>{item.host}:{item.port}</small></span>"""
new1 = """          <span class="rs-copy"><b>{item.name || (item.host ? (item.user || 'root') + '@' + item.host : '新会话')}</b><small>{item.host ? item.host + ':' + item.port : '未填写主机'}</small></span>"""
assert old1 in raw
raw = raw.replace(old1, new1, 1)
# rail mini title also
old2 = """            <button class="rs-mini" class:active={activeId === item.id} onclick={() => select(item.id)} title={(item.name || item.host) + ' · ' + item.host + ':' + item.port}>"""
new2 = """            <button class="rs-mini" class:active={activeId === item.id} onclick={() => select(item.id)} title={(item.name || (item.host ? item.host : '新会话')) + (item.host ? ' · ' + item.host + ':' + item.port : '')}>"""
assert old2 in raw
raw = raw.replace(old2, new2, 1)
open(p, 'w', encoding='utf-8', newline='\n').write(raw)
print("remote session display fixed")
