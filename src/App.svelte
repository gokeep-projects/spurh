<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import { isTauri, safeInvoke, safeListen } from './lib/env';
  import { AI_PRESETS, createAiProfile, deleteProfileSecret, fetchAiModels, flushLegacyAiSecrets, hydrateAiSecrets, isAiConfigured, loadAiProfileStore, processWithAi, saveAiProfileStore, saveProfileSecret, testAiConnection, type AiModel, type AiProfile } from './lib/ai';
  import { PROVIDER_NAMES, providerIcon } from './lib/providerIcons';
  import { BRAND_MARK, TOOL_ICONS, UI_ICONS, iconHtml } from './lib/icons';
  import { highlightCode } from './lib/highlight';
  import ResultView from './lib/components/ResultView.svelte';
  import CronPanel from './lib/panels/CronPanel.svelte';
  import CryptoPanel from './lib/panels/CryptoPanel.svelte';
  import RegexPanel from './lib/panels/RegexPanel.svelte';
  import TimestampPanel from './lib/panels/TimestampPanel.svelte';
  import { runtime, type PluginResult } from './lib/plugins';
  import { setPendingRepo } from './lib/panels/gitStore';
  import { trimImageHistory, type ClipItem } from './lib/clipHistory';

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

  const FONT_STACKS: Record<string, string> = {
    '系统默认': "-apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
    '微软雅黑': "'Microsoft YaHei', '微软雅黑', 'PingFang SC', sans-serif",
    '黑体': "'SimHei', '黑体', 'Microsoft YaHei', sans-serif",
    '宋体': "'SimSun', '宋体', 'STSong', serif",
    'Consolas': "'Consolas', 'Cascadia Code', monospace",
    'Cascadia Code': "'Cascadia Code', Consolas, monospace",
  };

  type AppSettings = {
    theme: ThemeMode;
    trayEnabled: boolean;
    contextMenuEnabled: boolean;
    clipboardWatch: boolean;
    dispatchHotkey: string;
    toolHotkeys: Record<string, string>;
    fontSize: number;
    fontFamily: string;
    sidebarShortcuts: boolean;
    hiddenTools: string[];
  };

  type ContextInfo = { path: string; content: string };

  type PaletteItem = { id: string; group: string; label: string; hint: string; icon: string; run: () => void };

  const SETTINGS_KEY = 'spurh.settings.v1';

  function loadAppSettings(): AppSettings {
    const fallback: AppSettings = {
      theme: 'dark', trayEnabled: true, contextMenuEnabled: true, clipboardWatch: true, dispatchHotkey: 'ctrl+shift+space',
      toolHotkeys: { '0': 'alt+1', '1': 'alt+2', '2': 'alt+3', '3': 'alt+4', '4': 'alt+5', '5': 'alt+6', '6': 'alt+7', '7': 'alt+8' },
      fontSize: 14, fontFamily: '系统默认',
      sidebarShortcuts: false,
      hiddenTools: [],
    };
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      const parsed = stored ? JSON.parse(stored) : {};
      return {
        ...fallback,
        ...parsed,
        hiddenTools: Array.isArray(parsed.hiddenTools) ? parsed.hiddenTools : fallback.hiddenTools,
        fontSize: typeof parsed.fontSize === 'number' && parsed.fontSize >= 12 && parsed.fontSize <= 20 ? parsed.fontSize : fallback.fontSize,
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
  let activePluginId = $state('spurh.json');
  let dispatcherInput = $state('');
  let dispatcherElement = $state<HTMLInputElement | undefined>(undefined);
  let inputElement = $state<HTMLTextAreaElement | undefined>(undefined);
  let streamScrollElement = $state<HTMLDivElement | undefined>(undefined);
  let toolSearch = $state('');
  let category = $state<(typeof categories)[number]>('全部');
  let copied = $state(false);
  const initialSettings = loadAppSettings();
  let appSettings = $state(initialSettings);
  let sidebarOpen = $state(true);
  const initialAiStore = loadAiProfileStore();
  let aiStore = $state(initialAiStore);
  let aiDraft = $state<AiProfile>(initialAiStore.profiles.find((profile) => profile.id === initialAiStore.activeId) ?? createAiProfile());
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
  let clipItems = $state<ClipItem[]>([]);
  let clipOverlayOpen = $state(false);
  let clipOverlayQuery = $state('');
  let clipOverlayIndex = $state(0);
  let clipElement = $state<HTMLInputElement | undefined>(undefined);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();


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
    'spurh.log': () => import('./lib/panels/LogPanel.svelte') as Promise<LazyPanelModule>,
    'spurh.clipboard': () => import('./lib/panels/ClipboardPanel.svelte') as Promise<LazyPanelModule>,
    'spurh.remote': () => import('./lib/panels/RemotePanel.svelte') as Promise<LazyPanelModule>,
    'spurh.sql': () => import('./lib/panels/SqlPanel.svelte') as Promise<LazyPanelModule>,
    'spurh.git': () => import('./lib/panels/GitPanel.svelte') as Promise<LazyPanelModule>,
  };
  let lazyPanel = $state<Component | null>(null);
  let lazyPanelLoading = $state(false);
  let logPanelStatus = $state<{ chars: number; summary: string } | null>(null);
  const lazyPanelProps = $derived<Record<string, unknown>>(
    activePluginId === 'spurh.clipboard'
      ? { onChangeInput: fillFromClipboard }
      : activePluginId === 'spurh.sql'
        ? { aiConfig }
        : activePluginId === 'spurh.log'
          ? {
              onStatus: (status: { chars: number; summary: string } | null) => (logPanelStatus = status),
              // 路由/拖拽进入日志面板的内容同步到面板输入区，避免“有结果但界面空”的割裂
              externalText: activeSession.input.trim() ? { text: activeSession.input, ts: activeSession.revision } : null,
            }
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
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const next = !isFullscreen;
        await win.setFullscreen(next);
        isFullscreen = next;
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      /* ignore */
    }
  }
  $effect(() => {
    if (isTauri) return;
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
  let anyAiProcessing = $derived(plugins.some((p) => sessions[p.id].aiProcessing));
  let statusText = $derived(
    activeSession.error ? '处理失败'
      : activeSession.aiProcessing ? 'AI 处理中…'
        : activeSession.processing ? '处理中…'
          : activePluginId === 'spurh.log' && logPanelStatus
            ? `结果 ${logPanelStatus.summary} · ${logPanelStatus.chars} 字符`
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
  let clipFiltered = $derived(clipOverlayQuery ? clipItems.filter((item) => item.text.toLowerCase().includes(clipOverlayQuery.toLowerCase())) : clipItems);
  $effect(() => {
    // 结果状态实时写入窗口标题（原生标题栏，任何渲染问题都无法遮挡）
    const result = currentSessionResult();
    const next = activePluginId === 'spurh.log' && logPanelStatus
      ? `Spurh · ${__BUILD_DATE__} · 日志: ${logPanelStatus.summary} · ${logPanelStatus.chars}字符`
      : result
        ? `Spurh · ${__BUILD_DATE__} · 结果: ${(result.summary || '有结果').slice(0, 24)} · ${result.output?.length ?? 0}字符`
        : `Spurh · ${__BUILD_DATE__} · 结果: 无`;
    if (document.title !== next) document.title = next;
  });

  $effect(() => {
    // 同步浏览器标签栏/桌面主题色
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', lightMode ? '#f4f6f9' : '#090b10');
  });

  $effect(() => {
    if (paletteIndex > paletteFlat.length - 1) paletteIndex = Math.max(0, paletteFlat.length - 1);
  });
  $effect(() => {
    if (clipOverlayIndex > Math.max(0, clipFiltered.length - 1)) clipOverlayIndex = Math.max(0, clipFiltered.length - 1);
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
      safeInvoke('set_clipboard_watch', { enabled: appSettings.clipboardWatch }).catch(() => undefined);
    }, 800);
    // 剪贴板历史：初始快照 + 实时事件
    safeInvoke<ClipItem[]>('clipboard_history').then((snapshot) => { clipItems = snapshot; }).catch(() => undefined);
    const clipUnlisten1 = safeListen<ClipItem[]>('clipboard:history', (event) => {
      // 后端历史不含图片，合并保留本地图片项，避免被全量替换清掉
      const images = clipItems.filter((item) => item.kind === 'image');
      clipItems = trimImageHistory([...images, ...event.payload].slice(0, 100));
    });
    const clipUnlisten2 = safeListen<ClipItem>('clipboard:item', (event) => {
      const item = event.payload;
      // 内容去重：同文本/同图片条目移动到头并更新时间，不新增重复项
      if (item.kind === 'image' && item.image) {
        // 图片按内容去重
        const dup = clipItems.find((other) => other.kind === 'image' && other.image === item.image);
        if (dup) {
          clipItems = [{ ...dup, ts: item.ts }, ...clipItems.filter((other) => other.id !== dup.id)].slice(0, 100);
          return;
        }
      } else {
        const dup = clipItems.find((other) => other.kind !== 'image' && other.text === item.text);
        if (dup) {
          clipItems = [{ ...dup, ts: item.ts }, ...clipItems.filter((other) => other.id !== dup.id)].slice(0, 100);
          return;
        }
      }
      clipItems = trimImageHistory([item, ...clipItems].slice(0, 100));
    });
    window.addEventListener('paste', handleGlobalPaste);
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
      window.removeEventListener('paste', handleGlobalPaste);
      window.removeEventListener('error', onFrontendError);
      window.removeEventListener('unhandledrejection', onFrontendError);
      unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
      clipUnlisten1.then((fn) => fn()).catch(() => undefined);
      clipUnlisten2.then((fn) => fn()).catch(() => undefined);
    };
  });

  function patchSession(pluginId: string, patch: Partial<ToolSession>): void {
    sessions = { ...sessions, [pluginId]: { ...sessions[pluginId], ...patch } };
  }

  function hasProcessableInput(pluginId: string, session: ToolSession): boolean {
    if (pluginId === 'spurh.network' || pluginId === 'spurh.clipboard' || pluginId === 'spurh.remote') return false;
    if (session.input.length > 0) return true;
    if (pluginId === 'spurh.timestamp' && session.actionId === 'now') return true;
    if (pluginId === 'spurh.timestamp' && session.actionId === 'to-unix' && session.options.pickDateTime) return true;
    if (pluginId === 'spurh.random') return true;
    if (pluginId === 'spurh.cron' && session.actionId === 'generate') return true;
    if (pluginId === 'spurh.crypto' && ['rsa-gen', 'MD5', 'SHA-1', 'SHA-256', 'SHA-512'].includes(session.actionId)) return true;
    return pluginId === 'spurh.regex' && Boolean(session.options.pattern);
  }

  function scheduleProcess(pluginId = activePluginId, delay = 300): void {
    const prev = timers.get(pluginId);
    if (prev) clearTimeout(prev);
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

  /* ── 输入区语法高亮（仅 JSON） ── */
  let inputLanguage = $derived(activePluginId === 'spurh.json' ? 'json' : 'text');
  let inputHighlightElement = $state<HTMLPreElement | undefined>(undefined);

  function handleInputChange(event: Event): void {
    changeInput((event.currentTarget as HTMLTextAreaElement).value);
  }

  /** 编辑器键位：Tab 缩进（Shift+Tab 反缩进）、Enter 延续缩进、括号/引号自动闭合 */
  function handleInputKeys(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.ctrlKey && activePluginId === 'spurh.sql') {
      event.preventDefault();
      runSql();
      return;
    }
    const target = event.currentTarget as HTMLTextAreaElement;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const value = target.value;

    if (event.key === 'Tab') {
      event.preventDefault();
      if (start === end) {
        // 单点：插入两个空格
        changeInput(value.slice(0, start) + '  ' + value.slice(end));
        requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2; });
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
      requestAnimationFrame(() => { target.selectionStart = lineStart; target.selectionEnd = lineStart + next.length; });
      return;
    }

        if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const lineEndIdx = value.indexOf('\n', end);
      const lineEndPos = lineEndIdx < 0 ? value.length : lineEndIdx;
      const cursorPart = value.slice(lineStart, start);
      const fullLine = value.slice(lineStart, lineEndPos);
      // 保持当前行缩进
      const indentSource = cursorPart.length === 0 ? fullLine : cursorPart;
      const indentMatch = indentSource.match(/^[\t ]*/);
      let indent = indentMatch ? indentMatch[0] : '';
      // 自动补全：未闭合引号 / 行尾开括号
      const openQuote = (cursorPart.match(/"/g) || []).length % 2 === 1;
      let extra = (!openQuote && /[{[(,:]$/.test(cursorPart.trimEnd())) ? '  ' : '';
      // 对齐闭合括号（} ] )）
      const nextLineStart = value.indexOf('\n', end);
      if (nextLineStart >= 0) {
        const nextLineEnd = value.indexOf('\n', nextLineStart + 1);
        const nextLine = value.slice(nextLineStart + 1, nextLineEnd < 0 ? value.length : nextLineEnd);
        const nextIndent = (nextLine.match(/^[\t ]*/) || [''])[0];
        if (/^[}\])]/.test(nextLine.trim()) && indent.length > nextIndent.length) {
          indent = nextIndent;
          extra = '';
        }
      }
      const insert = '\n' + indent + extra;
      changeInput(value.slice(0, start) + insert + value.slice(end));
      requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + insert.length; });
      return;
    }

    // 输入闭合括号时自动配对
    const CLOSERS: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
    if (event.key.length === 1 && CLOSERS[event.key]) {
      const cLineStart = value.lastIndexOf('\n', start - 1) + 1;
      const before = value.slice(cLineStart, start);
      if (/^[\t ]*$/.test(before)) {
        let depth = 0;
        for (let i = start - 1; i >= 0; i--) {
          const ch = value[i];
          if (ch === event.key) depth++;
          else if (ch === CLOSERS[event.key]) {
            if (depth === 0) {
              const openLineStart = value.lastIndexOf('\n', i - 1) + 1;
              const openIndent = (value.slice(openLineStart, i).match(/^[\t ]*/) || [''])[0];
              if (before.length > openIndent.length) {
                event.preventDefault();
                changeInput(value.slice(0, cLineStart) + openIndent + value.slice(start));
                requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = cLineStart + openIndent.length; });
                return;
              }
            } else depth--;
          }
        }
      }
    }

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const openChar = PAIRS[event.key];
      if (openChar) {
        event.preventDefault();
        changeInput(value.slice(0, start) + event.key + openChar + value.slice(end));
        requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 1; });
        return;
      }
      const isCloser = Object.values(PAIRS).includes(event.key);
      if (isCloser && value[start] === event.key) {
        // 下一个字符就是配对的闭合符号：跳过而不是重复输入
        event.preventDefault();
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
  let hideInputPane = $derived(activePluginId === 'spurh.timestamp');

  function changeAction(actionId: string): void {
    // Cron 面板内配置的表达式（手写/自定义）需同步到共享输入，解析/执行时间才有内容可用
    if (activePluginId === 'spurh.cron' && (actionId === 'explain' || actionId === 'next')) {
      const custom = activeSession.options.customExpr?.trim();
      if (!activeSession.input.trim() && custom) {
        patchSession(activePluginId, { input: custom });
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
  const SELF_CONTAINED_PANELS = new Set(['spurh.sql', 'spurh.network', 'spurh.remote', 'spurh.clipboard']);

  function fillFromClipboard(text: string): void {
    const match = runtime.dispatch(text).selected;
    const target = match && match.confidence >= 0.4 && !SELF_CONTAINED_PANELS.has(match.plugin.id) ? match.plugin.id : 'spurh.json';
    activePluginId = target;
    patchSession(target, { input: text, aiResult: null, aiError: '', ...(match?.suggestedAction ? { actionId: match.suggestedAction } : {}) });
    scheduleProcess(target, 0);
  }

  function handleDispatcherInput(value: string): void {
    dispatcherInput = value;
    dispatchIndex = 0;
    if (!value.trim()) return;
    const match = runtime.dispatch(value).selected;
    if (match && match.confidence >= 0.75 && !SELF_CONTAINED_PANELS.has(match.plugin.id)) {
      // 高置信度：立即路由执行并清空输入框，交互干脆
      routeLive(match.plugin.id, value, match.suggestedAction);
      dispatcherInput = '';
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

  function handleGlobalPaste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files ?? [];
    // 仅收位图格式（≤5MB）；SVG 可能携带脚本，粘贴到外部应用时有激活风险
    const image = [...files].find((file) => file.type.startsWith('image/') && !file.type.includes('svg') && file.size <= 5 * 1024 * 1024);
    if (!image) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const dup = clipItems.find((other) => other.kind === 'image' && other.image === dataUrl);
      if (dup) {
        clipItems = [{ ...dup, ts: Date.now() }, ...clipItems.filter((other) => other.id !== dup.id)].slice(0, 100);
        return;
      }
      const item: ClipItem = { id: crypto.randomUUID(), text: '', ts: Date.now(), kind: 'image', image: dataUrl };
      clipItems = trimImageHistory([item, ...clipItems].slice(0, 100));
    };
    reader.readAsDataURL(image);
  }

  function handleDispatcherPaste(event: ClipboardEvent): void {
    const content = event.clipboardData?.getData('text') ?? '';
    if (!content.trim()) return;
    event.preventDefault();
    dispatcherInput = content;
    dispatchIndex = 0;
    handleDispatcherInput(content);
  }

  function handleDispatcherKeys(event: KeyboardEvent): void {
    const max = dispatcherCandidates.length - 1;
    if (event.key === 'ArrowDown') { event.preventDefault(); dispatchIndex = Math.min(dispatchIndex + 1, max); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); dispatchIndex = Math.max(dispatchIndex - 1, 0); return; }
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
    try { changeInput(await navigator.clipboard.readText()); } catch { dispatcherElement?.focus(); }
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
    await navigator.clipboard.writeText(result.output);
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
    aiDraft = aiConfig ? { ...aiConfig } : createAiProfile();
    aiTestStatus = 'idle'; aiTestMessage = ''; settingsError = ''; settingsNotice = notice; settingsTab = tab; settingsOpen = true;
    recordingTool = null; recordingDispatch = false; hotkeyError = '';
    resetDeleteConfirm();
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

  async function changeClipboardWatch(enabled: boolean): Promise<void> {
    settingsBusy = 'clipboard'; settingsError = '';
    try { await safeInvoke('set_clipboard_watch', { enabled }); saveAppSettings({ clipboardWatch: enabled }); }
    catch (cause) { settingsError = cause instanceof Error ? cause.message : String(cause); }
    finally { settingsBusy = ''; }
  }

  async function loadRemoteModels(): Promise<void> {
    modelListLoading = true; aiTestStatus = 'idle'; aiTestMessage = '';
    try {
      modelList = await fetchAiModels(aiDraft);
      aiTestStatus = 'success';
      aiTestMessage = modelList.length ? `已拉取 ${modelList.length} 个模型` : '连接成功，列表为空';
      if (!aiDraft.model && modelList[0]) aiDraft = { ...aiDraft, model: modelList[0].id };
    } catch (cause) { aiTestStatus = 'error'; aiTestMessage = cause instanceof Error ? cause.message : String(cause); }
    finally { modelListLoading = false; }
  }

  async function testConnection(): Promise<void> {
    aiTestStatus = 'testing'; aiTestMessage = '';
    try { aiTestMessage = await testAiConnection(aiDraft); modelList = await fetchAiModels(aiDraft); aiTestStatus = 'success'; }
    catch (cause) { aiTestMessage = cause instanceof Error ? cause.message : String(cause); aiTestStatus = 'error'; }
  }

  function saveAiSettings(): void {
    const profile: AiProfile = { ...aiDraft, name: aiDraft.name.trim() || aiDraft.model.trim() || '未命名模型', endpoint: aiDraft.endpoint.trim().replace(/\/$/, ''), model: aiDraft.model.trim() };
    const exists = aiStore.profiles.some((item) => item.id === profile.id);
    const profiles = exists ? aiStore.profiles.map((item) => item.id === profile.id ? profile : item) : [...aiStore.profiles, profile];
    aiStore = { profiles, activeId: profile.id };
    saveProfileSecret(profile); // API Key 写入系统钥匙串，localStorage 只存非敏感字段
    saveAiProfileStore(aiStore); settingsNotice = ''; aiDraft = { ...profile };
    aiTestMessage = '配置已保存'; aiTestStatus = 'success';
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
    for (const clipItem of clipItems.slice(0, 5)) {
      items.push({
        id: 'clip:' + clipItem.id,
        group: '剪贴板',
        label: clipPreview(clipItem.text),
        hint: '填入当前工具 · ' + clipTimeLabel(clipItem.ts),
        icon: UI_ICONS.copy,
        run: () => { changeInput(clipItem.text); },
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

  /* ── 剪贴板全局浮层（Ctrl+Shift+V） ── */
  function openClipOverlay(): void {
    paletteOpen = false;
    clipOverlayOpen = true;
    clipOverlayQuery = '';
    clipOverlayIndex = 0;
    requestAnimationFrame(() => clipElement?.focus());
  }

  function closeClipOverlay(): void {
    clipOverlayOpen = false;
  }



  function clipPreview(text: string): string {
    return text.split(/\r?\n/)[0].trim() || '(空内容)';
  }

  function clipTimeLabel(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
    const date = new Date(ts);
    return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function useClipItem(item: ClipItem): void {
    closeClipOverlay();
    if (item.kind === 'image' || !item.text) return; // 图片项只能从剪贴板面板复制
    changeInput(item.text);
  }

  function handleClipKeys(event: KeyboardEvent): void {
    const count = clipFiltered.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); clipOverlayIndex = Math.min(clipOverlayIndex + 1, Math.max(0, count - 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); clipOverlayIndex = Math.max(clipOverlayIndex - 1, 0); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = clipFiltered[clipOverlayIndex] ?? clipFiltered[0];
      if (item) useClipItem(item);
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); closeClipOverlay(); }
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
    if (event.key === 'Escape' && clipOverlayOpen) {
      closeClipOverlay();
      return;
    }
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
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && key === 'v') {
      event.preventDefault();
      if (clipOverlayOpen) { closeClipOverlay(); } else { openClipOverlay(); }
      return;
    }
    if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && key === 'k') {
      event.preventDefault();
      clipOverlayOpen = false;
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
<svelte:window onkeydown={handleWindowKeydown} ondragover={handleFileDragOver} ondragleave={handleFileDragLeave} ondrop={handleFileDrop} />

<div class:light={lightMode} class:aurora={auroraMode} class:forest={forestMode} class="app" style={`--app-font-size: ${appSettings.fontSize}px; --app-font-family: ${FONT_STACKS[appSettings.fontFamily] ?? FONT_STACKS['系统默认']}`}>
  <header class="app-bar">
    <button class="brand" onclick={() => (sidebarOpen = !sidebarOpen)} aria-label="Spurh" title="Spurh 工具箱">
      <span class="brand-mark">{@html BRAND_MARK}</span>
    </button>
    <div class="dispatcher">
        <span class="dispatcher-spark">{@html UI_ICONS.sparkle}</span>
        <input bind:this={dispatcherElement} bind:value={dispatcherInput} oninput={(event) => handleDispatcherInput(event.currentTarget.value)} onpaste={handleDispatcherPaste} onkeydown={handleDispatcherKeys} onfocus={() => (dispatcherOpen = true)} onblur={() => (dispatcherOpen = false)} placeholder="粘贴内容，Spurh 自动路由到正确工具…" />
        {#if dispatcherOpen}
          <div class="dispatch-matches" role="listbox" aria-label="工具候选列表" tabindex="-1" onmousedown={(event) => { if (!(event.target as HTMLElement).closest('button')) dispatcherElement?.blur(); }}>
            {#if dispatcherInput.trim()}
              <div class="dispatch-header">
                <span><i></i>智能路由引擎</span>
                <small>{dispatcherCandidates.length} 个候选 · 内容识别 + 工具搜索</small>
              </div>
              {#if dispatcherCandidates.length === 0}
                <div class="dispatch-empty">没有匹配的工具或内容 — 继续输入，或按 Esc 关闭</div>
              {:else}
                {#each dispatcherCandidates as item, i}
                  <button class:active={dispatchIndex === i} title={item.reason || item.plugin.description} onmousedown={(event) => event.preventDefault()} onclick={() => routeContent(dispatcherInput.trim(), i)}>
                    <span class="match-icon">{@html iconHtml(item.plugin.icon)}</span>
                    <span class="match-main">
                      <b>{item.plugin.name}</b>
                      <small>{item.reason || item.plugin.description}</small>
                    </span>
                    {#if item.confidence !== null}
                      <span class="match-score"><i class="match-bar" style={`width:${Math.round(item.confidence * 100)}%`}></i><em>{Math.round(item.confidence * 100)}%</em></span>
                    {/if}
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
                  {#each ['JSON 格式化', 'Unix 时间戳', 'Base64 编解码', 'SQL 美化', '日志解析', '正则测试', '密码生成', 'UUID', 'Cron 表达式', '哈希 / HMAC', 'URL 编解码', '端口探测'] as cap}<span class="idle-chip">{cap}</span>{/each}
                </div>
                <div class="idle-hint"><span><kbd>↑</kbd><kbd>↓</kbd> 选择候选</span><span><kbd>↵</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div>
              </div>
            {/if}
          </div>
        {/if}
        <kbd>{dispatchHotkeyLabel}</kbd>
    </div>
    <div class="app-actions">
      {#if aiStore.profiles.length}
        <label class="model-switcher" title="切换 AI 模型">
          <select value={aiStore.activeId} onchange={(event) => switchAiProfile(event.currentTarget.value)}>
            {#each aiStore.profiles as profile}<option value={profile.id}>{profile.model || profile.name}</option>{/each}
          </select>
          {#if anyAiProcessing}<span class="ai-spin" title="AI 处理中"></span>{/if}
        </label>
      {/if}
      {#if fullscreenSupported}
        <button class="settings-button" onclick={toggleFullscreen} title={isFullscreen ? '退出全屏' : '全屏显示'}>
          <span>{@html isFullscreen ? UI_ICONS.shrink : UI_ICONS.expand}</span>{isFullscreen ? '退出全屏' : '全屏'}
        </button>
      {/if}
      <button class:configured={isAiConfigured(aiConfig)} class="settings-button" onclick={() => openSettings()}><span>{@html UI_ICONS.settings}</span>设置</button>
    </div>
  </header>

  <div class:sidebar-hidden={!sidebarOpen} class="app-body">
    <aside class="sidebar">
      <div class="side-heading"><small>{visiblePlugins.length} 个工具</small><button class="side-manage" title="管理工具显示与隐藏" onclick={() => openSettings('tools')}>{@html UI_ICONS.sliders}<span>显示/隐藏</span></button></div>
      <label class="tool-search"><span>{@html UI_ICONS.search}</span><input bind:value={toolSearch} placeholder="搜索" /></label>
      <div class="category-tabs">
        {#each categories as item}<button class:active={category === item} onclick={() => (category = item)}>{item}</button>{/each}
      </div>
      <nav class="tool-list">
        {#each visiblePlugins as plugin}
          {@const realIndex = plugins.indexOf(plugin)}
          <button class:active={activePluginId === plugin.id} onclick={() => selectPlugin(plugin.id)}>
            <span class="tool-icon">{@html iconHtml(plugin.icon)}</span><span class="tool-name"><b>{plugin.name}</b><small>{plugin.description}</small></span>
            {#if realIndex >= 0 && realIndex < 9}
              {@const binding = appSettings.toolHotkeys[String(realIndex)] ?? `alt+${realIndex + 1}`}
              {#if appSettings.sidebarShortcuts && binding && binding !== 'off' && binding !== ''}<kbd class="tool-kbd">{formatHotkey(binding)}</kbd>{/if}
            {/if}
          </button>
        {/each}
      </nav>
    </aside>

    <main class="workspace">
      {#if activePluginId === 'spurh.network' || activePluginId === 'spurh.log' || activePluginId === 'spurh.clipboard' || activePluginId === 'spurh.remote' || activePluginId === 'spurh.sql'}
        {#if !isTauri && activePluginId !== 'spurh.log' && activePluginId !== 'spurh.network'}
          <div class="browser-note"><span>{@html UI_ICONS.info}</span>浏览器预览模式:{activePlugin.name} 需要桌面能力,请运行 <code>npm run tauri dev</code> 获得完整功能</div>
        {/if}
        {#if lazyPanel}
          {@const Panel = lazyPanel}
          <Panel {...lazyPanelProps} />
        {:else}
          <div class="panel-loading"><span class="spinner"></span>正在加载工具…</div>
        {/if}
      {:else}
        <div class="tool-controls">
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
            {#if inputLanguage === 'json'}<pre class="input-hl" bind:this={inputHighlightElement} aria-hidden="true">{@html highlightCode(activeSession.input, 'json')}</pre>{/if}
            <textarea bind:this={inputElement} value={activeSession.input} oninput={handleInputChange} onkeydown={handleInputKeys} onscroll={syncInputScroll} spellcheck="false" placeholder="输入或粘贴内容…"></textarea>
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
                <pre class="result-raw">{currentSessionResult()!.output}</pre>
              {:else}
                <ResultView result={currentSessionResult()!} />
              {/if}
            {:else}
              <div class="output-empty"><span class="tool-icon large">{@html iconHtml(activePlugin.icon)}</span><b>等待输入</b><p>输入内容后自动处理</p></div>
            {/if}
          </div>
        </section>
      </div>
      {/if}

      {#if currentSessionResult()?.meta}
        <div class="result-meta">{#each Object.entries(currentSessionResult()!.meta!) as [key, value]}<span><small>{key}</small><b>{value}</b></span>{/each}</div>
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
                  <small>{item.hint}</small>
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

  {#if clipOverlayOpen}
    <div class="palette-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) closeClipOverlay(); }}>
      <div class="clip-overlay" role="dialog" aria-modal="true" aria-label="剪贴板历史">
        <div class="palette-search">
          <span class="palette-spark">{@html UI_ICONS.copy}</span>
          <input bind:this={clipElement} bind:value={clipOverlayQuery} onkeydown={handleClipKeys} placeholder="搜索剪贴板历史… Ctrl+Shift+V 唤起" spellcheck="false" />
          <kbd>ESC</kbd>
        </div>
        <div class="clip-overlay-results">
          {#if clipFiltered.length > 0}
            {#each clipFiltered.slice(0, 20) as item, i}
              <button class:active={i === clipOverlayIndex} onmousedown={(event) => event.preventDefault()} onclick={() => useClipItem(item)} title="点击填入当前工具输入区">
                <span class="clip-overlay-icon">{@html UI_ICONS.copy}</span>
                <code>{clipPreview(item.text)}</code>
                <small>{item.text.length} 字符 · {clipTimeLabel(item.ts)}</small>
                {#if i === clipOverlayIndex}<i>↵</i>{/if}
              </button>
            {/each}
          {:else}
            <div class="palette-empty">{clipItems.length === 0 ? '剪贴板历史为空，复制任意文本后会自动记录' : '没有匹配「' + clipOverlayQuery + '」的内容'}</div>
          {/if}
        </div>
        <footer class="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
          <span><kbd>↵</kbd> 填入当前工具</span>
          <span><kbd>ESC</kbd> 关闭</span>
        </footer>
      </div>
    </div>
  {/if}

  {#if settingsOpen}
    <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) settingsOpen = false; }}>
      <div class="settings-modal" role="dialog" aria-modal="true">
        <header class="settings-header"><div class="modal-icon">{@html UI_ICONS.settings}</div><div><h2>设置</h2><p>外观、系统、AI 与快捷键</p></div><button onclick={() => (settingsOpen = false)} aria-label="关闭">{@html UI_ICONS.close}</button></header>
        <div class="settings-layout">
          <nav class="settings-nav">
            <button class:active={settingsTab === 'general'} onclick={() => (settingsTab = 'general')}><span>{@html UI_ICONS.sliders}</span><div><b>通用</b><small>主题 · 启动 · 托盘</small></div></button>
            <button class:active={settingsTab === 'ai'} onclick={() => (settingsTab = 'ai')}><span>{@html UI_ICONS.sparkle}</span><div><b>AI 模型</b><small>服务商配置</small></div></button>
            <button class:active={settingsTab === 'shortcuts'} onclick={() => (settingsTab = 'shortcuts')}><span>{@html UI_ICONS.keyboard}</span><div><b>快捷键</b><small>全局绑定</small></div></button>
            <button class:active={settingsTab === 'tools'} onclick={() => (settingsTab = 'tools')}><span>{@html UI_ICONS.grid}</span><div><b>工具</b><small>显示与隐藏</small></div></button>
            <button class:active={settingsTab === 'about'} onclick={() => (settingsTab = 'about')}><span>{@html UI_ICONS.info}</span><div><b>关于</b><small>版本信息</small></div></button>
          </nav>
          <section class="settings-content">
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
              <label class="setting-row"><div class="setting-copy"><b>系统右键菜单</b><small>在资源管理器中“用 Spurh 打开”</small></div><input type="checkbox" checked={contextMenuEnabled} disabled={settingsBusy === 'contextMenu'} onchange={(event) => changeContextMenu(event.currentTarget.checked)} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>剪贴板历史</b><small>自动记录复制的文本（含密码等敏感内容，注意隐私）</small></div><input type="checkbox" checked={appSettings.clipboardWatch} disabled={settingsBusy === 'clipboard'} onchange={(event) => changeClipboardWatch(event.currentTarget.checked)} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>菜单栏显示快捷键</b><small>在左侧工具列表显示 Alt+1..9 快捷提示（默认隐藏）</small></div><input type="checkbox" checked={appSettings.sidebarShortcuts} onchange={(event) => saveAppSettings({ sidebarShortcuts: event.currentTarget.checked })} /><i></i></label>
              {#if settingsError}<div class="settings-error">{settingsError}</div>{/if}
            {/if}
            {#if settingsTab === 'tools'}
              <div class="settings-section-title model-title"><div><h3>工具显示</h3><small>默认全部显示，关闭后从侧栏、聚焦框与命令面板中隐藏</small></div><div class="visibility-actions"><button onclick={() => saveAppSettings({ hiddenTools: [] })}>全部显示</button><button onclick={() => saveAppSettings({ hiddenTools: plugins.map((plugin) => plugin.id) })}>全部隐藏</button></div></div>
              <div class="tool-visibility-grid">
                {#each plugins as plugin}
                  {@const hidden = appSettings.hiddenTools.includes(plugin.id)}
                  <label class="setting-row compact" class:off={hidden} title={plugin.description}>
                    <span class="tool-icon small">{@html iconHtml(plugin.icon)}</span>
                    <span class="visibility-copy"><b>{plugin.name}</b><small>{plugin.category}</small></span>
                    <input type="checkbox" checked={!hidden} onchange={(event) => { const next = event.currentTarget.checked ? appSettings.hiddenTools.filter((id) => id !== plugin.id) : [...appSettings.hiddenTools, plugin.id]; saveAppSettings({ hiddenTools: next }); }} /><i></i>
                  </label>
                {/each}
              </div>
            {/if}
            {#if settingsTab === 'ai'}
              <div class="settings-section-title model-title"><div><h3>AI 模型</h3></div><button onclick={addAiProfile}><span>{@html UI_ICONS.plus}</span>添加</button></div>
              {#if settingsNotice}<div class="settings-notice"><span>{@html UI_ICONS.info}</span>{settingsNotice}</div>{/if}
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
                  {#if modelList.length > 0}
                    <select bind:value={aiDraft.model}><option value="">-- 选择 --</option>{#each modelList as model}<option value={model.id}>{model.id}</option>{/each}</select>
                  {:else}
                    <input list="rm" bind:value={aiDraft.model} placeholder="输入或拉取" /><datalist id="rm">{#each modelList as m}<option value={m.id}>{m.id}</option>{/each}</datalist>
                  {/if}
                  <button disabled={modelListLoading || !aiDraft.endpoint} onclick={loadRemoteModels}><span>{@html UI_ICONS.refresh}</span>{modelListLoading ? '拉取中…' : '拉取模型'}</button>
                </div></label>
                <label><span>密钥</span><input type="password" bind:value={aiDraft.apiKey} placeholder={aiDraft.provider === 'ollama' ? '可留空' : 'sk-…'} autocomplete="off" /></label>
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
                    <span class="shortcut-name"><b>{plugin.name}</b><small>{enabled ? `当前：${formatHotkey(binding)}` : '未分配快捷键'}</small></span>
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
                  <span class="shortcut-name"><b>聚焦搜索框</b><small>{dispatchHotkey !== 'off' ? `当前：${formatHotkey(dispatchHotkey)}` : '未分配快捷键'}</small></span>
                  <button class="hk-record" class:recording={recordingDispatch} onclick={() => (recordingDispatch ? cancelRecord() : startRecordDispatch())} title="点击后按下新组合键">
                    {recordingDispatch ? '按下组合键…' : dispatchHotkey !== 'off' ? formatHotkey(dispatchHotkey) : '未分配'}
                  </button>
                  <label class="hk-switch" title={dispatchHotkey !== 'off' ? '禁用此快捷键' : '启用此快捷键'}>
                    <input type="checkbox" checked={dispatchHotkey !== 'off'} onchange={(event) => saveDispatchHotkey(event.currentTarget.checked ? 'ctrl+shift+space' : 'off')} />
                    <i></i>
                  </label>
                </div>
              </div>
              <div class="shortcuts-note">快捷键在系统全局生效，即使 Spurh 在后台也能唤起。Ctrl+Shift+Space 固定用于显示窗口，不可修改。</div>
            {/if}
            {#if settingsTab === 'about'}
              <div class="about-hero"><span class="brand-mark large">{@html BRAND_MARK}</span><div><h3>Spurh</h3><p>AI Native Developer Toolbox</p></div><b>v0.1.0</b></div>
              <div class="about-grid"><article><small>作者</small><b>xuning</b></article><article><small>版本</small><b>0.1.0</b></article><article><small>技术栈</small><b>Svelte 5 · Tauri 2</b></article><article><small>许可</small><b>MIT</b></article></div>
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