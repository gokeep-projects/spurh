<script lang="ts">
  import { UI_ICONS } from '../icons';
  import { generateRegexSamples } from '../regexgen';
  import { parseLiteral } from '../plugins/builtin/regex';
  import type { PluginResult } from '../plugins/types';

  let { session, onChangeAction, onChangeOption, onChangeInput, onClear, aiConfigured = false, aiBusy = false, onAiGenerate, onAiRecommend }: {
    session: { actionId: string; options: Record<string, string>; input: string; result: PluginResult | null; error: string; processing: boolean };
    onChangeAction: (id: string) => void;
    onChangeOption: (id: string, v: string) => void;
    onChangeInput: (v: string) => void;
    onClear: () => void;
    aiConfigured?: boolean;
    aiBusy?: boolean;
    onAiGenerate?: (description: string) => Promise<void>;
    onAiRecommend?: (samples: string) => Promise<void>;
  } = $props();

  const PRESETS_VISIBLE = 8;
  let presetsAllOpen = $state(false);
  let aiDescription = $state('');
  let samples = $state<string[]>([]);
  let samplesCopied = $state('');
  let sampleError = $state('');
  // 记录已同步到选项的正则输入：仅在新内容路由进来时更新表达式/标志，避免与用户手动编辑冲突
  let syncedRegex: string | null = null;

  $effect(() => {
    const input = session.input.trim();
    if (!input || input === syncedRegex) return;
    const literal = parseLiteral(input);
    if (!literal) return;
    syncedRegex = input;
    if (session.options.pattern !== literal.pattern) onChangeOption('pattern', literal.pattern);
    if (session.options.flags !== (literal.flags || 'g')) onChangeOption('flags', literal.flags || 'g');
  });

  const PRESETS: Array<{ label: string; pattern: string; flags?: string }> = [
    { label: '邮箱', pattern: '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+' },
    { label: 'URL', pattern: 'https?://[\\w\\-._~:/?#\\[\\]@!$&\'()*+,;=%]+' },
    { label: '手机号', pattern: '1[3-9]\\d{9}' },
    { label: 'IPv4', pattern: '(?:\\d{1,3}\\.){3}\\d{1,3}' },
    { label: 'IPv6', pattern: '(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}' },
    { label: 'MAC 地址', pattern: '(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}' },
    { label: 'UUID', pattern: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' },
    { label: '日期', pattern: '\\d{4}-\\d{2}-\\d{2}' },
    { label: '日期时间', pattern: '\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}(?::\\d{2})?' },
    { label: '时间', pattern: '\\d{2}:\\d{2}(?::\\d{2})?' },
    { label: '13 位时间戳', pattern: '\\d{13}' },
    { label: 'IP:端口', pattern: '(?:\\d{1,3}\\.){3}\\d{1,3}:\\d{2,5}' },
    { label: '16 进制色值', pattern: '#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?' },
    { label: '中文', pattern: '[\\u4e00-\\u9fa5]+' },
    { label: '英文单词', pattern: '\\b[A-Za-z]+\\b' },
    { label: '驼峰命名', pattern: '\\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\\b' },
    { label: '引号内容', pattern: '"[^"]*"|\'[^\']*\'' },
    { label: 'HTML 标签', pattern: '<[^>]+>' },
    { label: '空白行', pattern: '^\\s*$', flags: 'gm' },
    { label: '注释', pattern: '//[^\n]*|/\\*[\\s\\S]*?\\*/' },
    { label: '文件扩展名', pattern: '\\.(?:json|txt|log|js|ts|py|rs|sql|md)$', flags: 'gim' },
    { label: 'Windows 路径', pattern: '[A-Za-z]:\\\\[^\"<>|?*]+' },
    { label: 'JSON 键', pattern: '"[^"]*"\\s*:' },
    { label: '重复单词', pattern: '\\b(\\w+)\\s+\\1\\b' },
  ];

  const FLAGS = [
    { v: 'g', l: 'g', d: '全局' },
    { v: 'i', l: 'i', d: '忽略大小写' },
    { v: 'm', l: 'm', d: '多行' },
    { v: 's', l: 's', d: '点匹配换行' },
    { v: 'u', l: 'u', d: 'Unicode' },
  ];

  const flagSet = $derived(new Set((session.options.flags || 'g').split('')));

  function setFlag(flag: string, on: boolean): void {
    const next = new Set(flagSet);
    if (on) next.add(flag); else next.delete(flag);
    if (!next.has('g')) next.add('g');
    onChangeOption('flags', [...next].join(''));
  }

  function applyPreset(preset: { label: string; pattern: string; flags?: string }): void {
    onChangeOption('pattern', preset.pattern);
    onChangeOption('flags', preset.flags ?? 'g');
    onChangeAction('test');
    presetApplied = preset.label;
  }

  let presetApplied = $state('');

  async function generateWithAi(): Promise<void> {
    const description = aiDescription.trim();
    if (!description || !onAiGenerate) return;
    await onAiGenerate(description);
    aiDescription = '';
  }

  function buildSamples(): void {
    const pattern = session.options.pattern || '';
    sampleError = '';
    if (!pattern) {
      samples = [];
      sampleError = '请先输入正则表达式';
      return;
    }
    samples = generateRegexSamples(pattern, session.options.flags || 'g', 6);
    if (samples.length === 0) sampleError = '暂无法为这个表达式生成样例（可能包含复杂断言），试试用 AI 推荐';
  }

  async function copySample(sample: string, key: string): Promise<void> {
    try { await navigator.clipboard.writeText(sample); } catch { return; }
    samplesCopied = key;
    setTimeout(() => { if (samplesCopied === key) samplesCopied = ''; }, 1100);
  }

  async function recommendRegex(): Promise<void> {
    const text = session.input.trim();
    if (!text || !onAiRecommend) return;
    await onAiRecommend(text);
  }
</script>

<div class="regex-panel">
  <div class="regex-row">
    <label class="pat-label"><span>表达式</span>
      <input class="regex-pat" value={session.options.pattern || ''} placeholder="例如: (?<name>\w+)" oninput={(e) => onChangeOption('pattern', e.currentTarget.value)} spellcheck="false" />
    </label>
    <div class="regex-flags" role="group" aria-label="标志">
      {#each FLAGS as f}
        <button class:active={flagSet.has(f.v)} title={f.d} onclick={() => setFlag(f.v, !flagSet.has(f.v))}>{f.l}</button>
      {/each}
    </div>
  </div>

  <div class="regex-presets">
    <span>常用</span>
    <div class="preset-scroll">
      {#each (presetsAllOpen ? PRESETS : PRESETS.slice(0, PRESETS_VISIBLE)) as preset}
        <button class:active={presetApplied === preset.label} title={preset.pattern} onclick={() => applyPreset(preset)}>{preset.label}</button>
      {/each}
    </div>
    <button class="preset-more" onclick={() => (presetsAllOpen = !presetsAllOpen)} title={presetsAllOpen ? '收起' : '展开全部常用表达式'}>
      {presetsAllOpen ? '收起 ▲' : `更多 ${PRESETS.length - PRESETS_VISIBLE} ▾`}
    </button>
  </div>

  {#if session.actionId === 'replace'}
    <div class="regex-row">
      <label><span>替换为</span>
        <input class="regex-repl" value={session.options.replacement || ''} placeholder="替换文本，如 $1" oninput={(e) => onChangeOption('replacement', e.currentTarget.value)} spellcheck="false" />
      </label>
    </div>
  {/if}

  {#if presetApplied && !session.input.trim()}
    <p class="preset-hint">已套用「{presetApplied}」表达式，请在上方输入区粘贴要测试的文本。</p>
  {/if}

  <div class="regex-ai">
    <span class="ai-spark">{@html UI_ICONS.sparkle}</span>
    <input value={aiDescription} placeholder="自然语言描述，例如：匹配所有中国大陆手机号" oninput={(e) => (aiDescription = e.currentTarget.value)} onkeydown={(e) => { if (e.key === 'Enter') generateWithAi(); }} />
    <button class="ai-generate" disabled={!aiDescription.trim() || aiBusy || !aiConfigured} onclick={generateWithAi}>{aiBusy ? '生成中…' : 'AI 生成'}</button>
    <button class="ai-generate ghost" disabled={!session.input.trim() || aiBusy || !aiConfigured} onclick={recommendRegex} title="根据输入区的样例文本推断正则">样例→正则</button>
    {#if !aiConfigured}<small class="ai-hint">未配置 AI 模型</small>{/if}
  </div>

  <div class="regex-samples">
    <button class="sample-btn" disabled={!session.options.pattern} onclick={buildSamples} title="根据当前表达式生成匹配样例">生成样例</button>
    {#if samples.length}
      <div class="sample-chips">
        {#each samples as sample, i}
          <button class="sample-chip" class:copied={samplesCopied === String(i)} onclick={() => copySample(sample, String(i))} title="点击复制">{sample}</button>
        {/each}
      </div>
    {/if}
    {#if sampleError}<small class="sample-error">{sampleError}</small>{/if}
  </div>
</div>

<div class="regex-actions">
  <button class="primary" class:active={session.actionId === 'test'} onclick={() => onChangeAction('test')}>测试匹配</button>
  <button class:active={session.actionId === 'replace'} onclick={() => onChangeAction('replace')}>替换</button>
  <button class:active={session.actionId === 'explain'} onclick={() => onChangeAction('explain')}>解释</button>
  <div class="control-spacer"></div>
  <button class="regex-clear" onclick={onClear}>清空</button>
</div>

<style>
  .regex-panel { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }
  .regex-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .regex-row .pat-label { flex: 1; min-width: 240px; }
  .regex-row label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .regex-row label > span { color: var(--muted); font-size: 13px; }
  .regex-row input { height: 32px; color: var(--text); font: 500 13px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 6px; outline: 0; background: var(--bg); padding: 0 10px; }
  .regex-row input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .regex-pat { width: 100%; }
  .regex-repl { width: min(26vw, 240px); }
  .regex-flags { display: flex; gap: 3px; padding: 2px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); }
  .regex-flags button { width: 26px; height: 26px; cursor: pointer; color: var(--muted); font: 600 13px 'Cascadia Code', monospace; border: 0; border-radius: 5px; background: transparent; }
  .regex-flags button.active { color: #fff; background: var(--btn-gradient); }
  .regex-flags button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .regex-ai { display: flex; gap: 6px; align-items: center; }
  .regex-ai .ai-spark { color: var(--accent); font-size: 13px; }
  .regex-ai input { min-width: 0; flex: 1; height: 30px; padding: 0 10px; color: var(--text); font-size: 13px; border: 1px dashed var(--line-2); border-radius: 6px; outline: 0; background: var(--panel); }
  .regex-ai input:focus { border-style: solid; border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .regex-ai .ai-generate { height: 30px; padding: 0 12px; cursor: pointer; color: #fff; font-size: 13px; font-weight: 700; border: 0; border-radius: 6px; background: var(--btn-gradient); }
  .regex-ai .ai-generate:disabled { cursor: default; opacity: .4; }
  .regex-ai .ai-hint { color: var(--muted-2); font-size: 13px; }
  .regex-ai .ai-generate.ghost { background: transparent; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .regex-ai .ai-generate.ghost:hover:not(:disabled) { background: var(--accent-soft); }
  .regex-samples { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .regex-samples .sample-btn { height: 24px; padding: 0 10px; cursor: pointer; color: var(--accent); font-size: 13px; font-weight: 600; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius: 12px; background: transparent; white-space: nowrap; }
  .regex-samples .sample-btn:hover:not(:disabled) { background: var(--accent-soft); }
  .regex-samples .sample-btn:disabled { cursor: default; opacity: .4; }
  .sample-chips { display: flex; gap: 5px; flex-wrap: wrap; }
  .sample-chips button { padding: 3px 10.5px; cursor: pointer; color: var(--text); font: 500 13px 'Cascadia Code', monospace; border: 1px dashed var(--line-2); border-radius: 6px; background: var(--panel); user-select: all; }
  .sample-chips button:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); color: var(--accent); }
  .sample-chips button.copied { border-style: solid; border-color: var(--accent); color: var(--accent); }
  .sample-error { color: var(--danger); font-size: 13px; }
  .regex-presets { display: flex; gap: 8px; align-items: center; }
  .regex-presets > span { flex: 0 0 auto; color: var(--muted-2); font-size: 13px; }
  .preset-scroll { display: flex; gap: 5px; align-items: center; min-width: 0; overflow-x: auto; padding-bottom: 2px; }
  .preset-scroll::-webkit-scrollbar { height: 4px; }
  .preset-scroll::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 2px; }
  .regex-presets button { flex: 0 0 auto; height: 24px; padding: 0 10.5px; cursor: pointer; color: var(--muted); font-size: 13px; border: 1px solid var(--line); border-radius: 12px; background: transparent; white-space: nowrap; }
  .regex-presets button:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .regex-presets button.active { color: #fff; border-color: transparent; background: var(--btn-gradient); }
  .regex-presets .preset-more { height: 24px; padding: 0 10px; cursor: pointer; color: var(--accent); font-size: 13px; font-weight: 600; border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--line)); border-radius: 12px; background: transparent; white-space: nowrap; }
  .regex-presets .preset-more:hover { background: var(--accent-soft); border-style: solid; }
  .preset-hint { margin: 0; color: var(--warn); font-size: 13px; }
  .regex-actions { display: flex; gap: 4px; align-items: center; }
  .regex-actions button { height: 30px; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: 13px; border: 1px solid var(--line); border-radius: 6px; background: transparent; }
  .regex-actions button.primary { color: #fff; background: var(--btn-gradient); border-color: transparent; }
  .regex-actions button.primary.active { box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .regex-actions button.active:not(.primary) { color: var(--text); background: var(--panel-2); border-color: var(--line-2); }
  .regex-actions button:hover { background: var(--hover); }
  .regex-actions button.primary:hover { filter: brightness(1.08); }
  .regex-clear { height: 30px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: 13px; border: 1px solid transparent; border-radius: 6px; background: transparent; }
  .regex-clear:hover { color: var(--text); border-color: var(--line); }
  .control-spacer { flex: 1; }
</style>