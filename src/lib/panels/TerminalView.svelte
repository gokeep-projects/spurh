<script lang="ts">
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { Channel } from '@tauri-apps/api/core';
  import { isTauri, safeInvoke } from '../env';
  import '@xterm/xterm/css/xterm.css';

  type SshEvent = { kind: string; data?: string | null; message?: string | null };
  export type RemoteSession = {
    id: string;
    name: string;
    host: string;
    port: number;
    user: string;
    authType: 'password' | 'key';
    password: string;
    keyPath: string;
    passphrase: string;
  };

  const FONT_KEY = 'spurh.terminal.fontSize.v1';

  let { session, active, onState }: {
    session: RemoteSession;
    active: boolean;
    onState: (id: string, state: { status: string; message?: string }) => void;
  } = $props();

  let wrapEl: HTMLDivElement | undefined;
  let termEl: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let channel: Channel<SshEvent> | undefined;
  let connected = $state(false);
  let connecting = $state(false);
  let disposed = false;
  /** 会话在 ready 前已退出（服务器拒绝 shell 等情况），防止后续 ready 误报已连接 */
  let sessionDead = false;
  /** 终端区遮罩提示：连接失败 / 已断开 / 浏览器预览模式 */
  let banner = $state<{ kind: 'error' | 'disconnected' | 'preview'; message: string } | null>(null);
  let fontSize = $state<number>(loadFontSize());

  function loadFontSize(): number {
    const raw = Number(localStorage.getItem(FONT_KEY));
    return raw >= 10 && raw <= 24 ? raw : 13;
  }

  function saveFontSize(size: number): void {
    localStorage.setItem(FONT_KEY, String(size));
  }

  function cssVar(name: string, fallback: string): string {
    const app = document.querySelector('.app');
    if (!app) return fallback;
    return getComputedStyle(app).getPropertyValue(name).trim() || fallback;
  }

  /** 深色主题：深底浅字，高饱和亮色（默认） */
  const DARK_PALETTE = {
    black: '#0b0f14', red: '#f5637a', green: '#5ee8a5', yellow: '#e6c36a', blue: '#5ec8f0',
    magenta: '#d8a6ff', cyan: '#5fd7d4', white: '#d7dde3', brightBlack: '#7a8794',
    brightRed: '#ff8fa0', brightGreen: '#8af0bd', brightYellow: '#f2d98f', brightBlue: '#8fd8f7',
    brightMagenta: '#e6c0ff', brightCyan: '#8fe7e4', brightWhite: '#eef2f5',
  };
  /** 浅色主题：浅底深字，ANSI 颜色加深保证命令输出可读 */
  const LIGHT_PALETTE = {
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#9a6700', blue: '#0969da',
    magenta: '#8250df', cyan: '#1b7c83', white: '#57606a', brightBlack: '#6e7781',
    brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff',
    brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#24292f',
  };
  /** 极光主题：深色紫调 */
  const AURORA_PALETTE = {
    black: '#0e1029', red: '#f472b6', green: '#6ee7b7', yellow: '#fcd34d', blue: '#93c5fd',
    magenta: '#c4b5fd', cyan: '#67e8f9', white: '#e2e8f0', brightBlack: '#8b90c9',
    brightRed: '#fda4af', brightGreen: '#a7f3d0', brightYellow: '#fde68a', brightBlue: '#bfdbfe',
    brightMagenta: '#ddd6fe', brightCyan: '#a5f3fc', brightWhite: '#f8fafc',
  };
  /** 护眼主题：深色绿调 */
  const FOREST_PALETTE = {
    black: '#0a1f16', red: '#fb7185', green: '#34d399', yellow: '#fbbf24', blue: '#38bdf8',
    magenta: '#86efac', cyan: '#2dd4bf', white: '#d1e7dd', brightBlack: '#6b9180',
    brightRed: '#fda4af', brightGreen: '#6ee7b7', brightYellow: '#fde047', brightBlue: '#7dd3fc',
    brightMagenta: '#bbf7d0', brightCyan: '#5eead4', brightWhite: '#ecfdf5',
  };

  function currentTheme(): Record<string, string> {
    const app = document.querySelector('.app');
    const classes = app?.className ?? '';
    const palette = classes.includes('light')
      ? LIGHT_PALETTE
      : classes.includes('aurora')
        ? AURORA_PALETTE
        : classes.includes('forest')
          ? FOREST_PALETTE
          : DARK_PALETTE;
    return {
      background: cssVar('--bg', '#080b0e'),
      foreground: cssVar('--text', '#e4e9ef'),
      cursor: cssVar('--accent', '#5ee8a5'),
      selectionBackground: cssVar('--accent-soft', 'rgba(94,232,165,.3)'),
      ...palette,
    };
  }

  function toBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function pushData(base64: string): void {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      term?.write(bytes);
    } catch { /* 忽略损坏的负载 */ }
  }

  async function connect(): Promise<void> {
    if (!term || connected || connecting || disposed) return;
    if (!isTauri) {
      // 浏览器预览模式没有 Tauri IPC：给出明确提示，而不是卡死或报底层错误
      banner = { kind: 'preview', message: '浏览器预览模式没有桌面能力，无法建立 SSH 连接。请运行 npm run tauri dev 打开桌面版使用远程终端。' };
      onState(session.id, { status: 'error', message: '浏览器预览模式无法使用 SSH，请运行 npm run tauri dev 打开桌面版' });
      return;
    }
    connecting = true;
    sessionDead = false;
    banner = null;
    onState(session.id, { status: 'connecting', message: '正在连接 ' + session.host + ':' + session.port + ' …' });
    try {
      channel = new Channel<SshEvent>();
      channel.onmessage = (event) => {
        if (event.kind === 'ready') {
          if (sessionDead) {
            // 会话在 ready 前已退出：立即关闭，避免界面误报“已连接”但终端无响应
            safeInvoke('ssh_close', { sessionId: session.id }).catch(() => undefined);
            return;
          }
          connected = true;
          connecting = false;
          banner = null;
          onState(session.id, { status: 'connected' });
          requestAnimationFrame(() => fit());
        } else if (event.kind === 'data' && event.data) {
          pushData(event.data);
        } else if (event.kind === 'exit') {
          const wasConnected = connected;
          connected = false;
          connecting = false;
          const message = event.message ?? '连接已关闭';
          if (!wasConnected) {
            // 尚未 ready 就退出（服务器拒绝 PTY/Shell 或立即断开）按连接失败处理
            sessionDead = true;
            banner = { kind: 'error', message };
            onState(session.id, { status: 'error', message });
          } else {
            banner = { kind: 'disconnected', message };
            onState(session.id, { status: 'disconnected', message });
          }
        } else if (event.kind === 'error') {
          connected = false;
          connecting = false;
          sessionDead = true;
          const message = event.message ?? '连接失败';
          banner = { kind: 'error', message };
          onState(session.id, { status: 'error', message });
        }
      };
      await safeInvoke('ssh_connect', {
        sessionId: session.id,
        profile: {
          host: session.host,
          port: session.port,
          user: session.user,
          cols: Math.max(2, term.cols),
          rows: Math.max(2, term.rows),
          authType: session.authType,
          password: session.password,
          keyPath: session.keyPath,
          passphrase: session.passphrase,
        },
        out: channel,
      });
      // 组件在连接期间被卸载（例如重连）时，立即关闭新会话，避免悬挂
      if (disposed) {
        safeInvoke('ssh_close', { sessionId: session.id }).catch(() => undefined);
        return;
      }
    } catch (cause) {
      connected = false;
      connecting = false;
      sessionDead = true;
      const message = cause instanceof Error ? cause.message : String(cause);
      banner = { kind: 'error', message };
      onState(session.id, { status: 'error', message });
    }
  }

  function fit(): void {
    if (!fitAddon || !term) return;
    try {
      fitAddon.fit();
      if (connected) {
        safeInvoke('ssh_resize', { sessionId: session.id, cols: term.cols, rows: term.rows }).catch(() => undefined);
      }
    } catch { /* 隐藏状态下无法计算尺寸 */ }
  }

  function setFontSize(size: number): void {
    const clamped = Math.min(24, Math.max(10, size));
    fontSize = clamped;
    saveFontSize(clamped);
    if (term) {
      term.options.fontSize = clamped;
      requestAnimationFrame(() => fit());
    }
  }

  function clearScreen(): void {
    term?.clear();
  }

  function copySelection(): void {
    const selection = term?.getSelection();
    if (selection) {
      import('../env').then(({ copyText }) => copyText(selection)).catch(() => undefined);
    }
  }

  function pasteText(): void {
    import('../env').then(({ readClipboardText }) =>
      readClipboardText().then((text) => {
        if (text && connected) {
          safeInvoke('ssh_write', { sessionId: session.id, data: toBase64(text) }).catch(() => undefined);
        }
      }),
    ).catch(() => undefined);
  }

  // 仅活动标签页建立连接：切换标签时新标签自动连接，旧标签保持不断开
  $effect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      if (term) term.focus();
      fit();
    });
    if (!connected && !connecting && !disposed && !sessionDead) connect();
  });

  onMount(() => {
    term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'block',
      fontSize,
      fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
      lineHeight: 1.3,
      scrollback: 6000,
      theme: currentTheme(),
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termEl!);
    // 终端快捷键：Ctrl+L 清屏 / Ctrl+Shift+C 复制 / Ctrl+Shift+V 粘贴
    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        term?.clear();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelection();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteText();
        return false;
      }
      return true;
    });
    term.onData((data) => {
      if (connected) safeInvoke('ssh_write', { sessionId: session.id, data: toBase64(data) }).catch(() => undefined);
    });
    term.onResize(({ cols, rows }) => {
      if (connected) safeInvoke('ssh_resize', { sessionId: session.id, cols, rows }).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => fit());
    observer.observe(wrapEl!);
    // 应用主题切换（亮/暗/跟随系统）时同步终端配色
    const appEl = document.querySelector('.app');
    const themeObserver = new MutationObserver(() => {
      if (term) term.options.theme = currentTheme();
    });
    if (appEl) {
      themeObserver.observe(appEl, { attributes: true, attributeFilter: ['class'] });
    }
    // 首次挂载即建立连接：$effect 先于 onMount 运行时 term 尚未创建，connect() 会被跳过，需在此补连
    if (active) connect();
    return () => {
      disposed = true;
      observer.disconnect();
      themeObserver.disconnect();
      safeInvoke('ssh_close', { sessionId: session.id }).catch(() => undefined);
      channel = undefined;
      term?.dispose();
      term = undefined;
    };
  });
</script>

<div class="term-pane" class:inactive={!active}>
  <div class="term-toolbar" title="终端工具栏">
    <span class="term-status" class:on={connected} class:off={!connected && !connecting} class:busy={connecting}>
      <i></i>{connecting ? '连接中…' : connected ? '已连接' : '未连接'}
    </span>
    <i></i>
    <button onclick={() => setFontSize(fontSize - 1)} title="减小字号">A−</button>
    <span class="term-font">{fontSize}</span>
    <button onclick={() => setFontSize(fontSize + 1)} title="增大字号">A+</button>
    <i></i>
    <button onclick={clearScreen} title="清空终端回滚缓冲区">清屏</button>
    <button onclick={copySelection} title="复制选中内容">复制</button>
    <button onclick={pasteText} title="粘贴到远程终端">粘贴</button>
  </div>
  <div class="term-wrap" bind:this={wrapEl}>
    <div class="term-box" bind:this={termEl}></div>
    {#if banner}
      <div class="term-banner" class:error={banner.kind === 'error'} class:preview={banner.kind === 'preview'}>
        <b>{banner.kind === 'error' ? '连接失败' : banner.kind === 'preview' ? '浏览器预览模式' : '已断开'}</b>
        <p>{banner.message}</p>
        <button onclick={() => { banner = null; connect(); }}>重新连接</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .term-pane { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
  .term-pane.inactive { display: none; }
  .term-toolbar { height: 30px; flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 0 8px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .term-toolbar button { height: 26px; padding: 0 8px; cursor: pointer; color: var(--muted); font-size: var(--fs-tiny); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .term-toolbar button:hover { color: var(--text); border-color: var(--line-2); }
  .term-toolbar i { width: 1px; height: 14px; margin: 0 3px; background: var(--line); }
  .term-toolbar .term-font { min-width: 22px; color: var(--muted-2); font: 500 var(--fs-xs) 'Cascadia Code', monospace; text-align: center; }
  .term-status { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; color: var(--muted); font-size: var(--fs-tiny); font-weight: 600; border: 1px solid var(--line); border-radius: 999px; }
  .term-status i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-2); }
  .term-status.on { color: var(--c-green); border-color: color-mix(in srgb, var(--c-green) 40%, var(--line)); background: color-mix(in srgb, var(--c-green) 8%, transparent); }
  .term-status.on i { background: var(--c-green); box-shadow: 0 0 8px var(--c-green); }
  .term-status.busy { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .term-status.busy i { background: var(--accent); animation: term-blink 1s ease infinite; }
  .term-status.off i { background: var(--muted-2); }
  @keyframes term-blink { 50% { opacity: .3; } }
  .term-wrap { min-width: 0; min-height: 0; flex: 1; display: flex; position: relative; }
  .term-box { min-width: 0; min-height: 0; flex: 1; padding: 8px 10px; overflow: hidden; background: var(--bg); }
  .term-box :global(.xterm) { height: 100%; }
  .term-banner { position: absolute; inset: 8px; z-index: 10; display: grid; place-content: center; justify-items: center; gap: 8px; padding: 20px; text-align: center; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--line)); border-radius: 12px; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(6px); }
  .term-banner.preview { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
  .term-banner b { color: var(--danger); font-size: var(--fs-sm); }
  .term-banner.preview b { color: var(--accent); }
  .term-banner p { margin: 0; max-width: 420px; color: var(--muted); font-size: var(--fs-xs); line-height: 1.7; }
  .term-banner button { height: 28px; padding: 0 14px; cursor: pointer; color: #fff; font-size: var(--fs-xs); font-weight: 700; border: 0; border-radius: 8px; background: var(--btn-gradient); }
  .term-banner.preview button { display: none; }
</style>
