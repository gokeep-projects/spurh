<script lang="ts">
  import { runtime } from '../plugins';
  import { UI_ICONS } from '../icons';
  import { processWithAi, type AiConfig } from '../ai';

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
    try { await navigator.clipboard.writeText(aiOutput); } catch { /* noop */ }
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

  function exportReport(): void {
    const data = analysis;
    if (!data) return;
    const lines = [
      'Spurh 日志分析报告',
      `导出时间: ${new Date().toLocaleString()}`,
      `格式: ${data.format} | 总行数: ${data.lines} | 已解析: ${data.parsed}`,
      `级别统计: ${LEVELS.map((level) => `${level}=${data.counts[level] ?? 0}`).join('  ')}`,
      data.rootCause ? `根因: ${data.rootCause}` : '',
      '',
      '──────────────── 日志条目 ────────────────',
      ...data.entries.map((entry) =>
        `[${entry.line}] [${entry.level}] ${entry.time ?? ''} ${entry.source ? `(${entry.source}) ` : ''}${entry.message}` +
        (entry.stack?.length ? `\n    ${entry.stack.join('\n    ')}` : '')),
    ].filter(Boolean).join('\n');
    try {
      const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `spurh-log-analysis-${Date.now()}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      // WebView2 无下载处理器时兜底复制到剪贴板
      navigator.clipboard.writeText(lines).catch(() => undefined);
    }
    exported = true;
    setTimeout(() => (exported = false), 1500);
  }

  const errorEntries = $derived(analysis ? analysis.entries.filter((entry) => entry.level === 'ERROR' || entry.level === 'FATAL').slice(0, VISIBLE_MAX) : []);
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
      <button class="log-btn log-ai-btn" disabled={!text.trim() || aiBusy} title={aiConfigured ? 'AI 洞察：定位根因并给出修复建议' : 'AI 洞察（需先在设置中配置 AI 模型）'} onclick={aiAnalyze}><span class="btn-ai">{@html UI_ICONS.sparkle}</span>{aiBusy ? 'AI 分析中…' : aiOutput ? '重新 AI 分析' : 'AI 分析'}</button>
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

    {#if errorEntries.length}
      <div class="log-section-title"><b>重要异常</b><small>ERROR / FATAL 重点标记</small></div>
      <div class="log-entries">
        {#each errorEntries as entry}
          <button type="button" class="log-entry error" onclick={() => toggleEntry(entry.line)}>
            <i style={`background: ${LEVEL_COLOR[entry.level]}`}></i>
            <div class="log-entry-main">
              <div class="log-entry-head"><b>[{entry.line}] {entry.level}</b>{#if entry.source}<small>{entry.source}</small>{/if}{#if entry.time}<small>{entry.time}</small>{/if}</div>
              <p>{entry.message}</p>
              {#if entry.stack?.length}
                {#if expanded.has(entry.line)}
                  <pre>{entry.stack.join('\n')}</pre>
                {:else}
                  <small class="log-more">堆栈 {entry.stack.length} 行 · 点击展开</small>
                {/if}
              {/if}
            </div>
          </button>
        {/each}
      </div>
    {/if}

    <div class="log-section-title"><b>全部条目</b><small>{analysis.entries.length} 条{analysis.entries.length > VISIBLE_MAX ? ` · 仅显示前 ${VISIBLE_MAX} 条` : ''}</small></div>
    <div class="log-entries">
      {#each analysis.entries.slice(0, VISIBLE_MAX) as entry}
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
  .log-btn { height: 31px; display: inline-flex; align-items: center; gap: 6px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: transparent; transition: all .15s ease; }
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
  .log-ai-output { padding: 11px 13px; color: var(--text); font: 450 13.5px/1.7 'Cascadia Code', 'Microsoft YaHei', monospace; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .log-ai-wait { display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--muted); font-size: var(--fs-xs); }

  .log-input { flex: 0 0 auto; display: flex; flex-direction: column; gap: 5px; }
  .log-input textarea { width: 100%; height: 170px; padding: 12px 14px; resize: vertical; color: var(--text); font: 450 13.5px/1.6 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 10px; outline: 0; background: var(--panel); }
  .log-input textarea:focus { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .log-input small { color: var(--muted-2); font-size: var(--fs-xs); }

  .log-error { padding: 12px; color: var(--danger); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line)); border-radius: 10px; background: color-mix(in srgb, var(--danger) 5%, transparent); }
  .log-loading { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 20px; color: var(--muted); }
  .log-loading p { margin: 0; font-size: var(--fs-xs); }

  .log-stats { flex: 0 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
  .log-stat { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .log-stat b { font-size: 17px; font-weight: 700; color: var(--lv, var(--text)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-stat small { color: var(--muted); font-size: var(--fs-xs); }
  .log-stat-wide { min-width: 150px; }
  .log-stat-wide b { font-size: var(--fs-xs); font-weight: 600; }

  .log-section-title { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; }
  .log-section-title b { font-size: var(--fs-xs); }
  .log-section-title small { color: var(--muted-2); font-size: var(--fs-xs); }

  .log-entries { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 4px; overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); }
  .log-entry { display: flex; gap: 10px; padding: 10.5px 11px; cursor: pointer; text-align: left; width: 100%; color: var(--text); font: inherit; border: 0; border-radius: 8px; background: transparent; transition: background .15s ease; }
  .log-entry:hover { background: var(--hover); }
  .log-entry > i { flex: 0 0 auto; width: 3px; border-radius: 2px; align-self: stretch; }
  .log-entry.error { background: color-mix(in srgb, var(--danger) 6%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 18%, var(--line)); }
  .log-entry-main { min-width: 0; flex: 1; }
  .log-entry-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
  .log-entry-head b { color: var(--lv, var(--text)); font: 600 12px 'Cascadia Code', monospace; }
  .log-entry.error .log-entry-head b { color: var(--danger); }
  .log-entry-head small { color: var(--muted-2); font-size: var(--fs-xs); }
  .log-entry p { margin: 0; color: var(--text); font: 450 13.5px/1.5 'Cascadia Code', monospace; word-break: break-word; }
  .log-entry pre { margin: 6px 0 0; padding: 8px 10px; overflow: auto; color: var(--muted); font: 400 13.5px/1.5 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); white-space: pre-wrap; }
  .log-more { color: var(--muted-2); font-size: var(--fs-xs); }

  .log-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10.5px; flex: 1; color: var(--muted); text-align: center; }
  .log-empty b { font-size: var(--fs); }
  .log-empty p { margin: 0; font-size: var(--fs-xs); line-height: 1.7; }
</style>
