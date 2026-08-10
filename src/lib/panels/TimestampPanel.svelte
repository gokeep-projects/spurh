<script lang="ts">
  import { UI_ICONS } from '../icons';
  import type { PluginResult } from '../plugins/types';
  import { timestampPlugin } from '../plugins/builtin/timestamp';

  let { session, onChangeAction, onChangeOption, onChangeInput, onClear }: {
    session: { actionId: string; options: Record<string, string>; input: string; result: PluginResult | null; error: string; processing: boolean };
    onChangeAction: (id: string) => void;
    onChangeOption: (id: string, v: string) => void;
    onChangeInput: (v: string) => void;
    onClear: () => void;
  } = $props();

  const MODES = [
    { id: 'now', label: '当前时间', desc: '此刻的时间与 Unix 时间戳' },
    { id: 'to-date', label: '时间戳 → 日期', desc: '输入秒 / 毫秒时间戳' },
    { id: 'to-unix', label: '日期 → 时间戳', desc: '选择或填入日期时间' },
  ] as const;

  function nowValue(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 常用时间快捷预设：统一由 presetValue() 计算值，保证高亮与回填一致 */
  function presetValue(kind: string): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const fmt = (date: Date) => `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T00:00`;
    if (kind === 'now') return nowValue();
    if (kind === 'today') return fmt(d);
    if (kind === 'tomorrow') { const t = new Date(d); t.setDate(t.getDate() + 1); return fmt(t); }
    if (kind === 'thisWeek') {
      const monday = new Date(d);
      const day = (d.getDay() + 6) % 7;
      monday.setDate(d.getDate() - day);
      return fmt(monday);
    }
    if (kind === 'thisMonth') return fmt(new Date(d.getFullYear(), d.getMonth(), 1));
    if (kind === 'thisYear') return fmt(new Date(d.getFullYear(), 0, 1));
    return '';
  }

  /** 文本输入日期 → 写回 pickDateTime（YYYY-MM-DDTHH:mm），支持多种写法 */
  function parseDateTimeText(value: string): void {
    const m = value.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (!m) return;
    const p = (n: number) => String(n).padStart(2, '0');
    const norm = `${m[1]}-${p(Number(m[2]))}-${p(Number(m[3]))}T${p(Number(m[4] ?? 0))}:${p(Number(m[5] ?? 0))}`;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
    if (Number.isNaN(d.getTime())) return;
    onChangeOption('pickDateTime', norm);
  }
  /** 把 pickDateTime 转成给人看的文本 */
  function pickText(): string {
    const raw = session.options.pickDateTime || '';
    return raw.replace('T', ' ');
  }

  function quickPick(kind: string): void {
    const value = presetValue(kind);
    if (value) onChangeOption('pickDateTime', value);
  }

  const QUICK_PRESETS = [
    { id: 'now', label: '现在' },
    { id: 'today', label: '今天零点' },
    { id: 'tomorrow', label: '明天零点' },
    { id: 'thisWeek', label: '本周一' },
    { id: 'thisMonth', label: '本月 1 日' },
    { id: 'thisYear', label: '今年 1 月 1 日' },
  ];

  function refreshNow(): void {
    onChangeOption('unit', session.options.unit || 'auto');
    onChangeAction('now');
  }

  /** 输入内容变化时自动切换到匹配模式，避免“输入了却不出结果” */
  function handleInput(value: string): void {
    onChangeInput(value);
    const trimmed = value.trim();
    if (!trimmed) return;
    const detected = timestampPlugin.detect(trimmed);
    if (detected?.suggestedAction && detected.suggestedAction !== session.actionId) {
      onChangeAction(detected.suggestedAction);
    }
  }

  /** 手动切换模式：进入 to-unix 时清空共享输入残留的非日期文本（如旧时间戳），避免被插件误解析 */
  function switchMode(id: string): void {
    const residual = session.input.trim();
    if (id === 'to-unix') {
      if (residual && !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(residual)) {
        onChangeInput('');
      }
      if (!session.options.pickDateTime) onChangeOption('pickDateTime', nowValue());
    }
    onChangeAction(id);
  }
</script>

<div class="ts-panel">
  <div class="ts-modes">
    {#each MODES as m}
      <button class:active={session.actionId === m.id} title={m.desc} onclick={() => switchMode(m.id)}>
        <b>{m.label}</b><small>{m.desc}</small>
      </button>
    {/each}
  </div>

  {#if session.actionId === 'to-date'}
    <div class="ts-row">
      <label class="ts-field">
        <span>时间戳</span>
        <input value={session.input} placeholder="例如 1700000000 或 1700000000000" spellcheck="false" oninput={(e) => handleInput(e.currentTarget.value)} />
      </label>
      <label class="ts-field ts-narrow">
        <span>单位</span>
        <select value={session.options.unit || 'auto'} onchange={(e) => onChangeOption('unit', e.currentTarget.value)}>
          <option value="auto">自动</option>
          <option value="seconds">秒</option>
          <option value="milliseconds">毫秒</option>
        </select>
      </label>
      <button class="ts-clear" onclick={onClear} title="清空输入">清空</button>
    </div>
    <p class="ts-tip">支持 10 位（秒）与 13 位（毫秒）时间戳，可直接从日志、数据库或 API 响应中复制粘贴。</p>
  {:else if session.actionId === 'to-unix'}
    <div class="ts-row">
      <label class="ts-field">
        <span>日期时间</span>
        <input
          value={pickText()}
          placeholder="例如 2026-08-10 17:30"
          spellcheck="false"
          inputmode="numeric"
          oninput={(e) => parseDateTimeText(e.currentTarget.value)}
          onchange={(e) => parseDateTimeText(e.currentTarget.value)}
        />
        <small class="ts-field-hint">{session.options.pickDateTime ? '已选择：' + pickText() : ''}</small>
      </label>
      <div class="ts-quick">{#each QUICK_PRESETS as preset}<button class:active={session.options.pickDateTime === presetValue(preset.id)} onclick={() => quickPick(preset.id)}>{preset.label}</button>{/each}</div>
      <button class="ts-clear" onclick={onClear} title="清空">清空</button>
    </div>
    <p class="ts-tip">转换结果即时显示在右侧，包含本地时间、UTC 与 Unix 秒 / 毫秒，点击即可复制。</p>
  {:else}
    <div class="ts-row ts-nowrow">
      <span class="ts-live-label">结果实时显示在右侧</span>
      <button class="ts-now" onclick={refreshNow}><span>{@html UI_ICONS.refresh}</span>刷新</button>
    </div>
    <p class="ts-tip">当前时间的本地 / UTC 与 Unix 秒 / 毫秒会同步展示，适合作为时间戳速查。</p>
  {/if}
</div>

<style>
  .ts-panel { display: flex; flex-direction: column; gap: 12px; }
  .ts-modes { display: flex; gap: 6px; flex-wrap: wrap; }
  .ts-modes button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 14px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; border: 1px solid var(--line); border-radius: 999px; background: var(--w-03); transition: all var(--transition); }
  .ts-modes button:hover { color: var(--text); border-color: var(--line-strong); background: var(--w-06); }
  .ts-modes button.active { color: #fff; background: var(--btn-gradient); border-color: transparent; box-shadow: 0 4px 16px rgba(129, 140, 248, .4); }
  .ts-modes b { font-size: var(--fs-xs); font-weight: 600; }
  .ts-modes small { display: none; }
  .ts-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
  .ts-quick { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
  .ts-quick button { height: 26px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line-2); border-radius: 999px; background: var(--w-03); transition: all var(--transition); }
  .ts-quick button:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line-2)); background: var(--accent-soft); }
  .ts-field { display: flex; flex-direction: column; gap: 5px; }
  .ts-field span { color: var(--muted); font-size: var(--fs-sm); }
  .ts-field input, .ts-field select { height: 34px; padding: 0 12px; color: var(--text); font: 500 var(--fs-sm) 'Cascadia Code', Consolas, monospace; border: 1px solid var(--line); border-radius: 10px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .2s ease; }
  .ts-field input:hover, .ts-field select:hover { border-color: var(--line-strong); }
  .ts-field input:focus, .ts-field select:focus { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft), 0 0 12px color-mix(in srgb, var(--accent) 10%, transparent); }
  .ts-field-hint { color: var(--accent); font-size: var(--fs-xs); }
  .ts-field.ts-narrow select { width: 112px; }
  .ts-row .ts-field:first-child { flex: 1 1 auto; min-width: 240px; max-width: 340px; }
  .ts-row .ts-field:first-child input { width: 100%; }
  .ts-now, .ts-clear { height: 30px; padding: 0 14px; cursor: pointer; color: var(--muted); font-size: var(--fs-sm); border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel-2); transition: all var(--transition); }
  .ts-now { display: inline-flex; align-items: center; gap: 6px; }
  .ts-now span { display: inline-flex; }
  :global(.ts-now svg) { width: 13px; height: 13px; }
  .ts-now:hover, .ts-clear:hover { color: var(--text); border-color: var(--line); background: var(--hover); }
  .ts-tip { margin: 0; color: var(--muted-2); font-size: var(--fs-sm); line-height: 1.6; }
  .ts-nowrow { align-items: center; }
  .ts-live-label { color: var(--muted); font-size: var(--fs-sm); }
</style>