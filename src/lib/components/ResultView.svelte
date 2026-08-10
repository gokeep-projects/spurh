<script lang="ts">
  import { highlightCode } from '../highlight';
  import { copyText as copyTextNative, safeInvoke, isTauri } from '../env';
  import type { PluginResult } from '../plugins';
  import JsonView from './JsonView.svelte';

  let { result, exportName = '' }: { result: PluginResult; exportName?: string } = $props();

  let copiedKey = $state('');
  let exportState = $state('');

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
    await copyTextNative(value);
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 1100);
  }


  async function exportResult(): Promise<void> {
    if (!isTauri) {
      exportState = '仅桌面端可用';
      setTimeout(() => { if (exportState === '仅桌面端可用') exportState = ''; }, 1600);
      return;
    }
    try {
      const ext = result.language === 'json' ? 'json' : result.language ? result.language.replace(/[^\w-]/g, '') : 'txt';
      const base = exportName.replace(/[^\w-]/g, '') || 'spurh-export';
      const saved = await safeInvoke<string | null>('save_text_file', { name: `${base}.${ext}`, content: result.output });
      exportState = saved ? '已导出 ✓' : '';
      setTimeout(() => { if (exportState === '已导出 ✓') exportState = ''; }, 1600);
    } catch {
      exportState = '导出失败';
      setTimeout(() => { if (exportState === '导出失败') exportState = ''; }, 1600);
    }
  }

  let data = $derived(record(result.data));

    function timeHeroExtra(localText: string): { weekday: string; relative: string } {
    const m = localText.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m) return { weekday: '', relative: '' };
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    const diff = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(diff);
    const rel = diff === 0 ? '就是现在'
      : abs < 60 ? (diff > 0 ? '即将到来' : '刚刚')
      : abs < 3600 ? (diff > 0 ? Math.floor(abs / 60) + ' 分钟后' : Math.floor(abs / 60) + ' 分钟前')
      : abs < 86400 ? (diff > 0 ? Math.floor(abs / 3600) + ' 小时后' : Math.floor(abs / 3600) + ' 小时前')
      : (diff > 0 ? Math.floor(abs / 86400) + ' 天后' : Math.floor(abs / 86400) + ' 天前');
    return { weekday: week, relative: rel };
  }
  function withHeroExtra(data: Record<string, unknown>): Record<string, unknown> {
    const extra = timeHeroExtra(String(data.local ?? ''));
    return { ...data, weekday: extra.weekday, relative: extra.relative };
  }

  function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /** 轻量级 Markdown → HTML（AI 结果专用） */
  function renderAiText(text: string): string {
    const blocks = text.split(/\n{2,}/);
    return blocks.map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (t.startsWith('```')) {
        const lines = block.split('\n');
        const fence = lines[0].trim();
        const last = lines[lines.length - 1].trim();
        const body = lines.slice(1, last === '```' ? lines.length - 1 : lines.length).join('\n');
        return '<pre class="ai-code">' + escHtml(body) + '</pre>';
      }
      if (/^#{1,3}\s/.test(t)) {
        const level = t.match(/^#+/)![0].length;
        const tag = 'h' + Math.min(4, level + 1);
        return '<' + tag + ' class="ai-h">' + inlineMd(t.replace(/^#+\s*/, '')) + '</' + tag + '>';
      }
      const ulLines = block.split('\n').filter((l) => /^[-*]\s+/.test(l));
      if (ulLines.length > 0 && ulLines.length === block.split('\n').filter((l) => l.trim()).length) {
        return '<ul class="ai-ul">' + ulLines.map((l) => '<li>' + inlineMd(l.replace(/^[-*]\s+/, '')) + '</li>').join('') + '</ul>';
      }
      const olLines = block.split('\n').filter((l) => /^\d+\.\s+/.test(l));
      if (olLines.length > 0 && olLines.length === block.split('\n').filter((l) => l.trim()).length) {
        return '<ol class="ai-ol">' + olLines.map((l) => '<li>' + inlineMd(l.replace(/^\d+\.\s+/, '')) + '</li>').join('') + '</ol>';
      }
      return '<p class="ai-p">' + inlineMd(t) + '</p>';
    }).join('');
  }
  function inlineMd(s: string): string {
    const esc = escHtml(s);
    return esc
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  /** AI 结果：卡片视图 */
  const isAiAnswer = $derived(!!result.meta?.['来源'] && result.view === 'text');
  const aiHtml = $derived(isAiAnswer ? renderAiText(result.output) : '');

  let items = $derived(list(result.data));
  let canTreeView = $derived(result.view === 'code' && isComplexJson(result.output, result.language));
  let useTreeView = $state(false);
  $effect(() => { if (!canTreeView) useTreeView = false; });
  let sqlColumns = $derived(list(data.columns));
  let sqlRows = $derived(list(data.rows));
  /* SQL 结果高亮 + 状态标识样式 */
  const SQL_ROW_H = 37;
  const SQL_BUFFER = 24;
  let sqlWrapEl = $state<HTMLDivElement | undefined>(undefined);
  let sqlScrollTop = $state(0);
  let sqlViewH = $state(480);
  const sqlStart = $derived(Math.max(0, Math.floor(sqlScrollTop / SQL_ROW_H) - SQL_BUFFER));
  const sqlEnd = $derived(Math.min(sqlRows.length, Math.ceil((sqlScrollTop + sqlViewH) / SQL_ROW_H) + SQL_BUFFER));
  const sqlPadTop = $derived(sqlStart * SQL_ROW_H);
  const sqlPadBottom = $derived(Math.max(0, (sqlRows.length - sqlEnd) * SQL_ROW_H));
  const sqlVisible = $derived(sqlRows.slice(sqlStart, sqlEnd));
  function onSqlScroll(): void {
    if (sqlWrapEl) sqlScrollTop = sqlWrapEl.scrollTop;
  }
  $effect(() => {
    const el = sqlWrapEl;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { sqlViewH = el.clientHeight; });
    ro.observe(el);
    sqlViewH = el.clientHeight;
    return () => ro.disconnect();
  });
  function cell(row: unknown, index: number): unknown {
    return Array.isArray(row) ? row[index] : undefined;
  }

</script>

<div class="result-view" class:tree-mode={useTreeView}>
<div class="result-actions">
    {#if canTreeView}
      <button class="export-btn" onclick={() => (useTreeView = !useTreeView)} title={useTreeView ? '切换为格式化文本' : '切换为折叠树视图'}>{useTreeView ? '文本' : '树视图'}</button>
    {/if}
    {#if result.output}<button class="export-btn" onclick={exportResult} title="导出结果到文件">{exportState || '导出'}</button>{/if}
  </div>
  {#if result.view === 'timestamp' && Object.keys(data).length}
    {@const heroData = withHeroExtra(data)}
    <div class="time-hero">
      <div class="time-hero-top"><small>本地时间</small><span class="time-hero-tz">{display(heroData.timezone)}</span></div>
      <strong>{display(heroData.local)}</strong>
      <div class="time-hero-meta">
        <span class="time-hero-week">{display(heroData.weekday || '')}</span>
        <span class="time-hero-rel">{display(heroData.relative || '')}</span>
      </div>
    </div>
    <div class="value-grid time-grid">
      <article>
        <small>UTC / ISO 8601</small>
        <b>{display(heroData.utc)}</b>
        <button class="copy-btn" onclick={() => copyText(display(heroData.utc), 'utc')}>{copiedKey === 'utc' ? '已复制 ✓' : '复制'}</button>
      </article>
      <article>
        <small>Unix 秒</small>
        <b>{display(heroData.unixSeconds)}</b>
        <button class="copy-btn" onclick={() => copyText(display(heroData.unixSeconds), 'sec')}>{copiedKey === 'sec' ? '已复制 ✓' : '复制'}</button>
      </article>
      <article>
        <small>Unix 毫秒</small>
        <b>{display(heroData.unixMilliseconds)}</b>
        <button class="copy-btn" onclick={() => copyText(display(heroData.unixMilliseconds), 'ms')}>{copiedKey === 'ms' ? '已复制 ✓' : '复制'}</button>
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
  {:else if result.view === 'colors' && items.length}
    <div class="color-grid">
      {#each items as item, index}
        {@const hex = String(item).trim()}
        {@const valid = /^#[0-9a-f]{6}$/i.test(hex)}
        <article>
          <span class="color-swatch" style={valid ? `background: ${hex}` : 'background: repeating-conic-gradient(#232a37 0% 25%, #171c27 0% 50%) 0 0 / 12px 12px'}></span>
          <code>{hex}</code>
          <button class="copy-btn" onclick={() => copyText(hex, `c${index}`)}>{copiedKey === `c${index}` ? '已复制 ✓' : '复制'}</button>
        </article>
      {/each}
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
        <div class="sql-table-wrap" bind:this={sqlWrapEl} onscroll={onSqlScroll}>
          <table class="sql-table">
            <thead><tr>{#each sqlColumns as col}<th>{display(col)}</th>{/each}</tr></thead>
            <tbody>
              {#if sqlPadTop > 0}<tr style="height:{sqlPadTop}px" aria-hidden="true"></tr>{/if}
              {#each sqlVisible as row}
                <tr>
                  {#each sqlColumns as col, ci}
                    <td title={display(cell(row, ci))}>{display(cell(row, ci))}</td>
                  {/each}
                </tr>
              {/each}
              {#if sqlPadBottom > 0}<tr style="height:{sqlPadBottom}px" aria-hidden="true"></tr>{/if}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="structured-empty sql-empty"><span>✓</span><b>执行成功</b><small>{display(data.affected ?? 0)} 行受影响 · {display(data.elapsedMs)} ms</small></div>
      {/if}
    </div>
    {:else if isAiAnswer}
    <div class="ai-answer">
      <header><span class="ai-answer-badge">✦</span><div><b>AI 处理结果</b><small>{display(result.meta?.['模型'])} · {display(result.meta?.['来源'])}</small></div></header>
      <div class="ai-answer-body">{@html aiHtml}</div>
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
  .result-actions { position: sticky; top: 0; z-index: 6; display: flex; justify-content: flex-end; pointer-events: none; height: 0; }
  .result-actions .export-btn { pointer-events: auto; margin-top: -2px; margin-right: 2px; height: 28px; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 0 2px 10px color-mix(in srgb, #000 18%, transparent); backdrop-filter: blur(6px); }
  .result-actions .export-btn:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); }
  .tree-mode .result-actions { padding-right: 14px; }
  .result-view.tree-mode { padding: 0; display: flex; flex-direction: column; }
  .result-view.tree-mode :global(.json-tree) { flex: 1; min-height: 100%; }
  .ai-answer { overflow: hidden; border: 1px solid color-mix(in srgb, var(--c-violet) 34%, var(--line)); border-radius: 15px; background: linear-gradient(160deg, color-mix(in srgb, var(--c-violet) 9%, var(--panel)), var(--panel) 55%, color-mix(in srgb, var(--c-cyan) 6%, var(--panel))); box-shadow: 0 14px 44px color-mix(in srgb, var(--c-violet) 12%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent); }
  .ai-answer > header { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid color-mix(in srgb, var(--c-violet) 22%, var(--line)); background: color-mix(in srgb, var(--c-violet) 6%, transparent); }
  .ai-answer-badge { display: grid; place-items: center; width: 30px; height: 30px; color: #fff; font-size: 15px; border-radius: 9px; background: var(--grad-main); box-shadow: 0 6px 18px color-mix(in srgb, var(--c-violet) 45%, transparent); }
  .ai-answer > header b { display: block; font-size: var(--fs-sm); }
  .ai-answer > header small { color: var(--muted-2); font-size: var(--fs-xs); }
  .ai-answer-body { padding: 15px 18px 18px; color: var(--text); font-size: var(--fs-sm); line-height: 1.75; }
  :global(.ai-answer-body .ai-p) { margin: 0 0 11px; }
  :global(.ai-answer-body .ai-p:last-child) { margin-bottom: 0; }
  :global(.ai-answer-body .ai-h) { margin: 15px 0 8px; font-size: var(--fs-lg); font-weight: 750; }
  :global(.ai-answer-body .ai-ul), :global(.ai-answer-body .ai-ol) { margin: 0 0 11px; padding-left: 22px; }
  :global(.ai-answer-body .ai-ul li), :global(.ai-answer-body .ai-ol li) { margin: 4px 0; }
  :global(.ai-answer-body code) { padding: 1.5px 6px; color: var(--c-cyan); font: 500 var(--fs-xs) ui-monospace, Consolas, monospace; border-radius: 6px; background: color-mix(in srgb, var(--c-cyan) 11%, transparent); }
  :global(.ai-answer-body strong) { color: color-mix(in srgb, var(--text) 78%, var(--c-violet)); }
  :global(.ai-answer-body .ai-code) { margin: 0 0 11px; padding: 12px 14px; overflow: auto; color: var(--text); font: 450 var(--fs-xs)/1.6 ui-monospace, 'Cascadia Code', Consolas, monospace; white-space: pre; border: 1px solid var(--line); border-radius: 11px; background: var(--bg); }
  .result-view > pre { width: 100%; min-height: 100%; margin: 0; color: var(--text); font: 450 var(--fs-sm)/1.62 ui-monospace, 'Cascadia Code', Consolas, monospace; tab-size: 2; white-space: pre; overflow: auto; }
  .result-view > pre.plain { font-family: inherit; font-size: var(--fs-lg); }
  small { color: var(--muted); }
  .time-hero { position: relative; overflow: hidden; padding: 24px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 14px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, var(--panel)), var(--panel) 65%, color-mix(in srgb, var(--c-cyan) 8%, var(--panel))); box-shadow: 0 10px 30px color-mix(in srgb, var(--accent) 10%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 7%, transparent); }
  .time-hero::after { content: ""; position: absolute; inset: -60% -30% auto; height: 80%; background: radial-gradient(45% 65% at 30% 0%, color-mix(in srgb, var(--c-cyan) 14%, transparent), transparent 70%); pointer-events: none; }
  .time-hero-top { position: relative; z-index: 1; display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
  .time-hero-top small { display: block; font-size: var(--fs-xs); letter-spacing: 1.2px; text-transform: uppercase; }
  .time-hero-tz { display: inline-flex; padding: 2px 8px; color: var(--accent); font-size: var(--fs-xs); border-radius: 999px; background: var(--accent-soft); }
  .time-hero strong { position: relative; z-index: 1; display: block; font: 700 21px/1.3 'Cascadia Code', Consolas, monospace; letter-spacing: -.5px; }
  .time-hero-meta { position: relative; z-index: 1; display: flex; align-items: center; gap: 8px; margin-top: 13px; }
  .time-hero-week { display: inline-flex; padding: 3px 9px; color: var(--c-cyan); font-size: var(--fs-xs); font-weight: 700; border-radius: 8px; background: color-mix(in srgb, var(--c-cyan) 12%, transparent); }
  .time-hero-rel { display: inline-flex; padding: 3px 9px; color: var(--muted); font-size: var(--fs-xs); border-radius: 8px; background: color-mix(in srgb, var(--muted) 10%, transparent); }
  .value-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
  .value-grid article { min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 14px; border: 1px solid var(--line); border-radius: 10.5px; background: var(--panel); }
  .value-grid small { display: block; font-size: var(--fs-xs); }
  .value-grid b { overflow-wrap: anywhere; font: 550 13px/1.55 'Cascadia Code', monospace; }
  .time-grid article:first-child { grid-column: 1 / -1; }
  .copy-btn { align-self: flex-start; height: 28px; padding: 0 10.5px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: transparent; }
  .copy-btn:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .copy-btn.block { display: block; margin-top: 10.5px; }
  .jwt-overview { display: flex; align-items: center; gap: 10px; margin-bottom: 11px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 10.5px; background: var(--panel); }
  .jwt-overview > span { padding: 4px 8px; color: var(--blue); font-size: var(--fs-xs); border-radius: 8px; background: color-mix(in srgb, var(--blue) 10%, transparent); }
  .jwt-overview > span.good { color: var(--accent); background: var(--accent-soft); }
  .jwt-overview > span.bad { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, transparent); }
  .jwt-overview b { font: 600 13px 'Cascadia Code', monospace; }
  .jwt-overview small { margin-left: auto; font-size: var(--fs-xs); }
  .jwt-sections { display: grid; grid-template-columns: minmax(190px, .72fr) minmax(260px, 1.28fr); gap: 10px; }
  .jwt-sections article { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 10.5px; background: var(--panel); }
  .jwt-sections header { display: flex; align-items: center; justify-content: space-between; padding: 10.5px 11px; border-bottom: 1px solid var(--line); }
  .jwt-sections header span { color: var(--accent); font: 650 var(--fs-xs) 'Cascadia Code', monospace; }
  .jwt-sections header small { font-size: var(--fs-sm); }
  .jwt-sections pre { max-height: 310px; margin: 0; padding: 13px; overflow: auto; color: var(--text); font: 450 13px/1.65 'Cascadia Code', monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .raw-details { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .raw-details summary { cursor: pointer; color: var(--muted); font-size: var(--fs-xs); }
  .raw-details code { display: block; margin-top: 10.5px; overflow-wrap: anywhere; font-size: var(--fs-xs); line-height: 1.6; }
  .raw-details pre { margin: 10.5px 0 0; padding: 11px; overflow: auto; font: 450 13px/1.6 'Cascadia Code', monospace; border-radius: 8px; background: var(--bg); }
  .http-overview { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; padding: 13px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .http-overview > span { width: 50px; height: 42px; display: grid; place-items: center; flex: 0 0 auto; color: var(--blue); font: 700 16px 'Cascadia Code', monospace; border-radius: 8px; background: color-mix(in srgb, var(--blue) 10%, transparent); }
  .http-overview > span.good { color: var(--accent); background: var(--accent-soft); }.http-overview > span.bad { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, transparent); }
  .http-overview > div { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 4px; }.http-overview > div b { font-size: var(--fs-xs); }.http-overview > div small { overflow: hidden; font: var(--fs-xs) 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .http-overview aside { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }.http-overview aside b { color: var(--accent); font: 600 13px 'Cascadia Code', monospace; }.http-overview aside small { font-size: var(--fs-sm); }
  .http-response { overflow: hidden; border: 1px solid var(--line); border-radius: 10.5px; background: var(--panel); }
  .http-response > header { display: flex; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--line); }.http-response header span { font-size: var(--fs-xs); font-weight: 700; }.http-response header small { font-size: var(--fs-sm); }
  .http-response > pre { max-height: 430px; margin: 0; padding: 15px; overflow: auto; color: var(--text); font: 450 13px/1.65 'Cascadia Code', monospace; white-space: pre-wrap; word-break: break-word; }
  .stats-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .stats-grid article { min-height: 94px; display: flex; flex-direction: column; justify-content: center; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .stats-grid strong { color: var(--accent); font: 650 20px 'Cascadia Code', monospace; }
  .stats-grid span { margin-top: 7px; color: var(--muted); font-size: var(--fs-xs); }
  .match-list, .result-list { display: flex; flex-direction: column; gap: 8px; }
  .match-list article, .result-list article { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .match-index, .result-list article > span { flex: 0 0 auto; color: var(--accent); font: 600 var(--fs-xs) 'Cascadia Code', monospace; }
  .match-list code, .result-list code { min-width: 0; flex: 1; overflow-wrap: anywhere; color: var(--text); font: 500 13px/1.55 'Cascadia Code', monospace; }
  .match-list article > small { flex: 0 0 auto; font-size: var(--fs-sm); }
  .match-list pre { width: 100%; margin: 8px 0 0; padding: 8px; font: 13px/1.5 'Cascadia Code', monospace; border-radius: 8px; background: var(--bg); }
  .hash-card { overflow: hidden; border: 1px solid var(--line); border-radius: 11px; background: var(--panel); }
  .hash-card > div { display: flex; align-items: center; justify-content: space-between; padding: 12px 15px; border-bottom: 1px solid var(--line); }
  .hash-card > div small { color: var(--accent); font: 650 13px 'Cascadia Code', monospace; }
  .hash-card > div span { color: var(--muted); font-size: var(--fs-xs); }
  .hash-card > code { display: block; padding: 22px; overflow-wrap: anywhere; color: var(--text); font: 550 15px/1.8 'Cascadia Code', monospace; letter-spacing: .4px; }
  .hash-copy { padding: 10px 15px; border-top: 1px solid var(--line); }
  .structured-empty { min-height: 180px; display: grid; place-content: center; justify-items: center; gap: 6px; color: var(--muted); text-align: center; border: 1px dashed var(--line-2); border-radius: 8px; }
  .structured-empty > span { color: var(--accent); font-size: 28px; }.structured-empty b { color: var(--text); font-size: var(--fs-xs); }.structured-empty small { font-size: var(--fs-xs); }

  .sql-view { display: flex; flex-direction: column; gap: 12px; min-height: 100%; }
  .sql-bar { display: flex; align-items: center; gap: 10px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .sql-bar > span { padding: 3px 8px; color: var(--blue); font: 700 var(--fs-xs) 'Cascadia Code', monospace; letter-spacing: .5px; border-radius: 8px; background: color-mix(in srgb, var(--blue) 12%, transparent); }
  .sql-bar > span.write { color: var(--accent); background: var(--accent-soft); }
  .sql-bar b { font-size: var(--fs-xs); }
  .sql-bar small { font: 500 var(--fs-xs) 'Cascadia Code', monospace; }
  .sql-bar .copy-btn { margin-left: auto; }
  .sql-truncated { padding: 3px 8px; color: var(--warn); font-size: var(--fs-sm); font-style: normal; border-radius: 8px; background: var(--warn-soft); }
  .sql-table-wrap { max-height: 540px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .sql-table { width: 100%; border-collapse: collapse; font: 450 13.5px/1.5 'Cascadia Code', monospace; }
  .sql-table th { position: sticky; top: 0; z-index: 1; padding: 10.5px 12px; text-align: left; color: var(--accent); font-size: var(--fs-xs); font-weight: 650; white-space: nowrap; border-bottom: 1px solid var(--line); background: var(--panel-2); }
  .sql-table td { max-width: 340px; padding: 8px 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--line); }
  .sql-table tbody tr { height: 37px; }
  .sql-table tbody tr:last-child td { border-bottom: 0; }
  .sql-table tbody tr:hover td { background: var(--hover); }
  .sql-table tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--hover) 55%, transparent); }
  .sql-table tbody tr:nth-child(even):hover td { background: var(--hover); }
  .sql-empty { min-height: 150px; }
  .sql-empty > span { color: var(--accent); font-size: 26px; }
  .color-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 10px; }
  .color-grid article { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .color-swatch { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 8px; border: 1px solid var(--line-2); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .07); }
  .color-grid code { flex: 1; min-width: 0; color: var(--text); font: 500 13.5px 'Cascadia Code', monospace; overflow-wrap: anywhere; }
  @media (max-width: 900px) { .jwt-sections { grid-template-columns: 1fr; } .stats-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
