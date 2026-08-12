<script lang="ts">
  import { flushSync, onMount, type Component } from 'svelte';
  import { fade } from 'svelte/transition';
  import { isTauri, safeInvoke, safeListen, copyText, readClipboardText } from './lib/env';
  import { AI_PRESETS, createAiProfile, deleteProfileSecret, fetchAiModels, flushLegacyAiSecrets, hydrateAiSecrets, isAiConfigured, loadAiProfileStore, processWithAi, saveAiProfileStore, saveProfileSecret, testAiConnection, type AiModel, type AiProfile } from './lib/ai';
  import { PROVIDER_NAMES, providerIcon } from './lib/providerIcons';
  import { BRAND_MARK, TOOL_ICONS, UI_ICONS, iconHtml } from './lib/icons';
  import { highlightCode } from './lib/highlight';
  import ResultView from './lib/components/ResultView.svelte';
  import CronPanel from './lib/panels/CronPanel.svelte';
  import CryptoPanel from './lib/panels/CryptoPanel.svelte';
  import RegexPanel from './lib/panels/RegexPanel.svelte';
  import TimestampPanel from './lib/panels/TimestampPanel.svelte';
  import { buildExpression } from './lib/plugins/builtin/cron';
  import { runtime, type PluginResult } from './lib/plugins';

  type ToolSession = {
    input: string;
    actionId: string;
    options: Record<string, string>;
    result: PluginResult | null;
    error: string;
    processing: boolean;
    revision: number;
    aiResult: PluginResult | null;
    aiError: string;
    aiProcessing: boolean;
    aiReasoning: string;
    aiStreamContent: string;
  };

  type ThemeMode = 'light' | 'dark' | 'system' | 'aurora' | 'forest';
  type SettingsTab = 'general' | 'ai' | 'about' | 'shortcuts' | 'tools';

  const SETTINGS_TAB_TITLES: Record<SettingsTab, string> = {
    general: '通用设置', ai: 'AI 模型', shortcuts: '快捷键', tools: '工具管理', about: '关于 Spurh',
  };
  const SETTINGS_TAB_HINTS: Record<SettingsTab, string> = {
    general: '主题 · 启动 · 托盘 · 顶栏显示', ai: '服务商配置 · 模型管理', shortcuts: '全局绑定 · 点击后直接按下新组合', tools: '侧栏与聚焦框中的工具显示', about: '版本信息 · 本地优先 · AI 增强',
  };

  const FONT_STACKS: Record<string, string> = {
    '系统默认': "'Segoe UI Variable Text', 'Segoe UI Variable Display', 'HarmonyOS Sans SC', 'MiSans', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', ui-sans-serif, system-ui, sans-serif",
    '微软雅黑': "'HarmonyOS Sans SC', 'MiSans', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', sans-serif",
    '等线': "'DengXian', 'DengXian Light', 'HarmonyOS Sans SC', 'Microsoft YaHei UI', sans-serif",
    '黑体': "'SimHei', '黑体', 'HarmonyOS Sans SC', 'Microsoft YaHei', sans-serif",
    '宋体': "'SimSun', '宋体', 'STSong', serif",
    'Consolas': "'Consolas', 'Cascadia Code', monospace",
    'Cascadia Code': "'Cascadia Code', Consolas, monospace",
  };

  type AppSettings = {
    theme: ThemeMode;
    trayEnabled: boolean;
    contextMenuEnabled: boolean;
    dispatchHotkey: string;
    toolHotkeys: Record<string, string>;
    fontSize: number;
    fontFamily: string;
    sidebarOpen: boolean;
    hiddenTools: string[];
    topBarFullscreen: boolean;
    topBarSettings: boolean;
    fontSizeMigrated?: boolean;
    fontSizeMigrated2?: boolean;
    fontSizeMigrated3?: boolean;
  };

  type ContextInfo = { path: string; content: string };

  type PaletteItem = { id: string; group: string; label: string; hint: string; icon: string; run: () => void };

  const SETTINGS_KEY = 'spurh.settings.v1';
  const LAST_TOOL_KEY = 'spurh.lastTool';

  function loadAppSettings(): AppSettings {
    const fallback: AppSettings = {
      theme: 'dark', trayEnabled: true, contextMenuEnabled: true, dispatchHotkey: 'ctrl+shift+space',
      toolHotkeys: { '0': 'alt+1', '1': 'alt+2', '2': 'alt+3', '3': 'alt+4', '4': 'alt+5', '5': 'alt+6', '6': 'alt+7', '7': 'alt+8' },
      fontSize: 14, fontFamily: '系统默认',
      sidebarOpen: true,
      hiddenTools: [],
      topBarFullscreen: true,
      topBarSettings: true,
    };
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      const parsed = stored ? JSON.parse(stored) : {};
      // 字号：用户手动档位直接采用（默认 14），仅接受 12–20 合理范围
      const userFontSize = typeof parsed.fontSize === 'number' && parsed.fontSize >= 12 && parsed.fontSize <= 20 ? parsed.fontSize : fallback.fontSize;
      // 一次性迁移：历史遗留字号统一重置为默认 14px（用户要求默认 14）
      if (!parsed.fontSizeMigrated3) {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...parsed, fontSize: 14, fontSizeMigrated3: true })); } catch { /* ignore */ }
      }
      const fontSize = parsed.fontSizeMigrated3 ? userFontSize : 14;
      return {
        ...fallback,
        ...parsed,
        hiddenTools: Array.isArray(parsed.hiddenTools) ? parsed.hiddenTools : fallback.hiddenTools,
        fontSize,
        fontFamily: FONT_STACKS[parsed.fontFamily] ? parsed.fontFamily : '系统默认',
      };
    } catch {
      return fallback;
    }
  }

  function formatHotkey(hk: string): string {
    if (!hk || hk === 'off') return '已禁用';
    const parts: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Win', space: 'Space', up: '↑', down: '↓', left: '←', right: '→', enter: 'Enter', tab: 'Tab', esc: 'Esc', backspace: 'Backspace', delete: 'Del', home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn', insert: 'Ins' };
    return hk.split('+').map((part) => parts[part] ?? part.toUpperCase()).join(' + ');
  }

  function normalizeKeyName(key: string): string | null {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
    if (key === ' ') return 'space';
    if (/^[a-z]$/i.test(key)) return key.toLowerCase();
    if (/^[0-9]$/.test(key)) return key;
    if (/^F\d{1,2}$/i.test(key)) return key.toLowerCase();
    const map: Record<string, string> = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      Enter: 'enter', Tab: 'tab', Escape: 'esc', Backspace: 'backspace', Delete: 'delete',
      Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert',
      '`': 'backquote', '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright',
      '\\': 'backslash', ';': 'semicolon', "'": 'quote', ',': 'comma', '.': 'period', '/': 'slash',
    };
    return map[key] ?? key.toLowerCase();
  }

  const plugins = runtime.list();
  const categories = ['全部', '数据', '编码', '安全', '开发'] as const;
  const starterInput: Record<string, string> = {
    'spurh.json': '{\n  "name": "spurh",\n  "native": true,\n  "version": "0.1.0"\n}',
  };

  function makeSession(plugin: (typeof plugins)[number]): ToolSession {
    return {
      input: starterInput[plugin.id] ?? '',
      actionId: plugin.actions[0].id,
      options: Object.fromEntries((plugin.options ?? []).map((option) => [option.id, option.defaultValue])),
      result: null,
      error: '',
      processing: false,
      revision: 0,
      aiResult: null,
      aiError: '',
      aiProcessing: false,
      aiReasoning: '',
      aiStreamContent: '',
    };
  }

  let sessions = $state<Record<string, ToolSession>>(Object.fromEntries(plugins.map((plugin) => [plugin.id, makeSession(plugin)])));
  function loadLastTool(): string {
    try {
      const last = localStorage.getItem(LAST_TOOL_KEY);
      if (last && plugins.some((plugin) => plugin.id === last)) return last;
    } catch { /* ignore */ }
    return 'spurh.json';
  }
  let activePluginId = $state(loadLastTool());
  // 记住上次使用的工具，重启后自动恢复
  $effect(() => {
    const id = activePluginId;
    try {
      localStorage.setItem(LAST_TOOL_KEY, id);
    } catch { /* ignore */ }
  });
  let dispatcherInput = $state('');
  let dispatcherElement = $state<HTMLTextAreaElement | undefined>(undefined);
  let inputElement = $state<HTMLTextAreaElement | undefined>(undefined);
  let streamScrollElement = $state<HTMLDivElement | undefined>(undefined);
  let toolSearch = $state('');
  let category = $state<(typeof categories)[number]>('全部');
  let copied = $state(false);
  const initialSettings = loadAppSettings();
  let appSettings = $state(initialSettings);
  // 窄窗口（≤850px）侧栏默认收起，避免覆盖工作区；用户手动切换会持久化
  let sidebarOpen = $state(typeof window !== 'undefined' ? (window.innerWidth > 850 && (initialSettings.sidebarOpen ?? true)) : true);
  let sidebarUserNarrowChoice = $state(false); // 窄窗口下用户主动展开过则尊重其选择
  const initialAiStore = loadAiProfileStore();
  let aiStore = $state(initialAiStore);
  let aiDraft = $state<AiProfile>(initialAiStore.profiles.find((profile) => profile.id === initialAiStore.activeId) ?? createAiProfile());
  let aiKeyVisible = $state(false);
  let settingsOpen = $state(false);
  let resultRawMode = $state(false);
  let settingsTab = $state<SettingsTab>('general');
  let settingsNotice = $state('');
  let autostartEnabled = $state(false);
  let settingsBusy = $state('');
  let settingsError = $state('');
  let hotkeyError = $state('');
  let modelList = $state<AiModel[]>([]);
  let modelListLoading = $state(false);
  let aiTestStatus = $state<'idle' | 'testing' | 'success' | 'error'>('idle');
  let aiTestMessage = $state('');
  let contextMenuEnabled = $state(initialSettings.contextMenuEnabled);
  let openFileContext = $state<ContextInfo | null>(null);
  let dispatchIndex = $state(0);
  let dispatchHotkey = $state(initialSettings.dispatchHotkey || 'ctrl+shift+space');
  let recordingTool = $state<number | null>(null);
  let recordingDispatch = $state(false);
  let paletteOpen = $state(false);
  let paletteQuery = $state('');
  let paletteIndex = $state(0);
  let paletteElement = $state<HTMLInputElement | undefined>(undefined);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /* ── 关于页实时动态：打字标语 + 能力标签 ── */
  let aboutCanvas = $state<HTMLCanvasElement | undefined>(undefined);
  let aboutTagline = $state('');
  let aboutPanelsShown = $state(0);
  let aboutStageEl = $state<HTMLDivElement | undefined>(undefined);

  const aboutPhrases = ['AI Native Developer Toolbox', '本地优先 · 数据不出设备', '粘贴即用 · 一步完成', '11 个工具 · 一个入口'];
  const BUILD_STAMP = __BUILD_DATE__; // 构建标记来自 vite define
  
  function startAboutCanvas(canvas: HTMLCanvasElement, stage: HTMLElement, isLight: boolean): () => void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};
    const g = ctx;
    const colors = isLight
      ? ['rgba(8,145,178,', 'rgba(91,33,182,', 'rgba(168,22,122,']
      : ['rgba(34,211,238,', 'rgba(139,92,246,', 'rgba(232,121,249,'];
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let raf = 0, w = 0, h = 0, lastT = 0;
    const mouse = { x: -9999, y: -9999 };
    let parts: { x: number; y: number; vx: number; vy: number; r: number; c: number }[] = [];
    function size() {
      w = stage.clientWidth; h = stage.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.max(24, Math.min(56, Math.round((w * h) / 13000)));
      parts = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - .5) * .4, vy: (Math.random() - .5) * .4,
        r: 1.1 + Math.random() * 1.6, c: Math.floor(Math.random() * colors.length)
      }));
    }
    const ro = new ResizeObserver(() => size());
    ro.observe(stage);
    size();
    function onMove(e: PointerEvent) {
      const r = stage.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
    }
    function onLeave() { mouse.x = -9999; mouse.y = -9999; }
    stage.addEventListener('pointermove', onMove, { passive: true });
    stage.addEventListener('pointerleave', onLeave, { passive: true });
    function frame(t: number) {
      if (document.hidden) { raf = requestAnimationFrame(frame); return; }
      if (t - lastT < 40) { raf = requestAnimationFrame(frame); return; }
      lastT = t;
      g.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -12) p.x = w + 12; else if (p.x > w + 12) p.x = -12;
        if (p.y < -12) p.y = h + 12; else if (p.y > h + 12) p.y = -12;
        const dx = p.x - mouse.x, dy = p.y - mouse.y, d2 = dx * dx + dy * dy;
        if (d2 < 14400 && d2 > .01) { const d = Math.sqrt(d2); p.x += (dx / d) * .55; p.y += (dy / d) * .55; }
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        g.fillStyle = colors[p.c] + '.65)'; g.fill();
      }
      for (let i = 0; i < parts.length; i++) {
        const a = parts[i];
        for (let j = i + 1; j < parts.length; j++) {
          const b = parts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 8100) {
            const alpha = (1 - Math.sqrt(d2) / 90) * .2;
            g.strokeStyle = colors[a.c] + alpha + ')';
            g.lineWidth = 1;
            g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
          }
        }
        const mdx = a.x - mouse.x, mdy = a.y - mouse.y, md2 = mdx * mdx + mdy * mdy;
        if (md2 < 16900) {
          const alpha = (1 - Math.sqrt(md2) / 130) * .28;
          g.strokeStyle = colors[a.c] + alpha + ')';
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(mouse.x, mouse.y); g.stroke();
        }
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerleave', onLeave);
    };
  }

    function startAboutTilt(stage: HTMLElement): () => void {
    const target = stage.querySelector<HTMLElement>('.about-logo-wrap');
    if (!target) return () => {};
    const aurora = stage.querySelector<HTMLElement>('.about-aurora');
    const orbA = stage.querySelector<HTMLElement>('.about-orb-a');
    const orbB = stage.querySelector<HTMLElement>('.about-orb-b');
    let raf = 0;
    const glow = document.createElement('i');
    glow.className = 'about-glow';
    glow.setAttribute('aria-hidden', 'true');
    stage.appendChild(glow);
    const onMove = (e: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        target.style.transform = `perspective(900px) rotateX(${(-ny * 8).toFixed(2)}deg) rotateY(${(nx * 12).toFixed(2)}deg) translateZ(0)`;
        if (aurora) { aurora.style.setProperty('--ax', (nx * 14).toFixed(1) + 'px'); aurora.style.setProperty('--ay', (ny * 10).toFixed(1) + 'px'); }
        if (orbA) { orbA.style.setProperty('--dx', (nx * -18).toFixed(1) + 'px'); orbA.style.setProperty('--dy', (ny * -14).toFixed(1) + 'px'); }
        if (orbB) { orbB.style.setProperty('--dx', (nx * 16).toFixed(1) + 'px'); orbB.style.setProperty('--dy', (ny * 12).toFixed(1) + 'px'); }
        glow.style.opacity = '1';
        glow.style.transform = `translate3d(${(e.clientX - r.left - 90).toFixed(1)}px, ${(e.clientY - r.top - 90).toFixed(1)}px, 0)`;
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        target.style.transform = '';
        if (aurora) { aurora.style.removeProperty('--ax'); aurora.style.removeProperty('--ay'); }
        if (orbA) { orbA.style.removeProperty('--dx'); orbA.style.removeProperty('--dy'); }
        if (orbB) { orbB.style.removeProperty('--dx'); orbB.style.removeProperty('--dy'); }
        glow.style.opacity = '0';
      });
    };
    stage.addEventListener('pointermove', onMove, { passive: true });
    stage.addEventListener('pointerleave', onLeave, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerleave', onLeave);
      glow.remove();
    };
  }

  $effect(() => {
    if (settingsOpen && settingsTab === 'about') {
      const isLightTheme = appSettings.theme === 'light' || (appSettings.theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);

      /* 打字机标语 */
      let phrase = 0, char = 0, deleting = false;
      const typeTimer = setInterval(() => {
        const cur = aboutPhrases[phrase];
        if (!deleting) {
          char += 1;
          aboutTagline = cur.slice(0, char);
          if (char >= cur.length) { deleting = true; }
        } else {
          char -= 1;
          aboutTagline = cur.slice(0, char);
          if (char <= 0) { deleting = false; phrase = (phrase + 1) % aboutPhrases.length; }
        }
      }, 90);
      /* 内置工具数量滚动增长 */
      aboutPanelsShown = 0;
      const growCounter = setInterval(() => {
        if (aboutPanelsShown < 11) aboutPanelsShown += 1; else clearInterval(growCounter);
      }, 70);
      /* 粒子网络画布 */
      let disposeCanvas: (() => void) | undefined;
      if (aboutCanvas && aboutCanvas.parentElement) {
        disposeCanvas = startAboutCanvas(aboutCanvas, aboutCanvas.parentElement, isLightTheme);
      }
      const disposeTilt = aboutStageEl ? startAboutTilt(aboutStageEl) : () => {};
      return () => {
        clearInterval(typeTimer);
        clearInterval(growCounter);
        if (disposeCanvas) disposeCanvas();
        disposeTilt();
      };
    }
  });

  let activePlugin = $derived(plugins.find((plugin) => plugin.id === activePluginId)!);
  let activeSession = $derived(sessions[activePluginId]);
  let visibleResult = $derived(activeSession.aiResult ?? activeSession.result);
  let dispatch = $derived(runtime.dispatch(dispatcherInput));
  type DispatchCandidate = { plugin: (typeof plugins)[number]; confidence: number | null; reason?: string; suggestedAction?: string };
  let dispatcherCandidates = $derived<DispatchCandidate[]>(
    (() => {
      const query = dispatcherInput.trim();
      if (!query) return [];
      const isVisible = (plugin: (typeof plugins)[number]) => !appSettings.hiddenTools.includes(plugin.id);
      const detected: DispatchCandidate[] = [dispatch.selected, ...dispatch.alternatives]
        .filter((item): item is NonNullable<typeof item> => item !== null && isVisible(item.plugin))
        .map((item) => ({ plugin: item.plugin, confidence: item.confidence, reason: item.reason, suggestedAction: item.suggestedAction }));
      const detectedIds = new Set(detected.map((item) => item.plugin.id));
      const ql = query.toLowerCase();
      const named: DispatchCandidate[] = plugins
        .filter((plugin) => isVisible(plugin) && !detectedIds.has(plugin.id))
        .filter((plugin) => `${plugin.name} ${plugin.description} ${plugin.category}`.toLowerCase().includes(ql))
        .slice(0, 5)
        .map((plugin) => ({ plugin, confidence: null, reason: '工具名称匹配' }));
      return [...detected, ...named];
    })(),
  );

  /* 空态不展示工具卡片：聚焦框空态为智能路由引擎提示台 */
  let visiblePlugins = $derived(plugins.filter((plugin) =>
    (category === '全部' || plugin.category === category)
    && !appSettings.hiddenTools.includes(plugin.id)
    && `${plugin.name} ${plugin.description}`.toLowerCase().includes(toolSearch.toLowerCase()),
  ));
  let aiConfig = $derived(aiStore.profiles.find((profile) => profile.id === aiStore.activeId));

  /* ── 重型面板按需懒加载：首屏不打包 SQL/SSH/网络等大模块 ── */
  type LazyPanelModule = { default: Component };
  const PANEL_LOADERS: Record<string, () => Promise<LazyPanelModule>> = {
    'spurh.network': () => import('./lib/panels/NetworkPanel.svelte') as Promise<LazyPanelModule>,
    'spurh.remote': () => import('./lib/panels/RemotePanel.svelte') as Promise<LazyPanelModule>,
    'spurh.sql': () => import('./lib/panels/SqlPanel.svelte') as Promise<LazyPanelModule>,
  };
  let lazyPanel = $state<Component | null>(null);
  let lazyPanelLoading = $state(false);
  const lazyPanelProps = $derived<Record<string, unknown>>(
    activePluginId === 'spurh.sql'
      ? { aiConfig }
      : {},
  );

  $effect(() => {
    const loader = PANEL_LOADERS[activePluginId];
    if (!loader) { lazyPanel = null; lazyPanelLoading = false; return; }
    let cancelled = false;
    lazyPanel = null;
    lazyPanelLoading = true;
    loader()
      .then((module) => { if (!cancelled) lazyPanel = module.default; })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) lazyPanelLoading = false; });
    return () => { cancelled = true; };
  });
  /* ===== 全屏支持 ===== */
  let isFullscreen = $state(false);
  let fullscreenSupported = $state(
    typeof document !== 'undefined' && (Boolean(document.documentElement.requestFullscreen) || isTauri),
  );
  async function toggleFullscreen(): Promise<void> {
    try {
      if (isTauri) {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          // 以真实窗口状态为准，避免本地状态与系统状态失同步；isFullscreen 失败时回退本地状态
          let current = isFullscreen;
          try { current = await win.isFullscreen(); } catch { /* 权限差异时使用本地状态 */ }
          const next = !current;
          await win.setFullscreen(next);
          isFullscreen = next;
          return;
        } catch {
          // 原生全屏失败时回退浏览器 API（WebView2 环境）
        }
      }
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      /* ignore */
    }
  }
  $effect(() => {
    if (isTauri) {
      // Tauri 下窗口 API 没有 fullscreenchange 事件，改用 resize 监听
      let disposed = false;
      let unlisten: (() => void) | undefined;
      import('@tauri-apps/api/window')
        .then(async ({ getCurrentWindow }) => {
          if (disposed) return;
          const win = getCurrentWindow();
          win.isFullscreen().then((f) => { if (!disposed) isFullscreen = f; }).catch(() => undefined);
          unlisten = await win.onResized(() => {
            win.isFullscreen().then((f) => { if (!disposed) isFullscreen = f; }).catch(() => undefined);
          });
        })
        .catch(() => undefined);
      return () => { disposed = true; unlisten?.(); };
    }
    const onChange = (): void => { isFullscreen = Boolean(document.fullscreenElement); };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  });
  let resolvedTheme = $derived<'dark' | 'light' | 'aurora' | 'forest'>(
    appSettings.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : appSettings.theme,
  );
  let lightMode = $derived(resolvedTheme === 'light');
  let auroraMode = $derived(resolvedTheme === 'aurora');
  let forestMode = $derived(resolvedTheme === 'forest');
  let statusText = $derived(
    activeSession.error ? '处理失败'
      : activeSession.aiProcessing ? 'AI 处理中…'
        : activeSession.processing ? '处理中…'
          : currentSessionResult() ? `结果 ${currentSessionResult()!.output?.length ?? 0} 字符`
              : '等待输入',
  );
  let dispatchHotkeyLabel = $derived(formatHotkey(dispatchHotkey));
  let paletteItems = $derived(buildPaletteItems());
  let paletteFiltered = $derived(paletteQuery
    ? paletteItems.filter((item) => (item.label + ' ' + item.hint + ' ' + item.group).toLowerCase().includes(paletteQuery.toLowerCase()))
    : paletteItems);
  let paletteGroups = $derived((() => {
    const groups: Array<{ group: string; items: PaletteItem[] }> = [];
    for (const item of paletteFiltered) {
      const last = groups[groups.length - 1];
      if (last && last.group === item.group) last.items.push(item);
      else groups.push({ group: item.group, items: [item] });
    }
    return groups;
  })());
  let paletteFlat = $derived(paletteFiltered);
  let titleTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    // 结果状态实时写入窗口标题；纯 ASCII + 500ms 节流，规避 Tauri Windows 原生标题
    // 同步在快速连续切换时的崩溃风险，同时降低高频写入开销
    const result = currentSessionResult();
    const next = result
        ? `Spurh ${__BUILD_DATE__} | result ${(result.summary || 'ok').slice(0, 24)} | ${result.output?.length ?? 0}c`
        : `Spurh ${__BUILD_DATE__} | ready`;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      if (document.title !== next) document.title = next;
    }, 500);
    return () => clearTimeout(titleTimer);
  });

  $effect(() => {
    // 同步浏览器标签栏/桌面主题色
    const meta = document.querySelector('meta[name="theme-color"]');
    const bgHex = lightMode ? '#d2dbee' : resolvedTheme === 'aurora' ? '#060616' : resolvedTheme === 'forest' ? '#040d09' : '#04050b';
    if (meta) meta.setAttribute('content', bgHex);
    // body 随主题同步，避免 overscroll 露出深空色
    document.body.style.background = bgHex;
    document.body.style.color = lightMode ? '#171c33' : '#eef1ff';
    // 同步窗口原生标题栏主题，避免 WebView2 默认浅色闪白
    if (isTauri) safeInvoke('set_window_theme', { theme: resolvedTheme }).catch(() => undefined);
  });

  $effect(() => {
    if (paletteIndex > paletteFlat.length - 1) paletteIndex = Math.max(0, paletteFlat.length - 1);
  });

  async function applyHotkeys(): Promise<void> {
    if (!isTauri) return; // 浏览器模式无全局快捷键,静默跳过
    const tools = plugins.slice(0, 9).map((_, i) => appSettings.toolHotkeys[String(i)] ?? `alt+${i + 1}`);
    try {
      const results = await safeInvoke<Array<{ key: string; ok: boolean; error?: string | null }>>('apply_hotkeys', { dispatch: dispatchHotkey, tools });
      const failed = results.filter((r) => !r.ok);
      hotkeyError = failed.length
        ? `快捷键注册失败：${failed.map((f) => `${f.key}${f.error ? `（${f.error}）` : ''}`).join('；')}。请更换为未被系统占用的组合。`
        : '';
    } catch (cause) {
      hotkeyError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  onMount(() => {
    applyHotkeys();
    const unlistenPromise = safeListen<{ kind: string; index?: number }>('spurh:hotkey', (event) => {
      if (event.payload.kind === 'tool' && typeof event.payload.index === 'number') {
        const plugin = plugins[event.payload.index];
        if (plugin) selectPlugin(plugin.id);
      } else if (event.payload.kind === 'dispatch') {
        requestAnimationFrame(() => dispatcherElement?.focus());
      }
    });

    safeInvoke<{ path: string; isDir: boolean } | null>('take_pending_open').then(async (target) => {
      if (!target) return;
      if (target.isDir) {
        openFileContext = { path: target.path, content: '' };
        return;
      }
      try {
        const content = await safeInvoke<string>('open_file', { path: target.path });
        openFileContext = { path: target.path, content };
      } catch {
        openFileContext = { path: target.path, content: '' };
      }
    }).catch(() => undefined);

    // AI 配置的 API Key 从系统钥匙串异步加载（旧明文数据会在 load 时进入迁移队列）
    flushLegacyAiSecrets()
      .then(() => hydrateAiSecrets(aiStore))
      .then((store) => { aiStore = store; })
      .catch(() => undefined);

    setTimeout(() => scheduleProcess('spurh.json', 200), 100);
    const systemTimer = setTimeout(() => {
      safeInvoke<boolean>('get_autostart').then((enabled) => (autostartEnabled = enabled)).catch(() => undefined);
      safeInvoke<boolean>('get_context_menu_enabled').then((enabled) => (contextMenuEnabled = enabled)).catch(() => undefined);
      safeInvoke('set_tray_enabled', { enabled: appSettings.trayEnabled }).catch(() => undefined);
    }, 800);
    // 可见版本标识：窗口标题带构建日期，用于确认当前运行的是最新代码
    document.title = `Spurh · ${__BUILD_DATE__}`;
    const onFrontendError = (event: ErrorEvent | PromiseRejectionEvent): void => {
      const message = event instanceof PromiseRejectionEvent
        ? `unhandledrejection: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`
        : `error: ${event.message} @ ${event.filename}:${event.lineno}`;
      safeInvoke('app_log_error', { message }).catch(() => undefined);
    };
    window.addEventListener('error', onFrontendError);
    window.addEventListener('unhandledrejection', onFrontendError);
    return () => {
      clearTimeout(systemTimer);
      window.removeEventListener('error', onFrontendError);
      window.removeEventListener('unhandledrejection', onFrontendError);
      unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  });

  function patchSession(pluginId: string, patch: Partial<ToolSession>): void {
    sessions = { ...sessions, [pluginId]: { ...sessions[pluginId], ...patch } };
  }

  function hasProcessableInput(pluginId: string, session: ToolSession): boolean {
    if (pluginId === 'spurh.network' || pluginId === 'spurh.remote') return false;
    if (session.input.length > 0) return true;
    if (pluginId === 'spurh.timestamp' && session.actionId === 'now') return true;
    if (pluginId === 'spurh.timestamp' && session.actionId === 'to-unix' && session.options.pickDateTime) return true;
    if (pluginId === 'spurh.random') return true;
    if (pluginId === 'spurh.cron' && session.actionId === 'generate') return true;
    if (pluginId === 'spurh.crypto' && ['rsa-gen', 'MD5', 'SHA-1', 'SHA-256', 'SHA-512'].includes(session.actionId)) return true;
    return pluginId === 'spurh.regex' && Boolean(session.options.pattern);
  }

  function scheduleProcess(pluginId = activePluginId, delay = 200): void {
    const prev = timers.get(pluginId);
    if (prev) clearTimeout(prev);
    // 大文档输入时降低实时处理频率：避免每次按键都触发大结果重新布局（654KB 文档每次布局约 200ms）
    const session = sessions[pluginId];
    const inputLen = session?.input?.length ?? 0;
    // 大文档输入时降低实时处理频率，避免大结果反复重排
    if (delay >= 200) {
      if (inputLen > 200_000) delay = 800;
      else if (inputLen > 50_000) delay = 550;
      else if (inputLen > 12_000) delay = 350;
    }
    // 防抖等待期间即标记处理中，让结果区可切换轻量占位，避免大结果 DOM 反复重排
    patchSession(pluginId, { processing: true });
    timers.set(pluginId, setTimeout(() => processPlugin(pluginId), delay));
  }

  async function processPlugin(pluginId: string): Promise<void> {
    const session = sessions[pluginId];
    if (!hasProcessableInput(pluginId, session)) {
      patchSession(pluginId, { result: null, error: '', processing: false });
      logDebug(`跳过(无可处理输入) ${pluginId} 输入=${session.input.length} 动作=${session.actionId}`);
      return;
    }

    const revision = session.revision + 1;
    patchSession(pluginId, { processing: true, error: '', revision });
    logDebug(`开始执行 ${pluginId} 动作=${session.actionId} 输入=${session.input.length}字符 rev=${revision}`);
    try {
      const result = await runtime.execute(pluginId, session.actionId, session.input, session.options);
      if (sessions[pluginId].revision === revision) {
        patchSession(pluginId, { result, processing: false });
        logDebug(`执行成功 ${pluginId} rev=${revision} 输出=${result.output?.length ?? 0}字符`);
      } else {
        logDebug(`结果丢弃(输入已变) ${pluginId} rev=${revision}`);
      }
    } catch (cause) {
      if (sessions[pluginId].revision === revision) {
        patchSession(pluginId, { result: null, processing: false, error: cause instanceof Error ? cause.message : '处理失败' });
        logDebug(`执行失败 ${pluginId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  function logDebug(message: string): void {
    safeInvoke('app_log_error', { message: `[debug] ${message}` }).catch(() => undefined);
  }

  /** 直接读取当前会话结果（模板变量级响应，绕过 $: 链，杜绝 legacy 响应式不重算） */
  function currentSessionResult(): PluginResult | null {
    const session = sessions[activePluginId];
    if (!session) return null;
    return session.aiResult ?? session.result;
  }

  function selectPlugin(pluginId: string): void {
    activePluginId = pluginId;
    liveSyncedContent = '';
    if (hasProcessableInput(pluginId, sessions[pluginId]) && !sessions[pluginId].result && !sessions[pluginId].error) {
      scheduleProcess(pluginId, 0);
    }
  }

  function changeInput(value: string): void {
    patchSession(activePluginId, { input: value, aiResult: null, aiError: '' });
    scheduleProcess(activePluginId);
    syncInputScroll();
  }

  /* ── 输入区语法高亮（仅 JSON，防抖异步计算避免每键同步正则） ── */
  const INPUT_HIGHLIGHT_MAX = 24_000; // 超长输入跳过语法高亮（24K 以上开销明显）
  let inputLanguage = $derived(activePluginId === 'spurh.json' ? 'json' : 'text');
  let inputHighlightElement = $state<HTMLPreElement | undefined>(undefined);
  let inputHighlightHtml = $state('');
  let inputHighlightTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const input = activeSession.input;
    if (inputLanguage !== 'json' || input.length > INPUT_HIGHLIGHT_MAX) {
      inputHighlightHtml = '';
      return;
    }
    clearTimeout(inputHighlightTimer);
    inputHighlightTimer = setTimeout(() => {
      inputHighlightHtml = highlightCode(input, 'json');
      requestAnimationFrame(syncInputScroll);
    }, 50);
    return () => clearTimeout(inputHighlightTimer);
  });

  function handleInputChange(event: Event): void {
    changeInput((event.currentTarget as HTMLTextAreaElement).value);
  }

  /** 编辑器键位：Tab 缩进（Shift+Tab 反缩进）、Enter 延续缩进、括号/引号自动闭合 */
  function handleInputKeys(event: KeyboardEvent): void {
    // 中文输入法组合中按 Enter 确认候选词：不拦截，避免破坏正在输入的文本
    if (event.isComposing) return;
    if (event.key === 'Enter' && event.ctrlKey && activePluginId === 'spurh.sql') {
      event.preventDefault();
      runSql();
      return;
    }
    const target = event.currentTarget as HTMLTextAreaElement;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const value = target.value;

    // 括号/引号自动闭合（JSON 工具）：输入 { [ ( 自动补配对符并居中，引号在单词后不补
    if (event.key.length === 1 && start === end && !event.ctrlKey && !event.metaKey && !event.altKey && activePluginId === 'spurh.json') {
      const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')', '"': '"', "'": "'" };
      const closer = PAIRS[event.key];
      if (closer) {
        const nextChar = value[end] ?? '';
        const prevChar = value[start - 1] ?? '';
        if (event.key === '"' || event.key === "'") {
          if (nextChar === closer) { // 已配对：跳过闭合符（优先于单词判断，修复输入 "a" 后多出引号的问题）
            event.preventDefault();
            target.selectionStart = target.selectionEnd = end + 1;
            return;
          }
          if (/[\w\u4e00-\u9fff]/.test(prevChar)) return; // 单词/中文后不自动补引号
        }
        event.preventDefault();
        changeInput(value.slice(0, start) + event.key + closer + value.slice(end));
        flushSync();
        target.selectionStart = target.selectionEnd = start + 1;
        return;
      }
    }

    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && (activePluginId === 'spurh.json' || activePluginId === 'spurh.sql')) {
      // 自动换行缩进：按光标前的结构深度计算（含引号剥离），括号后回车自动补闭合行
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const linePrefix = value.slice(lineStart, start);
      const indentMatch = linePrefix.match(/^[\t ]*/);
      const stripStr = (s: string): string => s.replace(/"(\\.|[^"\\])*"/g, '');
      const depthOf = (s: string): number => {
        let d = 0;
        for (const ch of s) {
          if (ch === '{' || ch === '[' || ch === '(') d++;
          else if (ch === '}' || ch === ']' || ch === ')') d = Math.max(0, d - 1);
        }
        return d;
      };
      const before = stripStr(value.slice(0, start));
      const depth = depthOf(before);
      // 仅当前行以开放括号结尾才算 trailingOpener（避免 \s 跨行匹配导致空行回车重复插空行）
      const currentLineBefore = before.slice(before.lastIndexOf('\n') + 1);
      const trailingOpener = /[{\[(][ \t]*$/.test(currentLineBefore);
      const nextNonWs = value.slice(end).match(/^\s*(\S)/)?.[1] ?? '';
      const nextIndent = '  '.repeat(depth);
      // 开放括号后回车且光标后无内容：自动补闭合行（VS Code 行为：{\n  |\n}  ）
      if (trailingOpener && !value.slice(end).trim()) {
        event.preventDefault();
        const closer = currentLineBefore.trimEnd().endsWith('[') ? ']' : currentLineBefore.trimEnd().endsWith('(') ? ')' : '}';
        const closerIndent = '  '.repeat(Math.max(0, depth - 1));
        const insert = '\n' + nextIndent + '\n' + closerIndent + closer;
        changeInput(value.slice(0, start) + insert);
        flushSync();
        target.selectionStart = target.selectionEnd = start + 1 + nextIndent.length;
        return;
      }
      if (trailingOpener && nextNonWs && '}])'.includes(nextNonWs)) {
        event.preventDefault();
        const rest = value.slice(end);
        const closer = rest[0];
        const afterClose = rest.slice(1);
        const closerIndent = '  '.repeat(Math.max(0, depth - 1));
        let insert = '\n' + nextIndent + '\n' + closerIndent + closer;
        // 闭合括号后同一行还有内容：换行到外层缩进行，避免文字被直接拼接在括号后
        if (afterClose.trim()) insert += '\n' + closerIndent + afterClose.trimStart();
        else insert += rest.slice(1);
        changeInput(value.slice(0, start) + insert);
        flushSync();
        target.selectionStart = target.selectionEnd = start + 1 + nextIndent.length;
        return;
      }
      if (!trailingOpener && nextNonWs && '}])'.includes(nextNonWs)) {
        // 光标后紧跟闭合符：同行则将闭合符移到自己的行并对齐层级；行首则在闭合行上方插入新行；闭合符在后续行则普通换行
        event.preventDefault();
        const rest = value.slice(end);
        const lineRest = rest.split('\n')[0];
        const closerIndent = '  '.repeat(Math.max(0, depth - 1));
        const leadWs = lineRest.match(/^[ \t]*/)?.[0] ?? '';
        const sameLine = start > 0 && value[start - 1] !== '\n' && lineRest.trim() !== '';
        if (sameLine) {
          // 多个自动闭合符逐行放置、缩进逐级递减（与格式化输出一致，避免 }}} 挤在一行）
          const restTrim = lineRest.slice(leadWs.length);
          const closerLines = /^[}\])]+$/.test(restTrim)
            ? [...restTrim].map((ch, i) => '  '.repeat(Math.max(0, depth - 1 - i)) + ch).join('\n')
            : closerIndent + restTrim;
          const insert = '\n' + nextIndent + '\n' + closerLines;
          changeInput(value.slice(0, start) + insert + rest.slice(lineRest.length));
          flushSync();
          target.selectionStart = target.selectionEnd = start + 1 + nextIndent.length;
          return;
        }
        if (lineRest.trim() !== '') {
          // 光标位于闭合符行行首：仅在其上方插入新行（按深度缩进），闭合行保持原有缩进不叠加
          const insert = nextIndent + '\n' + lineRest;
          changeInput(value.slice(0, start) + insert + rest.slice(lineRest.length));
          flushSync();
          target.selectionStart = target.selectionEnd = start + nextIndent.length;
          return;
        }
        // 闭合符在后续行：普通换行并保持缩进，不动后续内容
        const insert = '\n' + nextIndent;
        changeInput(value.slice(0, start) + insert + rest);
        flushSync();
        target.selectionStart = target.selectionEnd = start + 1 + nextIndent.length;
        return;
      }
      event.preventDefault();
      const insert = '\n' + nextIndent;
      changeInput(value.slice(0, start) + insert + value.slice(end));
      flushSync();
      target.selectionStart = target.selectionEnd = start + 1 + nextIndent.length;
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      if (start === end) {
        // 单点：行首按结构深度对齐，行中插入两个空格
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const linePrefix = value.slice(lineStart, start);
        if (/^[\t ]*$/.test(linePrefix) && (activePluginId === 'spurh.json' || activePluginId === 'spurh.sql')) {
          const depthOf = (src: string): number => {
            let d = 0;
            for (const ch of src) {
              if (ch === '{' || ch === '[' || ch === '(') d++;
              else if (ch === '}' || ch === ']' || ch === ')') d = Math.max(0, d - 1);
            }
            return d;
          };
          const stripStr = (src: string): string => src.replace(/"(\\.|[^"\\])*"/g, '');
          const dLine = depthOf(stripStr(value.slice(0, lineStart)));
          const targetIndent = '  '.repeat(dLine + 1);
          if (linePrefix.length !== targetIndent.length) {
            changeInput(value.slice(0, lineStart) + targetIndent + value.slice(start));
            flushSync();
            target.selectionStart = target.selectionEnd = lineStart + targetIndent.length;
            return;
          }
        }
        changeInput(value.slice(0, start) + '  ' + value.slice(end));
        flushSync();
        target.selectionStart = target.selectionEnd = start + 2;
        return;
      }
      // 多行选区：整块缩进 / 反缩进
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const lineEndIdx = value.indexOf('\n', end);
      const blockEnd = lineEndIdx < 0 ? value.length : lineEndIdx;
      const block = value.slice(lineStart, blockEnd);
      const next = block.split('\n').map((line) =>
        event.shiftKey
          ? (line.startsWith('  ') ? line.slice(2) : line.startsWith(' ') ? line.slice(1) : line)
          : '  ' + line,
      ).join('\n');
      changeInput(value.slice(0, lineStart) + next + value.slice(blockEnd));
      flushSync();
      target.selectionStart = lineStart;
      target.selectionEnd = lineStart + next.length;
      return;
    }

        if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const lineEndIdx = value.indexOf('\n', end);
      const lineEndPos = lineEndIdx < 0 ? value.length : lineEndIdx;
      const beforeCursor = value.slice(lineStart, start);
      const afterCursor = value.slice(end, lineEndPos);
      // 基础缩进：光标前空白；光标在行首时沿用整行缩进
      let indent = (beforeCursor.match(/^[\t ]*/) || [''])[0];
      if (!indent && afterCursor.length > 0) indent = (value.slice(lineStart, lineEndPos).match(/^[\t ]*/) || [''])[0];
      // 括号深度：光标前未闭合的 { [ (（忽略字符串字面量），决定新行缩进层级
      const openQuote = (beforeCursor.match(/"/g) || []).length % 2 === 1;
      let level = 0;
      let dLine = 0;
      if (!openQuote) {
        const depthOf = (src: string): number => {
          let d = 0;
          for (const ch of src) {
            if (ch === '{' || ch === '[' || ch === '(') d++;
            else if (ch === '}' || ch === ']' || ch === ')') d = Math.max(0, d - 1);
          }
          return d;
        };
        const stripStr = (src: string): string => src.replace(/"(\\.|[^"\\])*"/g, '');
        dLine = depthOf(stripStr(value.slice(0, lineStart)));
        const dCursor = depthOf(stripStr(value.slice(0, start)));
        level = Math.max(0, dCursor - dLine);
      }
      // 光标位于纯空白行且该行缩进与结构深度不符：以结构深度为基准，保证 `{` 后新行正确缩进
      if (/^[\t ]*$/.test(beforeCursor) && afterCursor.length === 0 && level === 0 && dLine * 2 > indent.length) {
        indent = '  '.repeat(dLine);
      }
      // 光标后紧跟闭合括号（自动配对场景）：闭合括号单独换行到外层缩进，光标停在中间
      const closeMatch = afterCursor.match(/^\s*([}\])])/);
      if (closeMatch) {
        const newIndent = indent + '  '.repeat(level);
        const afterClose = afterCursor.slice(closeMatch[0].length);
        // 闭合括号后同一行还有内容：换行到新缩进行，避免文字被直接拼接在括号后
        let newText = '\n' + newIndent + '\n' + indent + closeMatch[1];
        if (afterClose.trim()) newText += '\n' + indent + afterClose.trimStart();
        newText += value.slice(lineEndPos);
        changeInput(value.slice(0, start) + newText);
        flushSync();
        target.selectionStart = target.selectionEnd = start + 1 + newIndent.length;
        return;
      }
      // 自动补全：JSON 工具中光标前为未闭合开放括号且光标后无内容 → 补闭合括号换行（VS Code 风格）
      const AUTO_CLOSERS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
      const lastNonSpace = beforeCursor.trimEnd().slice(-1);
      const restAfterLine = value.slice(lineEndPos).trim();
      if (activePluginId === 'spurh.json' && AUTO_CLOSERS[lastNonSpace] && !afterCursor.trim() && restAfterLine === '') {
        const closer = AUTO_CLOSERS[lastNonSpace];
        const newIndent = indent + '  '.repeat(level);
        const newText = '\n' + newIndent + '\n' + indent + closer;
        changeInput(value.slice(0, start) + newText + value.slice(end));
        flushSync();
        target.selectionStart = target.selectionEnd = start + 1 + newIndent.length;
        return;
      }
      const newIndent = indent + '  '.repeat(level);
      // 光标行是纯空白且下一行以闭合括号开头：跳出到闭合括号的缩进
      if (/^[\t ]*$/.test(beforeCursor)) {
        const nextLineEnd = value.indexOf('\n', lineEndPos + 1);
        const nextLine = value.slice(lineEndPos + 1, nextLineEnd < 0 ? value.length : nextLineEnd);
        const nextIndent = (nextLine.match(/^[\t ]*/) || [''])[0];
        if (/^[}\])]/.test(nextLine.trim()) && newIndent.length > nextIndent.length) {
          const insertAlign = '\n' + nextIndent;
          changeInput(value.slice(0, start) + insertAlign + value.slice(end));
          flushSync();
        target.selectionStart = target.selectionEnd = start + insertAlign.length;
          return;
        }
      }
      // 行中回车：光标后内容整体移到新行并沿用新缩进
      const suffix = afterCursor.trimStart();
      const insert = '\n' + newIndent;
      const prefixText = value.slice(0, start);
      const suffixText = suffix ? suffix : value.slice(end, lineEndPos);
      changeInput(prefixText + insert + suffixText + value.slice(lineEndPos));
      flushSync();
        target.selectionStart = target.selectionEnd = start + insert.length;
      return;
    }
    // 输入闭合括号时自动配对：在纯空白行输入 } ] ) 时，按层级对齐并吸收自动补全的闭合符
    const CLOSERS: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
    if (event.key.length === 1 && CLOSERS[event.key]) {
      const cLineStart = value.lastIndexOf('\n', start - 1) + 1;
      const before = value.slice(cLineStart, start);
      if (/^[\t ]*$/.test(before)) {
        // 从光标往前找匹配的开放符（跳过已闭合层级）
        let depth = 0;
        let openIndex = -1;
        for (let i = start - 1; i >= 0; i--) {
          const ch = value[i];
          if (ch === event.key) depth++;
          else if (ch === CLOSERS[event.key]) {
            if (depth === 0) { openIndex = i; break; }
            depth--;
          }
        }
        if (openIndex >= 0) {
          event.preventDefault();
          // 目标缩进 = 当前空行缩进向上一级（不高于 0）
          const targetIndent = ' '.repeat(Math.max(0, before.length - 2));
          // 吸收自动补全的闭合符（同行或下一行整行），避免重复闭合
          let tail = value.slice(start);
          if (tail.startsWith(event.key)) {
            tail = tail.slice(1);
          } else if (tail.startsWith('\n')) {
            const nl = tail.indexOf('\n', 1);
            const line = nl < 0 ? tail.slice(1) : tail.slice(1, nl);
            // 吸收整行闭合符时保留换行，让后续闭合符独立成行（与格式化输出一致）
            if (line.trim() === event.key) tail = nl < 0 ? '' : tail.slice(nl);
          }
          changeInput(value.slice(0, cLineStart) + targetIndent + event.key + tail);
          flushSync();
          target.selectionStart = target.selectionEnd = cLineStart + targetIndent.length + 1;
          return;
        }
      } else if (value[start] === '\n') {
        // 光标后整行是闭合符（自动补全残留）：在光标处插入并吸收该行
        const lineEnd = value.indexOf('\n', start + 1);
        const endPos = lineEnd < 0 ? value.length : lineEnd;
        const nextLine = value.slice(start + 1, endPos);
        if (nextLine.trim() === event.key && !before.trim().endsWith(event.key)) {
          event.preventDefault();
          changeInput(value.slice(0, start) + event.key + value.slice(endPos));
          flushSync();
          target.selectionStart = target.selectionEnd = start + 1;
          return;
        }
      }
    }

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // 先检查跳过：引号类同时是开/闭符号，必须优先于配对插入；闭合括号紧跟光标时跳过（吸收自动补全）
      const isCloser = Object.values(PAIRS).includes(event.key);
      if ((isCloser || CLOSERS[event.key]) && value[start] === event.key) {
        event.preventDefault();
        target.selectionStart = target.selectionEnd = start + 1;
        return;
      }
      const openChar = PAIRS[event.key];
      if (openChar) {
        event.preventDefault();
        changeInput(value.slice(0, start) + event.key + openChar + value.slice(end));
        flushSync();
        target.selectionStart = target.selectionEnd = start + 1;
        return;
      }
    }
  }

  function syncInputScroll(): void {
    // rAF 确保在 DOM 更新后再读取滚动位置，避免错位
    requestAnimationFrame(() => {
      if (inputHighlightElement && inputElement) {
        inputHighlightElement.scrollTop = inputElement.scrollTop;
        inputHighlightElement.scrollLeft = inputElement.scrollLeft;
      }
    });
  }

  // to-unix 用 picker 作为输入时隐藏文本框；但文本框有内容（自动识别粘贴/手动输入）时保留可见，避免残留输入不可见
  // 时间戳面板自带紧凑输入控件，所有模式都隐藏通用大输入框
  let hideInputPane = $derived(activePluginId === 'spurh.timestamp' || activePluginId === 'spurh.cron');

  function changeAction(actionId: string): void {
    // Cron 面板内配置的表达式（手写/构建）需同步到共享输入，解析/执行时间才有内容可用
    if (activePluginId === 'spurh.cron' && (actionId === 'explain' || actionId === 'next')) {
      const type = activeSession.options.type || 'daily';
      const expr = type === 'custom'
        ? (activeSession.options.customExpr?.trim() || '*/5 * * * *')
        : buildExpression(activeSession.options);
      if (expr) patchSession(activePluginId, { input: expr });
    }
    // 加解密互切时，把上一步的结果带进输入框，保证 加密 → 解密 闭环可用
    if (activePluginId === 'spurh.crypto' && (actionId === 'aes-encrypt' || actionId === 'aes-decrypt')) {
      const prev = activeSession.actionId;
      const out = activeSession.result?.output;
      if (prev !== actionId && typeof out === 'string' && out.trim() && out !== activeSession.input) {
        patchSession(activePluginId, { input: out, aiResult: null, aiError: '' });
      }
    }
    patchSession(activePluginId, { actionId });
    scheduleProcess(activePluginId, 0);
  }

  function runSql(): void {
    if (!sessions['spurh.sql'].input.trim()) return;
    scheduleProcess('spurh.sql', 0);
  }

  function changeOption(optionId: string, value: string): void {
    patchSession(activePluginId, { options: { ...activeSession.options, [optionId]: value } });
    if (optionId !== 'aiPrompt') scheduleProcess(activePluginId);
  }

  function localNowValue(): string {
    const date = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  function routeToPlugin(pluginId: string, content: string, suggestedAction?: string): void {
    activePluginId = pluginId;
    patchSession(pluginId, { input: content, aiResult: null, aiError: '', ...(suggestedAction ? { actionId: suggestedAction } : {}) });
    dispatcherInput = '';
    dispatchIndex = 0;
    scheduleProcess(pluginId, 0);
    queueMicrotask(() => inputElement?.focus());
  }

  /** 顶部输入框内容变化：用户主动输入即实时路由（不读取剪贴板），低置信度保留下拉等待回车确认 */
  let dispatcherOpen = $state(false);
  let liveSyncedContent = '';
  let draggingFile = $state(false);

  function routeLive(pluginId: string, content: string, suggestedAction?: string): void {
    const trimmed = content.trim();
    liveSyncedContent = trimmed;
    activePluginId = pluginId;
    patchSession(pluginId, { input: trimmed, aiResult: null, aiError: '', ...(suggestedAction ? { actionId: suggestedAction } : {}) });
    scheduleProcess(pluginId, 120); // 保留防抖窗口，避免输入过程重复执行
  }

  /** 面板型插件：自带完整界面，不接受输入→输出的实时路由 */
  const SELF_CONTAINED_PANELS = new Set(['spurh.sql', 'spurh.network', 'spurh.remote']);

  let dispatcherRouteTimer: ReturnType<typeof setTimeout> | undefined;
  function handleDispatcherInput(value: string, instant = false): void {
    dispatcherInput = value;
    dispatchIndex = 0;
    clearTimeout(dispatcherRouteTimer);
    if (!value.trim()) return;
    const match = runtime.dispatch(value).selected;
    if (match && match.confidence >= 0.75 && !SELF_CONTAINED_PANELS.has(match.plugin.id)) {
      if (instant) {
        // 粘贴等完整输入：立即路由
        routeLive(match.plugin.id, value, match.suggestedAction);
        dispatcherInput = '';
        dispatchIndex = 0;
        return;
      }
      // 高信度内容: 实时路由到工具区, 保留输入框内容(回车确认后清空)
      routeLive(match.plugin.id, value, match.suggestedAction);
    } else if (match && match.confidence >= 0.5 && !SELF_CONTAINED_PANELS.has(match.plugin.id)) {
      routeLive(match.plugin.id, value, match.suggestedAction);
    }
  }

  function routeContent(content = dispatcherInput, pluginIndex = 0): void {
    const candidate = dispatcherCandidates[pluginIndex];
    if (candidate) {
      if (SELF_CONTAINED_PANELS.has(candidate.plugin.id)) {
        // 自包含面板不接受输入→输出路由：只切换面板，不注入内容
        activePluginId = candidate.plugin.id;
      } else {
        routeToPlugin(candidate.plugin.id, content, candidate.suggestedAction);
      }
    } else {
      const plugin = plugins[pluginIndex] ?? plugins[0];
      if (plugin) {
        if (SELF_CONTAINED_PANELS.has(plugin.id)) activePluginId = plugin.id;
        else routeToPlugin(plugin.id, content);
      }
    }
  }

  function handleDispatcherPaste(event: ClipboardEvent): void {
    const content = event.clipboardData?.getData('text') ?? '';
    if (!content.trim()) return;
    event.preventDefault();
    dispatcherInput = content;
    dispatchIndex = 0;
    handleDispatcherInput(content, true);
  }

  function handleDispatcherKeys(event: KeyboardEvent): void {
    const max = dispatcherCandidates.length - 1;
    if (event.key === 'ArrowDown') { event.preventDefault(); dispatchIndex = Math.min(dispatchIndex + 1, max); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); dispatchIndex = Math.max(dispatchIndex - 1, 0); return; }
    if (event.key === 'Enter' && event.shiftKey) return; // Shift+Enter：插入换行
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const content = dispatcherInput.trim();
      if (!content) return;
      if (content === liveSyncedContent) {
        // 内容已被实时路由且未在工具区被修改：只清空输入框
        dispatcherInput = '';
        dispatchIndex = 0;
      } else {
        routeContent(content, dispatchIndex);
      }
      return;
    }
    if (event.key === 'Escape') { dispatcherElement?.blur(); dispatchIndex = 0; }
  }

  async function pasteToTool(): Promise<void> {
    try { changeInput(await readClipboardText()); } catch { dispatcherElement?.focus(); }
  }

  /* ── 浏览器预览模式:拖拽文件直接打开分析(桌面模式请用右键菜单) ── */
  function handleFileDragOver(event: DragEvent): void {
    if (isTauri || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    draggingFile = true;
  }

  function handleFileDragLeave(event: DragEvent): void {
    if (event.relatedTarget === null || (event.relatedTarget instanceof Node && !document.body.contains(event.relatedTarget))) {
      draggingFile = false;
    }
  }

  async function handleFileDrop(event: DragEvent): Promise<void> {
    if (isTauri) return;
    event.preventDefault();
    draggingFile = false;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      patchSession(activePluginId, { error: '文件过大(超过 2MB),请使用桌面应用的右键菜单打开' });
      return;
    }
    try {
      // 图片在浏览器预览中无法分析（后端有专用打开链路），直接提示而非读成乱码
      if (file.type.startsWith('image/')) {
        patchSession(activePluginId, { error: '图片文件请使用桌面应用的右键菜单打开分析' });
        return;
      }
      const bytes = await file.arrayBuffer();
      // 优先 UTF-8 严格解码；失败时回退 GBK（中文 Windows 常见编码），避免中文文本被误判为二进制
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        content = new TextDecoder('gbk').decode(bytes);
      }
      // 二进制文件（zip/exe 等）读成文本会大量出现替换字符，拒绝而非路由乱码
      if ((content.match(/\uFFFD/g) ?? []).length > Math.max(4, content.length / 100)) {
        patchSession(activePluginId, { error: '二进制文件无法直接分析，请使用桌面应用的右键菜单打开' });
        return;
      }
      const match = runtime.dispatch(content).selected;
      const target = match && match.confidence >= 0.5 && !SELF_CONTAINED_PANELS.has(match.plugin.id) ? match.plugin.id : 'spurh.json';
      routeToPlugin(target, content, match?.suggestedAction);
    } catch {
      patchSession(activePluginId, { error: '无法读取文件内容(可能不是文本文件)' });
    }
  }

  async function copyResult(): Promise<void> {
    const result = currentSessionResult();
    if (!result) return;
    await copyText(result.output);
    copied = true; setTimeout(() => (copied = false), 1200);
  }

  function clearActive(): void {
    const plugin = activePlugin;
    const next = makeSession(plugin);
    // SQL 工具清空输入时保留连接配置
    if (plugin.id === 'spurh.sql') next.options = { ...activeSession.options };
    sessions = { ...sessions, [plugin.id]: { ...next, input: '' } };
    queueMicrotask(() => inputElement?.focus());
  }

  function openSettings(tab: SettingsTab = 'general', notice = ''): void {
    paletteOpen = false;
    dispatcherElement?.blur();
    aiDraft = aiConfig ? { ...aiConfig } : createAiProfile();
    aiTestStatus = 'idle'; aiTestMessage = ''; settingsError = ''; settingsNotice = notice; settingsTab = tab; settingsOpen = true;
    recordingTool = null; recordingDispatch = false; hotkeyError = '';
    resetDeleteConfirm();
    // 打开设置时关闭工具面板内打开的弹窗（连接表单等），避免弹窗堆叠互相遮挡
    window.dispatchEvent(new CustomEvent('spurh:settings-open'));
  }

  function selectAiProvider(provider: string): void {
    const preset = AI_PRESETS[provider] ?? AI_PRESETS.custom;
    aiDraft = { ...aiDraft, ...preset, apiKey: aiDraft.apiKey };
    modelList = []; aiTestStatus = 'idle';
    resetDeleteConfirm();
  }

  function editAiProfile(profileId: string): void {
    const profile = aiStore.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    aiDraft = { ...profile }; modelList = []; aiTestStatus = 'idle'; aiTestMessage = '';
    resetDeleteConfirm();
  }

  function addAiProfile(): void {
    aiDraft = createAiProfile('openai', `模型配置 ${aiStore.profiles.length + 1}`);
    modelList = []; aiTestStatus = 'idle'; aiTestMessage = '';
    resetDeleteConfirm();
  }

  let deleteConfirming = $state(false);
  let deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  function resetDeleteConfirm(): void {
    deleteConfirming = false;
    if (deleteConfirmTimer) { clearTimeout(deleteConfirmTimer); deleteConfirmTimer = null; }
  }

  function removeAiProfile(): void {
    if (!aiStore.profiles.some((profile) => profile.id === aiDraft.id)) { resetDeleteConfirm(); return; }
    // 两段式确认：第一次点击进入确认态，3 秒内再点才删除（跨平台，不依赖原生对话框）
    if (!deleteConfirming) {
      deleteConfirming = true;
      if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
      deleteConfirmTimer = setTimeout(() => resetDeleteConfirm(), 3000);
      return;
    }
    resetDeleteConfirm();
    const profiles = aiStore.profiles.filter((profile) => profile.id !== aiDraft.id);
    deleteProfileSecret(aiDraft.id);
    const activeId = aiStore.activeId === aiDraft.id ? profiles[0]?.id ?? '' : aiStore.activeId;
    aiStore = { profiles, activeId }; saveAiProfileStore(aiStore);
    aiDraft = profiles.find((profile) => profile.id === activeId) ?? createAiProfile();
  }

  function switchAiProfile(profileId: string): void {
    if (!aiStore.profiles.some((profile) => profile.id === profileId)) return;
    aiStore = { ...aiStore, activeId: profileId }; saveAiProfileStore(aiStore);
  }

  function saveAppSettings(next: Partial<AppSettings>): void {
    appSettings = { ...appSettings, ...next };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
  }

  let sidebarAutoCollapsed = false; // 由窗口变窄自动收起（非用户手动），回到宽窗口时恢复

  function handleWindowResize(): void {
    if (window.innerWidth <= 850) {
      // 窄窗口下若用户从未主动展开：自动收起侧栏，避免浮层遮挡工作区（不持久化，回到宽窗口自动恢复）
      if (!sidebarUserNarrowChoice && sidebarOpen) {
        sidebarOpen = false;
        sidebarAutoCollapsed = true;
      }
    } else if (window.innerWidth > 850 && sidebarAutoCollapsed) {
      // 恢复宽窗口：仅当侧栏是被自动收起时重新展开，尊重用户手动选择
      sidebarAutoCollapsed = false;
      sidebarUserNarrowChoice = false;
      sidebarOpen = true;
      saveAppSettings({ sidebarOpen });
    } else if (window.innerWidth > 850) {
      sidebarUserNarrowChoice = false;
    }
  }

  function toggleSidebar(): void {
    sidebarOpen = !sidebarOpen;
    sidebarAutoCollapsed = false;
    if (window.innerWidth <= 850 && sidebarOpen) sidebarUserNarrowChoice = true;
    saveAppSettings({ sidebarOpen });
  }

  function saveDispatchHotkey(hk: string): void {
    const trimmed = hk.trim().toLowerCase();
    const value = trimmed === 'off' ? 'off' : trimmed || 'ctrl+shift+space';
    dispatchHotkey = value;
    saveAppSettings({ dispatchHotkey: value });
    applyHotkeys().catch(() => undefined);
  }

  async function changeAutostart(enabled: boolean): Promise<void> {
    settingsBusy = 'autostart'; settingsError = '';
    try { autostartEnabled = await safeInvoke<boolean>('set_autostart', { enabled }); }
    catch (cause) { settingsError = cause instanceof Error ? cause.message : String(cause); }
    finally { settingsBusy = ''; }
  }

  async function changeTray(enabled: boolean): Promise<void> {
    settingsBusy = 'tray'; settingsError = '';
    try { await safeInvoke('set_tray_enabled', { enabled }); saveAppSettings({ trayEnabled: enabled }); }
    catch (cause) { settingsError = cause instanceof Error ? cause.message : String(cause); }
    finally { settingsBusy = ''; }
  }

  async function changeContextMenu(enabled: boolean): Promise<void> {
    settingsBusy = 'contextMenu'; settingsError = '';
    try { await safeInvoke('set_context_menu_enabled', { enabled }); contextMenuEnabled = enabled; saveAppSettings({ contextMenuEnabled: enabled }); }
    catch (cause) { settingsError = cause instanceof Error ? cause.message : String(cause); }
    finally { settingsBusy = ''; }
  }

  async function loadRemoteModels(): Promise<void> {
    modelListLoading = true; aiTestStatus = 'idle'; aiTestMessage = '';
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('拉取超时（25 秒），请检查网络与接口地址')), 25000));
    try {
      modelList = await Promise.race([fetchAiModels(aiDraft), timeout]);
      aiTestStatus = 'success';
      aiTestMessage = modelList.length ? `已拉取 ${modelList.length} 个模型` : '连接成功，列表为空';
      if (!aiDraft.model && modelList[0]) aiDraft = { ...aiDraft, model: modelList[0].id };
    } catch (cause) { aiTestStatus = 'error'; aiTestMessage = cause instanceof Error ? cause.message : String(cause); }
    finally { modelListLoading = false; }
  }

  async function testConnection(): Promise<void> {
    aiTestStatus = 'testing'; aiTestMessage = '';
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('连接超时（25 秒），请检查网络与接口地址')), 25000));
    try { aiTestMessage = await Promise.race([testAiConnection(aiDraft), timeout]); modelList = await fetchAiModels(aiDraft); aiTestStatus = 'success'; }
    catch (cause) { aiTestMessage = cause instanceof Error ? cause.message : String(cause); aiTestStatus = 'error'; }
  }

  async function saveAiSettings(): Promise<void> {
    const profile: AiProfile = { ...aiDraft, name: aiDraft.name.trim() || aiDraft.model.trim() || '未命名模型', endpoint: aiDraft.endpoint.trim().replace(/\/$/, ''), model: aiDraft.model.trim() };
    const exists = aiStore.profiles.some((item) => item.id === profile.id);
    const profiles = exists ? aiStore.profiles.map((item) => item.id === profile.id ? profile : item) : [...aiStore.profiles, profile];
    aiStore = { profiles, activeId: profile.id };
    saveAiProfileStore(aiStore);
    try {
      await saveProfileSecret(profile); // API Key 写入系统钥匙串，localStorage 只存非敏感字段
      settingsNotice = ''; aiDraft = { ...profile };
      aiTestMessage = '配置已保存'; aiTestStatus = 'success';
    } catch (cause) {
      aiTestMessage = '密钥写入系统钥匙串失败：' + (cause instanceof Error ? cause.message : String(cause)); aiTestStatus = 'error';
    }
  }

  function scrollToLatestStream() {
    requestAnimationFrame(() => { if (streamScrollElement) streamScrollElement.scrollTop = streamScrollElement.scrollHeight; });
  }

  async function runAiProcessing(): Promise<void> {
    if (!activeSession.input.trim()) return;
    if (!isAiConfigured(aiConfig)) { openSettings('ai', '请先配置 AI 模型'); return; }
    const pluginId = activePlugin.id;
    patchSession(pluginId, { aiProcessing: true, aiResult: null, aiError: '', aiReasoning: '', aiStreamContent: '' });
    try {
      const plugin = plugins.find((item) => item.id === pluginId)!;
      const session = sessions[pluginId];
      const action = plugin.actions.find((item) => item.id === session.actionId)?.label ?? session.actionId;
      const expectJson = pluginId === 'spurh.json';
      const result = await processWithAi(aiConfig!, session.input, { tool: plugin.name, action, localError: session.error || undefined, expectJson, userPrompt: session.options.aiPrompt }, ({ reasoning, content }) => { patchSession(pluginId, { aiReasoning: reasoning, aiStreamContent: content }); scrollToLatestStream(); });
      const aiResult: PluginResult = { output: result.output, language: expectJson ? 'json' : 'text', view: expectJson ? 'code' : 'text', summary: result.parseError ?? 'AI 处理完成', meta: { 来源: 'AI', 模型: aiConfig!.model, ...(result.parseError ? { 解析: result.parseError } : {}) } };
      patchSession(pluginId, { aiProcessing: false, aiResult });
    } catch (cause) { patchSession(pluginId, { aiProcessing: false, aiError: cause instanceof Error ? cause.message : String(cause) }); }
  }

  async function aiGenerateRegex(description: string): Promise<void> {
    if (!isAiConfigured(aiConfig)) { openSettings('ai', '请先配置 AI 模型'); return; }
    const pluginId = activePlugin.id;
    patchSession(pluginId, { aiProcessing: true, aiResult: null, aiError: '', aiReasoning: '', aiStreamContent: '' });
    try {
      const result = await processWithAi(aiConfig!, description, {
        tool: '正则表达式', action: 'AI 生成',
        userPrompt: '根据描述生成 JavaScript 正则表达式。只输出 /pattern/flags 形式的字面量，例如 /\\b[\\w.+-]+@[\\w-]+\\.[\\w.]+\\b/gi。不要输出任何解释、反引号或额外文字。',
      }, () => undefined);
      const match = result.output.match(/^\s*\/(.+)\/([dgimsuvy]*)\s*$/);
      const pattern = match ? match[1] : result.output.trim();
      const flags = match ? (match[2] || 'g') : 'g';
      patchSession(pluginId, { options: { ...sessions[pluginId].options, pattern, flags }, aiProcessing: false, aiResult: null, aiError: '' });
      scheduleProcess(pluginId, 0);
    } catch (cause) {
      patchSession(pluginId, { aiProcessing: false, aiError: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function aiRecommendRegex(samples: string): Promise<void> {
    if (!isAiConfigured(aiConfig)) { openSettings('ai', '请先配置 AI 模型'); return; }
    const pluginId = activePlugin.id;
    patchSession(pluginId, { aiProcessing: true, aiResult: null, aiError: '', aiReasoning: '', aiStreamContent: '' });
    try {
      const result = await processWithAi(aiConfig!, samples, {
        tool: '正则表达式', action: 'AI 推荐',
        userPrompt: '根据这些样例文本推断一个能匹配它们全部的正则表达式。只输出 /pattern/flags 形式的字面量，例如 /\\b[\\w.+-]+@[\\w-]+\.[\\w.]+\\b/gi。不要输出任何解释、反引号或额外文字。',
      }, () => undefined);
      const match = result.output.match(/^\s*\/(.+)\/([dgimsuvy]*)\s*$/);
      const pattern = match ? match[1] : result.output.trim();
      const flags = match ? (match[2] || 'g') : 'g';
      patchSession(pluginId, { options: { ...sessions[pluginId].options, pattern, flags }, aiProcessing: false, aiResult: null, aiError: '' });
      scheduleProcess(pluginId, 0);
    } catch (cause) {
      patchSession(pluginId, { aiProcessing: false, aiError: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  /* ── 命令面板（Ctrl+K） ── */
  function closePalette(): void {
    paletteOpen = false;
    paletteQuery = '';
    paletteIndex = 0;
  }

  function buildPaletteItems(): PaletteItem[] {
    const items: PaletteItem[] = [];
    for (const plugin of plugins) {
      if (appSettings.hiddenTools.includes(plugin.id)) continue;
      items.push({
        id: 'tool:' + plugin.id,
        group: '工具',
        label: plugin.name,
        hint: plugin.description,
        icon: plugin.icon,
        run: () => { selectPlugin(plugin.id); },
      });
    }
    items.push({ id: 'settings:general', group: '设置', label: '通用设置', hint: '主题 · 启动 · 托盘', icon: UI_ICONS.sliders, run: () => openSettings('general') });
    items.push({ id: 'settings:ai', group: '设置', label: 'AI 模型', hint: '服务商配置', icon: UI_ICONS.sparkle, run: () => openSettings('ai') });
    items.push({ id: 'settings:shortcuts', group: '设置', label: '快捷键', hint: '全局绑定', icon: UI_ICONS.keyboard, run: () => openSettings('shortcuts') });
    items.push({ id: 'settings:about', group: '设置', label: '关于', hint: '版本信息', icon: UI_ICONS.info, run: () => openSettings('about') });
    items.push({ id: 'action:paste', group: '操作', label: '粘贴到输入区', hint: '读取系统剪贴板', icon: UI_ICONS.copy, run: () => { pasteToTool(); } });
    items.push({ id: 'action:copy', group: '操作', label: '复制结果', hint: visibleResult ? '复制当前工具的结果' : '当前工具暂无结果', icon: UI_ICONS.copy, run: () => { copyResult(); } });
    items.push({ id: 'action:ai', group: '操作', label: 'AI 处理', hint: activeSession.input.trim() ? '用 AI 分析当前输入' : '当前工具没有输入', icon: UI_ICONS.sparkle, run: () => { runAiProcessing(); } });
    items.push({ id: 'action:clear', group: '操作', label: '清空当前工具', hint: '重置输入与结果', icon: UI_ICONS.trash, run: () => { clearActive(); } });
    return items;
  }

  function handlePaletteKeys(event: KeyboardEvent): void {
    const count = paletteFlat.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, Math.max(0, count - 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = paletteFlat[paletteIndex] ?? paletteFlat[0];
      if (item) {
        const run = item.run;
        closePalette();
        run();
      }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
  }

  function runPaletteItem(item: PaletteItem): void {
    const run = item.run;
    closePalette();
    run();
  }

  function applyAiResult(): void {
    if (!activeSession.aiResult) return;
    patchSession(activePluginId, { input: activeSession.aiResult.output, aiResult: null, aiError: '' });
    scheduleProcess(activePluginId, 0);
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    // 先记录录制状态：onRecordKeydown 可能将 recordingTool/recordingDispatch 置空（取消或保存），
    // 若在之后判断会导致 Esc / 刚录制的组合键泄漏到 handleKeys（如 Esc 误关设置）
    const wasRecording = recordingTool !== null || recordingDispatch;
    onRecordKeydown(event);
    if (wasRecording) return;
    handleKeys(event);
  }

  function handleKeys(event: KeyboardEvent): void {
    if (event.key === 'Escape' && paletteOpen) {
      closePalette();
      return;
    }
    if (event.key === 'Escape' && settingsOpen) {
      settingsOpen = false;
      return;
    }
    const mods: string[] = [];
    if (event.ctrlKey) mods.push('ctrl');
    if (event.altKey) mods.push('alt');
    if (event.shiftKey) mods.push('shift');
    if (event.metaKey) mods.push('super');
    const key = normalizeKeyName(event.key);
    if (!key) return;
    if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && key === 'k') {
      event.preventDefault();
      paletteOpen = !paletteOpen;
      if (paletteOpen) {
        paletteQuery = '';
        paletteIndex = 0;
        requestAnimationFrame(() => paletteElement?.focus());
      }
      return;
    }
    if ([...mods, key].join('+') === dispatchHotkey) {
      event.preventDefault();
      dispatcherElement?.focus();
      return;
    }
    // 工具切换热键（Alt+1..8）：浏览器模式无全局快捷键，本地兜底保证一致体验
    const combo = [...mods, key].join('+');
    const toolIndex = plugins.slice(0, 9).findIndex((_, i) => (appSettings.toolHotkeys[String(i)] ?? `alt+${i + 1}`).toLowerCase() === combo);
    if (toolIndex >= 0) {
      event.preventDefault();
      selectPlugin(plugins[toolIndex].id);
    }
  }

  /* ── 快捷键录制 ── */
  function startRecordTool(index: number): void { recordingTool = index; recordingDispatch = false; hotkeyError = ''; }
  function startRecordDispatch(): void { recordingDispatch = true; recordingTool = null; hotkeyError = ''; }
  function cancelRecord(): void { recordingTool = null; recordingDispatch = false; hotkeyError = ''; }

  /** 检查组合键是否与其它工具快捷键冲突，skipIndex 为当前录制行 */
  function findToolConflict(norm: string, skipIndex: number): string | null {
    for (let i = 0; i < 9; i++) {
      if (i === skipIndex) continue;
      const other = appSettings.toolHotkeys[String(i)];
      if (other && other !== 'off' && other.toLowerCase() === norm) {
        return `与「${plugins[i]?.name ?? `工具 ${i + 1}`}」冲突`;
      }
    }
    return null;
  }

  /** 检查组合键是否与任何现有绑定冲突，返回冲突描述 */
  function findHotkeyConflict(combo: string): string | null {
    const norm = combo.toLowerCase();
    if (norm === 'ctrl+shift+space') return 'Ctrl+Shift+Space 已固定用于显示窗口';
    if (recordingDispatch) {
      if (norm === dispatchHotkey && dispatchHotkey !== 'off') return '与当前设置相同，无需修改';
      return findToolConflict(norm, -1);
    }
    if (recordingTool !== null) {
      if (norm === dispatchHotkey && dispatchHotkey !== 'off') return '与「聚焦搜索框」快捷键冲突';
      return findToolConflict(norm, recordingTool);
    }
    return null;
  }

  function onRecordKeydown(event: KeyboardEvent): void {
    if (recordingTool === null && !recordingDispatch) return;
    event.preventDefault();
    event.stopPropagation();
    // 只有单独按 Esc 才是取消；Ctrl+Esc 等组合键仍可录制
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      cancelRecord();
      return;
    }
    const mods: string[] = [];
    if (event.ctrlKey) mods.push('ctrl');
    if (event.altKey) mods.push('alt');
    if (event.shiftKey) mods.push('shift');
    if (event.metaKey) mods.push('super');
    const key = normalizeKeyName(event.key);
    if (!key) return;
    if (mods.length === 0) { hotkeyError = '请至少组合一个修饰键（Ctrl / Alt / Shift / Win），按 Esc 取消'; return; }
    const combo = [...mods, key].join('+');
    const conflict = findHotkeyConflict(combo);
    if (conflict) { hotkeyError = `无法使用 ${formatHotkey(combo)}：${conflict}，按 Esc 取消`; return; }
    if (recordingTool !== null) {
      saveAppSettings({ toolHotkeys: { ...appSettings.toolHotkeys, [String(recordingTool)]: combo } });
      recordingTool = null;
    } else if (recordingDispatch) {
      saveDispatchHotkey(combo);
      recordingDispatch = false;
    }
    hotkeyError = '';
    applyHotkeys().catch(() => undefined);
  }
</script>
<svelte:window onkeydown={handleWindowKeydown} ondragover={handleFileDragOver} ondragleave={handleFileDragLeave} ondrop={handleFileDrop} onresize={handleWindowResize} />

<div class:light={lightMode} class:aurora={auroraMode} class:forest={forestMode} class="app" style={`--app-font-size: ${appSettings.fontSize}px; --app-font-family: ${FONT_STACKS[appSettings.fontFamily] ?? FONT_STACKS['系统默认']}`}>
  <header class="app-bar">
    <button class="sidebar-toggle" onclick={toggleSidebar} aria-label="切换侧栏" title="显示或隐藏侧栏">{@html UI_ICONS.menu}</button>
    <button class="brand" onclick={toggleSidebar} aria-label="Spurh" title="Spurh 工具箱">
      <span class="brand-mark">{@html BRAND_MARK}</span>
      <b class="brand-name">Spurh</b>
    </button>
    <div class="dispatcher">
        <span class="dispatcher-spark" class:active={dispatcherOpen}>{@html UI_ICONS.sparkle}</span>
        <textarea rows="1" bind:this={dispatcherElement} bind:value={dispatcherInput} oninput={(event) => handleDispatcherInput(event.currentTarget.value)} onpaste={handleDispatcherPaste} onkeydown={handleDispatcherKeys} onfocus={() => (dispatcherOpen = true)} onblur={() => (dispatcherOpen = false)} placeholder="搜索工具或粘贴内容…（Shift+Enter 换行）"></textarea>
        {#if dispatcherOpen}
          <div class="dispatch-matches" class:passive={!dispatcherInput.trim()} role="listbox" aria-label="工具候选列表" tabindex="-1" onmousedown={(event) => { if (!(event.target as HTMLElement).closest('button')) dispatcherElement?.blur(); }}>
            {#if dispatcherInput.trim()}
              <div class="dispatch-header">
                <span><i></i>智能路由引擎</span>
                <small>{dispatcherCandidates.length} 个候选</small>
              </div>
              {#if dispatcherCandidates.length === 0}
                <div class="dispatch-empty">没有匹配的工具或内容 — 继续输入，或按 Esc 关闭</div>
              {:else}
                {#each dispatcherCandidates as item, i}
                  <button class:active={dispatchIndex === i} onmousedown={(event) => event.preventDefault()} onclick={() => routeContent(dispatcherInput.trim(), i)}>
                    <span class="match-icon">{@html iconHtml(item.plugin.icon)}</span>
                    <span class="match-main"><b>{item.plugin.name}</b><small>{item.plugin.description}</small></span>
                    {#if dispatchIndex === i}<i class="match-enter">↵</i>{/if}
                  </button>
                {/each}
              {/if}
              <div class="dispatch-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div>
            {:else}
              <div class="dispatch-idle">
                <div class="idle-halo"></div>
                <div class="idle-orb idle-orb-a"></div>
                <div class="idle-orb idle-orb-b"></div>
                <div class="idle-scan"></div>
                <span class="dispatch-idle-icon">{@html UI_ICONS.sparkle}</span>
                <div class="dispatch-idle-copy"><b>Spurh 智能路由引擎</b><small>粘贴任意内容，自动识别类型并路由到正确工具 — 即输即转，无需选择</small></div>
                <div class="idle-chips">
                  {#each ['JSON 格式化', 'Unix 时间戳', 'Base64 编解码', 'SQL 美化', '正则测试', '密码生成', 'UUID', 'Cron 表达式', '哈希 / HMAC', 'URL 编解码', '端口探测'] as cap}<span class="idle-chip">{cap}</span>{/each}
                </div>
                <div class="idle-hint"><span><kbd>↑</kbd><kbd>↓</kbd> 选择候选</span><span><kbd>↵</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div>
              </div>
            {/if}
          </div>
        {/if}

    </div>
    <div class="app-actions">
      {#if appSettings.topBarFullscreen && fullscreenSupported}
        <button class="settings-button" onclick={toggleFullscreen} title={isFullscreen ? '退出全屏' : '全屏显示'}>
          <span>{@html isFullscreen ? UI_ICONS.shrink : UI_ICONS.expand}</span>{isFullscreen ? '退出全屏' : '全屏'}
        </button>
      {/if}
      {#if appSettings.topBarSettings}
        <button class:configured={isAiConfigured(aiConfig)} class="settings-button" title="设置" aria-label="设置" onclick={() => openSettings()}><span>{@html UI_ICONS.settings}</span>设置</button>
      {/if}
    </div>
  </header>

  <div class:sidebar-hidden={!sidebarOpen} class="app-body">
    <aside class="sidebar">
      <div class="side-heading"><small>{visiblePlugins.length} 个工具</small><button class="side-manage" title="管理工具显示与隐藏" onclick={() => openSettings('tools')}>{@html UI_ICONS.sliders}<span>显示/隐藏</span></button></div>
      <label class="tool-search"><span>{@html UI_ICONS.search}</span><input bind:value={toolSearch} placeholder="搜索" onkeydown={(event) => { if (event.key === 'Escape') toolSearch = ''; }} />{#if toolSearch}<button class="tool-search-clear" onclick={() => (toolSearch = '')} aria-label="清除搜索" title="清除搜索">{@html UI_ICONS.close}</button>{/if}</label>
      <div class="category-tabs">
        {#each categories as item}<button class:active={category === item} onclick={() => (category = item)}>{item}</button>{/each}
      </div>
      <nav class="tool-list">
        {#each visiblePlugins as plugin}
          <button class:active={activePluginId === plugin.id} title={plugin.name} onclick={() => selectPlugin(plugin.id)}>
            <span class="tool-icon">{@html iconHtml(plugin.icon)}</span><span class="tool-name"><b>{plugin.name}</b></span>
          </button>
        {/each}
      </nav>
      <footer class="sidebar-foot">
        <button onclick={() => openSettings()} title="打开设置" aria-label="打开设置"><span>{@html UI_ICONS.settings}</span><b>设置</b></button>
      </footer>
    </aside>

    <main class="workspace">
      {#if activePluginId === 'spurh.network' || activePluginId === 'spurh.remote' || activePluginId === 'spurh.sql'}
        {#if !isTauri && activePluginId !== 'spurh.network'}
          <div class="browser-note"><span>{@html UI_ICONS.info}</span>浏览器预览模式:{activePlugin.name} 需要桌面能力,请运行 <code>npm run tauri dev</code> 获得完整功能</div>
        {/if}
        {#if lazyPanel}
          {@const Panel = lazyPanel}
          <div class="panel-fade-host" transition:fade={{ duration: 160 }}><Panel {...lazyPanelProps} /></div>
        {:else}
          <div class="panel-loading" transition:fade={{ duration: 120 }}><span class="spinner"></span>正在加载工具…</div>
        {/if}
      {:else}
        <div class="tool-controls" transition:fade={{ duration: 140 }}>
        {#if activePluginId === 'spurh.cron'}
          <CronPanel session={activeSession} onChangeAction={changeAction} onChangeOption={changeOption} onClear={clearActive} />
        {:else if activePluginId === 'spurh.crypto'}
          <CryptoPanel session={activeSession} onChangeAction={changeAction} onChangeOption={changeOption} onClear={clearActive} />
        {:else if activePluginId === 'spurh.regex'}
          <RegexPanel session={activeSession} onChangeAction={changeAction} onChangeOption={changeOption} onChangeInput={changeInput} onClear={clearActive} aiConfigured={isAiConfigured(aiConfig)} aiBusy={activeSession.aiProcessing} onAiGenerate={aiGenerateRegex} onAiRecommend={aiRecommendRegex} />
        {:else if activePluginId === 'spurh.timestamp'}
          <TimestampPanel session={activeSession} onChangeAction={changeAction} onChangeOption={changeOption} onChangeInput={changeInput} onClear={clearActive} />
        {:else}
          <div class="actions" aria-label="操作">
            {#each activePlugin.actions as action}
              <button class:active={activeSession.actionId === action.id} title={action.description} onclick={() => changeAction(action.id)}>{action.label}</button>
            {/each}
          </div>
          {#if activePlugin.options?.length}
            <div class="options">
              {#each activePlugin.options.filter((option) => (!option.actions || option.actions.includes(activeSession.actionId)) && (!option.showWhen || option.showWhen.values.includes(activeSession.options[option.showWhen.optionId]))) as option}
                <label><span>{option.label}</span>
                  {#if option.type === 'select'}
                    <select value={activeSession.options[option.id]} onchange={(event) => changeOption(option.id, event.currentTarget.value)}>
                      {#each option.choices ?? [] as choice}<option value={choice.value}>{choice.label}</option>{/each}
                    </select>
                  {:else if option.type === 'datetime'}
                    <span class="datetime-wrap">
                      <input type="datetime-local" value={activeSession.options[option.id]} oninput={(event) => changeOption(option.id, event.currentTarget.value)} />
                      <button type="button" class="dt-now" title="填入当前时间" onclick={() => changeOption(option.id, localNowValue())}>现在</button>
                    </span>
                  {:else if option.type === 'number'}
                    <input type="number" value={activeSession.options[option.id]} placeholder={option.placeholder} oninput={(event) => changeOption(option.id, event.currentTarget.value)} />
                  {:else if option.type === 'password'}
                    <input type="password" autocomplete="off" value={activeSession.options[option.id]} placeholder={option.placeholder} oninput={(event) => changeOption(option.id, event.currentTarget.value)} />
                  {:else}
                    <input value={activeSession.options[option.id]} placeholder={option.placeholder} oninput={(event) => changeOption(option.id, event.currentTarget.value)} />
                  {/if}
                </label>
              {/each}
            </div>
          {/if}
          <div class="control-spacer"></div>
        {/if}
        {#if activePluginId !== 'spurh.cron' && activePluginId !== 'spurh.crypto' && activePluginId !== 'spurh.regex' && activePluginId !== 'spurh.timestamp'}
          <div class="control-spacer"></div>
        {/if}
        {#if activePluginId !== 'spurh.cron' && activePluginId !== 'spurh.crypto' && activePluginId !== 'spurh.regex' && activePluginId !== 'spurh.timestamp'}
          <button class="ai-button" title={!isTauri ? 'AI 处理需要桌面应用（请运行 npm run tauri dev）' : '调用 AI 处理当前内容'} disabled={!isTauri || !activeSession.input.trim() || activeSession.aiProcessing} onclick={runAiProcessing}><span>{@html UI_ICONS.sparkle}</span>{activeSession.aiProcessing ? 'AI 中' : 'AI 处理'}</button>
          <button class="quiet-button" onclick={clearActive}>清空</button>
        {/if}
        </div>
        <div class="editor-grid" class:single={hideInputPane}>
        {#if !hideInputPane}
        <section class="editor-pane">
          <header><div><span>输入</span><small>{activeSession.input.length} 字符</small></div><button onclick={pasteToTool}>粘贴</button></header>
          <div class="editor-input" class:hli={inputLanguage === 'json'}>
            {#if inputLanguage === 'json' && activeSession.input.length <= INPUT_HIGHLIGHT_MAX}<pre class="input-hl" bind:this={inputHighlightElement} aria-hidden="true">{@html inputHighlightHtml}</pre>{/if}
            <textarea bind:this={inputElement} value={activeSession.input} oninput={handleInputChange} onkeydown={handleInputKeys} onscroll={syncInputScroll} spellcheck="false" wrap={inputLanguage === 'json' || activeSession.input.length > 60_000 ? 'off' : 'soft'} placeholder="输入或粘贴内容…"></textarea>
          </div>
        </section>
        {/if}
        <section class="editor-pane output-pane">
          <header><div><span>结果</span>{#if currentSessionResult()}<small>{currentSessionResult()!.summary}</small>{/if}</div>
            <div class="output-actions">
              {#if activeSession.aiResult && activePlugin.id === 'spurh.json' && !activeSession.aiResult.meta?.解析}<button class="apply-ai" onclick={applyAiResult}>应用修复</button>{/if}
              {#if currentSessionResult()}<button class="quiet-button" onclick={() => (resultRawMode = !resultRawMode)} title="切换原文/视图显示">{resultRawMode ? '视图' : '原文'}</button>{/if}
              <button disabled={!currentSessionResult()} onclick={copyResult}>{copied ? '已复制 ✓' : '复制'}</button>
            </div>
          </header>
          <div class="output-scroll" bind:this={streamScrollElement}>
            {#if activeSession.aiProcessing}
              <div class="ai-loading">
                <div class="ai-loading-title"><span class="spinner"></span><div><b>AI 处理中</b><small>{aiConfig?.model}</small></div><i>{@html UI_ICONS.sparkle}</i></div>
                <div class="stream-preview"><header><span>推理</span><i>实时</i></header><p>{activeSession.aiReasoning || activeSession.aiStreamContent || '等待响应…'}</p></div>
                {#if activeSession.aiStreamContent}<div class="answer-preview">{activeSession.aiStreamContent}</div>{/if}
              </div>
            {:else if activeSession.aiError}
              <div class="error-box ai-error"><span>{@html UI_ICONS.sparkle}</span><div><b>AI 失败</b><p>{activeSession.aiError}</p><button onclick={() => openSettings('ai')}>检查配置</button></div></div>
            {:else if activeSession.error}
              <div class="error-box"><span>{@html UI_ICONS.info}</span><div><b>处理失败</b><p>{activeSession.error}</p><button onclick={runAiProcessing}><span class="btn-ai">{@html UI_ICONS.sparkle}</span>AI 处理</button></div></div>
            {:else if currentSessionResult()}
              {#if resultRawMode}
                <pre class="result-raw" class:plain={currentSessionResult()!.language === 'text'}>{@html highlightCode(currentSessionResult()!.output, currentSessionResult()!.language)}</pre>
              {:else if activeSession.processing && currentSessionResult()!.output.length > 50_000}
                <div class="output-processing"><span class="spinner"></span><b>输入已变化，结果重新计算中…</b></div>
              {:else}
                <ResultView result={currentSessionResult()!} exportName={activePluginId} />
              {/if}
            {:else}
              <div class="output-empty"><span class="tool-icon large">{@html iconHtml(activePlugin.icon)}</span><b>等待输入</b></div>
            {/if}
          </div>
        </section>
      </div>
      {/if}

    </main>
  </div>

  {#if draggingFile}
    <div class="drop-overlay" role="presentation"><span>{@html UI_ICONS.file}</span><b>松开以打开文件</b><small>内容将自动识别并填入对应工具</small></div>
  {/if}

  {#if paletteOpen}
    <div class="palette-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="palette-search">
          <span class="palette-spark">{@html UI_ICONS.sparkle}</span>
          <input bind:this={paletteElement} bind:value={paletteQuery} onkeydown={handlePaletteKeys} placeholder="搜索工具、设置或操作… Ctrl+K 唤起" spellcheck="false" />
          <kbd>ESC</kbd>
        </div>
        <div class="palette-results">
          {#each paletteGroups as group}
            <div class="palette-group">
              <div class="palette-group-title">{group.group}</div>
              {#each group.items as item}
                <button class:active={paletteFlat.indexOf(item) === paletteIndex} onmousedown={(event) => event.preventDefault()} onclick={() => runPaletteItem(item)}>
                  <span class="palette-item-icon">{@html iconHtml(item.icon)}</span>
                  <b>{item.label}</b>
                  {#if paletteFlat.indexOf(item) === paletteIndex}<i>↵</i>{/if}
                </button>
              {/each}
            </div>
          {/each}
          {#if paletteFlat.length === 0}
            <div class="palette-empty">没有匹配「{paletteQuery}」的内容</div>
          {/if}
        </div>
        <footer class="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>ESC</kbd> 关闭</span>
        </footer>
      </div>
    </div>
  {/if}

  {#if settingsOpen}
    <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) { event.stopPropagation(); } }}>
      <div class="settings-modal" class:about-mode={settingsTab === 'about'} role="dialog" aria-modal="true">
        <header class="settings-header"><span class="settings-head-icon" aria-hidden="true">{@html UI_ICONS.settings}</span><h2>{SETTINGS_TAB_TITLES[settingsTab]}</h2><button onclick={() => (settingsOpen = false)} aria-label="关闭" title="关闭">{@html UI_ICONS.close}</button></header>
        <div class="settings-layout">
          <nav class="settings-nav">
            <button class:active={settingsTab === 'general'} title="主题 · 启动 · 托盘" onclick={() => (settingsTab = 'general')}><span>{@html UI_ICONS.sliders}</span><div><b>通用</b></div></button>
            <button class:active={settingsTab === 'ai'} title="服务商配置" onclick={() => { settingsTab = 'ai'; aiTestStatus = 'idle'; aiTestMessage = ''; }}><span>{@html UI_ICONS.sparkle}</span><div><b>AI 模型</b></div></button>
            <button class:active={settingsTab === 'shortcuts'} title="全局绑定" onclick={() => (settingsTab = 'shortcuts')}><span>{@html UI_ICONS.keyboard}</span><div><b>快捷键</b></div></button>
            <button class:active={settingsTab === 'tools'} title="显示与隐藏" onclick={() => (settingsTab = 'tools')}><span>{@html UI_ICONS.grid}</span><div><b>工具</b></div></button>
            <button class:active={settingsTab === 'about'} title="版本信息" onclick={() => (settingsTab = 'about')}><span>{@html UI_ICONS.info}</span><div><b>关于</b></div></button>
          </nav>
          <section class="settings-content">
            {#if settingsTab !== 'about'}<p class="settings-hint">{SETTINGS_TAB_HINTS[settingsTab]}</p>{/if}
            {#if settingsNotice}<div class="settings-notice"><span>{@html UI_ICONS.info}</span>{settingsNotice}</div>{/if}
            {#if settingsTab === 'general'}
              <div class="settings-section-title"><h3>通用</h3></div>
              <button class="visibility-entry" onclick={() => (settingsTab = 'tools')}>
                <span class="visibility-entry-icon">{@html UI_ICONS.grid}</span>
                <span class="visibility-entry-copy"><b>工具显示与隐藏</b><small>侧栏、聚焦框与命令面板中展示哪些工具</small></span>
                <span class="visibility-entry-arrow">→</span>
              </button>
              <div class="setting-group"><div class="setting-copy"><b>主题</b></div>
                <div class="theme-choice">
                  <button class:active={appSettings.theme === 'dark'} onclick={() => saveAppSettings({ theme: 'dark' })}>{@html UI_ICONS.moon}<span>深色</span></button>
                  <button class:active={appSettings.theme === 'light'} onclick={() => saveAppSettings({ theme: 'light' })}>{@html UI_ICONS.sun}<span>明亮</span></button>
                  <button class:active={appSettings.theme === 'aurora'} onclick={() => saveAppSettings({ theme: 'aurora' })}>{@html UI_ICONS.sparkle}<span>极光</span></button>
                  <button class:active={appSettings.theme === 'forest'} onclick={() => saveAppSettings({ theme: 'forest' })}>{@html UI_ICONS.leaf}<span>护眼</span></button>
                  <button class:active={appSettings.theme === 'system'} onclick={() => saveAppSettings({ theme: 'system' })}>{@html UI_ICONS.contrast}<span>跟随系统</span></button>
                </div>
              </div>
              <div class="setting-group"><div class="setting-copy"><b>字体大小</b><small>全局界面字号（12–20px），拖动立即生效</small></div>
                <div class="font-size-row"><input type="range" min="12" max="20" step="1" value={appSettings.fontSize} oninput={(event) => saveAppSettings({ fontSize: Number(event.currentTarget.value) })} /><b>{appSettings.fontSize}px</b></div>
              </div>
              <div class="setting-group"><div class="setting-copy"><b>字体</b></div>
                <div class="theme-choice font-choice">
                  {#each Object.keys(FONT_STACKS) as family}
                    <button class:active={appSettings.fontFamily === family} style={`font-family: ${FONT_STACKS[family]}`} onclick={() => saveAppSettings({ fontFamily: family })}><span>{family}</span></button>
                  {/each}
                </div>
              </div>
              <div class="setting-group font-preview"><div class="setting-copy"><b>实时预览</b><small>当前 {appSettings.fontSize}px · {appSettings.fontFamily}</small></div>
                <p style={`font-family: ${FONT_STACKS[appSettings.fontFamily] ?? FONT_STACKS['系统默认']}; font-size: ${appSettings.fontSize}px`}>Spurh 工具箱 · 中文测试 abc123</p>
              </div>
              <label class="setting-row"><div class="setting-copy"><b>开机启动</b></div><input type="checkbox" checked={autostartEnabled} disabled={settingsBusy === 'autostart'} onchange={(event) => changeAutostart(event.currentTarget.checked)} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>系统托盘</b></div><input type="checkbox" checked={appSettings.trayEnabled} disabled={settingsBusy === 'tray'} onchange={(event) => changeTray(event.currentTarget.checked)} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>侧栏默认展开</b><small>启动时默认显示左侧工具栏（窄窗口下自动收起）</small></div><input type="checkbox" checked={sidebarOpen} onchange={(event) => { sidebarOpen = event.currentTarget.checked; sidebarAutoCollapsed = false; if (sidebarOpen && window.innerWidth <= 850) sidebarUserNarrowChoice = true; saveAppSettings({ sidebarOpen }); }} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>系统右键菜单</b><small>在资源管理器中“用 Spurh 打开”</small></div><input type="checkbox" checked={contextMenuEnabled} disabled={settingsBusy === 'contextMenu'} onchange={(event) => changeContextMenu(event.currentTarget.checked)} /><i></i></label>
              <div class="settings-section-title"><h3>顶栏显示</h3><small>默认全部显示，可隐藏顶栏按钮（仍可通过 Ctrl+K 命令面板使用）</small></div>
              <label class="setting-row"><div class="setting-copy"><b>全屏按钮</b></div><input type="checkbox" checked={appSettings.topBarFullscreen} onchange={(event) => saveAppSettings({ topBarFullscreen: event.currentTarget.checked })} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>设置按钮</b></div><input type="checkbox" checked={appSettings.topBarSettings} onchange={(event) => saveAppSettings({ topBarSettings: event.currentTarget.checked })} /><i></i></label>
              {#if settingsError}<div class="settings-error">{settingsError}</div>{/if}
            {/if}
            {#if settingsTab === 'tools'}
              <div class="settings-section-title model-title"><div><h3>工具显示</h3><small>默认全部显示，关闭后从侧栏、聚焦框与命令面板中隐藏</small></div><div class="visibility-actions"><button onclick={() => saveAppSettings({ hiddenTools: [] })}>全部显示</button><button onclick={() => saveAppSettings({ hiddenTools: plugins.map((plugin) => plugin.id) })}>全部隐藏</button></div></div>
              <div class="tool-visibility-grid">
                {#each plugins as plugin}
                  {@const hidden = appSettings.hiddenTools.includes(plugin.id)}
                  <label class="setting-row compact" class:off={hidden}>
                    <span class="tool-icon small">{@html iconHtml(plugin.icon)}</span>
                    <span class="visibility-copy"><b>{plugin.name}</b></span>
                    <input type="checkbox" checked={!hidden} onchange={(event) => { const next = event.currentTarget.checked ? appSettings.hiddenTools.filter((id) => id !== plugin.id) : [...appSettings.hiddenTools, plugin.id]; saveAppSettings({ hiddenTools: next }); }} /><i></i>
                  </label>
                {/each}
              </div>
            {/if}
            {#if settingsTab === 'ai'}
              <div class="settings-section-title model-title"><div><h3>AI 模型</h3></div><button onclick={addAiProfile}><span>{@html UI_ICONS.plus}</span>添加</button></div>
              {#if aiStore.profiles.length === 0}
                <div class="settings-ai-empty">
                  <span>{@html UI_ICONS.sparkle}</span>
                  <div><b>尚未配置 AI 服务商</b><small>配置后，AI 处理 / 生成 / 分析 / 解释等功能会自动启用。填写服务商信息，点击「测试」验证连通性，再「保存」即可。</small></div>
                </div>
              {/if}
              <div class="profile-list">
                {#each aiStore.profiles as profile}
                  <button class:active={aiDraft.id === profile.id} onclick={() => editAiProfile(profile.id)}>
                    <span class="provider-logo small">{@html providerIcon(profile.provider)}</span><div><b>{profile.name}</b><small>{profile.model || '未选'}</small></div>{#if aiStore.activeId === profile.id}<i>使用中</i>{/if}
                  </button>
                {/each}
              </div>
              <div class="provider-list">
                {#each Object.keys(AI_PRESETS) as provider}
                  <button class:active={aiDraft.provider === provider} onclick={() => selectAiProvider(provider)}>
                    <span class="provider-logo small">{@html providerIcon(provider)}</span>{PROVIDER_NAMES[provider] || provider}
                  </button>
                {/each}
              </div>
              <div class="config-fields">
                <label><span>名称</span><input bind:value={aiDraft.name} placeholder="例如：日常" /></label>
                <label><span>地址</span><input bind:value={aiDraft.endpoint} placeholder="https://api.example.com/v1" /></label>
                <label class="model-field"><span>模型</span><div>
                  <span class="model-input-wrap">
                    {#if modelList.length > 0}
                      <select bind:value={aiDraft.model}><option value="">-- 选择 --</option>{#each modelList as model}<option value={model.id}>{model.id}</option>{/each}</select>
                    {:else}
                      <input list="rm" bind:value={aiDraft.model} placeholder="输入模型名，或拉取列表" /><datalist id="rm">{#each modelList as m}<option value={m.id}>{m.id}</option>{/each}</datalist>
                    {/if}
                    {#if modelList.length > 0 || aiDraft.endpoint.trim()}
                      <button class:loading={modelListLoading} class="model-fetch-link" disabled={modelListLoading} onclick={loadRemoteModels} title="从当前地址拉取模型列表">{@html UI_ICONS.refresh}{modelList.length > 0 ? (modelListLoading ? '拉取中…' : '重新拉取') : (modelListLoading ? '拉取中…' : '拉取')}</button>
                    {/if}
                  </span>
                </div></label>
                <label><span>密钥</span><span class="ai-secret">
                  <input type={aiKeyVisible ? 'text' : 'password'} bind:value={aiDraft.apiKey} placeholder={aiDraft.provider === 'ollama' ? '可留空' : 'sk-…'} autocomplete="off" />
                  <button class="ai-secret-toggle" onclick={() => (aiKeyVisible = !aiKeyVisible)} title={aiKeyVisible ? '隐藏密钥' : '显示密钥'}>{@html aiKeyVisible ? UI_ICONS.eyeOff : UI_ICONS.eye}</button>
                </span></label>
              </div>
              {#if aiTestStatus !== 'idle'}<div class:success={aiTestStatus === 'success'} class:error={aiTestStatus === 'error'} class="test-result">{aiTestMessage}</div>{/if}
              <div class="settings-ai-actions">
                {#if aiStore.profiles.some((p) => p.id === aiDraft.id)}<button class="delete-model" class:confirming={deleteConfirming} onclick={removeAiProfile}>{deleteConfirming ? '再次点击确认删除' : '删除'}</button>{/if}
                <div class="control-spacer"></div>
                <button class="test-button" disabled={aiTestStatus === 'testing' || !aiDraft.endpoint} onclick={testConnection}>测试</button>
                <button class="save-button" disabled={!aiDraft.endpoint || !aiDraft.model} onclick={saveAiSettings}>保存</button>
              </div>
            {/if}
            {#if settingsTab === 'shortcuts'}
              <div class="settings-section-title"><h3>快捷键</h3><small>点击组合键后直接按下新组合，Esc 取消</small></div>
              {#if hotkeyError}<div class="settings-error">{hotkeyError}</div>{/if}
              <div class="shortcut-list">
                {#each plugins.slice(0, 9) as plugin, i}
                  {@const binding = appSettings.toolHotkeys[String(i)] ?? `alt+${i + 1}`}
                  {@const enabled = binding !== 'off' && binding !== ''}
                  <div class="shortcut-row" class:recording={recordingTool === i}>
                    <span class="tool-icon small">{@html iconHtml(plugin.icon)}</span>
                    <span class="shortcut-name"><b>{plugin.name}</b></span>
                    <button class="hk-record" class:recording={recordingTool === i} onclick={() => (recordingTool === i ? cancelRecord() : startRecordTool(i))} title="点击后按下新组合键">
                      {recordingTool === i ? '按下组合键…' : enabled ? formatHotkey(binding) : '未分配'}
                    </button>
                    <label class="hk-switch" title={enabled ? '禁用此快捷键' : '启用此快捷键'}>
                      <input type="checkbox" checked={enabled} onchange={(event) => {
                        const value = event.currentTarget.checked ? `alt+${i + 1}` : 'off';
                        saveAppSettings({ toolHotkeys: { ...appSettings.toolHotkeys, [String(i)]: value } });
                        applyHotkeys().catch(() => undefined);
                      }} />
                      <i></i>
                    </label>
                  </div>
                {/each}
                <div class="shortcut-row" class:recording={recordingDispatch}>
                  <span class="tool-icon small">{@html UI_ICONS.search}</span>
                  <span class="shortcut-name"><b>聚焦搜索框</b></span>
                  <button class="hk-record" class:recording={recordingDispatch} onclick={() => (recordingDispatch ? cancelRecord() : startRecordDispatch())} title="点击后按下新组合键">
                    {recordingDispatch ? '按下组合键…' : dispatchHotkey !== 'off' ? formatHotkey(dispatchHotkey) : '未分配'}
                  </button>
                  <label class="hk-switch" title={dispatchHotkey !== 'off' ? '禁用此快捷键' : '启用此快捷键'}>
                    <input type="checkbox" checked={dispatchHotkey !== 'off'} onchange={(event) => saveDispatchHotkey(event.currentTarget.checked ? 'ctrl+shift+space' : 'off')} />
                    <i></i>
                  </label>
                </div>
              </div>
              <div class="shortcuts-note">快捷键在系统全局生效，即使 Spurh 在后台也能唤起。Ctrl+Shift+Space 为内置窗口唤起组合，默认同时用于聚焦搜索框，可在此修改。</div>
            {/if}
            {#if settingsTab === 'about'}
              <div class="about-stage" bind:this={aboutStageEl}>
                <div class="about-aurora" aria-hidden="true"></div>
                <div class="about-frame" aria-hidden="true"></div>
                <div class="about-scanline" aria-hidden="true"></div>
                <div class="about-orb about-orb-a" aria-hidden="true"></div>
                <div class="about-orb about-orb-b" aria-hidden="true"></div>
                <div class="about-particles" aria-hidden="true"><i style="--px:16%;--pd:.0s;--ps:8px"></i><i style="--px:38%;--pd:1.1s;--ps:6px"></i><i style="--px:58%;--pd:.5s;--ps:7px"></i><i style="--px:76%;--pd:1.9s;--ps:5px"></i><i style="--px:26%;--pd:2.7s;--ps:4px"></i><i style="--px:68%;--pd:3.4s;--ps:6px"></i></div>
                <canvas bind:this={aboutCanvas} class="about-canvas" aria-hidden="true"></canvas>
                <div class="about-cols">
                  <div class="about-col-left">
                    <div class="about-hero">
                      <span class="about-logo-wrap"><i class="about-logo-cone" aria-hidden="true"></i><i class="about-logo-ring" aria-hidden="true"></i><span class="brand-mark large about-logo">{@html BRAND_MARK}</span></span>
                      <div><h3 class="about-title">Spurh</h3><p class="about-type">{aboutTagline}<span class="about-caret" aria-hidden="true"></span></p></div><span class="about-badge"><i aria-hidden="true"></i>本地优先</span>
                    </div>
                    <div class="about-note"><b>本地优先 · AI 增强</b><p>所有工具在本地运行，数据不出设备；AI 能力按需接入，帮助生成、解释、修复与提炼，让重复工作一步完成。</p></div>
                    <div class="about-grid">
                      <article><small>作者</small><b>xuning</b></article>
                      <article><small>版本</small><b>0.1.0</b></article>
                      <article><small>内置工具</small><b>{aboutPanelsShown} 个</b></article>
                      <article><small>许可</small><b>MIT</b></article>
                    </div>
                    <div class="about-actions">
                      <button onclick={() => { copyText(`Spurh v0.1.0 · 构建 ${BUILD_STAMP} · MIT`); settingsNotice = "版本信息已复制到剪贴板"; }}>{@html UI_ICONS.copy}<span>复制版本信息</span></button>
                      <button onclick={() => (settingsNotice = `已是最新版本 v0.1.0（构建 ${BUILD_STAMP}）`)}>{@html UI_ICONS.refresh}<span>检查更新</span></button>
                    </div>
                    <footer class="about-foot">© 2026 Spurh · Made with ❤ by xuning</footer>
                  </div>
                  <div class="about-col-right">
                    <div class="about-status">
                      <span class="about-radar" aria-hidden="true"><i class="radar-sweep"></i></span>
                      <div><b>引擎在线</b><small>本地服务运行正常 · 响应实时</small></div>
                      <span class="about-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
                    </div>
                    <div class="about-version">
                      <div class="about-ver-head"><b>v0.1.0</b><small>构建 {BUILD_STAMP}</small></div>
                      <p class="about-ver-line">本地优先 · 数据不出设备 · 即开即用</p>
                    </div>
                  </div>
                </div>
              </div>
            {/if}
          </section>
        </div>
      </div>
    </div>
  {/if}

  {#if openFileContext}
    <div class="file-notice"><span>{@html UI_ICONS.file}</span><b>{openFileContext.path}</b><button onclick={() => (openFileContext = null)} aria-label="关闭">{@html UI_ICONS.close}</button></div>
  {/if}
</div>
