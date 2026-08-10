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

  /** 当前动作是否需要密钥但未填写 → 面板内给出醒目标识 */
  const secretEmpty = $derived(!(session.options.secret ?? '').trim());

  /** 各动作的输入引导，让每个动作“该填什么”一目了然 */
  const ACTION_HINTS: Record<string, string> = {
    'aes-encrypt': '在下方输入明文并填写密钥：AES-256-GCM 加密，密钥取前 32 字节。',
    'aes-decrypt': '在下方粘贴 Base64 密文并填写密钥；密钥不符会解密失败。',
    'rsa-gen': '无需输入，点击后自动生成 2048 位 RSA-OAEP 密钥对。',
    'jwt-decode': '在下方粘贴 JWT 令牌，自动解析 Header 与 Payload。',
    'jwt-verify': '在下方粘贴 JWT 并填写 HMAC 签名密钥进行验签。',
    'jwt-gen': '在下方输入 JSON Payload 并填写 HMAC 签名密钥。',
    'MD5': '在下方输入文本自动计算摘要；留空则计算空串摘要。',
    'SHA-1': '在下方输入文本自动计算摘要；留空则计算空串摘要。',
    'SHA-256': '在下方输入文本自动计算摘要；留空则计算空串摘要。',
    'SHA-512': '在下方输入文本自动计算摘要；留空则计算空串摘要。',
    'HMAC-SHA256': '在下方输入文本并填写密钥，自动计算 HMAC 摘要。',
    'HMAC-SHA512': '在下方输入文本并填写密钥，自动计算 HMAC 摘要。',
  };

  const currentHint = $derived(ACTION_HINTS[session.actionId] ?? '');

  const GROUPS: Array<{ label: string; icon: string; wide?: boolean; items: Array<{ id: string; label: string; hint: string }> }> = [
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
      wide: true,
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
      wide: true,
      items: [
        { id: 'HMAC-SHA256', label: 'HMAC-SHA256', hint: '需要密钥' },
        { id: 'HMAC-SHA512', label: 'HMAC-SHA512', hint: '需要密钥' },
      ],
    },
  ];

  const needsSecret = $derived(['aes-encrypt', 'aes-decrypt', 'jwt-verify', 'jwt-gen', 'HMAC-SHA256', 'HMAC-SHA512'].includes(session.actionId));
</script>

<div class="crypto-panel">
  <div class="crypto-grid">
    {#each GROUPS as group}
      <div class="crypto-group" class:wide={group.wide}>
        <span class="crypto-grp-label">{@html group.icon}<b>{group.label}</b></span>
        <span class="crypto-btns">
          {#each group.items as item}
            <button class:active={session.actionId === item.id} title={item.hint} onclick={() => onChangeAction(item.id)}>
              {item.label}
            </button>
          {/each}
        </span>
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
    {#if secretEmpty}
      <p class="crypto-hint warn"><b>⚠ 该操作需要密钥</b>，未填写将无法执行；密钥仅用于本地运算，不会离开本机。</p>
    {/if}
  {/if}
  <p class="crypto-hint">{currentHint}</p>
</div>

<style>
  .crypto-panel { display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0; }
  .crypto-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; width: 100%; min-width: 0; }
  .crypto-group { min-width: 0; display: flex; flex-direction: row; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--panel) 96%, var(--accent-soft)); transition: border-color .15s ease, box-shadow .15s ease; }
  .crypto-group:hover { border-color: color-mix(in srgb, var(--accent) 32%, var(--line)); box-shadow: 0 2px 10px color-mix(in srgb, var(--accent) 7%, transparent); }
  .crypto-grp-label { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; color: var(--muted); font-size: var(--fs-xs); font-weight: 700; white-space: nowrap; }
  /* svelte-ignore css_unused_selector */
  .crypto-grp-label :global(svg) { width: 13px; height: 13px; }
  .crypto-btns { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; flex: 1; }
  .crypto-group.wide .crypto-btns { display: flex; flex-wrap: wrap; }
  .crypto-group button { position: relative; width: auto; min-width: 64px; flex: 0 0 auto; height: 26px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); font-weight: 600; border: 1px solid transparent; border-radius: 7px; background: transparent; white-space: nowrap; transition: all .15s ease; overflow: hidden; text-overflow: ellipsis; }
  .crypto-group button:hover:not(.active) { color: var(--text); border-color: var(--line); background: var(--hover); }
  .crypto-group button.active { color: #fff; background: linear-gradient(120deg, var(--c-cyan), var(--accent) 55%, var(--c-magenta)); background-size: 180% 100%; box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent); animation: cryptoGlow 2.4s ease infinite; }
  @keyframes cryptoGlow { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
  @media (max-width: 1100px) { .crypto-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 1281px) { .crypto-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
  .crypto-key-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .crypto-key-row label { display: flex; align-items: center; gap: 6px; }
  .crypto-key-row label > span { color: var(--muted); font-size: var(--fs-xs); }
  .secret-wrap { position: relative; display: flex; align-items: center; min-width: 0; }
  .secret-wrap input { height: 28px; width: min(24vw, 240px); max-width: 100%; padding: 0 34px 0 11px; color: var(--text); font: 500 var(--fs-sm) 'Cascadia Code', Consolas, monospace; border: 1px solid var(--line); border-radius: 9px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .2s ease; }
  .secret-wrap input:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .secret-toggle { position: absolute; right: 4px; width: 26px; height: 26px; display: grid; place-items: center; cursor: pointer; font-size: var(--fs-xs); border: 0; border-radius: 7px; background: transparent; }
  /* svelte-ignore css_unused_selector */
  .secret-toggle :global(svg) { width: 14px; height: 14px; }
  .secret-toggle:hover { background: var(--hover); }
  .crypto-clear { height: 30px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid transparent; border-radius: 8px; background: transparent; }
  .crypto-clear:hover { color: var(--text); border-color: var(--line); }
  .crypto-hint { margin: 0; color: var(--muted-2); font-size: var(--fs-xs); line-height: 1.6; }
  .crypto-hint.warn { color: var(--warn); }
  .crypto-hint.warn b { font-weight: 700; }
  .crypto-copy-tip { margin-left: 6px; color: var(--muted-2); }
  .control-spacer { flex: 1; }
</style>