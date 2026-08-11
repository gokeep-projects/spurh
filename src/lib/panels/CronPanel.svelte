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
  // 记录已同步到生成器的输入，仅在新内容路由进来时切换「自定义」模式，避免与用户手动切换类型冲突
  let syncedInput: string | null = null;

  $effect(() => {
    const input = session.input.trim();
    if (!input) {
      syncedInput = null;
      return;
    }
    if (input === syncedInput) return;
    // 剥离 cron: 指令前缀，避免把前缀同步进表达式导致解析/展示异常（如“cron: 秒 · 每 5 分”）
    const expr = input.replace(/^cron[:：]\s*/i, '');
    if (!expr) return;
    try {
      parseCron(expr);
    } catch {
      return;
    }
    syncedInput = input;
    if (type !== 'custom' || (session.options.customExpr || '').trim() !== expr) {
      onChangeOption('type', 'custom');
      onChangeOption('customExpr', expr);
    }
  });

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
    ? (() => { try { return nextRuns(preview, 5).map((d) => d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })); } catch { return []; } })()
    : []);
  const previewExplain = $derived(preview
    ? (() => { try { return explainCron(preview); } catch { return ''; } })()
    : '');

  const EXAMPLES = [
    { label: '每分钟', expr: '* * * * *' },
    { label: '每 5 分钟', expr: '*/5 * * * *' },
    { label: '每 2 分钟', expr: '*/2 * * * *' },
    { label: '每 3 分钟', expr: '*/3 * * * *' },
    { label: '每 10 分钟', expr: '*/10 * * * *' },
    { label: '每 15 分钟', expr: '*/15 * * * *' },
    { label: '每 20 分钟', expr: '*/20 * * * *' },
    { label: '每 30 分钟', expr: '*/30 * * * *' },
    { label: '每 45 分钟', expr: '*/45 * * * *' },
    { label: '每天 02:30（备份）', expr: '30 2 * * *' },
    { label: '每天 03:00（凌晨备份）', expr: '0 3 * * *' },
    { label: '工作日每小时整点', expr: '0 * * * 1-5' },
    { label: '每周末 02:00', expr: '0 2 * * 0,6' },
    { label: '每周三 10:00（发布窗口）', expr: '0 10 * * 3' },
    { label: '每月最后一天 23:30', expr: '30 23 L * *' },
    { label: '每 5 分钟（工作日 9-18 点）', expr: '*/5 9-18 * * 1-5' },
    { label: '每 5 秒', expr: '*/5 * * * * *' },
    { label: '每 10 秒', expr: '*/10 * * * * *' },
    { label: '每 30 秒', expr: '*/30 * * * * *' },
    { label: '每小时', expr: '0 * * * *' },
    { label: '每小时 15 分', expr: '15 * * * *' },
    { label: '每小时 30 分', expr: '30 * * * *' },
    { label: '每小时 45 分', expr: '45 * * * *' },
    { label: '每 2 小时', expr: '0 */2 * * *' },
    { label: '每 4 小时', expr: '0 */4 * * *' },
    { label: '每 3 小时', expr: '0 */3 * * *' },
    { label: '每 6 小时', expr: '0 */6 * * *' },
    { label: '每 12 小时', expr: '0 */12 * * *' },
    { label: '每天 00:00（凌晨）', expr: '0 0 * * *' },
    { label: '每天 07:00', expr: '0 7 * * *' },
    { label: '每天 08:00', expr: '0 8 * * *' },
    { label: '每天 09:00', expr: '0 9 * * *' },
    { label: '每天 10:00', expr: '0 10 * * *' },
    { label: '每天 12:00（中午）', expr: '0 12 * * *' },
    { label: '每天 12:30', expr: '30 12 * * *' },
    { label: '每天 18:00', expr: '0 18 * * *' },
    { label: '每天 20:00', expr: '0 20 * * *' },
    { label: '每天 23:59', expr: '59 23 * * *' },
    { label: '每天 08:00 和 18:00', expr: '0 8,18 * * *' },
    { label: '工作日 08:00', expr: '0 8 * * 1-5' },
    { label: '工作日 09:30', expr: '30 9 * * 1-5' },
    { label: '工作日 18:30', expr: '30 18 * * 1-5' },
    { label: '工作日每 30 分钟(9-18)', expr: '*/30 9-18 * * 1-5' },
    { label: '每周一 08:00', expr: '0 8 * * 1' },
    { label: '每周一 09:00', expr: '0 9 * * 1' },
    { label: '每周五 17:00', expr: '0 17 * * 5' },
    { label: '每周五 18:00', expr: '0 18 * * 5' },
    { label: '周末 10:00', expr: '0 10 * * 0,6' },
    { label: '每月 1 号 00:00', expr: '0 0 1 * *' },
    { label: '每月 1 号 08:00', expr: '0 8 1 * *' },
    { label: '每月 10 号 09:00', expr: '0 9 10 * *' },
    { label: '每月 20 号 21:00', expr: '0 21 20 * *' },
    { label: '每月 1 日和 15 日 09:00', expr: '0 9 1,15 * *' },
    { label: '每月 15 号 10:00', expr: '0 10 15 * *' },
    { label: '每月最后一天 23:00', expr: '0 23 L * *' },
    { label: '每季度首日 08:00', expr: '0 8 1 1,4,7,10 *' },
    { label: '每半年首日 00:00', expr: '0 0 1 1,7 *' },
    { label: '每天 06:00（早起任务）', expr: '0 6 * * *' },
    { label: '工作日 07:30', expr: '30 7 * * 1-5' },
    { label: '每周日 00:00（周备份）', expr: '0 0 * * 0' },
    { label: '每月 5 号 02:00（月报）', expr: '0 2 5 * *' },
    { label: '每年 1 月 1 日 00:00', expr: '0 0 1 1 *' },
    { label: '工作日每 15 分钟（9-18 点）', expr: '*/15 9-18 * * 1-5' },
    { label: '每天 21:00（日报）', expr: '0 21 * * *' },
    { label: '每年 1 月 1 日 00:00', expr: '0 0 1 1 *' },
    { label: '每年 6 月 1 日 06:00', expr: '0 6 1 6 *' },
    { label: '每年 10 月 1 日 00:00', expr: '0 0 1 10 *' },
    { label: '每周日 00:00', expr: '0 0 * * 0' },
    { label: '每年 12 月 31 日 23:59', expr: '59 23 31 12 *' },
    { label: '每季度首日 09:00', expr: '0 9 1 1,4,7,10 *' },
    { label: '每月最后工作日 18:00', expr: '0 18 LW * *' },
    { label: '工作日每 15 分钟(9-18)', expr: '*/15 9-18 * * 1-5' },
    { label: '每 8 小时', expr: '0 */8 * * *' },
    { label: '工作日 18:00（下班后）', expr: '0 18 * * 1-5' },
  ];

  function applyExample(expr: string): void {
    onChangeOption('type', 'custom');
    onChangeOption('customExpr', expr);
  }

  function toggleWeekday(value: string): void {
    const next = new Set(weekdaySet);
    if (next.has(value)) next.delete(value); else next.add(value);
    onChangeOption('weekdays', [...next].sort().join(',') || '1');
  }

  async function copyPreview(): Promise<void> {
    if (!preview) return;
    const { copyText } = await import('../env');
    await copyText(preview);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
</script>

<div class="cron-panel">
  <div class="cron-layout">
    <section class="cron-config">
      <div class="cron-sec-title"><b>类型</b></div>
      <div class="cron-types">
        <div class="cron-type-group">
          <small>按间隔</small>
          <div class="cron-type-btns">
            {#each TYPES.slice(0, 3) as t}
              <button class:active={type === t.v} title={t.d} onclick={() => onChangeOption('type', t.v)}>{t.l}</button>
            {/each}
          </div>
        </div>
        <div class="cron-type-group">
          <small>按时间</small>
          <div class="cron-type-btns">
            {#each TYPES.slice(3, 8) as t}
              <button class:active={type === t.v} title={t.d} onclick={() => onChangeOption('type', t.v)}>{t.l}</button>
            {/each}
          </div>
        </div>
        <div class="cron-type-group">
          <small>手写</small>
          <div class="cron-type-btns">
            {#each TYPES.slice(8) as t}
              <button class:active={type === t.v} title={t.d} onclick={() => onChangeOption('type', t.v)}>{t.l}</button>
            {/each}
          </div>
        </div>
      </div>

      <div class="cron-examples">
        <span>试试</span>
        {#each EXAMPLES as ex}
          <button class:active={type === 'custom' && (session.options.customExpr || '').trim() === ex.expr} title={ex.expr} onclick={() => applyExample(ex.expr)}>{ex.label}</button>
        {/each}
      </div>

      <p class="cron-legend">格式：<b>分</b> <b>时</b> <b>日</b> <b>月</b> <b>周</b> · <i>*</i> 任意 <i>/</i> 间隔 <i>,</i> 列表 <i>-</i> 范围 <i>L</i> 最后一天（前 5 段为标准表达式，第 6 段为秒）</p>
      <div class="cron-sec-title"><b>配置</b><small>调整后实时生成表达式</small></div>
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
    </section>

    <aside class="cron-preview-panel">
      <div class="cron-preview" class:error={Boolean(previewError)}>
        <div class="preview-head"><span>表达式</span>{#if preview}<button onclick={copyPreview}>{copied ? '已复制 ✓' : '复制'}</button>{/if}</div>
        {#if previewError}
          <p class="preview-error">{previewError}</p>
        {:else if preview}
          <code>{preview}</code>
          {#if previewExplain}<p class="preview-explain">{previewExplain}</p>{/if}
        {:else}
          <p class="preview-empty">选择条件后实时预览</p>
        {/if}
      </div>

      {#if nextPreview.length}
        <div class="cron-sec-title"><b>未来执行</b></div>
        <div class="preview-runs">{#each nextPreview as run}<span>{run}</span>{/each}</div>
      {/if}
    </aside>
  </div>
</div>

<div class="cron-actions">
  <button class="primary" class:active={session.actionId === 'generate'} onclick={() => onChangeAction('generate')}>生成</button>
  <button class:active={session.actionId === 'next'} onclick={() => onChangeAction('next')}>执行时间</button>
  <button class:active={session.actionId === 'explain'} onclick={() => onChangeAction('explain')}>解析</button>
  <div class="control-spacer"></div>
  <button class="cron-clear" onclick={onClear}>清空</button>
</div>

<style>
  .cron-panel { display: flex; flex-direction: column; gap: 10px; width: 100%; min-width: 0; }
  .cron-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 12px; align-items: start; }
  @media (max-width: 900px) {
    .cron-layout { grid-template-columns: 1fr; }
    /* 有限高度下：预览/解释置顶始终可见，配置区内部滚动 */
    .cron-preview-panel { order: -1; }
    .cron-config { max-height: min(42vh, 320px); overflow-y: auto; }
  }

  .cron-config { display: flex; flex-direction: column; flex-wrap: nowrap; gap: 7px; min-width: 0; align-items: stretch; }
  .cron-sec-title { display: flex; align-items: baseline; gap: 8px; }
  .cron-sec-title b { color: var(--muted); font-size: var(--fs-xs); letter-spacing: 1.5px; }
  .cron-sec-title small { color: var(--muted-2); font-size: var(--fs-xs); }

  .cron-types { display: flex; flex-direction: column; align-items: stretch; gap: 6px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .cron-type-group { display: flex; align-items: center; gap: 10px; }
  .cron-type-group > small { flex: 0 0 auto; width: 50px; color: var(--muted-2); font-size: var(--fs-xs); }
  .cron-type-btns { display: flex; gap: 5px; flex-wrap: wrap; }
  .cron-type-btns button { height: 28px; min-width: 42px; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: transparent; transition: all .15s ease; }
  .cron-type-btns button:hover { color: var(--text); background: var(--hover); border-color: var(--line-2); }
  .cron-type-btns button.active { color: #fff; border-color: transparent; background: var(--btn-gradient); box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 22%, transparent); }

  .cron-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .cron-controls label { display: flex; align-items: center; gap: 6px; }
  .cron-controls label > span { color: var(--muted); font-size: var(--fs-xs); white-space: nowrap; }
  .cron-controls select { height: 30px; padding: 0 8px; color: var(--text); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--bg); }
  .cron-controls select:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .cron-controls select.clock { width: 56px; text-align: center; }
  .cron-controls .colon { color: var(--muted-2); font-style: normal; }
  .cron-controls .custom-expr { flex: 1; min-width: 260px; }
  .cron-controls .custom-expr input { height: 32px; width: 100%; padding: 0 10px; color: var(--text); font: 500 13px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--bg); }
  .cron-controls .custom-expr input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }

  .weekday-chips { display: flex; gap: 4px; }
  .weekday-chips button { width: 30px; height: 30px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 50%; background: transparent; transition: all .15s ease; }
  .weekday-chips button:hover { color: var(--text); border-color: var(--line-2); }
  .weekday-chips button.active { color: #fff; border-color: transparent; background: var(--btn-gradient); }

  .cron-preview-panel { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .cron-preview { padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .cron-preview.error { border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .preview-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; color: var(--muted); font-size: var(--fs-xs); letter-spacing: 1.5px; }
  .preview-head button { height: 30px; padding: 0 10px; cursor: pointer; color: var(--accent); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 8px; background: var(--accent-soft); }
  .cron-preview code { display: block; padding: 8px 10px; color: var(--c-violet); font: 600 13px 'Cascadia Code', monospace; word-break: break-all; border: 1px dashed var(--line-2); border-radius: 8px; background: var(--bg); }
  .preview-explain { margin: 8px 0 0; color: var(--muted); font-size: var(--fs-sm); line-height: 1.6; }
  .preview-error { margin: 0; color: var(--danger); font-size: var(--fs-xs); }
  .preview-empty { margin: 0; color: var(--muted-2); font-size: var(--fs-xs); }
  .preview-runs { display: flex; flex-wrap: wrap; gap: 5px; }
  .preview-runs span { padding: 4px 8px; color: var(--text); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }

  .cron-actions { display: flex; gap: 4px; align-items: center; }
  .cron-actions button { height: 30px; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: transparent; }
  .cron-actions button.primary { color: #fff; background: var(--btn-gradient); border-color: transparent; }
  .cron-actions button.primary.active { box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .cron-actions button.active:not(.primary) { color: var(--text); background: var(--panel-2); border-color: var(--line-2); }
  .cron-actions button:hover { background: var(--hover); }
  .cron-actions button.primary:hover { filter: brightness(1.08); }
  .cron-clear { height: 30px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid transparent; border-radius: 8px; background: transparent; }
  .cron-clear:hover { color: var(--text); border-color: var(--line); }
  .control-spacer { flex: 1; }
  .cron-examples { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 2px 10px; max-height: 108px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line-2) transparent; }
  .cron-examples > span { flex: 0 0 auto; color: var(--muted-2); font-size: var(--fs-xs); padding-right: 2px; }
  .cron-examples button { flex: 0 0 auto; min-width: 0; height: 28px; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); line-height: 1; border: 1px dashed var(--line-2); border-radius: 999px; background: transparent; white-space: nowrap; }
  .cron-examples button:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); }
  .cron-examples button.active { color: #fff; border-color: transparent; background: var(--btn-gradient); }
  .cron-legend { margin: 8px 2px 0; color: var(--muted-2); font-size: var(--fs-sm); line-height: 1.7; }
  .cron-legend b { display: inline-block; min-width: 18px; margin-right: 2px; padding: 0 5px; color: var(--text); font-weight: 600; text-align: center; border: 1px solid var(--line-2); border-radius: 5px; background: var(--w-04); }
  .cron-legend i { padding: 0 2px; color: var(--accent); font-style: normal; font-weight: 600; }
</style>
