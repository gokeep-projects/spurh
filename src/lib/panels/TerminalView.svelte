<script lang="ts">
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { Channel, invoke } from '@tauri-apps/api/core';
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
  let connected = false;
  let connecting = false;
  let disposed = false;
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
    connecting = true;
    channel = new Channel<SshEvent>();
    channel.onmessage = (event) => {
      if (event.kind === 'ready') {
        connected = true;
        connecting = false;
        onState(session.id, { status: 'connected' });
        requestAnimationFrame(() => fit());
      } else if (event.kind === 'data' && event.data) {
        pushData(event.data);
      } else if (event.kind === 'exit') {
        connected = false;
        connecting = false;
        onState(session.id, { status: 'disconnected', message: event.message ?? '连接已关闭' });
      } else if (event.kind === 'error') {
        connected = false;
        connecting = false;
        onState(session.id, { status: 'error', message: event.message ?? '连接失败' });
      }
    };
    try {
      await invoke('ssh_connect', {
        sessionId: session.id,
        profile: {
          host: session.host,
          port: session.port,
          user: session.user,
          cols: term.cols,
          rows: term.rows,
          authType: session.authType,
          password: session.password,
          keyPath: session.keyPath,
          passphrase: session.passphrase,
        },
        out: channel,
      });
      // 组件在连接期间被卸载（例如重连）时，立即关闭新会话，避免悬挂
      if (disposed) {
        invoke('ssh_close', { sessionId: session.id }).catch(() => undefined);
        return;
      }
    } catch (cause) {
      connected = false;
      connecting = false;
      onState(session.id, { status: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  function fit(): void {
    if (!fitAddon || !term) return;
    try {
      fitAddon.fit();
      if (connected) {
        invoke('ssh_resize', { sessionId: session.id, cols: term.cols, rows: term.rows }).catch(() => undefined);
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
    if (selection) navigator.clipboard.writeText(selection).catch(() => undefined);
  }

  function pasteText(): void {
    navigator.clipboard.readText()
      .then((text) => {
        if (text && connected) {
          invoke('ssh_write', { sessionId: session.id, data: toBase64(text) }).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  // 仅活动标签页建立连接：切换标签时新标签自动连接，旧标签保持不断开
  $effect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      if (term) term.focus();
      fit();
    });
    if (!connected && !connecting && !disposed) connect();
  });

  onMount(() => {
    term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'block',
      fontSize,
      fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
      lineHeight: 1.3,
      scrollback: 6000,
      theme: {
        background: cssVar('--bg', '#080b0e'),
        foreground: cssVar('--text', '#e4e9ef'),
        cursor: cssVar('--accent', '#5ee8a5'),
        selectionBackground: cssVar('--accent-soft', 'rgba(94,232,165,.3)'),
        black: '#0b0f14', red: '#f5637a', green: '#5ee8a5', yellow: '#e6c36a', blue: '#5ec8f0',
        magenta: '#d8a6ff', cyan: '#5fd7d4', white: '#d7dde3', brightBlack: '#7a8794',
        brightRed: '#ff8fa0', brightGreen: '#8af0bd', brightYellow: '#f2d98f', brightBlue: '#8fd8f7',
        brightMagenta: '#e6c0ff', brightCyan: '#8fe7e4', brightWhite: '#eef2f5',
      },
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termEl!);
    term.onData((data) => {
      if (connected) invoke('ssh_write', { sessionId: session.id, data: toBase64(data) }).catch(() => undefined);
    });
    term.onResize(({ cols, rows }) => {
      if (connected) invoke('ssh_resize', { sessionId: session.id, cols, rows }).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => fit());
    observer.observe(wrapEl!);
    return () => {
      disposed = true;
      observer.disconnect();
      invoke('ssh_close', { sessionId: session.id }).catch(() => undefined);
      channel = undefined;
      term?.dispose();
      term = undefined;
    };
  });
</script>

<div class="term-pane" class:inactive={!active}>
  <div class="term-toolbar" title="终端工具栏">
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
  </div>
</div>

<style>
  .term-pane { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
  .term-pane.inactive { display: none; }
  .term-toolbar { height: 30px; flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 0 8px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .term-toolbar button { height: 21px; padding: 0 8px; cursor: pointer; color: var(--muted); font-size: 10.6px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg); }
  .term-toolbar button:hover { color: var(--text); border-color: var(--line-2); }
  .term-toolbar i { width: 1px; height: 14px; margin: 0 3px; background: var(--line); }
  .term-toolbar .term-font { min-width: 22px; color: var(--muted-2); font: 500 10px 'Cascadia Code', monospace; text-align: center; }
  .term-wrap { min-width: 0; min-height: 0; flex: 1; display: flex; }
  .term-box { min-width: 0; min-height: 0; flex: 1; padding: 8px 10px; overflow: hidden; background: var(--bg); }
  .term-box :global(.xterm) { height: 100%; }
</style>
