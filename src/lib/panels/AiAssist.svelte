<script lang="ts">
  import { processWithAi, isAiConfigured, type AiConfig } from '../ai';
  import { UI_ICONS } from '../icons';

  type Preset = { label: string; text: string };

  let {
    config,
    tool,
    action = 'AI 助手',
    instruction = '',
    presets = [],
    getContext = () => '',
    onResult,
    compact = false,
  }: {
    config: AiConfig | undefined;
    tool: string;
    action?: string;
    instruction?: string;
    presets?: Preset[];
    getContext?: () => string;
    onResult?: (output: string) => void;
    compact?: boolean;
  } = $props();

  let open = $state(false);
  let prompt = $state('');
  let busy = $state(false);
  let error = $state('');
  let reasoning = $state('');
  let content = $state('');
  let copied = $state(false);

  const configured = $derived(isAiConfigured(config));

  function applyPreset(text: string): void {
    prompt = text;
  }

  async function run(): Promise<void> {
    if (!config || !configured || busy) return;
    const text = prompt.trim();
    if (!text) return;
    busy = true;
    error = '';
    reasoning = '';
    content = '';
    const context = getContext().trim();
    const localError = context || undefined;
    try {
      const result = await processWithAi(
        config,
        text,
        { tool, action, localError, userPrompt: instruction },
        (update) => {
          reasoning = update.reasoning;
          content = update.content;
        },
      );
      content = result.output;
      if (result.parseError) error = result.parseError;
      onResult?.(result.output);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function copyOutput(): Promise<void> {
    const { copyText } = await import('../env');
    await copyText(content);
    copied = true;
    setTimeout(() => (copied = false), 1100);
  }
</script>

<div class="ai-assist" class:compact class:busy={busy}>
  <div class="ai-head">
    <button class="ai-toggle" class:on={open} onclick={() => (open = !open)} title="AI 助手">
      <span class="ai-spark">{@html UI_ICONS.sparkle}</span>
      {open ? '收起 AI' : 'AI 助手'}
      <i class:busy></i>
    </button>
    {#if open}
      <div class="ai-presets">
        {#each presets as preset}
          <button class="ai-preset" onclick={() => applyPreset(preset.text)} title="填入提示词">{preset.label}</button>
        {/each}
      </div>
    {/if}
  </div>
  {#if open}
    <div class="ai-body">
      {#if !configured}
        <div class="ai-notice">
          <span>{@html UI_ICONS.sparkle}</span>
          <p>未配置 AI 模型，AI 功能暂不可用。可在「设置 → AI 模型」中一键添加。</p>
        </div>
      {:else}
        <div class="ai-prompt-row">
          <input
            bind:value={prompt}
            placeholder={compact ? '描述需求或粘贴报错，Enter 发送…' : '描述需求、粘贴报错内容，或使用上方预设…'}
            spellcheck="false"
            onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } }}
          />
          <button class="ai-send" disabled={!prompt.trim() || busy} onclick={run}>{busy ? '思考中…' : '发送'}</button>
        </div>
        {#if busy}
          <div class="ai-stream">
            {#if reasoning}<div class="ai-reasoning"><small>推理</small><p>{reasoning}</p></div>{/if}
            {#if content}<div class="ai-content"><small>✦ 回答</small><pre class="ai-answer">{content}</pre></div>{/if}
            {#if !content}<div class="ai-waiting"><span class="spinner"></span>AI 正在思考…</div>{/if}
          </div>
        {:else if content}
          <div class="ai-stream">
            <div class="ai-content"><small>回答</small><pre>{content}</pre></div>
            <div class="ai-result-actions">
              <button onclick={copyOutput}>{copied ? '已复制 ✓' : '复制'}</button>
              {#if onResult}<button onclick={() => onResult(content)}>应用</button>{/if}
            </div>
          </div>
        {/if}
        {#if error}<div class="ai-error"><i></i>{error}</div>{/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .ai-assist { position: relative; min-width: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--line)); border-radius: var(--radius); background: linear-gradient(160deg, color-mix(in srgb, var(--panel) 96%, var(--accent-soft)), var(--panel-2)); box-shadow: 0 6px 22px color-mix(in srgb, var(--accent) 8%, transparent); transition: border-color .2s ease, box-shadow .2s ease; }
  .ai-assist::before { content: ""; position: absolute; inset: -40% -20% auto; height: 60%; background: radial-gradient(40% 60% at 30% 0%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%); pointer-events: none; }
  .ai-assist:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); box-shadow: 0 8px 30px color-mix(in srgb, var(--accent) 14%, transparent); }
    .ai-assist { position: relative; min-width: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--line)); border-radius: var(--radius); background: linear-gradient(160deg, color-mix(in srgb, var(--panel) 96%, var(--accent-soft)), var(--panel-2)); box-shadow: 0 6px 22px color-mix(in srgb, var(--accent) 8%, transparent); transition: border-color .2s ease, box-shadow .2s ease; }
  .ai-assist::before { content: ""; position: absolute; inset: 0; padding: 1px; border-radius: inherit; background: linear-gradient(120deg, transparent 12%, color-mix(in srgb, var(--c-cyan) 45%, transparent) 38%, color-mix(in srgb, var(--c-magenta) 45%, transparent) 62%, transparent 88%); background-size: 220% 100%; animation: aiBorderFlow 5s linear infinite; -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude; pointer-events: none; }
  @keyframes aiBorderFlow { to { background-position: -220% 0; } }
  .ai-assist:hover { border-color: color-mix(in srgb, var(--accent) 42%, var(--line)); box-shadow: 0 8px 28px color-mix(in srgb, var(--accent) 14%, transparent); }
  .ai-assist.busy { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); animation: aiBusyGlow 1.8s ease-in-out infinite; }
  @keyframes aiBusyGlow { 0%, 100% { box-shadow: 0 8px 26px color-mix(in srgb, var(--accent) 12%, transparent); } 50% { box-shadow: 0 8px 34px color-mix(in srgb, var(--accent) 30%, transparent), 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); } }
  .ai-content pre { animation: aiAnswerIn .35s cubic-bezier(.2,.9,.3,1.15); }
  @keyframes aiAnswerIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
  .ai-head { display: flex; align-items: center; justify-content: center; gap: 9px; flex-wrap: wrap; padding: 8px 10px; }
  .ai-head::after { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 55%, transparent), transparent); }
  .ai-toggle { position: relative; height: 27px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; cursor: pointer; color: #fff; font-size: var(--fs-xs); font-weight: 700; border: 0; border-radius: 999px; background: linear-gradient(120deg, color-mix(in srgb, var(--c-cyan) 80%, var(--accent)), var(--accent) 55%, color-mix(in srgb, var(--c-magenta) 80%, var(--accent))); background-size: 180% 100%; box-shadow: 0 3px 12px color-mix(in srgb, var(--accent) 30%, transparent); transition: background-position .35s ease, transform .15s ease, box-shadow .2s ease; }
  .ai-toggle:hover { background-position: 100% 0; transform: translateY(-1px); box-shadow: 0 5px 18px color-mix(in srgb, var(--accent) 40%, transparent); }
  .ai-toggle.on { background: linear-gradient(120deg, color-mix(in srgb, var(--c-magenta) 80%, var(--accent)), var(--accent) 55%, color-mix(in srgb, var(--c-cyan) 80%, var(--accent))); }
  .ai-spark { display: inline-flex; }
  :global(.ai-spark svg) { width: 12px; height: 12px; }
  .ai-toggle i { width: 5px; height: 5px; border-radius: 50%; background: rgba(255, 255, 255, .85); }
  .ai-toggle i.busy { background: #fff; box-shadow: 0 0 8px #fff; animation: aiPulse 1s ease infinite; }
  @keyframes aiPulse { 50% { opacity: .3; } }
  .ai-presets { position: relative; z-index: 1; display: flex; align-items: center; gap: 5px; overflow-x: auto; scrollbar-width: none; }
  .ai-presets::-webkit-scrollbar { display: none; }
  .ai-preset { height: 25px; flex: 0 0 auto; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: var(--fs-sm); border: 1px solid var(--line); border-radius: 999px; background: color-mix(in srgb, var(--accent) 5%, var(--bg)); transition: all .15s ease; }
  .ai-preset:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 12%, transparent); }
  .ai-body { position: relative; z-index: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 9px 11px 11px; }
  .ai-notice { display: flex; align-items: center; gap: 8px; padding: 10px 12px; color: var(--muted); font-size: var(--fs-xs); border: 1px dashed color-mix(in srgb, var(--warn) 40%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--warn) 5%, var(--bg)); }
  .ai-notice span { display: inline-flex; color: var(--warn); }
  :global(.ai-notice span svg) { width: 14px; height: 14px; }
  .ai-prompt-row { display: flex; gap: 7px; }
  .ai-prompt-row input { min-width: 0; flex: 1; height: 33px; padding: 0 12px; color: var(--text); font: 500 var(--fs-sm) 'Cascadia Code', Consolas, monospace; border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--line)); border-radius: 10px; outline: 0; background: color-mix(in srgb, var(--accent) 4%, var(--bg)); transition: border-color .15s ease, box-shadow .2s ease; }
  .ai-prompt-row input:focus { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft), 0 0 14px color-mix(in srgb, var(--accent) 12%, transparent); }
  .ai-send { height: 31px; flex: 0 0 auto; padding: 0 16px; cursor: pointer; color: #fff; font-size: var(--fs-xs); font-weight: 700; border: 0; border-radius: 10px; background: linear-gradient(120deg, var(--c-cyan), var(--accent) 55%, var(--c-magenta)); background-size: 180% 100%; box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 24%, transparent); transition: background-position .3s ease, transform .15s ease; }
  .ai-send:hover:not(:disabled) { background-position: 100% 0; transform: translateY(-1px); }
  .ai-send:disabled { cursor: not-allowed; opacity: .45; box-shadow: none; }
  .ai-stream { display: flex; flex-direction: column; gap: 9px; max-height: min(28vh, 300px); overflow: auto; padding-right: 2px; }
  .ai-content { width: 100%; align-self: stretch; }
  .ai-reasoning { width: 100%; align-self: stretch; }
  .ai-reasoning, .ai-content { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .ai-reasoning small, .ai-content small { color: var(--muted-2); font: 600 var(--fs-tiny) 'Cascadia Code', monospace; letter-spacing: .8px; text-align: center; }
  .ai-reasoning p { margin: 0; padding: 9px 12px; color: var(--muted); font-size: var(--fs-xs); line-height: 1.65; border: 1px solid var(--line); border-left: 2px solid var(--c-cyan); border-radius: 8px; background: color-mix(in srgb, var(--c-cyan) 4%, var(--bg)); }
  .ai-content pre { width: min(100%, 680px); margin: 0 auto; padding: 14px 16px; overflow-x: auto; color: var(--text); font: 500 var(--fs-sm) 'Cascadia Code', Consolas, monospace; line-height: 1.7; white-space: pre-wrap; word-break: break-word; border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line)); border-radius: 14px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 7%, var(--bg)), var(--bg) 60%); box-shadow: 0 4px 18px color-mix(in srgb, var(--accent) 8%, transparent), inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent); }
  .ai-waiting { display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--muted); font-size: var(--fs-xs); }
  .ai-result-actions { display: flex; justify-content: flex-end; gap: 6px; }
  .ai-result-actions button { height: 28px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); transition: all .15s ease; }
  .ai-result-actions button:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .ai-error { display: flex; align-items: center; gap: 7px; padding: 8px 10px; color: var(--danger); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .ai-error i { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--danger); }
</style>
