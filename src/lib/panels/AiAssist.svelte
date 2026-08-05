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
    try { await navigator.clipboard.writeText(content); } catch { return; }
    copied = true;
    setTimeout(() => (copied = false), 1100);
  }
</script>

<div class="ai-assist" class:compact>
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
          <p>尚未配置 AI 模型。请先在右上角「设置 → AI 模型」中添加并启用。</p>
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
            {#if content}<div class="ai-content"><small>回答</small><pre>{content}</pre></div>{/if}
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
  .ai-assist { min-width: 0; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); overflow: hidden; }
  .ai-head { min-height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 9px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, color-mix(in srgb, var(--panel) 92%, var(--accent-soft)), var(--panel)); }
  .ai-toggle { height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; cursor: pointer; color: var(--accent); font-size: 10px; font-weight: 700; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 999px; background: var(--accent-soft); transition: all .15s ease; }
  .ai-toggle:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 18%, transparent); }
  .ai-toggle.on { color: #fff; background: linear-gradient(135deg, var(--accent), var(--blue)); border-color: transparent; }
  .ai-spark { display: inline-flex; }
  :global(.ai-spark svg) { width: 12px; height: 12px; }
  .ai-toggle i { width: 5px; height: 5px; border-radius: 50%; background: transparent; }
  .ai-toggle i.busy { background: var(--accent); box-shadow: 0 0 7px var(--accent); animation: aiPulse 1s ease infinite; }
  @keyframes aiPulse { 50% { opacity: .35; } }
  .ai-presets { display: flex; align-items: center; gap: 5px; overflow-x: auto; scrollbar-width: none; }
  .ai-presets::-webkit-scrollbar { display: none; }
  .ai-preset { height: 22px; flex: 0 0 auto; padding: 0 9px; cursor: pointer; color: var(--muted); font-size: 9px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); transition: all .15s ease; }
  .ai-preset:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .ai-body { min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 9px; }
  .ai-notice { display: flex; align-items: center; gap: 8px; padding: 10px 12px; color: var(--muted); font-size: 10px; border: 1px dashed var(--line-2); border-radius: 8px; background: var(--bg); }
  .ai-notice span { display: inline-flex; color: var(--warn); }
  :global(.ai-notice span svg) { width: 14px; height: 14px; }
  .ai-prompt-row { display: flex; gap: 7px; }
  .ai-prompt-row input { min-width: 0; flex: 1; height: 32px; padding: 0 11px; color: var(--text); font: 500 11px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 7px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .ai-prompt-row input:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .ai-send { height: 32px; flex: 0 0 auto; padding: 0 14px; cursor: pointer; color: #fff; font-size: 10px; font-weight: 700; border: 0; border-radius: 7px; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 22%, transparent); transition: all .15s ease; }
  .ai-send:disabled { cursor: not-allowed; opacity: .45; box-shadow: none; }
  .ai-stream { min-width: 0; display: flex; flex-direction: column; gap: 7px; max-height: 300px; overflow-y: auto; padding: 2px; }
  .ai-reasoning, .ai-content { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .ai-reasoning small, .ai-content small { color: var(--muted-2); font: 600 8px 'Cascadia Code', monospace; letter-spacing: .8px; }
  .ai-reasoning p { margin: 0; padding: 8px 10px; color: var(--muted); font-size: 10px; line-height: 1.6; border-left: 2px solid var(--line-2); background: var(--bg); }
  .ai-content pre { margin: 0; padding: 10px 12px; overflow-x: auto; color: var(--text); font: 500 10.5px 'Cascadia Code', monospace; line-height: 1.65; white-space: pre-wrap; word-break: break-word; border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--accent) 4%, var(--bg)); }
  .ai-waiting { display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--muted); font-size: 10px; }
  .ai-result-actions { display: flex; justify-content: flex-end; gap: 6px; }
  .ai-result-actions button { height: 24px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: 9.5px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); transition: all .15s ease; }
  .ai-result-actions button:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .ai-error { display: flex; align-items: center; gap: 7px; padding: 8px 10px; color: var(--danger); font-size: 10px; border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line)); border-radius: 7px; background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .ai-error i { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--danger); }
</style>
