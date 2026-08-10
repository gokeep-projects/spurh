<script lang="ts">
  import { runtime } from '../plugins';
  import { UI_ICONS } from '../icons';
  import { processWithAi, type AiConfig } from '../ai';
  import { isTauri, safeInvoke, copyText } from '../env';

  type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  type LogEntry = { line: number; level: LogLevel; message: string; source?: string; stack?: string[]; raw?: string; time?: string };
  type LogAnalysis = {
    format: 'json' | 'common' | 'stack' | 'mixed' | 'unknown';
    lines: number; parsed: number;
    counts: Partial<Record<LogLevel, number>>;
    entries: LogEntry[];
    topSources: { source: string; count: number }[];
    rootCause: string | null;
    sample: string | null;
  };

  const LEVELS: LogLevel[] = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
  const VISIBLE_MAX = 1500;
  const LEVEL_COLOR: Record<LogLevel, string> = {
    FATAL: 'var(--danger)', ERROR: 'var(--danger)', WARN: 'var(--warn)',
    INFO: 'var(--accent)', DEBUG: 'var(--muted)', TRACE: 'var(--muted-2)',
  };

  let { externalText, onStatus, aiConfig, aiConfigured }: {
    externalText?: { text: string; ts: number } | null;
    onStatus?: (status: { chars: number; summary: string } | null) => void;
    aiConfig?: AiConfig | undefined;
    aiConfigured?: boolean;
  } = $props();

  let inputOpen = $state(false);
  let text = $state('');
  let fileInput: HTMLInputElement | undefined;
  let analyzing = $state(false);
  let error = $state('');
  let analysis = $state<LogAnalysis | null>(null);
  let fileError = $state('');
  let expanded = $state<Set<number>>(new Set());
  let exported = $state(false);
  let groupFilter = $state<string | null>(null);
  const groupFilteredEntries = $derived(groupFilter ? (analysis?.entries ?? []).filter((entry) => `${entry.level}|${entry.source ?? ''}|${entry.message}` === groupFilter) : analysis?.entries ?? []);

  /* ── AI 参与：基于已解析日志的根因洞察 ── */
  let aiBusy = $state(false);
  let aiOutput = $state('');
  let aiReasoning = $state('');
  let aiError = $state('');

  async function aiAnalyze(): Promise<void> {
    if (!text.trim() || aiBusy) return;
    const config = aiConfig;
    if (!config || !aiConfigured) { aiError = '尚未配置 AI 模型，请先在「设置 → AI 模型」中完成配置'; return; }
    aiBusy = true;
    aiError = '';
    aiOutput = '';
    aiReasoning = '';
    try {
      const data = analysis;
      const summary = data
        ? `已解析 ${data.parsed}/${data.lines} 行，级别统计：${LEVELS.map((l) => `${l}=${data.counts[l] ?? 0}`).join(' ')}${data.rootCause ? `，本地根因：${data.rootCause}` : ''}${data.topSources.length ? `，主要来源：${data.topSources.map((s) => `${s.source}×${s.count}`).join('、')}` : ''}`
        : '未做本地解析';
      const result = await processWithAi(
        config,
        text.slice(0, 60000),
        {
          tool: '日志分析',
          action: 'analyze',
          userPrompt: `这是应用日志（已含本地统计：${summary}）。请从日志中定位真正的问题根因并给出可执行修复建议。回答请用中文，按「问题概述 → 根因分析 → 修复建议（按优先级）」组织，简明扼要，不输出与日志无关的内容。`,
        },
        (state) => { aiReasoning = state.reasoning; aiOutput = state.content; },
      );
      aiOutput = result.output;
    } catch (cause) {
      aiError = cause instanceof Error ? cause.message : String(cause);
    }
    aiBusy = false;
  }

  async function copyAiOutput(): Promise<void> {
    const { copyText } = await import('../env');
    await copyText(aiOutput);
  }

  $effect(() => {
    // 外部打开文件 → 同步到面板输入并展开输入区
    if (externalText && externalText.text !== text) {
      text = externalText.text;
      inputOpen = true;
    }
  });

  let debounce: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!text.trim()) {
      analysis = null;
      analyzing = false;
      onStatus?.(null);
      return;
    }
    if (debounce) clearTimeout(debounce);
    analyzing = true;
    debounce = setTimeout(async () => {
      try {
        const result = await runtime.execute('spurh.log', 'analyze', text, {});
        analysis = result.data as LogAnalysis;
        onStatus?.({ chars: text.length, summary: `已解析 ${analysis.parsed} 条` });
        error = '';
        expanded = new Set();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        analysis = null;
        onStatus?.(null);
      }
      analyzing = false;
    }, 300);
    return () => { if (debounce) clearTimeout(debounce); };
  });

  function openFile(): void {
    fileInput?.click();
  }

  function handleFile(event: Event): void {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    fileError = '';
    if (file.size > 5 * 1024 * 1024) { fileError = '日志文件过大（超过 5MB），请截取片段'; return; }
    // 优先 UTF-8 严格解码，失败时回退 GBK（中文 Windows 常见日志编码），与主界面拖放逻辑保持一致
    file.arrayBuffer().then((bytes) => {
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        decoded = new TextDecoder('gbk').decode(bytes);
      }
      text = decoded;
      inputOpen = true;
    }).catch(() => { fileError = '读取文件失败'; });
    (event.currentTarget as HTMLInputElement).value = '';
  }

  function toggleEntry(line: number): void {
    const next = new Set(expanded);
    if (next.has(line)) next.delete(line); else next.add(line);
    expanded = next;
  }

  async function exportReport(): Promise<void> {
    const data = analysis;
    if (!data) return;
    const lines = [
      'Spurh 日志分析报告',
      `时间: ${new Date().toLocaleString()}`, 
      `格式: ${data.format} | 总行数: ${data.lines} | 解析: ${data.parsed}`, 
      `级别统计: ${LEVELS.map((level) => `${level}=${data.counts[level] ?? 0}`).join('  ')}`,
      data.rootCause ? `根因: ${data.rootCause}` : '', 
      '',
      '────────── 日志明细 ──────────',
      ...data.entries.map((entry) =>
        `[${entry.line}] [${entry.level}] ${entry.time ?? ''} ${entry.source ? `(${entry.source}) ` : ''}${entry.message}` +
        (entry.stack?.length ? `\n    ${entry.stack.join('\n    ')}` : '')),
    ].filter(Boolean).join('\n');
    if (isTauri) {
      try {
        const saved = await safeInvoke<string | null>('save_text_file', {
          name: `spurh-log-analysis-${Date.now()}.txt`,
          content: lines,
        });
        if (saved !== null) {
          exported = true;
          setTimeout(() => (exported = false), 1500);
          return;
        }
        // 用户取消保存，静默返回
        return;
      } catch {
        // 原生保存失败时回退浏览器下载
      }
    }
    try {
      const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `spurh-log-analysis-${Date.now()}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      // WebView2 下载不可用，回退复制到剪贴板
      copyText(lines).catch(() => undefined);
    }
    exported = true;
    setTimeout(() => (exported = false), 1500);
  }
  /** 错误聚合：ERROR/FATAL 按「级别+来源+消息」聚类，重复异常一目了然 */
  type ErrorGroup = { level: LogLevel; message: string; source?: string; count: number; line: number; stack?: string[] };
  const errorGroups = $derived.by<ErrorGroup[]>(() => {
    const data = analysis;
    if (!data) return [];
    const map = new Map<string, ErrorGroup>();
    for (const entry of data.entries) {
      if (entry.level !== 'ERROR' && entry.level !== 'FATAL') continue;
      const message = entry.message.trim();
      if (!message) continue;
      const key = `${entry.level}|${entry.source ?? ''}|${message}`;
      const group = map.get(key);
      if (group) {
        group.count++;
        if (!group.stack && entry.stack) group.stack = entry.stack;
      } else {
        map.set(key, { level: entry.level, message, source: entry.source, count: 1, line: entry.line, stack: entry.stack });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.line - b.line).slice(0, 50);
  });

  const errorTotal = $derived(errorGroups.reduce((sum, group) => sum + group.count, 0));

  /** 级别分布：带比例条，比纯数字卡片更直观 */
  const distRows = $derived.by(() => {
    const data = analysis;
    if (!data) return [] as Array<{ level: LogLevel; count: number; ratio: number }>;
    const rows = LEVELS.map((level) => ({ level, count: data.counts[level] ?? 0 })).filter((row) => row.count > 0);
    const max = Math.max(...rows.map((row) => row.count), 1);
    return rows.map((row) => ({ ...row, ratio: (row.count / max) * 100 }));
  });

  /** 时间线：解析各条目时间并按时间分桶渲染直方图（无时间信息时返回 null） */
  function parseEntryTime(value: string | undefined): number | null {
    if (!value) return null;
    const full = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/);
    if (full) {
      const ms = Date.parse(`${full[1]}T${full[2].replace(',', '.')}`);
      return Number.isNaN(ms) ? null : ms;
    }
    const timeOnly = value.match(/^(\d{2}):(\d{2}):(\d{2})/);
    if (timeOnly) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return today.getTime() + Number(timeOnly[1]) * 3_600_000 + Number(timeOnly[2]) * 60_000 + Number(timeOnly[3]) * 1000;
    }
    return null;
  }

  const fmtClock = (ms: number): string => {
    const date = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  };

  const fmtSpan = (ms: number): string => {
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const p = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h} 小时 ${p(m)} 分` : `${p(m)} 分 ${p(s)} 秒`;
  };

  const timeline = $derived.by<{ start: number; end: number; labeled: number; buckets: Array<{ count: number; errors: number; ratio: number; label: string }> } | null>(() => {
    const data = analysis;
    if (!data) return null;
    const points: number[] = [];
    for (const entry of data.entries) {
      const ms = parseEntryTime(entry.time);
      if (ms !== null) points.push(ms);
    }
    if (points.length < 2) return null;
    const start = Math.min(...points);
    const end = Math.max(...points);
    if (end - start < 1000) return null;
    const BUCKETS = 12;
    const span = end - start;
    const counts = new Array<number>(BUCKETS).fill(0);
    const errors = new Array<number>(BUCKETS).fill(0);
    for (const entry of data.entries) {
      const ms = parseEntryTime(entry.time);
      if (ms === null) continue;
      const index = Math.min(BUCKETS - 1, Math.floor(((ms - start) / span) * BUCKETS));
      counts[index]++;
      if (entry.level === 'ERROR' || entry.level === 'FATAL') errors[index]++;
    }
    const max = Math.max(...counts);
    return {
      start, end, labeled: points.length,
      buckets: counts.map((count, index) => ({
        count, errors: errors[index],
        ratio: max ? count / max : 0,
        label: fmtClock(start + (span * index) / BUCKETS),
      })),
    };
  });

  const total = $derived((() => {
    const data = analysis;
    if (!data) return 0;
    return LEVELS.reduce((sum, level) => sum + (data.counts[level] ?? 0), 0);
  })());
</script>

<div class="log-panel">
  <header class="log-bar">
    <div class="log-bar-actions">
      <input type="file" accept=".log,.txt,.json,.xml,text/*" bind:this={fileInput} hidden onchange={handleFile} />
      <button class="log-btn" onclick={openFile}><span>{@html UI_ICONS.file}</span>打开日志文件</button>
      <button class="log-btn" class:active={inputOpen} onclick={() => (inputOpen = !inputOpen)}><span>⌨</span>{inputOpen ? '隐藏输入' : '手动输入'}</button>
      <button class="log-btn log-ai-btn" class:ready={aiConfigured && isTauri} disabled={!isTauri || !text.trim() || aiBusy} title={!isTauri ? 'AI 分析需要桌面应用（请运行 npm run tauri dev）' : aiConfigured ? 'AI 洞察：定位根因并给出修复建议' : 'AI 洞察（需先在设置中配置 AI 模型）'} onclick={aiAnalyze}><span class="btn-ai">{@html UI_ICONS.sparkle}</span>{aiBusy ? 'AI 分析中…' : aiOutput ? '重新 AI 分析' : 'AI 分析'}</button>
      {#if isTauri && !aiConfigured && text.trim()}<span class="log-ai-note" title="前往 设置 → AI 模型 完成配置">AI 未配置</span>{/if}
      <button class="log-btn" disabled={!analysis} onclick={exportReport}><span>⭳</span>{exported ? '已导出 ✓' : '导出报告'}</button>
      <button class="log-btn" onclick={() => { text = ''; analysis = null; aiOutput = ''; aiReasoning = ''; aiError = ''; }}><span>✕</span>清空</button>
      {#if fileError}<span class="log-file-error">{fileError}</span>{/if}
    </div>
    <div class="log-status">
      {#if analyzing}<span class="spinner"></span>分析中…
      {:else if analysis}<span class="log-status-dot ok"></span>{total} 条已解析
      {:else}<span class="log-status-dot"></span>等待日志{/if}
    </div>
  </header>

  {#if inputOpen}
    <div class="log-input">
      <textarea value={text} oninput={(e) => (text = e.currentTarget.value)} placeholder="粘贴日志内容，或点击「打开日志文件」…" spellcheck="false"></textarea>
      <small>{text.length} 字符{text ? ' · 分析自动进行' : ''}</small>
    </div>
  {/if}

  {#if error}
    <div class="log-error">{error}</div>
  {:else if analyzing && !analysis}
    <div class="log-loading">
      <div class="loading-track"><span></span></div>
      <p>正在解析日志，分析进度实时刷新…</p>
    </div>
  {:else if analysis}
    <div class="log-stats">
      {#each LEVELS as level}
        <div class="log-stat" style={`--lv: ${LEVEL_COLOR[level]}`}>
          <b>{analysis.counts[level] ?? 0}</b><small>{level}</small>
        </div>
      {/each}
      <div class="log-stat">
        <b>{analysis.lines}</b><small>总行数</small>
      </div>
      <div class="log-stat log-stat-wide">
        <b>{analysis.format}</b><small>格式</small>
      </div>
      <div class="log-stat log-stat-wide">
        <b title={analysis.rootCause ?? ''}>{analysis.rootCause ?? '未发现根因'}</b><small>根因</small>
      </div>
      {#if analysis.topSources.length}
        <div class="log-stat log-stat-wide">
          <b>{analysis.topSources.map((item) => `${item.source}×${item.count}`).join(' · ')}</b><small>主要来源</small>
        </div>
      {/if}
    </div>

    {#if distRows.length}
      <div class="log-dist">
        {#each distRows as row}
          <div class="log-dist-row" title={`${row.level}：${row.count} 条`}>
            <i class="ld-dot" style={`background: ${LEVEL_COLOR[row.level]}`}></i>
            <b>{row.level}</b>
            <div class="ld-track"><i style={`width: ${row.ratio}%`}></i></div>
            <small>{row.count}</small>
          </div>
        {/each}
      </div>
    {/if}

    {#if timeline}
      <div class="log-timeline">
        <div class="lt-head"><b>时间线</b><small>{timeline.labeled} 条含时间 · 跨度 {fmtSpan(timeline.end - timeline.start)}</small></div>
        <div class="lt-track">
          {#each timeline.buckets as bucket}
            <i class:err={bucket.errors > 0} style={`height: ${bucket.count ? Math.max(bucket.ratio * 100, 8) : 2}%`} title={`${bucket.label} · ${bucket.count} 条${bucket.errors ? `（${bucket.errors} 条错误）` : ''}`}></i>
          {/each}
        </div>
        <div class="lt-labels"><span>{fmtClock(timeline.start)}</span><span>{fmtClock(timeline.end)}</span></div>
      </div>
    {/if}

    {#if aiBusy || aiOutput || aiError}
      <div class="log-ai-card">
        <div class="log-ai-head"><span class="btn-ai">{@html UI_ICONS.sparkle}</span><b>AI 洞察</b><small>{aiBusy ? '分析中，实时输出…' : '基于日志的根因与建议'}</small>
          <div class="log-ai-actions">
            {#if aiOutput}<button class="log-btn" onclick={copyAiOutput}><span>⧉</span>复制</button>{/if}
            {#if aiOutput || aiError}<button class="log-btn" onclick={() => { aiOutput = ''; aiReasoning = ''; aiError = ''; }}><span>✕</span>关闭</button>{/if}
          </div>
        </div>
        {#if aiBusy && aiReasoning}<div class="log-ai-reasoning"><small>推理过程</small><p>{aiReasoning}</p></div>{/if}
        {#if aiError}<div class="log-ai-error">{aiError}</div>{/if}
        {#if aiOutput}<div class="log-ai-output">{aiOutput}</div>{/if}
        {#if aiBusy && !aiOutput && !aiError}<div class="log-ai-wait"><span class="spinner"></span>正在调用 AI 模型…</div>{/if}
      </div>
    {/if}

    {#if errorGroups.length}
      <div class="log-section-title"><b>错误聚合</b><small>{errorTotal} 条 ERROR / FATAL · {errorGroups.length} 类</small></div>
      <div class="log-entries">
        {#each errorGroups as group}
          {@const gkey = `${group.level}|${group.source ?? ''}|${group.message}`}
          <button type="button" class="log-entry error" class:filtered={groupFilter === gkey} onclick={() => { toggleEntry(group.line); groupFilter = groupFilter === gkey ? null : gkey; }} title="点击过滤出该错误的全部出现位置">
            <i style={`background: ${LEVEL_COLOR[group.level]}`}></i>
            <div class="log-entry-main">
              <div class="log-entry-head"><b>[{group.count}×] {group.level}</b>{#if group.source}<small>{group.source}</small>{/if}<small>第 {group.line} 行</small></div>
              <p>{group.message}</p>
              {#if group.stack?.length}
                {#if expanded.has(group.line)}
                  <pre>{group.stack.join('\n')}</pre>
                {:else}
                  <small class="log-more">堆栈 {group.stack.length} 行 · 点击展开</small>
                {/if}
              {/if}
            </div>
          </button>
        {/each}
      </div>
    {/if}

    <div class="log-section-title"><b>全部条目</b><small>{groupFilteredEntries.length} 条{groupFilteredEntries.length > VISIBLE_MAX ? ` · 仅显示前 ${VISIBLE_MAX} 条` : ''}</small>{#if groupFilter}<button class="log-filter-clear" onclick={() => (groupFilter = null)}>清除过滤 ✕</button>{/if}</div>
    <div class="log-entries">
      {#each groupFilteredEntries.slice(0, VISIBLE_MAX) as entry}
        <button type="button" class="log-entry" class:error={entry.level === 'ERROR' || entry.level === 'FATAL'} onclick={() => toggleEntry(entry.line)}>
          <i style={`background: ${LEVEL_COLOR[entry.level]}`}></i>
          <div class="log-entry-main">
            <div class="log-entry-head"><b>[{entry.line}] {entry.level}</b>{#if entry.source}<small>{entry.source}</small>{/if}{#if entry.time}<small>{entry.time}</small>{/if}</div>
            <p>{entry.message}</p>
            {#if entry.stack?.length && expanded.has(entry.line)}<pre>{entry.stack.join('\n')}</pre>{/if}
          </div>
        </button>
      {/each}
    </div>
  {:else}
    <div class="log-empty">
      <span class="tool-icon large">{@html UI_ICONS.file}</span>
      <b>日志分析</b>
      <p>点击「打开日志文件」选择本地日志，或展开「手动输入」粘贴内容<br />自动统计级别分布、定位根因、标记重要异常</p>
    </div>
  {/if}
</div>

<style>
  .log-panel { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
  .log-bar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10.5px 12px; border: 1px solid var(--line); border-radius: 11px; background: var(--panel); }
  .log-bar-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .log-btn { height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: transparent; transition: all .15s ease; }
  .log-btn:hover:not(:disabled) { color: var(--text); border-color: var(--line-2); background: var(--hover); }
  .log-btn.active { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); background: var(--accent-soft); }
  .log-btn:disabled { opacity: .4; cursor: default; }
  .log-btn span { display: inline-flex; font-size: var(--fs-xs); line-height: 1; }
  .log-status { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: var(--fs-sm); white-space: nowrap; }
  .log-status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line-2); }
  .log-status-dot.ok { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .log-file-error { color: var(--danger); font-size: var(--fs-sm); }
  .log-ai-btn:disabled { opacity: .4; cursor: default; }
  .log-ai-btn .btn-ai { display: inline-flex; color: var(--accent); }
  .log-ai-btn.ready .btn-ai { filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 65%, transparent)); }
  .log-ai-note { padding: 2px 7px; color: var(--warn); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line)); border-radius: 8px; background: var(--warn-soft); }

  .log-ai-card { flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 13px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 12px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 7%, var(--panel)), color-mix(in srgb, var(--c-cyan) 5%, var(--panel))); box-shadow: inset 0 0 24px color-mix(in srgb, var(--accent) 5%, transparent); }
  .log-ai-head { display: flex; align-items: center; gap: 7px; }
  .log-ai-head > .btn-ai { display: inline-flex; color: var(--accent); filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 65%, transparent)); }
  .log-ai-head b { font-size: var(--fs-sm); }
  .log-ai-head small { color: var(--muted-2); font-size: var(--fs-xs); }
  .log-ai-actions { margin-left: auto; display: flex; gap: 6px; }
  .log-ai-reasoning { padding: 8px 10px; color: var(--muted); font-size: var(--fs-xs); border: 1px dashed var(--line-2); border-radius: 8px; background: color-mix(in srgb, var(--bg) 60%, transparent); }
  .log-ai-reasoning small { display: block; margin-bottom: 4px; color: var(--muted-2); font-size: var(--fs-xs); }
  .log-ai-reasoning p { margin: 0; line-height: 1.55; white-space: pre-wrap; }
  .log-ai-error { padding: 9px 11px; color: var(--danger); font-size: var(--fs-sm); border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 5%, transparent); }
  .log-ai-output { padding: 11px 13px; color: var(--text); font: 450 13.5px/1.7 'Cascadia Code', 'Microsoft YaHei', monospace; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .log-ai-wait { display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--muted); font-size: var(--fs-xs); }

  .log-input { flex: 0 0 auto; display: flex; flex-direction: column; gap: 5px; }
  .log-input textarea { width: 100%; height: 170px; padding: 12px 14px; resize: vertical; color: var(--text); font: 450 13.5px/1.6 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--panel); }
  .log-input textarea:focus { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .log-input small { color: var(--muted-2); font-size: var(--fs-xs); }

  .log-error { padding: 12px; color: var(--danger); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 5%, transparent); }
  .log-loading { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 20px; color: var(--muted); }
  .log-loading p { margin: 0; font-size: var(--fs-xs); }

  .log-stats { flex: 0 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
  .log-stat { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .log-stat b { font-size: 17px; font-weight: 700; color: var(--lv, var(--text)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-stat small { color: var(--muted); font-size: var(--fs-xs); }
  .log-stat-wide { min-width: 150px; }
  .log-stat-wide b { font-size: var(--fs-xs); font-weight: 600; }

  .log-dist { flex: 0 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 6px 14px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .log-dist-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .log-dist-row b { flex: 0 0 auto; color: var(--muted); font: 600 var(--fs-xs) 'Cascadia Code', monospace; }
  .log-dist-row small { flex: 0 0 auto; color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', monospace; }
  .ld-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; }
  .ld-track { min-width: 0; flex: 1; height: 5px; overflow: hidden; border-radius: 3px; background: var(--w-06); }
  .ld-track i { display: block; height: 100%; border-radius: 3px; background: var(--btn-gradient); }

  .log-timeline { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; padding: 9px 11px 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .lt-head { display: flex; align-items: baseline; gap: 8px; }
  .lt-head b { font-size: var(--fs-xs); }
  .lt-head small { color: var(--muted-2); font-size: var(--fs-xs); }
  .lt-track { display: flex; align-items: flex-end; gap: 3px; height: 52px; padding: 4px 2px 0; border-bottom: 1px solid var(--line-2); }
  .lt-track i { flex: 1; min-width: 0; border-radius: 3px 3px 0 0; background: color-mix(in srgb, var(--accent) 55%, transparent); transition: background .15s ease; }
  .lt-track i:hover { background: var(--accent); }
  .lt-track i.err { background: color-mix(in srgb, var(--danger) 65%, transparent); }
  .lt-track i.err:hover { background: var(--danger); }
  .lt-labels { display: flex; justify-content: space-between; color: var(--muted-2); font: 500 var(--fs-xs) 'Cascadia Code', monospace; }

  .log-section-title { display: flex; align-items: center; gap: 8px; }
  .log-filter-clear { height: 22px; padding: 0 10px; cursor: pointer; color: var(--c-cyan); font-size: var(--fs-xs); font-weight: 600; border: 1px solid color-mix(in srgb, var(--c-cyan) 40%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--c-cyan) 8%, transparent); transition: all var(--transition); }
  .log-filter-clear:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .log-entry.error.filtered { border-color: color-mix(in srgb, var(--danger) 55%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--danger) 25%, transparent); }
  .log-section-title { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; }
  .log-section-title b { font-size: var(--fs-xs); }
  .log-section-title small { color: var(--muted-2); font-size: var(--fs-xs); }

  .log-entries { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 4px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
  .log-entry { display: flex; gap: 10px; padding: 10.5px 11px; cursor: pointer; text-align: left; width: 100%; color: var(--text); font: inherit; border: 0; border-radius: 8px; background: transparent; transition: background .15s ease; }
  .log-entry:hover { background: var(--hover); }
  .log-entry > i { flex: 0 0 auto; width: 3px; border-radius: 2px; align-self: stretch; }
  .log-entry.error { background: color-mix(in srgb, var(--danger) 6%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 18%, var(--line)); }
  .log-entry-main { min-width: 0; flex: 1; }
  .log-entry-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
  .log-entry-head b { color: var(--lv, var(--text)); font: 600 var(--fs-xs) 'Cascadia Code', monospace; }
  .log-entry.error .log-entry-head b { color: var(--danger); }
  .log-entry-head small { color: var(--muted-2); font-size: var(--fs-xs); }
  .log-entry p { margin: 0; color: var(--text); font: 450 13.5px/1.5 'Cascadia Code', monospace; word-break: break-word; }
  .log-entry pre { margin: 6px 0 0; padding: 8px 10px; overflow: auto; color: var(--muted); font: 400 13.5px/1.5 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); white-space: pre-wrap; }
  .log-more { color: var(--muted-2); font-size: var(--fs-xs); }

  .log-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10.5px; flex: 1; color: var(--muted); text-align: center; }
  .log-empty b { font-size: var(--fs); }
  .log-empty p { margin: 0; font-size: var(--fs-xs); line-height: 1.7; }
</style>
