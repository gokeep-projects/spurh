<script lang="ts">
  import { UI_ICONS } from '../icons';
  import type { PluginResult } from '../plugins/types';

  let { session, onChangeAction, onChangeOption, onClear }: {
    session: { actionId: string; options: Record<string, string>; input: string; result: PluginResult | null; error: string; processing: boolean };
    onChangeAction: (id: string) => void;
    onChangeOption: (id: string, v: string) => void;
    onClear: () => void;
  } = $props();

  let showSecret = $state(false);

  const GROUPS: Array<{ label: string; icon: string; items: Array<{ id: string; label: string; hint: string }> }> = [
    {
      label: 'AES',
      icon: UI_ICONS.key,
      items: [
        { id: 'aes-encrypt', label: '加密', hint: 'AES-256-GCM' },
        { id: 'aes-decrypt', label: '解密', hint: 'AES-256-GCM' },
      ],
    },
    {
      label: '密钥',
      icon: UI_ICONS.lock,
      items: [{ id: 'rsa-gen', label: 'RSA 密钥对', hint: '2048 位' }],
    },
    {
      label: 'JWT',
      icon: UI_ICONS.ticket,
      items: [
        { id: 'jwt-decode', label: '解码', hint: 'Header/Payload' },
        { id: 'jwt-verify', label: '验签', hint: 'HMAC' },
        { id: 'jwt-gen', label: '生成', hint: 'HS256' },
      ],
    },
    {
      label: '摘要',
      icon: UI_ICONS.hash,
      items: [
        { id: 'MD5', label: 'MD5', hint: '128 位' },
        { id: 'SHA-1', label: 'SHA-1', hint: '160 位' },
        { id: 'SHA-256', label: 'SHA-256', hint: '256 位' },
        { id: 'SHA-512', label: 'SHA-512', hint: '512 位' },
      ],
    },
    {
      label: 'HMAC',
      icon: UI_ICONS.shield,
      items: [
        { id: 'HMAC-SHA256', label: 'HMAC-SHA256', hint: '需要密钥' },
        { id: 'HMAC-SHA512', label: 'HMAC-SHA512', hint: '需要密钥' },
      ],
    },
  ];

  const needsSecret = $derived(['aes-encrypt', 'aes-decrypt', 'jwt-verify', 'jwt-gen', 'HMAC-SHA256', 'HMAC-SHA512'].includes(session.actionId));
</script>

<div class="crypto-panel">
  <div class="crypto-groups">
    {#each GROUPS as group}
      <div class="crypto-group">
        <span class="crypto-grp-label">{@html group.icon}<b>{group.label}</b></span>
        {#each group.items as item}
          <button class:active={session.actionId === item.id} title={item.hint} onclick={() => onChangeAction(item.id)}>
            {item.label}
          </button>
        {/each}
      </div>
    {/each}
  </div>

  {#if needsSecret}
    <div class="crypto-key-row">
      <label><span>密钥</span>
        <div class="secret-wrap">
          <input type={showSecret ? 'text' : 'password'} value={session.options.secret || ''} placeholder={session.actionId.startsWith('jwt') ? 'HMAC 签名密钥' : session.actionId.startsWith('aes') ? '加密/解密密钥' : 'HMAC 密钥'} oninput={(e) => onChangeOption('secret', e.currentTarget.value)} spellcheck="false" />
          <button class="secret-toggle" title={showSecret ? '隐藏' : '显示'} onclick={() => (showSecret = !showSecret)}>{@html showSecret ? UI_ICONS.eyeOff : UI_ICONS.eye}</button>
        </div>
      </label>
      <div class="control-spacer"></div>
      <button class="crypto-clear" onclick={onClear}>清空</button>
    </div>
  {:else}
    <div class="crypto-note">输入内容后自动处理；哈希与摘要仅需输入文本。</div>
  {/if}
</div>

<style>
  .crypto-panel { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }
  .crypto-groups { display: flex; gap: 12px; flex-wrap: wrap; }
  .crypto-group { display: flex; gap: 3px; align-items: center; padding: 3px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .crypto-grp-label { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 10px; font-weight: 700; margin: 0 4px; white-space: nowrap; }
  /* svelte-ignore css_unused_selector */
  .crypto-grp-label :global(svg) { width: 13px; height: 13px; }
  .crypto-group button { height: 26px; padding: 0 10.5px; cursor: pointer; color: var(--muted); font-size: 10px; border: 0; border-radius: 6px; background: transparent; white-space: nowrap; transition: all .15s ease; }
  .crypto-group button.active { color: #fff; background: var(--btn-gradient); box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .crypto-group button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .crypto-key-row { display: flex; gap: 8px; align-items: center; }
  .crypto-key-row label { display: flex; align-items: center; gap: 6px; }
  .crypto-key-row label > span { color: var(--muted); font-size: 11px; }
  .secret-wrap { position: relative; display: flex; align-items: center; }
  .secret-wrap input { height: 32px; width: min(26vw, 260px); padding: 0 34px 0 10px; color: var(--text); font: 500 12px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 6px; outline: 0; background: var(--bg); }
  .secret-wrap input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .secret-toggle { position: absolute; right: 4px; width: 26px; height: 26px; display: grid; place-items: center; cursor: pointer; font-size: 12px; border: 0; border-radius: 5px; background: transparent; }
  /* svelte-ignore css_unused_selector */
  .secret-toggle :global(svg) { width: 14px; height: 14px; }
  .secret-toggle:hover { background: var(--hover); }
  .crypto-clear { height: 30px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; }
  .crypto-clear:hover { color: var(--text); border-color: var(--line); }
  .crypto-note { color: var(--muted-2); font-size: 11px; }
  .control-spacer { flex: 1; }
</style>