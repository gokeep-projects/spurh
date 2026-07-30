<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';
  import { AI_PRESETS, createAiProfile, fetchAiModels, isAiConfigured, loadAiProfileStore, processWithAi, saveAiProfileStore, testAiConnection, type AiModel, type AiProfile } from './lib/ai';
  import ResultView from './lib/components/ResultView.svelte';
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
    dispatchHotkey: string;
    toolHotkeys: Record<string, string>;
  };

  type ContextInfo = { path: string; content: string };

  const SETTINGS_KEY = 'spurh.settings.v1';

  const PROVIDER_LABELS: Record<string, string> = {
    openai: 'O', deepseek: 'D', qwen: 'Q', ollama: 'O', custom: 'C',
  };
  const PROVIDER_COLORS: Record<string, string> = {
    openai: '#10a37f', deepseek: '#4d6bfe', qwen: '#615ced', ollama: '#f0f0f0', custom: '#888',
  };
  const PROVIDER_NAMES: Record<string, string> = {
    openai: 'OpenAI', deepseek: 'DeepSeek', qwen: 'Qwen', ollama: 'Ollama', custom: 'Custom',
  };

  function loadAppSettings(): AppSettings {
    const fallback: AppSettings = {
      theme: 'light', trayEnabled: true, contextMenuEnabled: false, dispatchHotkey: 'k',
      toolHotkeys: { '0': 'alt+1', '1': 'alt+2', '2': 'alt+3', '3': 'alt+4', '4': 'alt+5', '5': 'alt+6', '6': 'alt+7', '7': 'alt+8', '8': 'alt+9' },
    };
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      return stored ? { ...fallback, ...JSON.parse(stored) } : fallback;
    } catch {
      return fallback;
    }
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
  let dispatcherElement: HTMLInputElement;
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
  let modelList: AiModel[] = [];
  let modelListLoading = false;
  let aiTestStatus: 'idle' | 'testing' | 'success' | 'error' = 'idle';
  let aiTestMessage = '';
  let contextMenuEnabled = appSettings.contextMenuEnabled;
  let clipboardWatchEnabled = true;
  let lastClipboardContent = '';
  let openFileContext: ContextInfo | null = null;
  let dispatchIndex = 0;
  let dispatchHotkey = appSettings.dispatchHotkey || 'k';
  let dispatchHotkeyDraft = dispatchHotkey;
  let clipboardTimer: ReturnType<typeof setInterval> | null = null;
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

  onMount(() => {
    (window as any).__spurhOpenFile = (info: ContextInfo) => {
      openFileContext = info;
      handleClipboardDispatch(info.content);
    };

    setTimeout(() => scheduleProcess('spurh.json', 200), 100);
    const systemTimer = setTimeout(() => {
      invoke<boolean>('get_autostart').then((enabled) => (autostartEnabled = enabled)).catch(() => undefined);
      invoke<boolean>('get_context_menu_enabled').then((enabled) => (contextMenuEnabled = enabled)).catch(() => undefined);
      invoke('set_tray_enabled', { enabled: appSettings.trayEnabled }).catch(() => undefined);
    }, 800);
    clipboardTimer = setInterval(async () => {
      if (!clipboardWatchEnabled || settingsOpen) return;
      try {
        const text = await invoke<string>('read_clipboard');
        if (text && text !== lastClipboardContent && text.trim().length > 3) {
          lastClipboardContent = text;
          handleClipboardDispatch(text);
        }
      } catch { /* clipboard empty */ }
    }, 3000);
    return () => {
      clearTimeout(systemTimer);
      if (clipboardTimer) clearInterval(clipboardTimer);
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
    if (hasProcessableInput(pluginId, sessions[pluginId]) && !sessions[pluginId].result && !sessions[pluginId].error) {
      scheduleProcess(pluginId, 0);
    }
  }

  function changeInput(value: string): void {
    patchSession(activePluginId, { input: value, aiResult: null, aiError: '' });
    scheduleProcess(activePluginId);
  }

  function changeAction(actionId: string): void {
    patchSession(activePluginId, { actionId });
    scheduleProcess(activePluginId, 0);
  }

  function changeOption(optionId: string, value: string): void {
    patchSession(activePluginId, { options: { ...activeSession.options, [optionId]: value } });
    if (optionId !== 'aiPrompt') scheduleProcess(activePluginId);
  }

  function routeToPlugin(pluginId: string, content: string): void {
    activePluginId = pluginId;
    patchSession(pluginId, { input: content });
    dispatcherInput = '';
    dispatchIndex = 0;
    scheduleProcess(pluginId, 0);
  }

  function routeContent(content = dispatcherInput, pluginIndex = 0): void {
    const dispatchResult = runtime.dispatch(content);
    const matches = [dispatchResult.selected, ...dispatchResult.alternatives].filter(Boolean) as NonNullable<typeof dispatchResult.selected>[];
    const match = matches[pluginIndex];
    if (match) {
      routeToPlugin(match.plugin.id, content);
    } else {
      const plugin = plugins[pluginIndex];
      if (plugin) routeToPlugin(plugin.id, content);
    }
  }

  function handleDispatcherPaste(event: ClipboardEvent): void {
    const content = event.clipboardData?.getData('text') ?? '';
    const dispatchResult = runtime.dispatch(content);
    const match = dispatchResult.selected;
    if (!match) return;
    event.preventDefault();
    dispatcherInput = content;
    if (match.confidence >= 0.3) {
      queueMicrotask(() => routeContent(content));
    }
  }

  function handleDispatcherKeys(event: KeyboardEvent): void {
    const max = dispatch.selected || matchedPlugins.length > 0 ? matchedPlugins.length - 1 : plugins.length - 1;
    if (event.key === 'ArrowDown') { event.preventDefault(); dispatchIndex = Math.min(dispatchIndex + 1, max); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); dispatchIndex = Math.max(dispatchIndex - 1, 0); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const content = dispatcherInput.trim();
      if (!content) return;
      if (dispatch.selected) {
        routeToPlugin(dispatch.selected.plugin.id, content);
      } else if (matchedPlugins.length > 0 && dispatchIndex >= 0 && dispatchIndex <= matchedPlugins.length) {
        routeContent(content, dispatchIndex);
      } else if (plugins[dispatchIndex] && dispatchIndex >= 0) {
        routeToPlugin(plugins[dispatchIndex].id, content);
      } else if (plugins[0]) {
        routeToPlugin(plugins[0].id, content);
      }
      return;
    }
    if (event.key === 'Escape') { dispatcherElement.blur(); dispatchIndex = 0; }
  }

  async function pasteToTool(): Promise<void> {
    try { changeInput(await navigator.clipboard.readText()); } catch { dispatcherElement.focus(); }
  }

  async function copyResult(): Promise<void> {
    if (!visibleResult) return;
    await navigator.clipboard.writeText(visibleResult.output);
    copied = true; setTimeout(() => (copied = false), 1200);
  }

  function clearActive(): void {
    const plugin = activePlugin;
    sessions = { ...sessions, [plugin.id]: { ...makeSession(plugin), input: '' } };
  }

  function openSettings(tab: SettingsTab = 'general', notice = ''): void {
    aiDraft = aiConfig ? { ...aiConfig } : createAiProfile();
    aiTestStatus = 'idle'; aiTestMessage = ''; settingsError = ''; settingsNotice = notice; settingsTab = tab; settingsOpen = true;
    dispatchHotkeyDraft = dispatchHotkey;
  }

  function selectAiProvider(provider: string): void {
    const preset = AI_PRESETS[provider] ?? AI_PRESETS.custom;
    aiDraft = { ...aiDraft, ...preset, apiKey: aiDraft.apiKey };
    modelList = []; aiTestStatus = 'idle';
  }

  function editAiProfile(profileId: string): void {
    const profile = aiStore.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    aiDraft = { ...profile }; modelList = []; aiTestStatus = 'idle'; aiTestMessage = '';
  }

  function addAiProfile(): void {
    aiDraft = createAiProfile('openai', `模型配置 ${aiStore.profiles.length + 1}`);
    modelList = []; aiTestStatus = 'idle'; aiTestMessage = '';
  }

  function removeAiProfile(): void {
    if (!aiStore.profiles.some((profile) => profile.id === aiDraft.id)) return;
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

  function saveDispatchHotkey(): void {
    const hk = dispatchHotkeyDraft.trim().toLowerCase().slice(0, 3) || 'k';
    dispatchHotkey = hk;
    saveAppSettings({ dispatchHotkey: hk });
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
      if (expectJson && pluginId === 'spurh.json' && !result.parseError) requestAnimationFrame(() => applyAiResult());
    } catch (cause) { patchSession(pluginId, { aiProcessing: false, aiError: cause instanceof Error ? cause.message : String(cause) }); }
  }

  function applyAiResult(): void {
    if (!activeSession.aiResult) return;
    patchSession(activePluginId, { input: activeSession.aiResult.output, aiResult: null, aiError: '' });
    scheduleProcess(activePluginId, 0);
  }

  function handleKeys(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === dispatchHotkey) {
      event.preventDefault();
      dispatcherElement.focus();
      return;
    }
    for (let i = 0; i < plugins.length && i < 9; i++) {
      const binding = appSettings.toolHotkeys[String(i)];
      if (!binding || binding === 'off' || binding === '') continue;
      const [mod, key] = binding.split('+');
      const modMatch = (mod === 'alt' && event.altKey) || (mod === 'ctrl' && event.ctrlKey) || (mod === 'shift' && event.shiftKey);
      if (modMatch && key && event.key.toLowerCase() === key.toLowerCase()) {
        event.preventDefault();
        selectPlugin(plugins[i].id);
        return;
      }
    }
  }

  $: dispatchHotkeyLabel = `Ctrl+${dispatchHotkey.toUpperCase()}`;
</script>

<svelte:window on:keydown={handleKeys} />

<div class:light={lightMode} class="app">
  <header class="app-bar">
    <button class="brand" on:click={() => (sidebarOpen = !sidebarOpen)} aria-label="侧栏">
      <span class="brand-mark"><i></i><i></i></span><b>Spurh</b>
    </button>
    <div class="dispatcher">
      <span class="dispatcher-spark">✦</span>
      <input bind:this={dispatcherElement} bind:value={dispatcherInput} on:paste={handleDispatcherPaste} on:keydown={handleDispatcherKeys} placeholder="粘贴内容，自动识别工具…  ↑↓选择  Esc关闭" />
      {#if dispatcherInput && (dispatch.selected || matchedPlugins.length > 0)}
        <div class="dispatch-matches">
          {#each [dispatch.selected!, ...matchedPlugins].filter(Boolean).slice(0, 6) as match, i}
            {#if match}
              <button class:active={dispatchIndex === i} on:click={() => routeContent(dispatcherInput, i)}>
                <span>{match.plugin.icon}</span><b>{match.plugin.name}</b><small>{Math.round(match.confidence * 100)}%</small>
                {#if dispatchIndex === i}<i>↵</i>{/if}
              </button>
            {/if}
          {/each}
        </div>
      {:else if dispatcherInput}
        <div class="dispatch-matches">
          <div class="dispatch-header">未匹配 — 选择工具：</div>
          {#each plugins as plugin, i}
            <button class:active={i === dispatchIndex} on:click={() => routeToPlugin(plugin.id, dispatcherInput)}>
              <span>{plugin.icon}</span><b>{plugin.name}</b>{#if i === dispatchIndex}<i>↵</i>{/if}
            </button>
          {/each}
        </div>
      {/if}
      <kbd>{dispatchHotkeyLabel}</kbd>
    </div>
    <div class="app-actions">
      {#if aiStore.profiles.length}
        <label class="model-switcher" title="AI 模型">
          <span class="provider-badge" style="background:{PROVIDER_COLORS[aiConfig?.provider ?? ''] ?? '#888'}">{PROVIDER_LABELS[aiConfig?.provider ?? ''] ?? 'AI'}</span>
          <select value={aiStore.activeId} on:change={(event) => switchAiProfile(event.currentTarget.value)}>
            {#each aiStore.profiles as profile}<option value={profile.id}>{PROVIDER_LABELS[profile.provider] ?? 'AI'} {profile.name} · {profile.model}</option>{/each}
          </select>
        </label>
      {/if}
      {#if aiConfig && isAiConfigured(aiConfig)}
        <span class="ai-status" class:processing={plugins.some((p) => sessions[p.id].aiProcessing)}><span class="status-dot"></span>{aiConfig.model}</span>
      {/if}
      <button class:configured={isAiConfigured(aiConfig)} class="settings-button" on:click={() => openSettings()}><span>⚙</span>设置</button>
    </div>
  </header>

  <div class:sidebar-hidden={!sidebarOpen} class="app-body">
    <aside class="sidebar">
      <div class="side-heading"><span>工具</span></div>
      <label class="tool-search"><span>⌕</span><input bind:value={toolSearch} placeholder="搜索" /></label>
      <div class="category-tabs">
        {#each categories as item}<button class:active={category === item} on:click={() => (category = item)}>{item}</button>{/each}
      </div>
      <nav class="tool-list">
        {#each visiblePlugins as plugin, i}
          <button class:active={activePluginId === plugin.id} on:click={() => selectPlugin(plugin.id)}>
            <span class="tool-icon">{plugin.icon}</span><span class="tool-name"><b>{plugin.name}</b><small>{plugin.description}</small></span>
            {#if i < 9}
              {@const binding = appSettings.toolHotkeys[String(i)]}
              {#if binding && binding !== 'off' && binding !== ''}<kbd class="tool-kbd">{binding}</kbd>{/if}
            {/if}
          </button>
        {/each}
      </nav>
    </aside>

    <main class="workspace">
      <div class="tool-header">
        <div class="tool-identity">
          <span class="tool-icon large">{activePlugin.icon}</span>
          <div><div><h1>{activePlugin.name}</h1><em>{activePlugin.category}</em></div><p>{activePlugin.description}</p></div>
        </div>
        <div class="auto-state" class:error={Boolean(activeSession.error)}>
          {#if activeSession.processing}<span class="spinner"></span>处理中
          {:else if activeSession.error}<i></i>错误
          {:else if activeSession.result}<i></i>完成
          {:else}<i></i>就绪{/if}
        </div>
      </div>

      <div class="tool-controls">
        <div class="actions" aria-label="操作">
          {#each activePlugin.actions as action}
            <button class:active={activeSession.actionId === action.id} title={action.description} on:click={() => changeAction(action.id)}>{action.label}</button>
          {/each}
        </div>
        {#if activePlugin.options?.length}
          <div class="options">
            {#each activePlugin.options.filter((option) => (!option.actions || option.actions.includes(activeSession.actionId)) && (!option.showWhen || option.showWhen.values.includes(activeSession.options[option.showWhen.optionId]))) as option}
              <label><span>{option.label}</span>
                {#if option.type === 'select'}
                  <select value={activeSession.options[option.id]} on:change={(event) => changeOption(option.id, event.currentTarget.value)}>
                    {#each option.choices ?? [] as choice}<option value={choice.value}>{choice.label}</option>{/each}
                  </select>
                {:else}
                  <input value={activeSession.options[option.id]} placeholder={option.placeholder} on:input={(event) => changeOption(option.id, event.currentTarget.value)} />
                {/if}
              </label>
            {/each}
          </div>
        {/if}
        <div class="control-spacer"></div>
        <button class="ai-button" disabled={!activeSession.input.trim() || activeSession.aiProcessing} on:click={runAiProcessing}><span>✦</span>{activeSession.aiProcessing ? 'AI 中' : 'AI 处理'}</button>
        <button class="quiet-button" on:click={clearActive}>清空</button>
      </div>

      <div class="editor-grid">
        <section class="editor-pane">
          <header><div><span>输入</span><small>{activeSession.input.length} 字符</small></div><button on:click={pasteToTool}>粘贴</button></header>
          <textarea bind:this={inputElement} value={activeSession.input} on:input={(event) => changeInput(event.currentTarget.value)} spellcheck="false" placeholder="输入或粘贴内容…"></textarea>
        </section>
        <section class="editor-pane output-pane">
          <header><div><span>结果</span>{#if visibleResult}<small>{visibleResult.summary}</small>{/if}</div>
            <div class="output-actions">
              {#if activeSession.aiResult && activePlugin.id === 'spurh.json' && !activeSession.aiResult.meta?.解析}<button class="apply-ai" on:click={applyAiResult}>应用修复</button>{/if}
              <button disabled={!visibleResult} on:click={copyResult}>{copied ? '已复制 ✓' : '复制'}</button>
            </div>
          </header>
          <div class="output-scroll" bind:this={streamScrollElement}>
            {#if activeSession.aiProcessing}
              <div class="ai-loading">
                <div class="ai-loading-title"><span class="spinner"></span><div><b>AI 处理中</b><small>{aiConfig?.model}</small></div><i>✦</i></div>
                <div class="stream-preview"><header><span>推理</span><i>实时</i></header><p>{activeSession.aiReasoning || activeSession.aiStreamContent || '等待响应…'}</p></div>
                {#if activeSession.aiStreamContent}<div class="answer-preview">{activeSession.aiStreamContent}</div>{/if}
              </div>
            {:else if activeSession.aiError}
              <div class="error-box ai-error"><span>✦</span><div><b>AI 失败</b><p>{activeSession.aiError}</p><button on:click={() => openSettings('ai')}>检查配置</button></div></div>
            {:else if activeSession.error}
              <div class="error-box"><span>!</span><div><b>处理失败</b><p>{activeSession.error}</p><button on:click={runAiProcessing}>✦ AI 处理</button></div></div>
            {:else if visibleResult}
              <ResultView result={visibleResult} />
            {:else}
              <div class="output-empty"><span>{activePlugin.icon}</span><b>等待输入</b><p>输入内容后自动处理</p></div>
            {/if}
          </div>
        </section>
      </div>

      {#if visibleResult?.meta}
        <div class="result-meta">{#each Object.entries(visibleResult.meta) as [key, value]}<span><small>{key}</small><b>{value}</b></span>{/each}</div>
      {/if}
    </main>
  </div>

  {#if settingsOpen}
    <div class="modal-backdrop" role="presentation">
      <div class="settings-modal" role="dialog" aria-modal="true">
        <header class="settings-header"><div class="modal-icon">⚙</div><div><h2>设置</h2><p>外观、系统、AI 与快捷键</p></div><button on:click={() => (settingsOpen = false)}>×</button></header>
        <div class="settings-layout">
          <nav class="settings-nav">
            <button class:active={settingsTab === 'general'} on:click={() => (settingsTab = 'general')}><span>◫</span><div><b>通用</b><small>主题 · 启动 · 托盘</small></div></button>
            <button class:active={settingsTab === 'ai'} on:click={() => (settingsTab = 'ai')}><span>✦</span><div><b>AI 模型</b><small>服务商配置</small></div></button>
            <button class:active={settingsTab === 'shortcuts'} on:click={() => (settingsTab = 'shortcuts')}><span>⌨</span><div><b>快捷键</b><small>自定义绑定</small></div></button>
            <button class:active={settingsTab === 'about'} on:click={() => (settingsTab = 'about')}><span>i</span><div><b>关于</b><small>版本信息</small></div></button>
          </nav>
          <section class="settings-content">
            {#if settingsTab === 'general'}
              <div class="settings-section-title"><h3>通用</h3></div>
              <div class="setting-group"><div class="setting-copy"><b>主题</b></div>
                <div class="theme-choice">
                  <button class:active={appSettings.theme === 'light'} on:click={() => saveAppSettings({ theme: 'light' })}>☼ 明亮</button>
                  <button class:active={appSettings.theme === 'dark'} on:click={() => saveAppSettings({ theme: 'dark' })}>☾ 深色</button>
                  <button class:active={appSettings.theme === 'system'} on:click={() => saveAppSettings({ theme: 'system' })}>◐ 系统</button>
                </div>
              </div>
              <label class="setting-row"><div class="setting-copy"><b>开机启动</b></div><input type="checkbox" checked={autostartEnabled} disabled={settingsBusy === 'autostart'} on:change={(event) => changeAutostart(event.currentTarget.checked)} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>系统托盘</b></div><input type="checkbox" checked={appSettings.trayEnabled} disabled={settingsBusy === 'tray'} on:change={(event) => changeTray(event.currentTarget.checked)} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>剪贴板监听</b></div><input type="checkbox" checked={clipboardWatchEnabled} on:change={(event) => (clipboardWatchEnabled = event.currentTarget.checked)} /><i></i></label>
              <label class="setting-row"><div class="setting-copy"><b>系统右键菜单</b></div><input type="checkbox" checked={contextMenuEnabled} disabled={settingsBusy === 'contextMenu'} on:change={(event) => changeContextMenu(event.currentTarget.checked)} /><i></i></label>
              {#if settingsError}<div class="settings-error">{settingsError}</div>{/if}
            {:else if settingsTab === 'ai'}
              <div class="settings-section-title model-title"><div><h3>AI 模型</h3></div><button on:click={addAiProfile}>＋ 添加</button></div>
              {#if settingsNotice}<div class="settings-notice"><span>!</span>{settingsNotice}</div>{/if}
              <div class="profile-list">
                {#each aiStore.profiles as profile}
                  <button class:active={aiDraft.id === profile.id} on:click={() => editAiProfile(profile.id)}>
                    <span class="provider-badge" style="background:{PROVIDER_COLORS[profile.provider] ?? '#888'}">{PROVIDER_LABELS[profile.provider] ?? 'AI'}</span><div><b>{profile.name}</b><small>{profile.model || '未选'}</small></div>{#if aiStore.activeId === profile.id}<i>使用中</i>{/if}
                  </button>
                {/each}
              </div>
              <div class="provider-list">
                {#each Object.keys(AI_PRESETS) as provider}
                  <button class:active={aiDraft.provider === provider} on:click={() => selectAiProvider(provider)}>
                    <span class="provider-badge small" style="background:{PROVIDER_COLORS[provider] ?? '#888'}">{PROVIDER_LABELS[provider]}</span>{PROVIDER_NAMES[provider] || provider}
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
                  <button disabled={modelListLoading || !aiDraft.endpoint} on:click={loadRemoteModels}>{modelListLoading ? '…' : '↻ 拉取'}</button>
                </div></label>
                <label><span>密钥</span><input type="password" bind:value={aiDraft.apiKey} placeholder={aiDraft.provider === 'ollama' ? '可留空' : 'sk-…'} autocomplete="off" /></label>
              </div>
              {#if aiTestStatus !== 'idle'}<div class:success={aiTestStatus === 'success'} class:error={aiTestStatus === 'error'} class="test-result">{aiTestMessage}</div>{/if}
              <div class="settings-ai-actions">
                {#if aiStore.profiles.some((p) => p.id === aiDraft.id)}<button class="delete-model" on:click={removeAiProfile}>删除</button>{/if}
                <div class="control-spacer"></div>
                <button class="test-button" disabled={aiTestStatus === 'testing' || !aiDraft.endpoint} on:click={testConnection}>测试</button>
                <button class="save-button" disabled={!aiDraft.endpoint || !aiDraft.model} on:click={saveAiSettings}>保存</button>
              </div>
            {:else if settingsTab === 'shortcuts'}
              <div class="settings-section-title"><h3>快捷键配置</h3></div>
              <div class="shortcut-list">
                {#each plugins.slice(0, 9) as plugin, i}
                  {@const binding = appSettings.toolHotkeys[String(i)] ?? `alt+${i + 1}`}
                  {@const enabled = binding !== 'off' && binding !== ''}
                  <div class="shortcut-row">
                    <span class="tool-icon small" style="margin-right:8px">{plugin.icon}</span>
                    <span>{plugin.name}</span>
                    <div class="shortcut-config">
                      <input type="checkbox" checked={enabled} on:change={(e) => {
                        const v = e.currentTarget.checked ? `alt+${i + 1}` : 'off';
                        saveAppSettings({ toolHotkeys: { ...appSettings.toolHotkeys, [String(i)]: v } });
                      }} />
                      <input class="hk-input" value={enabled ? binding : 'off'} disabled={!enabled} on:input={(e) => {
                        const val = e.currentTarget.value.toLowerCase().trim();
                        saveAppSettings({ toolHotkeys: { ...appSettings.toolHotkeys, [String(i)]: val || 'off' } });
                      }} maxlength="10" />
                    </div>
                  </div>
                {/each}
                <div class="shortcut-row">
                  <span style="width:28px"></span><span>聚焦搜索框</span>
                  <div class="shortcut-config"><span>Ctrl+</span><input class="hk-input" bind:value={dispatchHotkeyDraft} maxlength="3" on:input={() => saveDispatchHotkey()} /></div>
                </div>
              </div>
              <div class="shortcuts-note">格式: alt+1, ctrl+a, shift+f。修改即保存。</div>
            {:else}
              <div class="about-hero"><span class="brand-mark large"><i></i><i></i></span><div><h3>Spurh</h3><p>AI Native Developer Toolbox</p></div><b>v0.1.0</b></div>
              <div class="about-grid"><article><small>作者</small><b>xuning</b></article><article><small>版本</small><b>0.1.0</b></article><article><small>技术栈</small><b>Svelte 5 · Tauri 2</b></article><article><small>许可</small><b>MIT</b></article></div>
            {/if}
          </section>
        </div>
      </div>
    </div>
  {/if}

  {#if openFileContext}
    <div class="file-notice"><span>外部文件</span><b>{openFileContext.path}</b><button on:click={() => (openFileContext = null)}>×</button></div>
  {/if}
</div>
