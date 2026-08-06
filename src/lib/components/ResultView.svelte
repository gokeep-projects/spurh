<script lang="ts">
  import { highlightCode } from '../highlight';
  import type { PluginResult } from '../plugins';
  import JsonView from './JsonView.svelte';

  let { result }: { result: PluginResult } = $props();

  let copiedKey = $state('');

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

  async function copyText(value: string, key = ''): Promise<void> {
    try { await navigator.clipboard.writeText(value); } catch { return; }
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 1100);
  }

  let data = $derived(record(result.data));
  let items = $derived(list(result.data));
  let useTreeView = $derived(result.view === 'code' && isComplexJson(result.output, result.language));
  let logLevel = $state('');
  let logSearch = $state('');

  const logLevels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

  let sqlColumns = $derived(list(data.columns));
  let sqlRows = $derived(list(data.rows));
  let logEntries = $derived(list(data.entries));
  let logCounts = $derived(record(data.counts));
  let errorTotal = $derived(Number(logCounts.ERROR ?? 0) + Number(logCounts.FATAL ?? 0));
  let filteredLogs = $derived(logEntries.filter((entry) => {
    if (logLevel && record(entry).level !== logLevel) return false;
    if (logSearch) {
      const item = record(entry);
      const haystack = ((item.message ?? '') + ' ' + (item.source ?? '') + ' ' + (item.raw ?? '') + ' ' + (Array.isArray(item.stack) ? item.stack : []).join(' ')).toLowerCase();
      if (!haystack.includes(logSearch.toLowerCase())) return false;
    }
    return true;
  }));

  function cell(row: unknown, index: number): unknown {
    return Array.isArray(row) ? row[index] : undefined;
  }

  function levelClass(level: unknown): string {
    return String(level ?? '').toLowerCase() || 'none';
  }

  function stackText(value: unknown): string {
    return Array.isArray(value) ? value.join('\n') : '';
  }

  function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightStack(text: string): string {
    return text
      .split('\n')
      .map((line) => {
        if (/Caused by:/i.test(line)) return '<span class="stack-cause">' + escapeHtml(line) + '</span>';
        if (/\b(?:Error|Exception|Fatal)\b/.test(line)) return '<span class="stack-error">' + escapeHtml(line) + '</span>';
        const at = line.match(/at\s+[\w.$<>]+(?:\.[\w$<>]+)+\(/);
        if (at) {
          // 先整体转义整行,再按原始位置插入高亮 span,避免行内其余部分被注入
          const i = line.indexOf(at[0]);
          return (
            escapeHtml(line.slice(0, i)) +
            '<span class="stack-at">' + escapeHtml(at[0]) + '</span>' +
            escapeHtml(line.slice(i + at[0].length))
          );
        }
        return escapeHtml(line);
      })
      .join('\n');
  }

</script>

<div class="result-view" class:tree-mode={useTreeView}>
  {#if result.view === 'timestamp' && Object.keys(data).length}
    <div class="time-hero">
      <small>本地时间</small>
      <strong>{display(data.local)}</strong>
      <span>{display(data.timezone)}</span>
    </div>
    <div class="value-grid time-grid">
      <article>
        <small>UTC / ISO 8601</small>
        <b>{display(data.utc)}</b>
        <button class="copy-btn" onclick={() => copyText(display(data.utc), 'utc')}>{copiedKey === 'utc' ? '已复制 ✓' : '复制'}</button>
      </article>
      <article>
        <small>Unix 秒</small>
        <b>{display(data.unixSeconds)}</b>
        <button class="copy-btn" onclick={() => copyText(display(data.unixSeconds), 'sec')}>{copiedKey === 'sec' ? '已复制 ✓' : '复制'}</button>
      </article>
      <article>
        <small>Unix 毫秒</small>
        <b>{display(data.unixMilliseconds)}</b>
        <button class="copy-btn" onclick={() => copyText(display(data.unixMilliseconds), 'ms')}>{copiedKey === 'ms' ? '已复制 ✓' : '复制'}</button>
      </article>
      <article>
        <small>本地时间</small>
        <b>{display(data.local)}</b>
        <button class="copy-btn" onclick={() => copyText(display(data.local), 'local')}>{copiedKey === 'local' ? '已复制 ✓' : '复制'}</button>
      </article>
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
      <details class="raw-details"><summary>查看完整令牌</summary><code>{display(data.token)}</code><button class="copy-btn block" onclick={() => copyText(display(data.token), 'jwt')}>{copiedKey === 'jwt' ? '已复制 ✓' : '复制令牌'}</button></details>
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
          {@const row = record(item)}
          <article>
            <span class="match-index">#{index + 1}</span>
            <code>{display(row.value ?? item)}</code>
            {#if row.index !== undefined}<small>位置 {display(row.index)}</small>{/if}
            <button class="copy-btn" onclick={() => copyText(display(row.value ?? item), `m${index}`)}>{copiedKey === `m${index}` ? '已复制 ✓' : '复制'}</button>
            {#if Object.keys(record(row.groups)).length}<pre>{@html highlightCode(JSON.stringify(row.groups, null, 2), 'json')}</pre>{/if}
          </article>
        {/each}
      {:else}
        <div class="structured-empty"><span>∅</span><b>没有匹配结果</b><small>输入内容中没有找到符合当前表达式的片段。</small></div>
      {/if}
    </div>
  {:else if result.view === 'list' && items.length}
    <div class="result-list">
      {#each items as item, index}
        <article>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <code>{display(item)}</code>
          <button class="copy-btn" onclick={() => copyText(display(item), `l${index}`)}>{copiedKey === `l${index}` ? '已复制 ✓' : '复制'}</button>
        </article>
      {/each}
    </div>
  {:else if result.view === 'hash' && Object.keys(data).length}
    <div class="hash-card">
      <div><small>{display(data.algorithm)}</small><span>{display(data.bits)} 位摘要</span></div>
      <code>{display(data.digest ?? result.output)}</code>
      <div class="hash-copy"><button class="copy-btn" onclick={() => copyText(display(data.digest ?? result.output), 'hash')}>{copiedKey === 'hash' ? '已复制 ✓' : '复制摘要'}</button></div>
    </div>
  {:else if result.view === 'sql' && Object.keys(data).length}
    <div class="sql-view">
      <div class="sql-bar">
        <span class:query={data.isQuery === true} class:write={data.isQuery !== true}>{data.isQuery === true ? 'QUERY' : 'AFFECTED'}</span>
        <b>{data.isQuery === true ? sqlRows.length + ' 行结果' : '影响 ' + (data.affected ?? 0) + ' 行'}</b>
        <small>{display(data.elapsedMs)} ms</small>
        {#if data.truncated === true}<em class="sql-truncated">结果已截断</em>{/if}
        {#if sqlColumns.length > 0}
          <button class="copy-btn" onclick={() => copyText(JSON.stringify(sqlRows, null, 2), 'sql')}>{copiedKey === 'sql' ? '已复制 ✓' : '复制 JSON'}</button>
        {/if}
      </div>
      {#if sqlColumns.length > 0}
        <div class="sql-table-wrap">
          <table class="sql-table">
            <thead><tr>{#each sqlColumns as col}<th>{display(col)}</th>{/each}</tr></thead>
            <tbody>
              {#each sqlRows as row}
                <tr>
                  {#each sqlColumns as col, ci}
                    <td title={display(cell(row, ci))}>{display(cell(row, ci))}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="structured-empty sql-empty"><span>✓</span><b>执行成功</b><small>{display(data.affected ?? 0)} 行受影响 · {display(data.elapsedMs)} ms</small></div>
      {/if}
    </div>
  {:else if result.view === 'log' && Object.keys(data).length}
    <div class="log-view">
      <div class="log-overview">
        <span class="log-format">{display(data.format).toUpperCase()}</span>
        <b>{logEntries.length} 条记录</b>
        {#if errorTotal > 0}<em class="log-errors">{errorTotal} 条错误</em>{/if}
        <button class="copy-btn" onclick={() => copyText(result.output, 'log')}>{copiedKey === 'log' ? '已复制 ✓' : '复制原文'}</button>
      </div>
      {#if typeof data.rootCause === 'string' && data.rootCause}
        <div class="log-root-cause">
          <span>根因</span>
          <code>{display(data.rootCause)}</code>
          <button class="copy-btn" onclick={() => copyText(display(data.rootCause), 'root')}>{copiedKey === 'root' ? '已复制 ✓' : '复制'}</button>
        </div>
      {/if}
      <div class="log-filters">
        <button class:active={logLevel === ''} onclick={() => (logLevel = '')}>全部<span>{logEntries.length}</span></button>
        {#each logLevels as level}
          {@const count = Number(logCounts[level] ?? 0)}
          {#if count > 0 || logLevel === level}
            <button class:active={logLevel === level} class:lvl={level.toLowerCase()} onclick={() => (logLevel = logLevel === level ? '' : level)}>{level}<span>{count}</span></button>
          {/if}
        {/each}
        <input class="log-search" bind:value={logSearch} placeholder="搜索消息 / 源码 / 堆栈…" />
      </div>
      {#if filteredLogs.length > 0}
        <div class="log-list">
          {#each filteredLogs as entry}
            {@const e = record(entry)}
            <article class="log-entry" class:error={e.level === 'ERROR' || e.level === 'FATAL'}>
              <span class="log-line">{display(e.line)}</span>
              {#if e.time}<time>{display(e.time)}</time>{/if}
              {#if e.level}<b class="log-level {levelClass(e.level)}">{display(e.level)}</b>{/if}
              {#if e.source}<small class="log-source">{display(e.source)}</small>{/if}
              <p>{display(e.message)}</p>
              {#if Array.isArray(e.stack) && e.stack.length}
                <details class="log-stack">
                  <summary>堆栈 · {e.stack.length} 帧</summary>
                  <pre>{@html highlightStack(stackText(e.stack))}</pre>
                </details>
              {/if}
            </article>
          {/each}
        </div>
      {:else}
        <div class="structured-empty"><span>∅</span><b>没有匹配的日志</b><small>调整级别过滤或搜索关键词。</small></div>
      {/if}
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
  .result-view.tree-mode { padding: 0; display: flex; flex-direction: column; }
  .result-view.tree-mode :global(.json-tree) { flex: 1; min-height: 100%; }
  .result-view > pre { width: 100%; min-height: 100%; margin: 0; color: var(--text); font: 450 14px/1.72 'Cascadia Code', Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  .result-view > pre.plain { font-family: inherit; font-size: 15px; }
  small { color: var(--muted); }
  .time-hero { padding: 23px; border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--line)); border-radius: 12px; background: linear-gradient(135deg, var(--accent-soft), transparent); }
  .time-hero small { display: block; margin-bottom: 8px; font-size: 11px; }
  .time-hero strong { display: block; font: 650 26px/1.25 'Cascadia Code', Consolas, monospace; letter-spacing: -.8px; }
  .time-hero span { display: inline-flex; margin-top: 12px; padding: 4px 8px; color: var(--accent); font-size: 10px; border-radius: 5px; background: var(--accent-soft); }
  .value-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
  .value-grid article { min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 14px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .value-grid small { display: block; font-size: 10px; }
  .value-grid b { overflow-wrap: anywhere; font: 550 13px/1.55 'Cascadia Code', monospace; }
  .time-grid article:first-child { grid-column: 1 / -1; }
  .copy-btn { align-self: flex-start; height: 24px; padding: 0 9px; cursor: pointer; color: var(--muted); font-size: 10px; border: 1px solid var(--line); border-radius: 5px; background: transparent; }
  .copy-btn:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .copy-btn.block { display: block; margin-top: 9px; }
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
  .hash-copy { padding: 10px 15px; border-top: 1px solid var(--line); }
  .structured-empty { min-height: 180px; display: grid; place-content: center; justify-items: center; gap: 6px; color: var(--muted); text-align: center; border: 1px dashed var(--line-2); border-radius: 10px; }
  .structured-empty > span { color: var(--accent); font-size: 28px; }.structured-empty b { color: var(--text); font-size: 12px; }.structured-empty small { font-size: 10px; }

  .sql-view { display: flex; flex-direction: column; gap: 12px; min-height: 100%; }
  .sql-bar { display: flex; align-items: center; gap: 10px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .sql-bar > span { padding: 3px 8px; color: var(--blue); font: 700 9px 'Cascadia Code', monospace; letter-spacing: .5px; border-radius: 5px; background: color-mix(in srgb, var(--blue) 12%, transparent); }
  .sql-bar > span.write { color: var(--accent); background: var(--accent-soft); }
  .sql-bar b { font-size: 12px; }
  .sql-bar small { font: 500 10px 'Cascadia Code', monospace; }
  .sql-bar .copy-btn { margin-left: auto; }
  .sql-truncated { padding: 3px 8px; color: var(--warn); font-size: 9px; font-style: normal; border-radius: 5px; background: var(--warn-soft); }
  .sql-table-wrap { max-height: 540px; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .sql-table { width: 100%; border-collapse: collapse; font: 450 11.5px/1.5 'Cascadia Code', monospace; }
  .sql-table th { position: sticky; top: 0; z-index: 1; padding: 9px 12px; text-align: left; color: var(--accent); font-size: 10px; font-weight: 650; white-space: nowrap; border-bottom: 1px solid var(--line); background: var(--panel-2); }
  .sql-table td { max-width: 340px; padding: 8px 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--line); }
  .sql-table tbody tr:last-child td { border-bottom: 0; }
  .sql-table tbody tr:hover td { background: var(--hover); }
  .sql-table tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--hover) 55%, transparent); }
  .sql-table tbody tr:nth-child(even):hover td { background: var(--hover); }
  .sql-empty { min-height: 150px; }
  .sql-empty > span { color: var(--accent); font-size: 26px; }
  .log-view { display: flex; flex-direction: column; gap: 12px; min-height: 100%; }
  .log-overview { display: flex; align-items: center; gap: 10px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .log-format { padding: 3px 8px; color: var(--blue); font: 700 9px 'Cascadia Code', monospace; border-radius: 5px; background: color-mix(in srgb, var(--blue) 12%, transparent); }
  .log-overview b { font-size: 12px; }
  .log-errors { padding: 3px 8px; color: var(--danger); font-size: 9px; font-style: normal; border-radius: 5px; background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .log-overview .copy-btn { margin-left: auto; }
  .log-root-cause { display: flex; align-items: center; gap: 10px; padding: 11px 13px; border: 1px solid color-mix(in srgb, var(--danger) 32%, var(--line)); border-radius: 10px; background: color-mix(in srgb, var(--danger) 6%, var(--panel)); }
  .log-root-cause > span { flex: 0 0 auto; padding: 3px 7px; color: var(--danger); font: 700 9px 'Cascadia Code', monospace; border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); border-radius: 5px; }
  .log-root-cause code { min-width: 0; flex: 1; overflow-wrap: anywhere; color: var(--text); font: 500 11.5px/1.6 'Cascadia Code', monospace; }
  .log-filters { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .log-filters button { height: 25px; display: inline-flex; align-items: center; gap: 6px; padding: 0 9px; cursor: pointer; color: var(--muted); font-size: 9.5px; border: 1px solid var(--line); border-radius: 6px; background: transparent; }
  .log-filters button span { color: var(--muted-2); font: 500 8.5px 'Cascadia Code', monospace; }
  .log-filters button.active { color: var(--text); border-color: var(--line-2); background: var(--hover); }
  :global(.log-filters button.lvl-error.active), :global(.log-filters button.lvl-fatal.active) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); background: color-mix(in srgb, var(--danger) 9%, transparent); }
  :global(.log-filters button.lvl-warn.active) { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); background: var(--warn-soft); }
  :global(.log-filters button.lvl-info.active) { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 45%, var(--line)); background: color-mix(in srgb, var(--blue) 9%, transparent); }
  .log-filters .log-search { min-width: 160px; height: 25px; flex: 1; padding: 0 9px; color: var(--text); font-size: 10.5px; border: 1px solid var(--line); border-radius: 6px; outline: 0; background: var(--panel); }
  .log-filters .log-search:focus { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .log-list { display: flex; flex-direction: column; gap: 7px; }
  .log-entry { display: grid; grid-template-columns: auto auto auto minmax(0, 1fr); align-items: baseline; gap: 4px 9px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .log-entry.error { border-color: color-mix(in srgb, var(--danger) 30%, var(--line)); background: color-mix(in srgb, var(--danger) 4%, var(--panel)); }
  .log-line { color: var(--muted-2); font: 500 9px 'Cascadia Code', monospace; }
  .log-entry time { color: var(--muted); font: 450 9.5px 'Cascadia Code', monospace; }
  .log-level { padding: 2px 6px; color: var(--muted); font: 700 8.5px 'Cascadia Code', monospace; border-radius: 4px; background: var(--hover); }
  .log-level.error, .log-level.fatal { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .log-level.warn { color: var(--warn); background: var(--warn-soft); }
  .log-level.info { color: var(--blue); background: color-mix(in srgb, var(--blue) 12%, transparent); }
  .log-level.debug, .log-level.trace { color: var(--muted); background: var(--hover); }
  .log-source { min-width: 0; overflow: hidden; color: var(--muted); font: 450 9.5px 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .log-entry p { min-width: 0; grid-column: 1 / -1; margin: 2px 0 0; color: var(--text); font: 450 11.5px/1.6 'Cascadia Code', monospace; overflow-wrap: anywhere; white-space: pre-wrap; }
  .log-stack { grid-column: 1 / -1; margin-top: 4px; padding-top: 7px; border-top: 1px dashed var(--line); }
  .log-stack summary { cursor: pointer; color: var(--muted); font-size: 9.5px; }
  .log-stack pre { margin: 7px 0 0; padding: 10px; overflow: auto; color: var(--muted); font: 450 10.5px/1.6 'Cascadia Code', monospace; white-space: pre-wrap; border-radius: 7px; background: var(--bg); }
  :global(.log-stack .stack-cause) { color: var(--danger); font-weight: 650; }
  :global(.log-stack .stack-error) { color: var(--danger); }
  :global(.log-stack .stack-at) { color: var(--blue); }
  @media (max-width: 900px) { .jwt-sections { grid-template-columns: 1fr; } .stats-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
