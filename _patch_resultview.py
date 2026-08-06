# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

p = Path(r"D:\work\spurh\src\lib\components\ResultView.svelte")
text = p.read_text(encoding="utf-8")
orig = text

# 模板：插入 colors 视图（在 hash 视图分支后）
anchor = """  {:else if result.view === 'hash' && Object.keys(data).length}
    <div class="hash-card">
      <div><small>{display(data.algorithm)}</small><span>{display(data.bits)} 位摘要</span></div>
      <code>{display(data.digest ?? result.output)}</code>
      <div class="hash-copy"><button class="copy-btn" onclick={() => copyText(display(data.digest ?? result.output), 'hash')}>{copiedKey === 'hash' ? '已复制 ✓' : '复制摘要'}</button></div>
    </div>
  {:else if result.view === 'sql'"""
new_block = """  {:else if result.view === 'hash' && Object.keys(data).length}
    <div class="hash-card">
      <div><small>{display(data.algorithm)}</small><span>{display(data.bits)} 位摘要</span></div>
      <code>{display(data.digest ?? result.output)}</code>
      <div class="hash-copy"><button class="copy-btn" onclick={() => copyText(display(data.digest ?? result.output), 'hash')}>{copiedKey === 'hash' ? '已复制 ✓' : '复制摘要'}</button></div>
    </div>
  {:else if result.view === 'colors' && items.length}
    <div class="color-grid">
      {#each items as item, index}
        {@const hex = String(item).trim()}
        {@const valid = /^#[0-9a-f]{6}$/i.test(hex)}
        <article>
          <span class="color-swatch" style={valid ? `background: ${hex}` : 'background: repeating-conic-gradient(#232a37 0% 25%, #171c27 0% 50%) 0 0 / 12px 12px'}></span>
          <code>{hex}</code>
          <button class="copy-btn" onclick={() => copyText(hex, `c${index}`)}>{copiedKey === `c${index}` ? '已复制 ✓' : '复制'}</button>
        </article>
      {/each}
    </div>
  {:else if result.view === 'sql'"""
assert anchor in text, "anchor not found"
text = text.replace(anchor, new_block)

# CSS：在 style 块内追加
css_anchor = "  @media (max-width: 900px) { .jwt-sections { grid-template-columns: 1fr; } .stats-grid { grid-template-columns: repeat(2, 1fr); } }"
css_add = """  .color-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 10px; }
  .color-grid article { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .color-swatch { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 9px; border: 1px solid var(--line-2); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .07); }
  .color-grid code { flex: 1; min-width: 0; color: var(--text); font: 500 12.5px 'Cascadia Code', monospace; overflow-wrap: anywhere; }
  @media (max-width: 900px) { .jwt-sections { grid-template-columns: 1fr; } .stats-grid { grid-template-columns: repeat(2, 1fr); } }"""
assert css_anchor in text, "css anchor not found"
text = text.replace(css_anchor, css_add)

p.write_text(text, encoding="utf-8", newline="")
print("ResultView OK")