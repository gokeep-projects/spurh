<script lang="ts">
  import { UI_ICONS } from '../icons';
  import type { PluginResult } from '../plugins/types';

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

  function refreshNow(): void {
    onChangeOption('unit', session.options.unit || 'auto');
    onChangeAction('now');
  }
</script>

<div class="ts-panel">
  <div class="ts-modes">
    {#each MODES as m}
      <button class:active={session.actionId === m.id} title={m.desc} onclick={() => onChangeAction(m.id)}>
        <b>{m.label}</b><small>{m.desc}</small>
      </button>
    {/each}
  </div>

  {#if session.actionId === 'to-date'}
    <div class="ts-row">
      <label class="ts-field">
        <span>时间戳</span>
        <input value={session.input} placeholder="例如 1700000000 或 1700000000000" spellcheck="false" oninput={(e) => onChangeInput(e.currentTarget.value)} />
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
        <input type="datetime-local" value={session.options.pickDateTime || ''} oninput={(e) => onChangeOption('pickDateTime', e.currentTarget.value)} />
      </label>
      <button class="ts-now" onclick={() => onChangeOption('pickDateTime', nowValue())}>现在</button>
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
  .ts-modes { display: flex; gap: 8px; flex-wrap: wrap; }
  .ts-modes button { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 132px; padding: 10.5px 13px; cursor: pointer; color: var(--muted); text-align: left; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); transition: all var(--transition); }
  .ts-modes button:hover { color: var(--text); border-color: var(--line-2); background: var(--hover); }
  .ts-modes button.active { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); }
  .ts-modes b { font-size: var(--fs-xs); }
  .ts-modes small { color: var(--muted-2); font-size: var(--fs-xs); }
  .ts-modes button.active small { color: var(--muted); }
  .ts-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
  .ts-field { display: flex; flex-direction: column; gap: 5px; }
  .ts-field span { color: var(--muted); font-size: var(--fs-sm); }
  .ts-field input, .ts-field select { height: 36px; padding: 0 11px; color: var(--text); font-size: var(--fs-xs); border: 1px solid var(--line-2); border-radius: 8px; outline: 0; background: var(--panel); }
  .ts-field input:focus, .ts-field select:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line-2)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .ts-field.ts-narrow select { width: 112px; }
  .ts-row .ts-field:first-child { flex: 1; min-width: 240px; }
  .ts-row .ts-field:first-child input { width: 100%; }
  .ts-now, .ts-clear { height: 36px; padding: 0 14px; cursor: pointer; color: var(--muted); font-size: var(--fs-sm); border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel-2); transition: all var(--transition); }
  .ts-now { display: inline-flex; align-items: center; gap: 6px; }
  .ts-now span { display: inline-flex; }
  :global(.ts-now svg) { width: 13px; height: 13px; }
  .ts-now:hover, .ts-clear:hover { color: var(--text); border-color: var(--line); background: var(--hover); }
  .ts-tip { margin: 0; color: var(--muted-2); font-size: var(--fs-sm); line-height: 1.6; }
  .ts-nowrow { align-items: center; }
  .ts-live-label { color: var(--muted); font-size: var(--fs-sm); }
</style>