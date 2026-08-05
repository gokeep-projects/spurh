<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { onMount } from 'svelte';
  import { AI_PRESETS, createAiProfile, fetchAiModels, isAiConfigured, loadAiProfileStore, processWithAi, saveAiProfileStore, testAiConnection, type AiModel, type AiProfile } from './lib/ai';
  import { PROVIDER_NAMES, providerIcon } from './lib/providerIcons';
  import { BRAND_MARK, TOOL_ICONS, UI_ICONS, iconHtml } from './lib/icons';
  import { highlightCode } from './lib/highlight';
  import ResultView from './lib/components/ResultView.svelte';
  import CronPanel from './lib/panels/CronPanel.svelte';
  import CryptoPanel from './lib/panels/CryptoPanel.svelte';
  import RegexPanel from './lib/panels/RegexPanel.svelte';
  import SqlPanel from './lib/panels/SqlPanel.svelte';
  import NetworkPanel from './lib/panels/NetworkPanel.svelte';
  import ClipboardPanel from './lib/panels/ClipboardPanel.svelte';
  import RemotePanel from './lib/panels/RemotePanel.svelte';
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

  type ThemeMode = 'light' | 'dark' | 'system';
  type SettingsTab = 'general' | 'ai' | 'about' | 'shortcuts';

  type AppSettings = {
    theme: ThemeMode;
    trayEnabled: boolean;
    contextMenuEnabled: boolean;
    clipboardWatch: boolean;
    dispatchHotkey: string;
    toolHotkeys: Record<string, string>;
  };

  type ContextInfo = { path: string; content: string };
  type ClipItem = { id: string; text: string; ts: number };

  type PaletteItem = { id: string; group: string; label: string; hint: string; icon: string; run: () => void };

  const SETTINGS_KEY = 'spurh.settings.v1';

  function loadAppSettings(): AppSettings {
    const fallback: AppSettings = {
      theme: 'light', trayEnabled: true, contextMenuEnabled: true, clipboardWatch: true, dispatchHotkey: 'ctrl+shift+space',
      toolHotkeys: { '0': 'alt+1', '1': 'alt+2', '2': 'alt+3', '3': 'alt+4', '4': 'alt+5', '5': 'alt+6', '6': 'alt+7', '7': 'alt+8' },
    };
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      return stored ? { ...fallback, ...JSON.parse(stored) } : fallback;
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

  let sessions: Record<string, ToolSession> = Object.fromEntries(plugins.map((plugin) => [plugin.id, makeSession(plugin)]));
  let activePluginId = 'spurh.json';
  let dispatcherInput = '';
  let dispatcherElement: HTMLInputElement | undefined;
  let inputElement: HTMLTextAreaElement;
  let streamScrollElement: HTMLDivElement;
  let toolSearch = '';
  let category: (typeof categories)[number] = '全部';
  let copied = false;
  let appSettings = loadAppSettings();
  let lightMode = true;
  let sidebarOpen = true;
  let aiStore = loadAiProfileStore();
  let aiConfig: AiProfile | undefined;
  let aiDraft: AiProfile = aiStore.profiles.find((profile) => profile.id === aiStore.activeId) ?? createAiProfile();
  let settingsOpen = false;
  let settingsTab: SettingsTab = 'general';
  let settingsNotice = '';
  let autostartEnabled = false;
  let settingsBusy = '';
  let settingsError = '';
  let hotkeyError = '';
  let modelList: AiModel[] = [];
  let modelListLoading = false;
  let aiTestStatus: 'idle' | 'testing' | 'success' | 'error' = 'idle';
  let aiTestMessage = '';
  let contextMenuEnabled = appSettings.contextMenuEnabled;
  let clipboardWatchEnabled = appSettings.clipboardWatch;
  let lastClipboardContent = '';
  let openFileContext: ContextInfo | null = null;
  let dispatchIndex = 0;
  let dispatchHotkey = appSettings.dispatchHotkey || 'ctrl+shift+space';
  let clipboardTimer: ReturnType<typeof setInterval> | null = null;
  let recordingTool: number | null = null;
  let recordingDispatch = false;
  let paletteOpen = false;
  let paletteQuery = '';
  let paletteIndex = 0;
  let paletteElement: HTMLInputElement | undefined;
  let clipItems: ClipItem[] = [];
  let clipOverlayOpen = false;
  let clipOverlayQuery = '';
  let clipOverlayIndex = 0;
  let clipElement: HTMLInputElement | undefined;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  $: activePlugin = plugins.find((plugin) => plugin.id === activePluginId)!;
  $: activeSession = sessions[activePluginId];
  $: visibleResult = activeSession.aiResult ?? activeSession.result;
  $: dispatch = runtime.dispatch(dispatcherInput);
  $: matchedPlugins = dispatcherInput ? dispatch.alternatives.slice(0, 5) : [];
  $: visiblePlugins = plugins.filter((plugin) =>
    (category === '全部' || plugin.category === category)
    && `${plugin.name} ${plugin.description}`.toLowerCase().includes(toolSearch.toLowerCase()),
  );
  $: aiConfig = aiStore.profiles.find((profile) => profile.id === aiStore.activeId);
  $: lightMode = appSettings.theme === 'light'
    || (appSettings.theme === 'system' && !window.matchMedia('(prefers-color-scheme: dark)').matches);
  $: anyAiProcessing = plugins.some((p) => sessions[p.id].aiProcessing);
  $: dispatchHotkeyLabel = formatHotkey(dispatchHotkey);
  $: paletteItems = buildPaletteItems();
  $: paletteFiltered = paletteQuery
    ? paletteItems.filter((item) => (item.label + ' ' + item.hint + ' ' + item.group).toLowerCase().includes(paletteQuery.toLowerCase()))
    : paletteItems;
  $: paletteGroups = (() => {
    const groups: Array<{ group: string; items: PaletteItem[] }> = [];
    for (const item of paletteFiltered) {
      const last = groups[groups.length - 1];
      if (last && last.group === item.group) last.items.push(item);
      else groups.push({ group: item.group, items: [item] });
    }
    return groups;
  })();
  $: paletteFlat = paletteFiltered;
  $: if (paletteIndex > paletteFlat.length - 1) paletteIndex = Math.max(0, paletteFlat.length - 1);
  $: clipFiltered = clipOverlayQuery ? clipItems.filter((item) => item.text.toLowerCase().includes(clipOverlayQuery.toLowerCase())) : clipItems;
  $: if (clipOverlayIndex > Math.max(0, clipFiltered.length - 1)) clipOverlayIndex = Math.max(0, clipFiltered.length - 1);

  async function applyHotkeys(): Promise<void> {
    const tools = plugins.slice(0, 9).map((_, i) => appSettings.toolHotkeys[String(i)] ?? `alt+${i + 1}`);
    try {
      const results = await invoke<Array<{ key: string; ok: boolean; error?: string | null }>>('apply_hotkeys', { dispatch: dispatchHotkey, tools });
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
    const unlistenPromise = listen<{ kind: string; index?: number }>('spurh:hotkey', (event) => {
      if (event.payload.kind === 'tool' && typeof event.payload.index === 'number') {
        const plugin = plugins[event.payload.index];
        if (plugin) selectPlugin(plugin.id);
      } else if (event.payload.kind === 'dispatch') {
        requestAnimationFrame(() => dispatcherElement?.focus());
      }
    });

    invoke<{ path: string; isDir: boolean } | null>('take_pending_open').then(async (target) => {
      if (!target) return;
      if (target.isDir) {
        openFileContext = { path: target.path, content: '' };
        return;
      }
      try {
        const content = await invoke<string>('open_file', { path: target.path });
        openFileContext = { path: target.path, content };
        handleClipboardDispatch(content);
      } catch {
        openFileContext = { path: target.path, content: '' };
      }
    }).catch(() => undefined);

    setTimeout(() => scheduleProcess('spurh.json', 200), 100);
    const systemTimer = setTimeout(() => {
      invoke<boolean>('get_autostart').then((enabled) => (autostartEnabled = enabled)).catch(() => undefined);
      invoke<boolean>('get_context_menu_enabled').then((enabled) => (contextMenuEnabled = enabled)).catch(() => undefined);
      invoke('set_tray_enabled', { enabled: appSettings.trayEnabled }).catch(() => undefined);
    }, 800);
    // 剪贴板历史：初始快照 + 实时事件
    invoke<ClipItem[]>('clipboard_history').then((snapshot) => { clipItems = snapshot; }).catch(() => undefined);
    const clipUnlisten1 = listen<ClipItem[]>('clipboard:history', (event) => { clipItems = event.payload; });
    const clipUnlisten2 = listen<ClipItem>('clipboard:item', (event) => {
      clipItems = [event.payload, ...clipItems.filter((item) => item.id !== event.payload.id)].slice(0, 100);
    });
    // 仅在窗口失焦时轮询剪贴板：后台复制内容自动识别，前台不空转
    clipboardTimer = setInterval(async () => {
      if (!clipboardWatchEnabled || settingsOpen || document.hasFocus()) return;
      try {
        const text = await invoke<string>('read_clipboard');
        if (text && text !== lastClipboardContent && text.trim().length > 2) {
          lastClipboardContent = text;
          handleClipboardDispatch(text);
        }
      } catch { /* clipboard empty */ }
    }, 3000);
    return () => {
      clearTimeout(systemTimer);
      if (clipboardTimer) clearInterval(clipboardTimer);
      unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
      clipUnlisten1.then((fn) => fn()).catch(() => undefined);
      clipUnlisten2.then((fn) => fn()).catch(() => undefined);
    };
  });

  function handleClipboardDispatch(text: string): void {
    const match = runtime.dispatch(text).selected;
    if (match && match.confidence >= 0.4) {
      activePluginId = match.plugin.id;
      patchSession(match.plugin.id, { input: text });
      scheduleProcess(match.plugin.id, 0);
    }
  }

  function patchSession(pluginId: string, patch: Partial<ToolSession>): void {
    sessions = { ...sessions, [pluginId]: { ...sessions[pluginId], ...patch } };
  }

  function hasProcessableInput(pluginId: string, session: ToolSession): boolean {
    if (pluginId === 'spurh.network' || pluginId === 'spurh.clipboard' || pluginId === 'spurh.remote') return false;
    if (session.input.length > 0) return true;
    if (pluginId === 'spurh.timestamp' && session.actionId === 'now') return true;
    if (pluginId === 'spurh.random') return true;
    if (pluginId === 'spurh.cron' && session.actionId === 'generate') return true;
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
      return;
    }

    const revision = session.revision + 1;
    patchSession(pluginId, { processing: true, error: '', revision });
    try {
      const result = await runtime.execute(pluginId, session.actionId, session.input, session.options);
      if (sessions[pluginId].revision === revision) patchSession(pluginId, { result, processing: false });
    } catch (cause) {
      if (sessions[pluginId].revision === revision) {
        patchSession(pluginId, { result: null, processing: false, error: cause instanceof Error ? cause.message : '处理失败' });
      }
    }
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
  $: inputLanguage = activePluginId === 'spurh.json' ? 'json' : 'text';
  let inputHighlightElement: HTMLPreElement;

  function handleInputChange(event: Event): void {
    changeInput((event.currentTarget as HTMLTextAreaElement).value);
  }

  /** Tab 键插入缩进而不是移出焦点 */
  function handleInputKeys(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.ctrlKey && activePluginId === 'spurh.sql') {
      event.preventDefault();
      runSql();
      return;
    }
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const target = event.currentTarget as HTMLTextAreaElement;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    changeInput(target.value.slice(0, start) + '  ' + target.value.slice(end));
    // 受控组件更新后恢复光标位置
    requestAnimationFrame(() => {
      target.selectionStart = target.selectionEnd = start + 2;
    });
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

  function changeAction(actionId: string): void {
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

  function routeToPlugin(pluginId: string, content: string): void {
    activePluginId = pluginId;
    patchSession(pluginId, { input: content, aiResult: null, aiError: '' });
    dispatcherInput = '';
    dispatchIndex = 0;
    liveSyncedContent = '';
    scheduleProcess(pluginId, 0);
    queueMicrotask(() => inputElement?.focus());
  }

  /** dispatcher 输入实时路由：高置信度匹配直接更新右侧输出，不清空输入框 */
  let liveSyncedContent = '';
  function routeLive(pluginId: string, content: string): void {
    const trimmed = content.trim();
    liveSyncedContent = trimmed;
    activePluginId = pluginId;
    patchSession(pluginId, { input: trimmed, aiResult: null, aiError: '' });
    scheduleProcess(pluginId, 0);
  }

  /** 顶部输入框内容变化：高置信度实时路由，低置信度保留下拉等待回车确认 */
  let dispatcherOpen = false;

  function handleDispatcherInput(value: string): void {
    dispatcherInput = value;
    dispatchIndex = 0;
    if (!value.trim()) return;
    const match = runtime.dispatch(value).selected;
    if (match && match.confidence >= 0.4) {
      routeLive(match.plugin.id, value);
    }
  }

  function routeContent(content = dispatcherInput, pluginIndex = 0): void {
    const dispatchResult = runtime.dispatch(content);
    const matches = [dispatchResult.selected, ...dispatchResult.alternatives].filter(Boolean) as NonNullable<typeof dispatchResult.selected>[];
    const match = matches[pluginIndex];
    if (match) {
      routeToPlugin(match.plugin.id, content);
    } else {
      const plugin = plugins[pluginIndex] ?? plugins[0];
      if (plugin) routeToPlugin(plugin.id, content);
    }
  }

  function handleDispatcherPaste(event: ClipboardEvent): void {
    const content = event.clipboardData?.getData('text') ?? '';
    if (!content.trim()) return;
    const match = runtime.dispatch(content).selected;
    if (!match) return;
    event.preventDefault();
    dispatcherInput = content;
    lastClipboardContent = content;
    if (match.confidence >= 0.3) {
      queueMicrotask(() => routeContent(content));
    }
  }

  function handleDispatcherKeys(event: KeyboardEvent): void {
    // 下拉行数：有匹配时为首项 selected + alternatives，未匹配时为全部工具
    const max = dispatch.selected || matchedPlugins.length > 0 ? matchedPlugins.length : plugins.length - 1;
    if (event.key === 'ArrowDown') { event.preventDefault(); dispatchIndex = Math.min(dispatchIndex + 1, max); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); dispatchIndex = Math.max(dispatchIndex - 1, 0); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const content = dispatcherInput.trim();
      if (!content) return;
      if (dispatch.selected || matchedPlugins.length > 0) {
        // 内容已被实时路由且未在工具区被修改：只清空输入框，避免旧文本覆盖新编辑
        if (content === liveSyncedContent) {
          dispatcherInput = '';
          dispatchIndex = 0;
        } else {
          routeContent(content, Math.min(dispatchIndex, matchedPlugins.length));
        }
      } else if (plugins[dispatchIndex] && dispatchIndex >= 0) {
        routeToPlugin(plugins[dispatchIndex].id, content);
      } else if (plugins[0]) {
        routeToPlugin(plugins[0].id, content);
      }
      return;
    }
    if (event.key === 'Escape') { dispatcherElement?.blur(); dispatchIndex = 0; }
  }

  async function pasteToTool(): Promise<void> {
    try { changeInput(await navigator.clipboard.readText()); } catch { dispatcherElement?.focus(); }
  }

  async function copyResult(): Promise<void> {
    if (!visibleResult) return;
    await navigator.clipboard.writeText(visibleResult.output);
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

  let deleteConfirming = false;
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
    try { autostartEnabled = await invoke<boolean>('set_autostart', { enabled }); }
    catch (cause) { settingsError = cause instanceof Error ? cause.message : String(cause); }
    finally { settingsBusy = ''; }
  }

  async function changeTray(enabled: boolean): Promise<void> {
    settingsBusy = 'tray'; settingsError = '';
    try { await invoke('set_tray_enabled', { enabled }); saveAppSettings({ trayEnabled: enabled }); }
    catch (cause) { settingsError = cause instanceof Error ? cause.message : String(cause); }
    finally { settingsBusy = ''; }
  }

  async function changeContextMenu(enabled: boolean): Promise<void> {
    settingsBusy = 'contextMenu'; settingsError = '';
    try { await invoke('set_context_menu_enabled', { enabled }); contextMenuEnabled = enabled; saveAppSettings({ contextMenuEnabled: enabled }); }
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
    aiStore = { profiles, activeId: profile.id }; saveAiProfileStore(aiStore); settingsNotice = ''; aiDraft = { ...profile };
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
    onRecordKeydown(event);
    if (recordingTool !== null || recordingDispatch) return;
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
<svelte:window onkeydown={handleWindowKeydown} />

<div class:light={lightMode} class="app">
  <header class="app-bar">
    <button class="brand" onclick={() => (sidebarOpen = !sidebarOpen)} aria-label="侧栏">
      <span class="brand-mark">{@html BRAND_MARK}</span><b>Spurh</b>
    </button>
    <div class="dispatcher">
      <span class="dispatcher-spark">{@html UI_ICONS.sparkle}</span>
      <input bind:this={dispatcherElement} bind:value={dispatcherInput} oninput={(event) => handleDispatcherInput(event.currentTarget.value)} onpaste={handleDispatcherPaste} onkeydown={handleDispatcherKeys} onfocus={() => (dispatcherOpen = true)} onblur={() => (dispatcherOpen = false)} placeholder="粘贴或输入内容，自动识别工具…" />
      {#if dispatcherOpen && dispatcherInput && (dispatch.selected || matchedPlugins.length > 0)}
        <div class="dispatch-matches">
          {#each [dispatch.selected!, ...matchedPlugins].filter(Boolean).slice(0, 6) as match, i}
            {#if match}
              <button class:active={dispatchIndex === i} title={match.reason} onmousedown={(event) => event.preventDefault()} onclick={() => routeContent(dispatcherInput, i)}>
                <span class="match-icon">{@html iconHtml(match.plugin.icon)}</span><b>{match.plugin.name}</b><small>{Math.round(match.confidence * 100)}%</small>
                {#if dispatchIndex === i}<i>↵</i>{/if}
              </button>
            {/if}
          {/each}
        </div>
      {:else if dispatcherOpen && dispatcherInput}
        <div class="dispatch-matches">
          <div class="dispatch-header">未匹配 — 选择工具：</div>
          {#each plugins as plugin, i}
            <button class:active={i === dispatchIndex} onmousedown={(event) => event.preventDefault()} onclick={() => routeToPlugin(plugin.id, dispatcherInput)}>
              <span class="match-icon">{@html iconHtml(plugin.icon)}</span><b>{plugin.name}</b>{#if i === dispatchIndex}<i>↵</i>{/if}
            </button>
          {/each}
        </div>
      {/if}
      <kbd>{dispatchHotkeyLabel}</kbd>
    </div>
    <div class="app-actions">
      {#if aiStore.profiles.length}
        <label class="model-switcher" title="切换 AI 模型">
          <span class="provider-logo">{@html providerIcon(aiConfig?.provider)}</span>
          <select value={aiStore.activeId} onchange={(event) => switchAiProfile(event.currentTarget.value)}>
            {#each aiStore.profiles as profile}<option value={profile.id}>{profile.name} · {profile.model}</option>{/each}
          </select>
          {#if anyAiProcessing}<span class="ai-spin" title="AI 处理中"></span>{/if}
        </label>
      {/if}
      <button class:configured={isAiConfigured(aiConfig)} class="settings-button" onclick={() => openSettings()}><span>{@html UI_ICONS.settings}</span>设置</button>
    </div>
  </header>

  <div class:sidebar-hidden={!sidebarOpen} class="app-body">
    <aside class="sidebar">
      <div class="side-heading"><span>工具</span></div>
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
              {@const binding = appSettings.toolHotkeys[String(realIndex)]}
              {#if binding && binding !== 'off' && binding !== ''}<kbd class="tool-kbd">{formatHotkey(binding)}</kbd>{/if}
            {/if}
          </button>
        {/each}
      </nav>
    </aside>

    <main class="workspace">
      <div class="tool-header">
        <div class="tool-identity">
          <span class="tool-icon large">{@html iconHtml(activePlugin.icon)}</span>
          <div><div><h1>{activePlugin.name}</h1><em>{activePlugin.category}</em></div><p>{activePlugin.description}</p></div>
        </div>
        <div class="auto-state" class:error={Boolean(activeSession.error)}>
          {#if activeSession.processing}<span class="spinner"></span>处理中
          {:else if activeSession.error}<i></i>错误
          {:else if activeSession.result}<i></i>完成
          {:else}<i></i>就绪{/if}
        </div>
      </div>

      {#if activePluginId === 'spurh.network'}
        <NetworkPanel />
      {:else if activePluginId === 'spurh.clipboard'}
        <ClipboardPanel onChangeInput={changeInput} />
      {:else if activePluginId === 'spurh.remote'}
        <RemotePanel />
      {:else if activePluginId === 'spurh.sql'}
        <SqlPanel />
      {:else}
        <div class="tool-controls">
        {#if activePluginId === 'spurh.cron'}
          <CronPanel session={activeSession} onChangeAction={changeAction} onChangeOption={changeOption} onClear={clearActive} />
        {:else if activePluginId === 'spurh.crypto'}
          <CryptoPanel session={activeSession} onChangeAction={changeAction} onChangeOption={changeOption} onClear={clearActive} />
        {:else if activePluginId === 'spurh.regex'}
          <RegexPanel session={activeSession} onChangeAction={changeAction} onChangeOption={changeOption} onChangeInput={changeInput} onClear={clearActive} aiConfigured={isAiConfigured(aiConfig)} aiBusy={activeSession.aiProcessing} onAiGenerate={aiGenerateRegex} onAiRecommend={aiRecommendRegex} />
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
                    <input type="datetime-local" value={activeSession.options[option.id]} oninput={(event) => changeOption(option.id, event.currentTarget.value)} />
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
        {#if activePluginId !== 'spurh.cron' && activePluginId !== 'spurh.crypto' && activePluginId !== 'spurh.regex'}
          <div class="control-spacer"></div>
        {/if}
        <button class="ai-button" disabled={!activeSession.input.trim() || activeSession.aiProcessing} onclick={runAiProcessing}><span>{@html UI_ICONS.sparkle}</span>{activeSession.aiProcessing ? 'AI 中' : 'AI 处理'}</button>
        <button class="quiet-button" onclick={clearActive}>清空</button>
        </div>
        <div class="editor-grid">
        <section class="editor-pane">
          <header><div><span>输入</span><small>{activeSession.input.length} 字符</small></div><button onclick={pasteToTool}>粘贴</button></header>
          <div class="editor-input" class:hli={inputLanguage === 'json'}>
            {#if inputLanguage === 'json'}<pre class="input-hl" bind:this={inputHighlightElement} aria-hidden="true">{@html highlightCode(activeSession.input, 'json')}</pre>{/if}
            <textarea bind:this={inputElement} value={activeSession.input} oninput={handleInputChange} onkeydown={handleInputKeys} onscroll={syncInputScroll} spellcheck="false" placeholder="输入或粘贴内容…"></textarea>
          </div>
        </section>
        <section class="editor-pane output-pane">
          <header><div><span>结果</span>{#if visibleResult}<small>{visibleResult.summary}</small>{/if}</div>
            <div class="output-actions">
              {#if activeSession.aiResult && activePlugin.id === 'spurh.json' && !activeSession.aiResult.meta?.解析}<button class="apply-ai" onclick={applyAiResult}>应用修复</button>{/if}
              <button disabled={!visibleResult} onclick={copyResult}>{copied ? '已复制 ✓' : '复制'}</button>
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
            {:else if visibleResult}
              <ResultView result={visibleResult} />
            {:else}
              <div class="output-empty"><span class="tool-icon large">{@html iconHtml(activePlugin.icon)}</span><b>等待输入</b><p>输入内容后自动处理</p></div>
            {/if}
          </div>
        </section>
      </div>
      {/if}

      {#if visibleResult?.meta}
        <div class="result-meta">{#each Object.entries(visibleResult.meta) as [key, value]}<span><small>{key}</small><b>{value}</b></span>{/each}</div>
      {/if}
    </main>
  </div>

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
            {#each clipFiltered.slice(0, 12) as item, i}
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
            <button class:active={settingsTab === 'about'} onclick={() => (settingsTab = 'about')}><span>{@html UI_ICONS.info}</span><div><b>关于</b><small>版本信息</small></div></button>
          </nav>
          <section class="settings-content">
            {#if settingsTab === 'general'}
              <div class="settings-section-title"><h3>通用</h3></div>
              <div class="setting-group"><div class="setting-copy"><b>主题</b></div>
                <div class="theme-choice">
                  <button class:active={appSettings.theme === 'light'} onclick={() => saveAppSettings({ theme: 'light' })}>{@html UI_ICONS.sun}<span>明亮</span></button>
                  <button class:active={appSettings.theme === 'dark'} onclick={() => saveAppSettings({ theme: 'dark' })}>{@html UI_ICONS.moon}<span>深色</span></button>
                  <button class:active={appSettings.theme === 'system'} onclick={() => saveAppSettings({ theme: 'system' })}>{@html UI_ICONS.contrast}<span>跟随系统</span></button>
                </div>
              </div>
              <label class="setting-row"><div class="setting-copy"><b>开机启动</b></div><input type="checkbox" checked={autostartEnabled} disabled={settingsBusy === 'autostart'} onchange={(event) => changeAutostart(event.currentTarget.checked)} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>系统托盘</b></div><input type="checkbox" checked={appSettings.trayEnabled} disabled={settingsBusy === 'tray'} onchange={(event) => changeTray(event.currentTarget.checked)} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>剪贴板监听</b><small>后台自动识别复制内容</small></div><input type="checkbox" checked={clipboardWatchEnabled} onchange={(event) => { clipboardWatchEnabled = event.currentTarget.checked; saveAppSettings({ clipboardWatch: clipboardWatchEnabled }); }} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>系统右键菜单</b><small>在资源管理器中“用 Spurh 打开”</small></div><input type="checkbox" checked={contextMenuEnabled} disabled={settingsBusy === 'contextMenu'} onchange={(event) => changeContextMenu(event.currentTarget.checked)} /><i></i></label>
              {#if settingsError}<div class="settings-error">{settingsError}</div>{/if}
            {:else if settingsTab === 'ai'}
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
            {:else if settingsTab === 'shortcuts'}
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
            {:else}
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