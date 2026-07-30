<script lang="ts">
  import { highlightCode } from '../highlight';
  import type { PluginResult } from '../plugins';
  import JsonView from './JsonView.svelte';

  export let result: PluginResult;

  function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  function display(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return '—';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  }

  function isComplexJson(output: string, language?: string): boolean {
    if (language !== 'json') return false;
    try {
      const parsed = JSON.parse(output);
      return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0;
    } catch { return false; }
  }

  $: data = record(result.data);
  $: items = list(result.data);
  $: useTreeView = isComplexJson(result.output, result.language) && result.view !== 'jwt' && result.view !== 'matches';
</script>

<div class="result-view">
  {#if result.view === 'timestamp' && Object.keys(data).length}
    <div class="time-hero">
      <small>本地时间</small>
      <strong>{display(data.local)}</strong>
      <span>{display(data.timezone)}</span>
    </div>
    <div class="value-grid time-grid">
      <article><small>UTC / ISO 8601</small><b>{display(data.utc)}</b></article>
      <article><small>Unix 秒</small><b>{display(data.unixSeconds)}</b></article>
      <article><small>Unix 毫秒</small><b>{display(data.unixMilliseconds)}</b></article>
    </div>
  {:else if result.view === 'http' && Object.keys(data).length}
    <div class="http-overview">
      <span class:good={Number(data.status) >= 200 && Number(data.status) < 400} class:bad={Number(data.status) >= 400}>{display(data.status)}</span>
      <div><b>{display(data.statusText || 'HTTP 响应')}</b><small>{display(data.method)} · {display(data.url)}</small></div>
      <aside><b>{display(data.durationMs)} ms</b><small>{display(data.sizeBytes)} B</small></aside>
    </div>
    <div class="http-response">
      <header><span>响应体</span><small>{display(data.contentType || '未知内容类型')}</small></header>
      {#if data.body}<pre>{@html highlightCode(display(data.body), display(data.language))}</pre>{:else}<div class="structured-empty"><span>∅</span><b>响应体为空</b><small>该请求只返回了状态和响应头。</small></div>{/if}
    </div>
    <details class="raw-details"><summary>响应头 · {Object.keys(record(data.headers)).length} 项</summary><pre>{@html highlightCode(JSON.stringify(data.headers ?? {}, null, 2), 'json')}</pre></details>
  {:else if result.view === 'jwt' && Object.keys(data).length}
    <div class="jwt-overview">
      <span class:good={data.valid === true} class:bad={data.valid === false || data.expired === true}>
        {data.valid === true ? '签名有效' : data.valid === false ? '签名无效' : data.expired === true ? '令牌已过期' : '已解码 · 未验签'}
      </span>
      <b>{display(record(data.header).alg || '未知算法')}</b>
      {#if data.expiresAt}<small>过期时间 {display(data.expiresAt)}</small>{/if}
    </div>
    <div class="jwt-sections">
      <article>
        <header><span>HEADER</span><small>头部</small></header>
        <pre>{@html highlightCode(JSON.stringify(data.header ?? {}, null, 2), 'json')}</pre>
      </article>
      <article>
        <header><span>PAYLOAD</span><small>载荷</small></header>
        <pre>{@html highlightCode(JSON.stringify(data.payload ?? {}, null, 2), 'json')}</pre>
      </article>
    </div>
    {#if data.token}
      <details class="raw-details"><summary>查看完整令牌</summary><code>{display(data.token)}</code></details>
    {/if}
  {:else if result.view === 'stats' && Object.keys(data).length}
    <div class="stats-grid">
      {#each Object.entries(data) as [key, value]}
        <article><strong>{display(value)}</strong><span>{key}</span></article>
      {/each}
    </div>
  {:else if result.view === 'matches'}
    <div class="match-list">
      {#if items.length}
        {#each items as item, index}
          <article>
            <span class="match-index">#{index + 1}</span>
            <code>{display(record(item).value ?? item)}</code>
            {#if record(item).index !== undefined}<small>位置 {display(record(item).index)}</small>{/if}
            {#if Object.keys(record(record(item).groups)).length}<pre>{@html highlightCode(JSON.stringify(record(item).groups, null, 2), 'json')}</pre>{/if}
          </article>
        {/each}
      {:else}
        <div class="structured-empty"><span>∅</span><b>没有匹配结果</b><small>输入内容中没有找到符合当前表达式的片段。</small></div>
      {/if}
    </div>
  {:else if result.view === 'list' && items.length}
    <div class="result-list">
      {#each items as item, index}
        <article><span>{String(index + 1).padStart(2, '0')}</span><code>{display(item)}</code></article>
      {/each}
    </div>
  {:else if result.view === 'hash' && Object.keys(data).length}
    <div class="hash-card">
      <div><small>{display(data.algorithm)}</small><span>{display(data.bits)} 位摘要</span></div>
      <code>{display(data.digest ?? result.output)}</code>
    </div>
  {:else}
    {#if useTreeView}
      <JsonView jsonString={result.output} />
    {:else}
      <pre class:plain={result.language === 'text'} class:highlighted={result.language === 'json'}>{@html highlightCode(result.output, result.language)}</pre>
    {/if}
  {/if}
</div>

<style>
  .result-view { min-height: 100%; padding: 18px; overflow: auto; background: var(--panel-2); }
  .result-view > pre { width: 100%; min-height: 100%; margin: 0; color: var(--text); font: 450 14px/1.72 'Cascadia Code', Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  .result-view > pre.plain { font-family: inherit; font-size: 15px; }
  small { color: var(--muted); }
  .time-hero { padding: 23px; border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--line)); border-radius: 12px; background: linear-gradient(135deg, var(--accent-soft), transparent); }
  .time-hero small { display: block; margin-bottom: 8px; font-size: 11px; }
  .time-hero strong { display: block; font: 650 26px/1.25 'Cascadia Code', Consolas, monospace; letter-spacing: -.8px; }
  .time-hero span { display: inline-flex; margin-top: 12px; padding: 4px 8px; color: var(--accent); font-size: 10px; border-radius: 5px; background: var(--accent-soft); }
  .value-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
  .value-grid article { min-width: 0; padding: 15px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .value-grid small { display: block; margin-bottom: 8px; font-size: 10px; }
  .value-grid b { display: block; overflow-wrap: anywhere; font: 550 13px/1.55 'Cascadia Code', monospace; }
  .time-grid article:first-child { grid-column: 1 / -1; }
  .jwt-overview { display: flex; align-items: center; gap: 10px; margin-bottom: 11px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .jwt-overview > span { padding: 4px 8px; color: var(--blue); font-size: 10px; border-radius: 5px; background: color-mix(in srgb, var(--blue) 10%, transparent); }
  .jwt-overview > span.good { color: var(--accent); background: var(--accent-soft); }
  .jwt-overview > span.bad { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, transparent); }
  .jwt-overview b { font: 600 12px 'Cascadia Code', monospace; }
  .jwt-overview small { margin-left: auto; font-size: 10px; }
  .jwt-sections { display: grid; grid-template-columns: minmax(190px, .72fr) minmax(260px, 1.28fr); gap: 10px; }
  .jwt-sections article { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .jwt-sections header { display: flex; align-items: center; justify-content: space-between; padding: 9px 11px; border-bottom: 1px solid var(--line); }
  .jwt-sections header span { color: var(--accent); font: 650 10px 'Cascadia Code', monospace; }
  .jwt-sections header small { font-size: 9px; }
  .jwt-sections pre { max-height: 310px; margin: 0; padding: 13px; overflow: auto; color: var(--text); font: 450 12px/1.65 'Cascadia Code', monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .raw-details { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .raw-details summary { cursor: pointer; color: var(--muted); font-size: 10px; }
  .raw-details code { display: block; margin-top: 9px; overflow-wrap: anywhere; font-size: 11px; line-height: 1.6; }
  .raw-details pre { margin: 9px 0 0; padding: 11px; overflow: auto; font: 450 11px/1.6 'Cascadia Code', monospace; border-radius: 6px; background: var(--bg); }
  .http-overview { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; padding: 13px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .http-overview > span { width: 50px; height: 42px; display: grid; place-items: center; flex: 0 0 auto; color: var(--blue); font: 700 16px 'Cascadia Code', monospace; border-radius: 7px; background: color-mix(in srgb, var(--blue) 10%, transparent); }
  .http-overview > span.good { color: var(--accent); background: var(--accent-soft); }.http-overview > span.bad { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, transparent); }
  .http-overview > div { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 4px; }.http-overview > div b { font-size: 13px; }.http-overview > div small { overflow: hidden; font: 10px 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .http-overview aside { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }.http-overview aside b { color: var(--accent); font: 600 12px 'Cascadia Code', monospace; }.http-overview aside small { font-size: 9px; }
  .http-response { overflow: hidden; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .http-response > header { display: flex; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--line); }.http-response header span { font-size: 11px; font-weight: 700; }.http-response header small { font-size: 9px; }
  .http-response > pre { max-height: 430px; margin: 0; padding: 15px; overflow: auto; color: var(--text); font: 450 12px/1.65 'Cascadia Code', monospace; white-space: pre-wrap; word-break: break-word; }
  .stats-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .stats-grid article { min-height: 94px; display: flex; flex-direction: column; justify-content: center; padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .stats-grid strong { color: var(--accent); font: 650 24px 'Cascadia Code', monospace; }
  .stats-grid span { margin-top: 7px; color: var(--muted); font-size: 11px; }
  .match-list, .result-list { display: flex; flex-direction: column; gap: 8px; }
  .match-list article, .result-list article { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .match-index, .result-list article > span { flex: 0 0 auto; color: var(--accent); font: 600 10px 'Cascadia Code', monospace; }
  .match-list code, .result-list code { min-width: 0; flex: 1; overflow-wrap: anywhere; color: var(--text); font: 500 13px/1.55 'Cascadia Code', monospace; }
  .match-list article > small { flex: 0 0 auto; font-size: 9px; }
  .match-list pre { width: 100%; margin: 8px 0 0; padding: 8px; font: 11px/1.5 'Cascadia Code', monospace; border-radius: 5px; background: var(--bg); }
  .hash-card { overflow: hidden; border: 1px solid var(--line); border-radius: 11px; background: var(--panel); }
  .hash-card > div { display: flex; align-items: center; justify-content: space-between; padding: 12px 15px; border-bottom: 1px solid var(--line); }
  .hash-card > div small { color: var(--accent); font: 650 11px 'Cascadia Code', monospace; }
  .hash-card > div span { color: var(--muted); font-size: 10px; }
  .hash-card > code { display: block; padding: 22px; overflow-wrap: anywhere; color: var(--text); font: 550 15px/1.8 'Cascadia Code', monospace; letter-spacing: .4px; }
  .structured-empty { min-height: 180px; display: grid; place-content: center; justify-items: center; gap: 6px; color: var(--muted); text-align: center; border: 1px dashed var(--line-2); border-radius: 10px; }
  .structured-empty > span { color: var(--accent); font-size: 28px; }.structured-empty b { color: var(--text); font-size: 12px; }.structured-empty small { font-size: 10px; }
  @media (max-width: 900px) { .jwt-sections { grid-template-columns: 1fr; } .stats-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
