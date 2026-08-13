<script lang="ts">
  import { UI_ICONS, TOOL_ICONS } from '../icons';
  import { copyText as copyTextNative } from '../env';
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
    const m = value.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return;
    const p = (n: number) => String(n).padStart(2, '0');
    const norm = `${m[1]}-${p(Number(m[2]))}-${p(Number(m[3]))}T${p(Number(m[4] ?? 0))}:${p(Number(m[5] ?? 0))}:${p(Number(m[6] ?? 0))}`;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    if (Number.isNaN(d.getTime())) return;
    onChangeOption('pickDateTime', norm);
    flashPicked();
  }
  /** 把 pickDateTime 转成给人看的文本 */
  function pickText(): string {
    const raw = session.options.pickDateTime || '';
    return raw.replace('T', ' ');
  }

  function quickPick(kind: string): void {
    const value = presetValue(kind);
    if (value) { onChangeOption('pickDateTime', value); flashPicked(); }
  }

  const QUICK_PRESETS = [
    { id: 'now', label: '现在' },
    { id: 'today', label: '今天零点' },
    { id: 'tomorrow', label: '明天零点' },
    { id: 'thisWeek', label: '本周一' },
    { id: 'thisMonth', label: '本月 1 日' },
    { id: 'thisYear', label: '今年 1 月 1 日' },
  ];
  /** 常用时刻快捷预设：点击即回填 HH:mm */
  const TIME_PRESETS = [
    { label: '00:00', value: '00:00:00', title: '零点' },
    { label: '09:30', value: '09:30:00', title: '上午九点半' },
    { label: '12:00', value: '12:00:00', title: '正午' },
    { label: '18:00', value: '18:00:00', title: '傍晚六点' },
    { label: '23:59', value: '23:59:59', title: '一天结束' },
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

  /** 一键填入当前 Unix 秒级时间戳（时间戳 → 日期 模式的“现在”快捷） */
  function fillNowTimestamp(): void {
    onChangeInput(String(Math.floor(Date.now() / 1000)));
  }

  /** 时间戳 → 日期模式的即时解析反馈：本地时间 / UTC / ISO / 相对时间 / 秒与毫秒 */
  const toDateParsed = $derived((() => {
    const raw = session.input.trim();
    if (!/^\d{1,14}$/.test(raw)) return null;
    const unit = session.options.unit || 'auto';
    let ms: number;
    if (unit === 'seconds') ms = Number(raw) * 1000;
    else if (unit === 'milliseconds') ms = Number(raw);
    else ms = raw.length >= 13 ? Number(raw) : Number(raw) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    const diff = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(diff);
    const rel = diff === 0 ? '就是现在'
      : abs < 60 ? (diff > 0 ? '即将到来' : '刚刚')
      : abs < 3600 ? (diff > 0 ? Math.floor(abs / 60) + ' 分钟后' : Math.floor(abs / 60) + ' 分钟前')
      : abs < 86400 ? (diff > 0 ? Math.floor(abs / 3600) + ' 小时后' : Math.floor(abs / 3600) + ' 小时前')
      : (diff > 0 ? Math.floor(abs / 86400) + ' 天后' : Math.floor(abs / 86400) + ' 天前');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '本地';
    const local = d.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const utc = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '';
    return { ms, sec: String(Math.floor(ms / 1000)), msStr: String(ms), local, utc, iso: d.toISOString(), rel, week, tz };
  })());

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

  /** 选中日期时间的内联反馈：实时显示对应 Unix 秒（右栏同步展示完整结果） */
  const unixPreview = $derived((() => {
    const raw = session.options.pickDateTime || '';
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
    if (Number.isNaN(d.getTime())) return '';
    return String(Math.floor(d.getTime() / 1000));
  })());

  /** 日期时间 → 本地可读文本 */
  const localPreview = $derived((() => {
    const raw = session.options.pickDateTime || '';
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + (m[6] !== undefined ? ':' + m[6] : ':00');
  })());
  const weekdayPreview = $derived((() => {
    const raw = session.options.pickDateTime || '';
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '';
  })());
  const unixMsPreview = $derived(unixPreview ? String(Number(unixPreview) * 1000) : '');
  const relativePreview = $derived((() => {
    const raw = session.options.pickDateTime || '';
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
    const diff = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(diff);
    if (diff === 0) return '就是现在';
    if (abs < 60) return diff > 0 ? '即将到来' : '刚刚';
    if (abs < 3600) return (diff > 0 ? Math.floor(abs / 60) + ' 分钟后' : Math.floor(abs / 60) + ' 分钟前');
    if (abs < 86400) return (diff > 0 ? Math.floor(abs / 3600) + ' 小时后' : Math.floor(abs / 3600) + ' 小时前');
    return (diff > 0 ? Math.floor(abs / 86400) + ' 天后' : Math.floor(abs / 86400) + ' 天前');
  })());
  let copiedTs = $state('');
  async function copyTs(value: string, key: string): Promise<void> {
    await copyTextNative(value);
    copiedTs = key;
    setTimeout(() => { if (copiedTs === key) copiedTs = ''; }, 1100);
  }

  let tsClockTimer: ReturnType<typeof setInterval> | undefined;
  let tsClock = $state('');
  function tickTsClock(): void {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    tsClock = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  $effect(() => {
    tickTsClock();
    tsClockTimer = setInterval(tickTsClock, 1000);
    return () => { if (tsClockTimer) clearInterval(tsClockTimer); };
  });

  /** 日期文本直填草稿：支持 2024-11-15 10:30 / 2024/11/15 等写法，解析成功后同步到日历控件 */
  let dtTextDraft = $state('');
  function handleDtText(value: string): void {
    dtTextDraft = value;
    parseDateTimeText(value);
  }

  /* ── 自定义日历弹层（替换原生 datetime-local，交互与观感统一） ── */
  let calOpen = $state(false);
  let calYear = $state(new Date().getFullYear());
  let calMonth = $state(new Date().getMonth());
  const CAL_WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const calTitle = $derived(`${calYear} 年 ${calMonth + 1} 月`);
  const calDays = $derived.by(() => {
    const first = new Date(calYear, calMonth, 1);
    const start = first.getDay();
    const count = new Date(calYear, calMonth + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < start; i++) cells.push(null);
    for (let d = 1; d <= count; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  });
  function openCalendar(): void {
    const cur = session.options.pickDateTime;
    const m = cur ? cur.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/) : null;
    const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
    calYear = base.getFullYear();
    calMonth = base.getMonth();
    calOpen = true;
  }
  function calPrevMonth(): void {
    calMonth -= 1;
    if (calMonth < 0) { calMonth = 11; calYear -= 1; }
  }
  function calNextMonth(): void {
    calMonth += 1;
    if (calMonth > 11) { calMonth = 0; calYear += 1; }
  }
  function calPickDay(day: number): void {
    const p = (n: number) => String(n).padStart(2, '0');
    const cur = session.options.pickDateTime;
    const m = cur ? cur.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/) : null;
    const hh = m ? m[4] : '00';
    const mm = m ? m[5] : '00';
    const ss = m && m[6] !== undefined ? m[6] : '00';
    onChangeOption('pickDateTime', `${calYear}-${p(calMonth + 1)}-${p(day)}T${hh}:${mm}:${ss}`);
    calOpen = false;
    flashPicked();
  }
  function isCalToday(day: number): boolean {
    const now = new Date();
    return now.getFullYear() === calYear && now.getMonth() === calMonth && now.getDate() === day;
  }
  function isCalSelected(day: number): boolean {
    const cur = session.options.pickDateTime;
    const m = cur ? cur.match(/^(\d{4})-(\d{2})-(\d{2})T/) : null;
    return !!m && Number(m[1]) === calYear && Number(m[2]) === calMonth + 1 && Number(m[3]) === day;
  }
  /** 时间文本校验回填：HH:mm（允许 HH:mm:ss） */
  function handleTimeText(value: string): void {
    const m = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = m[3] !== undefined ? Number(m[3]) : 0;
    if (hh > 23 || mm > 59 || ss > 59) return;
    const p = (n: number) => String(n).padStart(2, '0');
    const cur = session.options.pickDateTime || nowValue();
    const dm = cur.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (!dm) return;
    onChangeOption('pickDateTime', `${dm[1]}-${dm[2]}-${dm[3]}T${p(hh)}:${p(mm)}:${p(ss)}`);
    flashPicked();
  }
  const timeText = $derived((session.options.pickDateTime || '').replace('T', ' ').slice(11, 19) || '00:00:00');
  const dateText = $derived((session.options.pickDateTime || '').slice(0, 10) || '');
  /** 选中日期对应的星期几（供选择按钮实时反馈） */
  const dateWeekday = $derived((() => {
    const raw = session.options.pickDateTime || '';
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '';
  })());
  /** 选中后是否刚刚发生（用于闪动反馈） */
  let pickedAt = $state(0);
  function flashPicked(): void { pickedAt = Date.now(); }


</script>

<div class="ts-panel">
  <div class="ts-panel-clock"><i class="ts-clock-dot"></i><b>{tsClock}</b><small>本地时间 · 实时</small></div>
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
        <div class="ts-input-wrap ts-ts-wrap">
          <input value={session.input} placeholder="例如 1700000000 或 1700000000000" spellcheck="false" oninput={(e) => handleInput(e.currentTarget.value)} />
          <button class="ts-now-inline" onclick={() => fillNowTimestamp()} title="填入当前时间戳">现在</button>
        </div>
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
    {#if toDateParsed}
      {#key toDateParsed.msStr}
      <div class="ts-inline-card ts-to-date-card">
        <div class="ts-inline-local">
          <span>本地时间 · {toDateParsed.tz}</span>
          <b>{toDateParsed.local}</b>
          <em>{toDateParsed.week}</em>
          {#if toDateParsed.rel}<i>{toDateParsed.rel}</i>{/if}
        </div>
        <div class="ts-inline-cols">
          <button class="ts-chip" onclick={() => copyTs(toDateParsed.sec, 'sec')} title="点击复制">
            <small>Unix 秒</small><b>{toDateParsed.sec}</b>{copiedTs === 'sec' ? '✓ 已复制' : '复制'}
          </button>
          <button class="ts-chip" onclick={() => copyTs(toDateParsed.msStr, 'ms')} title="点击复制">
            <small>Unix 毫秒</small><b>{toDateParsed.msStr}</b>{copiedTs === 'ms' ? '✓ 已复制' : '复制'}
          </button>
        </div>
        <div class="ts-inline-utc"><small>UTC</small><b>{toDateParsed.utc}</b></div>
        <div class="ts-inline-utc"><small>ISO 8601</small><b>{toDateParsed.iso}</b></div>
      </div>
      {/key}
    {/if}
    {:else if session.actionId === 'to-unix'}
    <div class="ts-row">
      <label class="ts-field ts-dtfield">
        <span>日期时间</span>
        <div class="ts-pick-box" class:open={calOpen} class:picked={pickedAt > 0}>
          {#key pickedAt}
          <button class="ts-pick-date" onclick={openCalendar} title="点击打开日历选择日期">
            <i class="ts-cal-ico">{@html TOOL_ICONS['spurh.timestamp']}</i>
            <b>{dateText || '选择日期'}</b>
            {#if dateWeekday}<em class="ts-date-week">{dateWeekday}</em>{/if}
            <em class="ts-cal-caret">▾</em>
          </button>
          {/key}
          <span class="ts-pick-sep">·</span>
          <span class="ts-time-wrap">
            <i class="ts-clock-ico">{@html UI_ICONS.clock}</i>
            <input class="ts-time-input" value={timeText} placeholder="00:00:00" spellcheck="false" oninput={(e) => handleTimeText(e.currentTarget.value)} />
          </span>
          <button class="ts-now-inline" onclick={() => quickPick('now')} title="填入当前时间">现在</button>
          <div class="ts-time-presets">
            {#each TIME_PRESETS as item}
              <button class:active={timeText === item.value} onclick={() => handleTimeText(item.value)} title={item.title}>{item.label}</button>
            {/each}
          </div>
          {#if calOpen}
            <div class="ts-cal" role="dialog" aria-label="选择日期">
              <header class="ts-cal-head">
                <button onclick={calPrevMonth} title="上一月">‹</button>
                <b>{calTitle}</b>
                <button onclick={calNextMonth} title="下一月">›</button>
              </header>
              <div class="ts-cal-week">
                {#each CAL_WEEK as w}<span>{w}</span>{/each}
              </div>
              <div class="ts-cal-grid">
                {#each calDays as day, i (i)}
                  {#if day === null}
                    <i class="ts-cal-empty"></i>
                  {:else}
                    <button
                      class:today={isCalToday(day)}
                      class:selected={isCalSelected(day)}
                      onclick={() => calPickDay(day)}
                    >{day}</button>
                  {/if}
                {/each}
              </div>
              <footer class="ts-cal-foot"><button onclick={() => { quickPick('today'); calOpen = false; }}>今天</button><button class="ts-cal-clear" onclick={() => { onChangeOption('pickDateTime', ''); calOpen = false; }}>清除</button><button onclick={() => { calOpen = false; }}>关闭</button></footer>
            </div>
          {/if}
        </div>
        {#if session.options.pickDateTime}
          {#key unixPreview || 'empty'}
          <div class="ts-inline-card ts-inline-card-pop">
            <div class="ts-inline-local">
              <span>本地时间</span>
              <b>{localPreview || '—'}</b>
              <em>{weekdayPreview}</em>
              {#if relativePreview}<i>{relativePreview}</i>{/if}
            </div>
            <div class="ts-inline-cols">
              <button class="ts-chip" onclick={() => copyTs(unixPreview || '', 'sec')} title="点击复制">
                <small>Unix 秒</small><b>{unixPreview || '—'}</b>{copiedTs === 'sec' ? '✓ 已复制' : '复制'}
              </button>
              <button class="ts-chip" onclick={() => copyTs(unixMsPreview || '', 'ms')} title="点击复制">
                <small>Unix 毫秒</small><b>{unixMsPreview || '—'}</b>{copiedTs === 'ms' ? '✓ 已复制' : '复制'}
              </button>
            </div>
          </div>
          {/key}
        {:else}
          <small class="ts-field-hint">点击日期框打开日历，或使用下方快捷预设，结果即时显示</small>
        {/if}
      </label>
      <div class="ts-quick">{#each QUICK_PRESETS as preset}<button class:active={session.options.pickDateTime === presetValue(preset.id)} onclick={() => quickPick(preset.id)}>{preset.label}</button>{/each}</div>
      <button class="ts-clear" onclick={onClear} title="清空">清空</button>
    </div>
    <p class="ts-tip">转换结果即时显示在右侧，包含本地时间、UTC 与 Unix 秒 / 毫秒，点击即可复制。</p>
  {:else}
    <div class="ts-row ts-nowrow">
      <span class="ts-live-clock"><i></i><b>{tsClock}</b><small>本地时间 · 实时</small></span>
      <span class="ts-live-label">结果实时显示在右侧</span>
      <button class="ts-now" onclick={refreshNow}><span>{@html UI_ICONS.refresh}</span>刷新</button>
    </div>
    <p class="ts-tip">当前时间的本地 / UTC 与 Unix 秒 / 毫秒会同步展示，适合作为时间戳速查。</p>
  {/if}
</div>

<style>
  .ts-panel { display: flex; flex-direction: column; gap: 12px; }
  .ts-panel-clock { display: inline-flex; align-items: center; gap: 9px; align-self: flex-start; padding: 6px 14px 6px 10px; border: 1px solid color-mix(in srgb, var(--c-green) 34%, var(--line)); border-radius: 999px; background: linear-gradient(120deg, color-mix(in srgb, var(--c-green) 9%, var(--panel)), var(--panel)); box-shadow: 0 3px 12px color-mix(in srgb, var(--c-green) 10%, transparent); }
  .ts-panel-clock b { font: 700 var(--fs-lg) 'Cascadia Code', Consolas, monospace; color: var(--c-green); font-variant-numeric: tabular-nums; letter-spacing: .6px; }
  .ts-panel-clock small { color: var(--muted); font-size: var(--fs-xs); }
  .ts-clock-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-green); box-shadow: 0 0 0 0 color-mix(in srgb, var(--c-green) 55%, transparent); animation: tsPulse 2s ease-out infinite; }
  @keyframes tsPulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--c-green) 50%, transparent); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
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
  .ts-field input, .ts-field select { height: 40px; padding: 0 12px; color: var(--text); font: 500 var(--fs-sm) 'Cascadia Code', Consolas, monospace; border: 1px solid var(--line); border-radius: 10px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .2s ease; }
  .ts-field input:hover, .ts-field select:hover { border-color: var(--line-strong); }
  .ts-field input:focus, .ts-field select:focus { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft), 0 0 12px color-mix(in srgb, var(--accent) 10%, transparent); }
  .ts-field-hint { color: var(--accent); font-size: var(--fs-xs); }
  .ts-inline-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--c-green) 32%, var(--line)); border-radius: 12px; background: linear-gradient(135deg, color-mix(in srgb, var(--c-green) 8%, var(--panel)), var(--panel) 70%); box-shadow: 0 4px 16px color-mix(in srgb, var(--c-green) 8%, transparent); animation: tsCardIn .28s cubic-bezier(.2,.9,.3,1.2); }
  @keyframes tsCardIn { from { opacity: 0; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
  .ts-inline-local { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .ts-inline-local span { color: var(--muted); font-size: var(--fs-xs); letter-spacing: .6px; text-transform: uppercase; }
  .ts-inline-local b { font: 650 var(--fs-sm) 'Cascadia Code', Consolas, monospace; color: var(--c-green); font-variant-numeric: tabular-nums; }
  .ts-inline-local em { font-style: normal; color: var(--accent); font-size: var(--fs-xs); font-weight: 700; }
  .ts-inline-cols { display: flex; gap: 8px; flex-wrap: wrap; }
  .ts-chip { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 9px; background: var(--w-04); transition: all .15s ease; }
  .ts-chip small { color: var(--muted-2); }
  .ts-chip b { font: 600 var(--fs-xs) 'Cascadia Code', Consolas, monospace; color: var(--text); font-variant-numeric: tabular-nums; }
  .ts-chip:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); transform: translateY(-1px); }
  .ts-now-inline { top: 50%; transform: translateY(-50%); }
  .ts-dtfield { flex: 1 1 560px !important; max-width: none !important; min-width: 0; }
  .ts-dtfield:has(.ts-inline-card) { min-width: 100%; max-width: none; width: 100%; }
  .ts-field.ts-narrow select { width: 112px; }
  .ts-row .ts-field:first-child { flex: 1 1 auto; min-width: 240px; max-width: 340px; }
  .ts-row .ts-field:first-child input:not(.ts-time-input) { width: 100%; }
  .ts-now, .ts-clear { height: 30px; padding: 0 14px; cursor: pointer; color: var(--muted); font-size: var(--fs-sm); border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel-2); transition: all var(--transition); }
  .ts-now { display: inline-flex; align-items: center; gap: 6px; }
  .ts-now span { display: inline-flex; }
  :global(.ts-now svg) { width: 13px; height: 13px; }
  .ts-now:hover, .ts-clear:hover { color: var(--text); border-color: var(--line); background: var(--hover); }
  .ts-tip { margin: 0; color: var(--muted-2); font-size: var(--fs-sm); line-height: 1.6; }
  .ts-nowrow { align-items: center; }
  .ts-live-label { color: var(--muted); font-size: var(--fs-sm); }

  .ts-input-wrap { position: relative; display: flex; align-items: stretch; }
  .ts-input-wrap .ts-now-inline { right: 4px; }
  .ts-input-wrap input { height: 44px; padding-left: 36px; padding-right: 60px; border: 1.5px solid var(--line); background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 3%, var(--bg)), var(--bg)); color: var(--text); font: 550 var(--fs-sm) 'Cascadia Code', Consolas, monospace; outline: 0; box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 4%, transparent); transition: border-color .15s ease, box-shadow .2s ease, background .15s ease; }
  .ts-input-wrap.ts-ts-wrap { width: 100%; }
  .ts-input-wrap.ts-ts-wrap input { padding-left: 12px; padding-right: 64px; }
  .ts-input-wrap.ts-ts-wrap .ts-now-inline { right: 5px; }
  .ts-input-wrap input::selection { background: color-mix(in srgb, var(--accent) 35%, transparent); }
  .ts-input-wrap input:hover { border-color: var(--line-strong); }
  .ts-input-wrap input:focus { border-color: color-mix(in srgb, var(--accent) 65%, var(--line)); box-shadow: 0 0 0 3.5px var(--accent-soft), 0 0 16px color-mix(in srgb, var(--accent) 14%, transparent); background: color-mix(in srgb, var(--accent) 3%, var(--bg)); }
  .ts-inline-card { position: relative; margin-top: 2px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 13px; background: linear-gradient(150deg, color-mix(in srgb, var(--accent) 8%, var(--panel)), var(--panel-2) 60%); box-shadow: 0 8px 22px color-mix(in srgb, var(--accent) 10%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent); }
  .ts-to-date-card { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 9px; animation: tsCardIn .22s cubic-bezier(.2,.9,.3,1.1); }
  @keyframes tsCardIn { from { opacity: 0; transform: translateY(4px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
  .ts-inline-utc { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 5px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--w-03); }
  .ts-inline-utc small { flex: 0 0 52px; color: var(--muted-2); font: 600 var(--fs-tiny) 'Cascadia Code', monospace; }
  .ts-inline-utc b { min-width: 0; overflow: hidden; color: var(--text); font: 500 var(--fs-xs) 'Cascadia Code', Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .ts-inline-card::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(120px 60px at 12% 0%, color-mix(in srgb, var(--c-cyan) 12%, transparent), transparent 70%); }
  .ts-inline-local { position: relative; display: flex; align-items: baseline; gap: 9px; padding: 11px 13px 5px; }
  .ts-inline-local span { color: var(--muted); font-size: var(--fs-tiny); letter-spacing: .4px; }
  .ts-inline-local b { font: 700 calc(var(--fs) + 3px)/1.2 'Cascadia Code', Consolas, monospace; color: var(--text); font-variant-numeric: tabular-nums; letter-spacing: .2px; }
  .ts-inline-local em { color: var(--accent); font: 600 var(--fs-xs) sans-serif; font-style: normal; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); }
  .ts-inline-local i { color: var(--c-green); font: 600 var(--fs-xs) sans-serif; font-style: normal; }
  .ts-inline-cols { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 7px; padding: 6px 13px 12px; }
  .ts-now-inline { position: absolute; right: 5px; height: 26px; padding: 0 11px; cursor: pointer; color: var(--accent); font-size: var(--fs-xs); font-weight: 700; border: 0; border-radius: 8px; background: var(--accent-soft); transition: all .15s ease; }
  .ts-now-inline:hover { background: color-mix(in srgb, var(--accent) 24%, transparent); box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 20%, transparent); }

  .ts-live-clock { display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 10px; background: color-mix(in srgb, var(--accent) 7%, var(--panel)); }
  .ts-live-clock i { width: 7px; height: 7px; border-radius: 50%; background: var(--c-green); box-shadow: 0 0 8px color-mix(in srgb, var(--c-green) 70%, transparent); animation: tsLive 2s ease infinite; }
  @keyframes tsLive { 50% { opacity: .35; } }
  .ts-live-clock b { font: 600 var(--fs-sm) 'Cascadia Code', Consolas, monospace; letter-spacing: .4px; font-variant-numeric: tabular-nums; }
  .ts-live-clock small { color: var(--muted-2); font-size: var(--fs-xs); }

/* 自定义日期选择器 */
  .ts-pick-box { position: relative; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 6px 0 12px; border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--line)); border-radius: 12px; background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 5%, var(--w-04)), var(--w-02)); transition: border-color .15s ease, box-shadow .2s ease, transform .15s ease; flex-wrap: wrap; row-gap: 4px; height: auto; min-height: 44px; padding-bottom: 6px; }
  .ts-pick-box:not(:has(.ts-time-presets)) { height: 44px; padding-bottom: 6px; }
  .ts-pick-box:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); box-shadow: 0 4px 18px color-mix(in srgb, var(--accent) 14%, transparent); }
  .ts-pick-box.open { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent), 0 6px 22px color-mix(in srgb, var(--accent) 16%, transparent); }
  .ts-pick-box.picked { animation: tsPickFlash .55s cubic-bezier(.2, .9, .3, 1.2); }
  @keyframes tsPickFlash { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); transform: translateY(0); } 40% { box-shadow: 0 0 0 6px transparent, 0 8px 26px color-mix(in srgb, var(--accent) 22%, transparent); transform: translateY(-1px); } 100% { box-shadow: 0 0 0 0 transparent; transform: translateY(0); } }
  .ts-date-week { color: var(--accent); font: 600 var(--fs-tiny) sans-serif; font-style: normal; padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); }
  .ts-pick-date { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px 0 6px; cursor: pointer; color: var(--text); font: 600 var(--fs-sm) 'Cascadia Code', Consolas, monospace; border: 0; border-radius: 8px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 15%, var(--w-06)), var(--w-06)); transition: background .15s ease, transform .15s ease; flex: 0 0 auto; }
  .ts-pick-date:hover { background: color-mix(in srgb, var(--accent) 22%, var(--w-06)); transform: translateY(-1px); }
  .ts-pick-date b { font-weight: 650; letter-spacing: .4px; }
  .ts-cal-ico { display: inline-flex; color: var(--accent); }
  .ts-cal-ico :global(svg) { width: 15px; height: 15px; }
  .ts-cal-caret { display: inline-flex; color: var(--muted); transition: transform .2s ease; }
  .ts-pick-box.open .ts-cal-caret { transform: rotate(180deg); }
  .ts-pick-sep { color: var(--muted-2); }
  .ts-time-input { width: 96px; height: 32px; padding: 0 8px; color: var(--text); font: 600 var(--fs-sm) 'Cascadia Code', Consolas, monospace; text-align: center; border: 1px solid var(--line-2); border-radius: 8px; outline: 0; background: var(--w-04); transition: border-color .15s ease, box-shadow .2s ease; }
  .ts-time-wrap { position: relative; display: inline-flex; align-items: center; flex: 0 0 auto; }
  .ts-time-wrap .ts-clock-ico { position: absolute; left: 8px; display: inline-flex; color: var(--muted-2); pointer-events: none; }
  .ts-time-wrap .ts-clock-ico :global(svg) { width: 13px; height: 13px; }
  .ts-time-wrap .ts-time-input { width: 118px; padding: 0 8px 0 27px; text-align: left; }
  .ts-time-presets { display: inline-flex; gap: 4px; flex: 1 1 auto; flex-wrap: wrap; padding-right: 58px; }
  .ts-time-presets button { height: 26px; padding: 0 8px; cursor: pointer; color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', Consolas, monospace; border: 1px solid var(--line-2); border-radius: 7px; background: var(--w-03); transition: all .15s ease; }
  .ts-time-presets button:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line-2)); background: var(--accent-soft); }
  .ts-time-presets button.active { color: #fff; background: var(--btn-gradient); border-color: transparent; box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 35%, transparent); }
  .ts-time-input:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--line-2)); }
  .ts-time-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
  .ts-now-inline { height: 32px; padding: 0 12px; cursor: pointer; color: var(--accent); font-size: var(--fs-xs); font-weight: 650; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line-2)); border-radius: 8px; background: var(--accent-soft); transition: all .15s ease; }
  .ts-pick-box .ts-now-inline { position: static; top: auto; transform: none; }
  .ts-now-inline:hover { transform: translateY(-1px); box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 22%, transparent); }
  /* 日历弹层 */
  .ts-cal { position: absolute; top: calc(100% + 8px); left: 0; z-index: 60; width: 268px; padding: 10px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 14px; background: linear-gradient(170deg, var(--glass-strong), var(--bg2)); box-shadow: 0 18px 46px rgba(3, 5, 10, .4), 0 0 0 1px rgba(129, 140, 248, .12); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); animation: ts-cal-in .18s cubic-bezier(.2, .9, .3, 1.15); }
  @keyframes ts-cal-in { from { opacity: 0; transform: translateY(-6px) scale(.97); } }
  .ts-cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .ts-cal-head b { font-size: var(--fs-sm); font-weight: 700; }
  .ts-cal-head button { width: 26px; height: 26px; display: grid; place-items: center; cursor: pointer; color: var(--muted); font-size: 15px; line-height: 1; border: 1px solid var(--line); border-radius: 8px; background: var(--w-04); transition: all .15s ease; }
  .ts-cal-head button:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); }
  .ts-cal-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin-bottom: 4px; }
  .ts-cal-week span { text-align: center; color: var(--muted-2); font-size: 10.5px; line-height: 24px; }
  .ts-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .ts-cal-grid button, .ts-cal-empty { height: 30px; border-radius: 8px; }
  .ts-cal-grid button { cursor: pointer; color: var(--text); font-size: var(--fs-xs); border: 1px solid transparent; background: transparent; transition: all .13s ease; }
  .ts-cal-grid button:hover { background: var(--w-06); border-color: var(--line-2); transform: translateY(-1px); }
  .ts-cal-grid button.today { border-color: color-mix(in srgb, var(--accent) 55%, transparent); color: var(--accent); font-weight: 700; }
  .ts-cal-grid button.selected { color: #fff; background: var(--btn-gradient); border-color: transparent; box-shadow: 0 4px 14px rgba(129, 140, 248, .45); }
  .ts-cal-foot { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
  .ts-cal-foot button { height: 26px; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line-2); border-radius: 8px; background: var(--w-03); transition: all .15s ease; }
  .ts-cal-foot button:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line-2)); background: var(--accent-soft); }
  .ts-inline-card-pop { animation: ts-card-pop .28s cubic-bezier(.2, .9, .3, 1.2); }
  @keyframes ts-card-pop { from { opacity: 0; transform: translateY(6px) scale(.98); } }

  /* v56: 输入与交互升级 */
  .ts-modes button { height: 34px; padding: 0 16px; font-size: var(--fs-sm); border-radius: 10px; gap: 8px; background: linear-gradient(160deg, var(--w-05), var(--w-02)); border-color: var(--line-2); }
  .ts-modes button:hover { transform: translateY(-1px); box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 12%, transparent); }
  .ts-modes button.active { background: linear-gradient(120deg, var(--c-cyan), var(--accent) 55%, var(--c-magenta)); box-shadow: 0 5px 18px color-mix(in srgb, var(--accent) 38%, transparent); transform: translateY(-1px); }
  .ts-modes b { font-size: var(--fs-sm); }
  .ts-field > span { font-weight: 650; letter-spacing: .3px; }
  .ts-field input, .ts-field select { height: 44px; border-radius: 12px; border-color: var(--line-2); background: linear-gradient(160deg, var(--w-05), var(--bg)); font-size: var(--fs); }
  .ts-field input:focus, .ts-field select:focus { border-color: color-mix(in srgb, var(--accent) 70%, var(--line)); box-shadow: 0 0 0 4px var(--accent-soft), 0 6px 20px color-mix(in srgb, var(--accent) 14%, transparent); }
  .ts-field select { appearance: none; -webkit-appearance: none; padding-right: 34px; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 18px) 20px, calc(100% - 13px) 20px; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; cursor: pointer; }
  .ts-field select:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .ts-input-wrap { position: relative; display: flex; align-items: center; }
  .ts-input-wrap input { width: 100%; min-width: 0; }
  .ts-now-inline { top: auto; transform: none; position: static; height: 38px; flex: 0 0 auto; border-radius: 10px; background: linear-gradient(120deg, color-mix(in srgb, var(--c-cyan) 16%, var(--bg)), var(--accent-soft)); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .ts-now-inline:hover { transform: translateY(-1px); box-shadow: 0 5px 16px color-mix(in srgb, var(--accent) 22%, transparent); }
  .ts-clear { height: 38px; border-radius: 10px; }
  .ts-quick button { height: 30px; padding: 0 13px; font-size: var(--fs-sm); }
  .ts-time-input { height: 38px !important; border-radius: 10px !important; }
  .ts-pick-box { border-radius: 14px; }
  .ts-pick-date { height: 38px; border-radius: 10px; }

  .ts-pick-date { display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 14px; cursor: pointer; color: var(--text); font: 650 var(--fs-sm) 'Cascadia Code', Consolas, monospace; border: 1.5px solid var(--line); border-radius: 10px; background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 10%, var(--bg)), var(--bg)); box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 4%, transparent); transition: all .18s ease; }
  .ts-pick-date:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 16%, transparent); transform: translateY(-1px); }
  .ts-pick-date:active { transform: translateY(0); }
  .ts-pick-date::before { content: ""; width: 13px; height: 13px; border-radius: 4px; border: 1.5px solid var(--accent); background: linear-gradient(135deg, color-mix(in srgb, var(--c-cyan) 30%, transparent), color-mix(in srgb, var(--c-magenta) 26%, transparent)); }
  .ts-time-input { height: 38px; padding: 0 12px; font: 650 var(--fs-sm) 'Cascadia Code', Consolas, monospace; text-align: center; letter-spacing: .5px; }
  .ts-field .ts-pick-date:focus, .ts-time-input:focus { border-color: color-mix(in srgb, var(--accent) 65%, var(--line)); box-shadow: 0 0 0 3.5px var(--accent-soft), 0 0 16px color-mix(in srgb, var(--accent) 14%, transparent); outline: 0; }
  .ts-row { display: flex; align-items: center; gap: 10px; }
</style>
