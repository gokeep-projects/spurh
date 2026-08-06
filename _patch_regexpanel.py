# -*- coding: utf-8 -*-
import sys, json
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

p = Path(r"D:\work\spurh\src\lib\panels\RegexPanel.svelte")
lines = p.read_text(encoding="utf-8").split("\n")
orig = "\n".join(lines)

# 找到 PRESETS 数组的行范围
start = next(i for i, l in enumerate(lines) if "const PRESETS:" in l)
end = next(i for i, l in enumerate(lines) if l.strip() == "];" and i > start)

new_presets = '''  const PRESETS: Array<{ label: string; pattern: string; flags?: string }> = [
    { label: '邮箱', pattern: '[\\\\w.+-]+@[\\\\w-]+(?:\\\\.[\\\\w-]+)+' },
    { label: 'URL', pattern: 'https?://[\\\\w\\\\-._~:/?#\\\\[\\\\]@!$&\\'()*+,;=%]+' },
    { label: '手机号', pattern: '1[3-9]\\\\d{9}' },
    { label: 'IPv4', pattern: '(?:\\\\d{1,3}\\\\.){3}\\\\d{1,3}' },
    { label: 'IPv6', pattern: '(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}' },
    { label: 'MAC 地址', pattern: '(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}' },
    { label: 'UUID', pattern: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' },
    { label: '日期', pattern: '\\\\d{4}-\\\\d{2}-\\\\d{2}' },
    { label: '日期时间', pattern: '\\\\d{4}-\\\\d{2}-\\\\d{2}[ T]\\\\d{2}:\\\\d{2}(?::\\\\d{2})?' },
    { label: '时间', pattern: '\\\\d{2}:\\\\d{2}(?::\\\\d{2})?' },
    { label: '13 位时间戳', pattern: '\\\\d{13}' },
    { label: 'IP:端口', pattern: '(?:\\\\d{1,3}\\\\.){3}\\\\d{1,3}:\\\\d{2,5}' },
    { label: '16 进制色值', pattern: '#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?' },
    { label: '中文', pattern: '[\\\\u4e00-\\\\u9fa5]+' },
    { label: '英文单词', pattern: '\\\\b[A-Za-z]+\\\\b' },
    { label: '驼峰命名', pattern: '\\\\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\\\\b' },
    { label: '引号内容', pattern: '"[^"]*"|\\'[^\\']*\\'' },
    { label: 'HTML 标签', pattern: '<[^>]+>' },
    { label: '空白行', pattern: '^\\\\s*$', flags: 'gm' },
    { label: '注释', pattern: '//[^\\n]*|/\\\\*[\\\\s\\\\S]*?\\\\*/' },
    { label: '文件扩展名', pattern: '\\\\.(?:json|txt|log|js|ts|py|rs|sql|md)$', flags: 'gim' },
    { label: 'Windows 路径', pattern: '[A-Za-z]:\\\\\\\\[^\\"<>|?*]+' },
    { label: 'JSON 键', pattern: '"[^"]*"\\\\s*:' },
    { label: '重复单词', pattern: '\\\\b(\\\\w+)\\\\s+\\\\1\\\\b' },
  ];'''
lines[start:end+1] = new_presets.split("\n")

text = "\n".join(lines)

# 模板：常用 + 更多展开
old_tpl = """  <div class="regex-presets">
    <span>常用</span>
    <div class="preset-scroll">
      {#each PRESETS as preset}
        <button class:active={presetApplied === preset.label} title={preset.pattern} onclick={() => applyPreset(preset)}>{preset.label}</button>
      {/each}
    </div>
  </div>"""
new_tpl = """  <div class="regex-presets">
    <span>常用</span>
    <div class="preset-scroll">
      {#each (presetsAllOpen ? PRESETS : PRESETS.slice(0, PRESETS_VISIBLE)) as preset}
        <button class:active={presetApplied === preset.label} title={preset.pattern} onclick={() => applyPreset(preset)}>{preset.label}</button>
      {/each}
    </div>
    <button class="preset-more" onclick={() => (presetsAllOpen = !presetsAllOpen)} title={presetsAllOpen ? '收起' : '展开全部常用表达式'}>
      {presetsAllOpen ? '收起 ▲' : `更多 ${PRESETS.length - PRESETS_VISIBLE} ▾`}
    </button>
  </div>"""
assert old_tpl in text, "template not found"
text = text.replace(old_tpl, new_tpl)

# script：常量与状态
old_state = """  let aiDescription = $state('');
  let samples = $state<string[]>([]);"""
new_state = """  const PRESETS_VISIBLE = 8;
  let presetsAllOpen = $state(false);
  let aiDescription = $state('');
  let samples = $state<string[]>([]);"""
assert old_state in text, "state not found"
text = text.replace(old_state, new_state)

# CSS：更多按钮样式
css_anchor = """  .regex-presets button.active { color: #fff; border-color: transparent; background: var(--btn-gradient); }"""
css_new = """  .regex-presets button.active { color: #fff; border-color: transparent; background: var(--btn-gradient); }
  .regex-presets .preset-more { height: 24px; padding: 0 10px; cursor: pointer; color: var(--accent); font-size: 10px; font-weight: 600; border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--line)); border-radius: 12px; background: transparent; white-space: nowrap; }
  .regex-presets .preset-more:hover { background: var(--accent-soft); border-style: solid; }"""
assert css_anchor in text, "css not found"
text = text.replace(css_anchor, css_new)

p.write_text(text, encoding="utf-8", newline="")
print("RegexPanel OK; presets from line", start+1, "to", end+1)