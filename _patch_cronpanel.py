# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

p = Path(r"D:\work\spurh\src\lib\panels\CronPanel.svelte")
text = p.read_text(encoding="utf-8")
orig = text

# 1) script：EXAMPLES + applyExample（插在 toggleWeekday 前）
old_fn = """  function toggleWeekday(value: string): void {"""
new_fn = """  const EXAMPLES = [
    { label: '每分钟', expr: '* * * * *' },
    { label: '每 5 分钟', expr: '*/5 * * * *' },
    { label: '每 10 秒', expr: '*/10 * * * * *' },
    { label: '每小时', expr: '0 * * * *' },
    { label: '每天 09:00', expr: '0 9 * * *' },
    { label: '工作日 09:30', expr: '30 9 * * 1-5' },
    { label: '每周一 09:00', expr: '0 9 * * 1' },
    { label: '每月 1 号 00:00', expr: '0 0 1 * *' },
  ];

  function applyExample(expr: string): void {
    onChangeOption('type', 'custom');
    onChangeOption('customExpr', expr);
  }

  function toggleWeekday(value: string): void {"""
assert old_fn in text, "fn anchor not found"
text = text.replace(old_fn, new_fn)

# 2) 模板：示例区（配置标题前）
old_tpl = """      <div class="cron-sec-title"><b>配置</b><small>调整后实时生成表达式</small></div>"""
new_tpl = """      <div class="cron-examples">
        <span>试试</span>
        {#each EXAMPLES as ex}
          <button class:active={type === 'custom' && (session.options.customExpr || '').trim() === ex.expr} title={ex.expr} onclick={() => applyExample(ex.expr)}>{ex.label}</button>
        {/each}
      </div>

      <div class="cron-sec-title"><b>配置</b><small>调整后实时生成表达式</small></div>"""
assert old_tpl in text, "tpl anchor not found"
text = text.replace(old_tpl, new_tpl)

# 3) CSS：追加到 style 块末尾（用 </style> 前锚点）
css_anchor = "</style>"
css_add = """  .cron-examples { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 0 2px; }
  .cron-examples > span { color: var(--muted-2); font-size: 11px; }
  .cron-examples button { height: 24px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: 10.5px; border: 1px dashed var(--line-2); border-radius: 12px; background: transparent; white-space: nowrap; }
  .cron-examples button:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); }
  .cron-examples button.active { color: #fff; border-color: transparent; background: var(--btn-gradient); }
</style>"""
assert css_anchor in text, "css anchor not found"
text = text.replace(css_anchor, css_add, 1)

p.write_text(text, encoding="utf-8", newline="")
print("CronPanel OK")