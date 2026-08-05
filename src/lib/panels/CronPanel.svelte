<script lang="ts">
  import type { PluginResult } from '../plugins/types';
  import { buildExpression, explainCron, nextRuns, parseCron } from '../plugins/builtin/cron';

  let { session, onChangeAction, onChangeOption, onClear }: {
    session: { actionId: string; options: Record<string, string>; input: string; result: PluginResult | null; error: string; processing: boolean };
    onChangeAction: (id: string) => void;
    onChangeOption: (id: string, v: string) => void;
    onClear: () => void;
  } = $props();

  const TYPES = [
    { v: 'seconds', l: '秒', d: '每 N 秒' },
    { v: 'minutes', l: '分', d: '每 N 分钟' },
    { v: 'hourly', l: '时', d: '每 N 小时' },
    { v: 'daily', l: '天', d: '每天定时' },
    { v: 'workdays', l: '工作日', d: '工作日定时' },
    { v: 'weekly', l: '周', d: '每周固定几天' },
    { v: 'monthly', l: '月', d: '每月固定日期' },
    { v: 'yearly', l: '年', d: '每年固定日期' },
    { v: 'custom', l: '自定义', d: '手写表达式' },
  ];
  const WEEKDAYS = [
    { v: '0', l: '日' }, { v: '1', l: '一' }, { v: '2', l: '二' }, { v: '3', l: '三' },
    { v: '4', l: '四' }, { v: '5', l: '五' }, { v: '6', l: '六' },
  ];
  const H = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const M = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

  let copied = $state(false);

  const type = $derived(session.options.type || 'daily');
  const weekdaySet = $derived(new Set((session.options.weekdays || '1,3,5').split(',').filter(Boolean)));

  const previewInfo = $derived((() => {
    try {
      if (type === 'custom') {
        const expr = (session.options.customExpr || '').trim() || session.input.trim();
        if (!expr) return { expr: '', error: '' };
        parseCron(expr);
        return { expr, error: '' };
      }
      return { expr: buildExpression(session.options), error: '' };
    } catch (error) {
      return { expr: '', error: error instanceof Error ? error.message : String(error) };
    }
  })());
  const preview = $derived(previewInfo.expr);
  const previewError = $derived(previewInfo.error);

  const nextPreview = $derived(preview
    ? (() => { try { return nextRuns(preview, 3).map((d) => d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })); } catch { return []; } })()
    : []);
  const previewExplain = $derived(preview
    ? (() => { try { return explainCron(preview); } catch { return ''; } })()
    : '');

  function toggleWeekday(value: string): void {
    const next = new Set(weekdaySet);
    if (next.has(value)) next.delete(value); else next.add(value);
    onChangeOption('weekdays', [...next].sort().join(',') || '1');
  }

  async function copyPreview(): Promise<void> {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch { /* 剪贴板不可用时静默 */ }
  }
</script>

<div class="cron-panel">
  <div class="cron-types">
    {#each TYPES as t}
      <button class:active={type === t.v} title={t.d} onclick={() => onChangeOption('type', t.v)}>
        <b>{t.l}</b><small>{t.d}</small>
      </button>
    {/each}
  </div>

  <div class="cron-controls">
    {#if type === 'seconds'}
      <label><span>间隔</span>
        <select value={session.options.secondInterval || '10'} onchange={(e) => onChangeOption('secondInterval', e.currentTarget.value)}>
          {#each Array.from({ length: 59 }, (_, i) => String(i + 1)) as v}<option value={v}>每 {v} 秒</option>{/each}
        </select>
      </label>
    {:else if type === 'minutes'}
      <label><span>间隔</span>
        <select value={session.options.minuteInterval || '5'} onchange={(e) => onChangeOption('minuteInterval', e.currentTarget.value)}>
          {#each Array.from({ length: 59 }, (_, i) => String(i + 1)) as v}<option value={v}>每 {v} 分钟</option>{/each}
        </select>
      </label>
    {:else if type === 'hourly'}
      <label><span>间隔</span>
        <select value={session.options.hourInterval || '2'} onchange={(e) => onChangeOption('hourInterval', e.currentTarget.value)}>
          {#each Array.from({ length: 23 }, (_, i) => String(i + 1)) as v}<option value={v}>每 {v} 小时</option>{/each}
        </select>
      </label>
    {:else if ['daily', 'workdays', 'weekly', 'monthly', 'yearly'].includes(type)}
      <label><span>时间</span>
        <select class="clock" value={session.options.hour || '09'} onchange={(e) => onChangeOption('hour', e.currentTarget.value)}>
          {#each H as v}<option value={v}>{v}</option>{/each}
        </select>
        <i class="colon">:</i>
        <select class="clock" value={session.options.minute || '00'} onchange={(e) => onChangeOption('minute', e.currentTarget.value)}>
          {#each M as v}<option value={v}>{v}</option>{/each}
        </select>
        <i class="colon">:</i>
        <select class="clock" value={session.options.second || '00'} onchange={(e) => onChangeOption('second', e.currentTarget.value)}>
          {#each M as v}<option value={v}>{v}</option>{/each}
        </select>
      </label>
    {/if}

    {#if type === 'weekly'}
      <div class="weekday-chips" role="group" aria-label="星期">
        {#each WEEKDAYS as w}
          <button class:active={weekdaySet.has(w.v)} onclick={() => toggleWeekday(w.v)}>{w.l}</button>
        {/each}
      </div>
    {/if}

    {#if type === 'monthly' || type === 'yearly'}
      <label><span>日期</span>
        <select value={session.options.monthDay || '1'} onchange={(e) => onChangeOption('monthDay', e.currentTarget.value)}>
          {#each Array.from({ length: 31 }, (_, i) => String(i + 1)) as v}<option value={v}>{v} 号</option>{/each}
          <option value="L">最后一天</option>
          {#each Array.from({ length: 7 }, (_, i) => `L-${i + 1}`) as v}<option value={v}>最后一天前 {v.slice(2)} 天</option>{/each}
        </select>
      </label>
    {/if}

    {#if type === 'yearly'}
      <label><span>月份</span>
        <select value={session.options.month || '1'} onchange={(e) => onChangeOption('month', e.currentTarget.value)}>
          {#each Array.from({ length: 12 }, (_, i) => String(i + 1)) as v}<option value={v}>{v} 月</option>{/each}
        </select>
      </label>
    {/if}

    {#if type === 'custom'}
      <label class="custom-expr"><span>表达式</span>
        <input value={session.options.customExpr || session.input || ''} placeholder="分 时 日 月 周 [秒 年] 例如: */5 * * * *" oninput={(e) => onChangeOption('customExpr', e.currentTarget.value)} spellcheck="false" />
      </label>
    {/if}
  </div>

  <div class="cron-preview" class:error={Boolean(previewError)}>
    <div class="preview-head"><span>表达式</span>{#if preview}<button onclick={copyPreview}>{copied ? '已复制 ✓' : '复制'}</button>{/if}</div>
    {#if previewError}
      <p class="preview-error">{previewError}</p>
    {:else if preview}
      <code>{preview}</code>
      {#if previewExplain}<p class="preview-explain">{previewExplain}</p>{/if}
      {#if nextPreview.length}
        <div class="preview-runs">{#each nextPreview as run}<span>{run}</span>{/each}</div>
      {/if}
    {:else}
      <p class="preview-empty">选择条件后实时预览</p>
    {/if}
  </div>

  <div class="cron-actions">
    <button class="primary" class:active={session.actionId === 'generate'} onclick={() => onChangeAction('generate')}>生成</button>
    <button class:active={session.actionId === 'next'} onclick={() => onChangeAction('next')}>执行时间</button>
    <button class:active={session.actionId === 'explain'} onclick={() => onChangeAction('explain')}>解析</button>
    <div class="control-spacer"></div>
    <button class="cron-clear" onclick={onClear}>清空</button>
  </div>
</div>

<style>
  .cron-panel { display: flex; flex-direction: column; gap: 10px; width: 100%; min-width: 0; }
  .cron-types { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; }
  .cron-types button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-width: 0; padding: 7px 6px; cursor: pointer; color: var(--muted); font-size: 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; transition: all .15s ease; }
  .cron-types button b { color: inherit; font-size: 12px; }
  .cron-types button small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; font-size: 9px; opacity: .75; }
  .cron-types button:hover { color: var(--text); background: var(--hover); border-color: var(--line-2); }
  .cron-types button.active { color: var(--accent); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .cron-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .cron-controls label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .cron-controls label > span { color: var(--muted); font-size: 11px; }
  .cron-controls select { height: 32px; color: var(--text); font-size: 12px; border: 1px solid var(--line); border-radius: 6px; outline: 0; background: var(--bg); padding: 0 8px; cursor: pointer; }
  .cron-controls select.clock { width: 62px; font-family: 'Cascadia Code', monospace; }
  .cron-controls .colon { color: var(--muted); font-style: normal; font-size: 12px; }
  .weekday-chips { display: flex; gap: 4px; }
  .weekday-chips button { width: 30px; height: 30px; cursor: pointer; color: var(--muted); font-size: 12px; border: 1px solid var(--line); border-radius: 50%; background: transparent; transition: all .15s ease; }
  .weekday-chips button:hover { color: var(--text); border-color: var(--line-2); }
  .weekday-chips button.active { color: #fff; background: linear-gradient(135deg, var(--accent), var(--blue)); border-color: transparent; }
  .custom-expr input { width: min(34vw, 320px); height: 32px; padding: 0 10px; color: var(--text); font: 500 12px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 6px; outline: 0; background: var(--bg); }
  .cron-preview { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .cron-preview.error { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
  .preview-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .preview-head span { color: var(--muted); font-size: 10px; font-weight: 700; }
  .preview-head button { height: 22px; padding: 0 8px; cursor: pointer; color: var(--muted); font-size: 9px; border: 1px solid transparent; border-radius: 4px; background: transparent; }
  .preview-head button:hover { color: var(--text); border-color: var(--line); }
  .cron-preview code { display: block; padding: 8px 10px; color: var(--accent); font: 600 13px 'Cascadia Code', monospace; border-radius: 6px; background: var(--bg); }
  .preview-explain { margin-top: 6px; color: var(--muted); font-size: 11px; }
  .preview-runs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .preview-runs span { padding: 3px 8px; color: var(--text); font-size: 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg); }
  .preview-error { color: var(--danger); font-size: 11px; }
  .preview-empty { color: var(--muted-2); font-size: 11px; }
  .cron-actions { display: flex; gap: 4px; align-items: center; }
  .cron-actions button { height: 30px; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: 11px; border: 1px solid var(--line); border-radius: 6px; background: transparent; }
  .cron-actions button.primary { color: #fff; background: linear-gradient(135deg, var(--accent), var(--blue)); border-color: transparent; }
  .cron-actions button.primary.active { box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .cron-actions button.active:not(.primary) { color: var(--text); background: var(--panel-2); border-color: var(--line-2); }
  .cron-actions button:hover { background: var(--hover); }
  .cron-actions button.primary:hover { background: linear-gradient(135deg, var(--accent), var(--blue)); filter: brightness(1.08); }
  .cron-clear { height: 30px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; }
  .cron-clear:hover { color: var(--text); border-color: var(--line); }
  .control-spacer { flex: 1; }
</style>