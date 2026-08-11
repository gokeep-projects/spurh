# -*- coding: utf-8 -*-
import io, glob, sys
sys.stdout.reconfigure(encoding='utf-8')
moji = set('宸杩鏂浼绠鍒鍔鎺娴璇鏉瀛閿鐢闂鍙鍥剧粺缂撳瓨鍒涘缓鑾峰彇鏄剧ず閫夋嫨杈撳叆杈撳嚭杩炴帴鍒嗙寮鍝佺被鍒嗙粍淇濆瓨鍒犻櫎')
def check(p):
    s = io.open(p, encoding='utf-8').read()
    n = sum(1 for c in s if c in moji)
    bad_lines = []
    for i, line in enumerate(s.split('\n'), 1):
        cnt = sum(1 for c in line if c in moji)
        if cnt >= 3 and len(line) < 200:
            bad_lines.append((i, cnt, line.strip()[:70]))
    return n, bad_lines[:3]
files = ['src/App.svelte', 'src/styles.css'] + glob.glob('src/lib/**/*.svelte', recursive=True) + glob.glob('src/lib/**/*.ts', recursive=True)
for p in files:
    n, bl = check(p)
    if n > 20 or bl:
        print(p, 'moji_count=', n)
        for i, c, t in bl:
            print('   L%d (%d): %s' % (i, c, t.encode('unicode_escape').decode()))
