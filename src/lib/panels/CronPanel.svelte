<script lang="ts">
  import type { PluginResult } from '../plugins/types';

  let { session, onChangeAction, onChangeOption, onClear }: {
    session: { actionId: string; options: Record<string,string>; input: string; result: PluginResult | null; error: string; processing: boolean };
    onChangeAction: (id: string) => void;
    onChangeOption: (id: string, v: string) => void;
    onClear: () => void;
  } = $props();

  const H = Array.from({length:24},(_,i)=>String(i).padStart(2,'0'));
  const M = Array.from({length:60},(_,i)=>String(i).padStart(2,'0'));

  const types = [
    {v:'minutes',l:'每 N 分钟'},{v:'hourly',l:'每小时整点'},
    {v:'daily',l:'每天定时'},{v:'workdays',l:'每个工作日'},
    {v:'weekly',l:'每周'},{v:'monthly',l:'每月'},
  ];
</script>

<div class="cron-panel">
  <div class="cron-row">
    <label><span>频率</span>
      <select value={session.options.type||'daily'} onchange={e => onChangeOption('type', e.currentTarget.value)}>
        {#each types as t}<option value={t.v}>{t.l}</option>{/each}
      </select>
    </label>

    {#if session.options.type === 'minutes'}
      <label><span>间隔</span>
        <select value={session.options.interval||'5'} onchange={e => onChangeOption('interval', e.currentTarget.value)}>
          {#each Array.from({length:59},(_,i)=>String(i+1)) as v}
            <option value={v}>{v} 分钟</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if ['daily','workdays','weekly','monthly'].includes(session.options.type||'daily')}
      <label><span>时间</span>
        <select value={session.options.hour||'09'} onchange={e => onChangeOption('hour', e.currentTarget.value)} style="width:72px">
          {#each H as v}<option value={v}>{v}:00</option>{/each}
        </select>
        <span style="margin:0 2px">:</span>
        <select value={session.options.minute||'00'} onchange={e => onChangeOption('minute', e.currentTarget.value)} style="width:72px">
          {#each M as v}<option value={v}>{v}</option>{/each}
        </select>
      </label>
    {/if}

    {#if session.options.type === 'weekly'}
      <label><span>星期</span>
        <select value={session.options.weekday||'1'} onchange={e => onChangeOption('weekday', e.currentTarget.value)}>
          <option value="0">周日</option><option value="1">周一</option><option value="2">周二</option>
          <option value="3">周三</option><option value="4">周四</option><option value="5">周五</option><option value="6">周六</option>
        </select>
      </label>
    {/if}

    {#if session.options.type === 'monthly'}
      <label><span>日期</span>
        <select value={session.options.monthDay||'1'} onchange={e => onChangeOption('monthDay', e.currentTarget.value)}>
          {#each Array.from({length:31},(_,i)=>String(i+1)) as v}<option value={v}>{v} 号</option>{/each}
        </select>
      </label>
    {/if}
  </div>

  <div class="cron-actions">
    <button class:active={session.actionId==='generate'} onclick={()=>onChangeAction('generate')}>生成</button>
    <button class:active={session.actionId==='explain'} onclick={()=>onChangeAction('explain')}>解析已有</button>
    <button class:active={session.actionId==='next'} onclick={()=>onChangeAction('next')}>执行时间</button>
    <div class="control-spacer"></div>
    <button class="cron-clear" onclick={onClear}>清空</button>
  </div>
</div>

<style>
  .cron-panel { display:flex; flex-direction:column; gap:8px; width:100%; }
  .cron-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .cron-row label { display:flex; align-items:center; gap:5px; white-space:nowrap; }
  .cron-row label > span { color:var(--muted); font-size:11px; min-width:28px; }
  .cron-row select { height:32px; color:var(--text); font-size:12px; border:1px solid var(--line); border-radius:5px; outline:0; background:var(--bg); padding:0 8px; cursor:pointer; }
  .cron-actions { display:flex; gap:4px; align-items:center; }
  .cron-actions button { height:30px; padding:0 12px; cursor:pointer; color:var(--muted); font-size:11px; border:1px solid var(--line); border-radius:5px; background:transparent; }
  .cron-actions button.active { color:var(--text); background:var(--panel-2); border-color:var(--line-2); }
  .cron-actions button:hover { background:var(--hover); }
  .cron-clear { height:30px; padding:0 10px; cursor:pointer; color:var(--muted); font-size:10px; border:1px solid transparent; border-radius:5px; background:transparent; }
  .cron-clear:hover { color:var(--text); border-color:var(--line); }
  .control-spacer { flex:1; }
</style>
