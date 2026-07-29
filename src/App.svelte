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
  type SettingsTab = 'general' | 'ai' | 'about';

  type AppSettings = {
    theme: ThemeMode;
    trayEnabled: boolean;
  };

  type ContextTarget = 'input' | 'output';
  type ContextMenuState = { x: number; y: number; target: ContextTarget };

  const SETTINGS_KEY = 'spurh.settings.v1';

  function loadAppSettings(): AppSettings {
    const fallback: AppSettings = { theme: 'light', trayEnabled: true };
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
    'spurh.cron': '*/5 * * * *',
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
  let contextMenu: ContextMenuState | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  $: activePlugin = plugins.find((plugin) => plugin.id === activePluginId)!;
  $: activeSession = sessions[activePluginId];
  $: visibleResult = activeSession.aiResult ?? activeSession.result;
  $: dispatch = runtime.dispatch(dispatcherInput);
  $: visiblePlugins = plugins.filter((plugin) =>
    (category === '全部' || plugin.category === category)
    && `${plugin.name} ${plugin.description}`.toLowerCase().includes(toolSearch.toLowerCase()),
  );
  $: aiConfig = aiStore.profiles.find((profile) => profile.id === aiStore.activeId);
  $: lightMode = appSettings.theme === 'light'
    || (appSettings.theme === 'system' && !window.matchMedia('(prefers-color-scheme: dark)').matches);

  onMount(() => {
    requestAnimationFrame(() => scheduleProcess('spurh.json', 0));
    const systemTimer = setTimeout(() => {
      invoke<boolean>('get_autostart').then((enabled) => (autostartEnabled = enabled)).catch(() => undefined);
      invoke('set_tray_enabled', { enabled: appSettings.trayEnabled }).catch(() => undefined);
    }, 450);
    return () => clearTimeout(systemTimer);
  });

  function patchSession(pluginId: string, patch: Partial<ToolSession>): void {
    sessions = { ...sessions, [pluginId]: { ...sessions[pluginId], ...patch } };
  }

  function hasProcessableInput(pluginId: string, session: ToolSession): boolean {
    if (session.input.length > 0) return true;
    if (pluginId === 'spurh.timestamp' && session.actionId === 'now') return true;
    if (pluginId === 'spurh.random') return true;
    if (pluginId === 'spurh.http') return Boolean(session.options.url);
    if (pluginId === 'spurh.cron' && session.actionId === 'generate' && session.options.scheduleType !== 'natural') return true;
    return pluginId === 'spurh.regex' && Boolean(session.options.pattern);
  }

  function scheduleProcess(pluginId = activePluginId, delay = 220): void {
    const previous = timers.get(pluginId);
    if (previous) clearTimeout(previous);
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
        patchSession(pluginId, {
          result: null,
          processing: false,
          error: cause instanceof Error ? cause.message : '处理失败',
        });
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
    if (activePluginId !== 'spurh.http') scheduleProcess(activePluginId);
  }

  function changeAction(actionId: string): void {
    patchSession(activePluginId, { actionId });
    scheduleProcess(activePluginId, 0);
  }

  function changeOption(optionId: string, value: string): void {
    patchSession(activePluginId, { options: { ...activeSession.options, [optionId]: value } });
    if (optionId !== 'aiPrompt' && activePluginId !== 'spurh.http') scheduleProcess(activePluginId);
  }

  function routeContent(content = dispatcherInput): void {
    const match = runtime.dispatch(content).selected;
    if (!match) return;
    activePluginId = match.plugin.id;
    patchSession(match.plugin.id, { input: content });
    dispatcherInput = '';
    scheduleProcess(match.plugin.id, 0);
  }

  function handleDispatcherPaste(event: ClipboardEvent): void {
    const content = event.clipboardData?.getData('text') ?? '';
    const match = runtime.dispatch(content).selected;
    if (!match || match.confidence < 0.6) return;
    event.preventDefault();
    dispatcherInput = content;
    queueMicrotask(() => routeContent(content));
  }

  async function pasteToTool(): Promise<void> {
    try {
      changeInput(await navigator.clipboard.readText());
    } catch {
      dispatcherElement.focus();
    }
  }

  async function copyResult(): Promise<void> {
    if (!visibleResult) return;
    await navigator.clipboard.writeText(visibleResult.output);
    copied = true;
    setTimeout(() => (copied = false), 1_200);
  }

  function clearActive(): void {
    const plugin = activePlugin;
    sessions = { ...sessions, [plugin.id]: { ...makeSession(plugin), input: '' } };
  }

  function openSettings(tab: SettingsTab = 'general', notice = ''): void {
    aiDraft = aiConfig ? { ...aiConfig } : createAiProfile();
    aiTestStatus = 'idle';
    aiTestMessage = '';
    settingsError = '';
    settingsNotice = notice;
    settingsTab = tab;
    settingsOpen = true;
  }

  function selectAiProvider(provider: string): void {
    const preset = AI_PRESETS[provider] ?? AI_PRESETS.custom;
    aiDraft = { ...aiDraft, ...preset, apiKey: aiDraft.apiKey };
    modelList = [];
    aiTestStatus = 'idle';
  }

  function editAiProfile(profileId: string): void {
    const profile = aiStore.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    aiDraft = { ...profile };
    modelList = [];
    aiTestStatus = 'idle';
    aiTestMessage = '';
  }

  function addAiProfile(): void {
    aiDraft = createAiProfile('openai', `模型配置 ${aiStore.profiles.length + 1}`);
    modelList = [];
    aiTestStatus = 'idle';
    aiTestMessage = '';
  }

  function removeAiProfile(): void {
    if (!aiStore.profiles.some((profile) => profile.id === aiDraft.id)) return;
    const profiles = aiStore.profiles.filter((profile) => profile.id !== aiDraft.id);
    const activeId = aiStore.activeId === aiDraft.id ? profiles[0]?.id ?? '' : aiStore.activeId;
    aiStore = { profiles, activeId };
    saveAiProfileStore(aiStore);
    aiDraft = profiles.find((profile) => profile.id === activeId) ?? createAiProfile();
  }

  function switchAiProfile(profileId: string): void {
    if (!aiStore.profiles.some((profile) => profile.id === profileId)) return;
    aiStore = { ...aiStore, activeId: profileId };
    saveAiProfileStore(aiStore);
  }

  function saveAppSettings(next: Partial<AppSettings>): void {
    appSettings = { ...appSettings, ...next };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
  }

  async function changeAutostart(enabled: boolean): Promise<void> {
    settingsBusy = 'autostart';
    settingsError = '';
    try {
      autostartEnabled = await invoke<boolean>('set_autostart', { enabled });
    } catch (cause) {
      settingsError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      settingsBusy = '';
    }
  }

  async function changeTray(enabled: boolean): Promise<void> {
    settingsBusy = 'tray';
    settingsError = '';
    try {
      await invoke('set_tray_enabled', { enabled });
      saveAppSettings({ trayEnabled: enabled });
    } catch (cause) {
      settingsError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      settingsBusy = '';
    }
  }

  async function loadRemoteModels(): Promise<void> {
    modelListLoading = true;
    aiTestStatus = 'idle';
    aiTestMessage = '';
    try {
      modelList = await fetchAiModels(aiDraft);
      aiTestStatus = 'success';
      aiTestMessage = modelList.length ? `已从服务商拉取 ${modelList.length} 个模型` : '连接成功，但模型列表为空';
      if (!aiDraft.model && modelList[0]) aiDraft = { ...aiDraft, model: modelList[0].id };
    } catch (cause) {
      aiTestStatus = 'error';
      aiTestMessage = cause instanceof Error ? cause.message : String(cause);
    } finally {
      modelListLoading = false;
    }
  }

  async function testConnection(): Promise<void> {
    aiTestStatus = 'testing';
    aiTestMessage = '';
    try {
      aiTestMessage = await testAiConnection(aiDraft);
      modelList = await fetchAiModels(aiDraft);
      aiTestStatus = 'success';
    } catch (cause) {
      aiTestMessage = cause instanceof Error ? cause.message : String(cause);
      aiTestStatus = 'error';
    }
  }

  function saveAiSettings(): void {
    const profile: AiProfile = {
      ...aiDraft,
      name: aiDraft.name.trim() || aiDraft.model.trim() || '未命名模型',
      endpoint: aiDraft.endpoint.trim().replace(/\/$/, ''),
      model: aiDraft.model.trim(),
    };
    const exists = aiStore.profiles.some((item) => item.id === profile.id);
    const profiles = exists
      ? aiStore.profiles.map((item) => item.id === profile.id ? profile : item)
      : [...aiStore.profiles, profile];
    aiStore = { profiles, activeId: profile.id };
    saveAiProfileStore(aiStore);
    settingsNotice = '';
    aiDraft = { ...profile };
    aiTestMessage = '配置已保存并切换为当前模型';
    aiTestStatus = 'success';
  }

  async function runAiProcessing(): Promise<void> {
    if (!activeSession.input.trim()) return;
    if (!isAiConfigured(aiConfig)) {
      openSettings('ai', '请先配置并保存可用的 AI 模型，再使用 AI 处理。');
      return;
    }

    const pluginId = activePlugin.id;
    patchSession(pluginId, { aiProcessing: true, aiResult: null, aiError: '', aiReasoning: '', aiStreamContent: '' });
    try {
      const plugin = plugins.find((item) => item.id === pluginId)!;
      const session = sessions[pluginId];
      const action = plugin.actions.find((item) => item.id === session.actionId)?.label ?? session.actionId;
      const expectJson = pluginId === 'spurh.json';
      const output = await processWithAi(aiConfig!, session.input, {
        tool: plugin.name,
        action,
        localError: session.error || undefined,
        expectJson,
        userPrompt: session.options.aiPrompt,
      }, ({ reasoning, content }) => {
        patchSession(pluginId, { aiReasoning: reasoning, aiStreamContent: content });
      });
      patchSession(pluginId, {
        aiProcessing: false,
        aiResult: {
          output,
          language: expectJson ? 'json' : 'text',
          view: expectJson ? 'code' : 'text',
          summary: `由 ${aiConfig!.model} 处理完成`,
          meta: { 来源: 'AI 处理', 模型: aiConfig!.model },
        },
      });
    } catch (cause) {
      patchSession(pluginId, {
        aiProcessing: false,
        aiError: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  function applyAiResult(): void {
    if (!activeSession.aiResult) return;
    const repaired = activeSession.aiResult.output;
    patchSession(activePluginId, { input: repaired, aiResult: null, aiError: '' });
    scheduleProcess(activePluginId, 0);
  }

  function handleKeys(event: KeyboardEvent): void {
    if (event.key === 'Escape') contextMenu = null;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      dispatcherElement.focus();
    }
    if (event.key === 'Enter' && document.activeElement === dispatcherElement && dispatch.selected) {
      event.preventDefault();
      routeContent();
    }
  }

  function showContextMenu(event: MouseEvent, target: ContextTarget): void {
    event.preventDefault();
    const width = 180;
    const height = target === 'input' ? 250 : 120;
    contextMenu = {
      target,
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
    };
  }

  async function runContextAction(action: string): Promise<void> {
    const target = contextMenu?.target;
    contextMenu = null;
    if (action === 'copy-result') return copyResult();
    if (action === 'ai') return runAiProcessing();
    if (action === 'clear') return clearActive();
    if (!inputElement || target !== 'input') return;
    const start = inputElement.selectionStart;
    const end = inputElement.selectionEnd;
    const selected = activeSession.input.slice(start, end);
    if (action === 'copy') {
      await navigator.clipboard.writeText(selected || activeSession.input);
    } else if (action === 'cut') {
      await navigator.clipboard.writeText(selected || activeSession.input);
      changeInput(selected ? activeSession.input.slice(0, start) + activeSession.input.slice(end) : '');
    } else if (action === 'paste') {
      const value = await navigator.clipboard.readText();
      changeInput(activeSession.input.slice(0, start) + value + activeSession.input.slice(end));
    } else if (action === 'select-all') {
      inputElement.focus();
      inputElement.select();
    }
  }
</script>

<svelte:window on:keydown={handleKeys} on:click={() => (contextMenu = null)} />

<div class:light={lightMode} class="app">
  <header class="app-bar">
    <button class="brand" on:click={() => (sidebarOpen = !sidebarOpen)} aria-label="切换侧栏">
      <span class="brand-mark"><i></i><i></i></span>
      <b>Spurh</b>
      <small>0.1</small>
    </button>

    <div class="dispatcher">
      <span class="dispatcher-spark">✦</span>
      <input
        bind:this={dispatcherElement}
        bind:value={dispatcherInput}
        on:paste={handleDispatcherPaste}
        placeholder="粘贴任意开发内容，自动识别并打开对应工具…"
        aria-label="智能识别输入"
      />
      {#if dispatcherInput && dispatch.selected}
        <button class="dispatch-match" on:click={() => routeContent()}>
          <span>{dispatch.selected.plugin.icon}</span>
          <b>{dispatch.selected.plugin.name}</b>
          <small>{Math.round(dispatch.selected.confidence * 100)}%</small>
          <i>打开 ↵</i>
        </button>
      {:else}
        <kbd>Ctrl K</kbd>
      {/if}
    </div>

    <div class="app-actions">
      {#if aiStore.profiles.length}
        <label class="model-switcher" title="切换 AI 模型">
          <span>✦</span>
          <select value={aiStore.activeId} on:change={(event) => switchAiProfile(event.currentTarget.value)}>
            {#each aiStore.profiles as profile}<option value={profile.id}>{profile.name} · {profile.model}</option>{/each}
          </select>
        </label>
      {/if}
      <button class:configured={isAiConfigured(aiConfig)} class="settings-button" on:click={() => openSettings()}>
        <span>⚙</span>设置
      </button>
    </div>
  </header>

  <div class:sidebar-hidden={!sidebarOpen} class="app-body">
    <aside class="sidebar">
      <div class="side-heading">
        <span>工具</span><small>{plugins.length} 个已启用</small>
      </div>
      <label class="tool-search">
        <span>⌕</span>
        <input bind:value={toolSearch} placeholder="搜索工具" />
      </label>
      <div class="category-tabs">
        {#each categories as item}
          <button class:active={category === item} on:click={() => (category = item)}>{item}</button>
        {/each}
      </div>
      <nav class="tool-list">
        {#each visiblePlugins as plugin}
          <button class:active={activePluginId === plugin.id} on:click={() => selectPlugin(plugin.id)}>
            <span class="tool-icon">{plugin.icon}</span>
            <span class="tool-name"><b>{plugin.name}</b><small>{plugin.description}</small></span>
            {#if sessions[plugin.id].result}<i class="ready-dot"></i>{/if}
          </button>
        {/each}
      </nav>
    </aside>

    <main class="workspace">
      <div class="tool-header">
        <div class="tool-identity">
          <span class="tool-icon large">{activePlugin.icon}</span>
          <div>
            <div><h1>{activePlugin.name}</h1><em>{activePlugin.category}</em></div>
            <p>{activePlugin.description}</p>
          </div>
        </div>
        <div class="auto-state" class:error={Boolean(activeSession.error)}>
          {#if activeSession.processing}<span class="spinner"></span>{activePlugin.id === 'spurh.http' ? '正在请求' : '正在处理'}
          {:else if activeSession.error}<i></i>需要修改
          {:else if activeSession.result}<i></i>{activePlugin.id === 'spurh.http' ? '处理完成' : '已自动更新'}
          {:else}<i></i>{activePlugin.id === 'spurh.http' ? '等待手动发送' : '实时处理已开启'}{/if}
        </div>
      </div>

      <div class="tool-controls">
        <div class="actions" aria-label="工具操作">
          {#each activePlugin.actions as action}
            <button
              class:active={activeSession.actionId === action.id}
              title={action.description}
              on:click={() => changeAction(action.id)}
            >{action.label}</button>
          {/each}
        </div>
        {#if activePlugin.options?.length}
          <div class="options">
            {#each activePlugin.options.filter((option) =>
              (!option.actions || option.actions.includes(activeSession.actionId))
              && (!option.showWhen || option.showWhen.values.includes(activeSession.options[option.showWhen.optionId]))
            ) as option}
              <label>
                <span>{option.label}</span>
                {#if option.type === 'select'}
                  <select value={activeSession.options[option.id]} on:change={(event) => changeOption(option.id, event.currentTarget.value)}>
                    {#each option.choices ?? [] as choice}<option value={choice.value}>{choice.label}</option>{/each}
                  </select>
                {:else}
                  <input
                    value={activeSession.options[option.id]}
                    placeholder={option.placeholder}
                    on:input={(event) => changeOption(option.id, event.currentTarget.value)}
                  />
                {/if}
              </label>
            {/each}
          </div>
        {/if}
        <div class="control-spacer"></div>
        <button class="ai-button" disabled={!activeSession.input.trim() || activeSession.aiProcessing} on:click={runAiProcessing}>
          <span>✦</span>{activeSession.aiProcessing ? 'AI 处理中' : 'AI 处理'}
        </button>
        <button class="quiet-button" on:click={clearActive}>清空</button>
      </div>

      <div class="editor-grid">
        <section class="editor-pane">
          <header>
            <div><span>{activePlugin.id === 'spurh.http' ? '请求 Body' : '输入'}</span><small>{activeSession.input.length} 字符</small></div>
            <button on:click={pasteToTool}>粘贴</button>
          </header>
          <textarea
            bind:this={inputElement}
            value={activeSession.input}
            on:input={(event) => changeInput(event.currentTarget.value)}
            on:contextmenu={(event) => showContextMenu(event, 'input')}
            spellcheck="false"
            placeholder={activePlugin.id === 'spurh.regex' ? '在这里输入需要测试的文本…' : activePlugin.id === 'spurh.http' ? '输入请求 Body；GET / HEAD 请求可以留空…' : `输入或粘贴 ${activePlugin.name} 内容…`}
          ></textarea>
        </section>

        <section aria-label="处理结果" class:error={Boolean(activeSession.error)} class="editor-pane output-pane" on:contextmenu={(event) => showContextMenu(event, 'output')}>
          <header>
            <div>
              <span>结果</span>
              {#if visibleResult}<small>{visibleResult.summary}</small>{/if}
            </div>
            <div class="output-actions">
              {#if activeSession.aiResult && activePlugin.id === 'spurh.json'}<button class="apply-ai" on:click={applyAiResult}>应用修复</button>{/if}
              <button disabled={!visibleResult} on:click={copyResult}>{copied ? '已复制 ✓' : '复制'}</button>
            </div>
          </header>
          {#if activeSession.aiProcessing}
            <div class="ai-loading">
              <div class="ai-loading-title"><span class="spinner"></span><div><b>AI 正在处理</b><small>{aiConfig?.model} · 实时响应</small></div><i>✦</i></div>
              <div class="stream-preview">
                <header><span>模型过程</span><i>实时</i></header>
                <p>{activeSession.aiReasoning || activeSession.aiStreamContent || '正在连接模型并等待首个响应…'}</p>
              </div>
              {#if activeSession.aiStreamContent}<div class="answer-preview">{activeSession.aiStreamContent}</div>{/if}
            </div>
          {:else if activeSession.aiError}
            <div class="error-box ai-error"><span>✦</span><div><b>AI 处理失败</b><p>{activeSession.aiError}</p><button on:click={() => openSettings('ai')}>检查模型配置</button></div></div>
          {:else if activeSession.error}
            <div class="error-box"><span>!</span><div><b>本地处理失败</b><p>{activeSession.error}</p><button on:click={runAiProcessing}>✦ 使用 AI 处理</button></div></div>
          {:else if visibleResult}
            <ResultView result={visibleResult} />
          {:else}
            <div class="output-empty">
              <span>{activePlugin.icon}</span>
              <b>{activePlugin.id === 'spurh.http' ? '配置请求' : '等待输入'}</b>
              <p>{activePlugin.id === 'spurh.http' ? '填写请求信息后发送，或直接生成调用代码。' : '结果会随着输入自动更新，不需要点击运行。'}</p>
            </div>
          {/if}
        </section>
      </div>

      {#if visibleResult?.meta}
        <div class="result-meta">
          {#each Object.entries(visibleResult.meta) as [key, value]}
            <span><small>{key}</small><b>{value}</b></span>
          {/each}
        </div>
      {/if}
    </main>
  </div>

  {#if settingsOpen}
    <div class="modal-backdrop" role="presentation" on:click={(event) => event.currentTarget === event.target && (settingsOpen = false)}>
      <div class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header class="settings-header">
          <div class="modal-icon">⚙</div>
          <div><h2 id="settings-title">设置</h2><p>管理 Spurh 的外观、系统行为与 AI 能力。</p></div>
          <button on:click={() => (settingsOpen = false)} aria-label="关闭">×</button>
        </header>
        <div class="settings-layout">
          <nav class="settings-nav">
            <button class:active={settingsTab === 'general'} on:click={() => (settingsTab = 'general')}><span>◫</span><div><b>通用设置</b><small>主题与系统行为</small></div></button>
            <button class:active={settingsTab === 'ai'} on:click={() => (settingsTab = 'ai')}><span>✦</span><div><b>AI 模型</b><small>服务商与模型连接</small></div></button>
            <button class:active={settingsTab === 'about'} on:click={() => (settingsTab = 'about')}><span>i</span><div><b>关于 Spurh</b><small>作者与版本信息</small></div></button>
          </nav>

          <section class="settings-content">
            {#if settingsTab === 'general'}
              <div class="settings-section-title"><h3>通用设置</h3><p>设置会立即生效并保存在本机。</p></div>
              <div class="setting-group">
                <div class="setting-copy"><b>主题</b><small>选择适合当前环境的界面外观</small></div>
                <div class="theme-choice">
                  <button class:active={appSettings.theme === 'light'} on:click={() => saveAppSettings({ theme: 'light' })}>☼ 明亮</button>
                  <button class:active={appSettings.theme === 'dark'} on:click={() => saveAppSettings({ theme: 'dark' })}>☾ 深色</button>
                  <button class:active={appSettings.theme === 'system'} on:click={() => saveAppSettings({ theme: 'system' })}>◐ 跟随系统</button>
                </div>
              </div>
              <label class="setting-row">
                <div class="setting-copy"><b>开机自动启动</b><small>登录 Windows 后自动启动 Spurh</small></div>
                <input type="checkbox" checked={autostartEnabled} disabled={settingsBusy === 'autostart'} on:change={(event) => changeAutostart(event.currentTarget.checked)} />
                <i></i>
              </label>
              <label class="setting-row">
                <div class="setting-copy"><b>显示系统托盘</b><small>在系统托盘保留 Spurh 快捷入口</small></div>
                <input type="checkbox" checked={appSettings.trayEnabled} disabled={settingsBusy === 'tray'} on:change={(event) => changeTray(event.currentTarget.checked)} />
                <i></i>
              </label>
              {#if settingsError}<div class="settings-error">{settingsError}</div>{/if}
            {:else if settingsTab === 'ai'}
              <div class="settings-section-title model-title"><div><h3>AI 模型</h3><p>保存多个模型配置，并在顶部随时切换。</p></div><button on:click={addAiProfile}>＋ 添加模型</button></div>
              {#if settingsNotice}<div class="settings-notice"><span>!</span>{settingsNotice}</div>{/if}
              <div class="profile-list">
                {#if aiStore.profiles.length}
                  {#each aiStore.profiles as profile}
                    <button class:active={aiDraft.id === profile.id} on:click={() => editAiProfile(profile.id)}>
                      <span>✦</span><div><b>{profile.name}</b><small>{profile.model || '尚未选择模型'}</small></div>{#if aiStore.activeId === profile.id}<i>使用中</i>{/if}
                    </button>
                  {/each}
                {:else}
                  <p>还没有模型配置，填写下方内容后保存即可。</p>
                {/if}
              </div>
              <div class="provider-list">
                {#each Object.keys(AI_PRESETS) as provider}
                  <button class:active={aiDraft.provider === provider} on:click={() => selectAiProvider(provider)}>{provider === 'custom' ? '自定义' : provider === 'openai' ? 'OpenAI' : provider === 'deepseek' ? 'DeepSeek' : provider === 'qwen' ? 'Qwen' : 'Ollama'}</button>
                {/each}
              </div>
              <div class="config-fields">
                <label><span>配置名称</span><input bind:value={aiDraft.name} placeholder="例如：日常对话 / 本地模型" /></label>
                <label><span>接口地址</span><input bind:value={aiDraft.endpoint} placeholder="https://api.example.com/v1" /></label>
                <label class="model-field">
                  <span>模型名称</span>
                  <div><input list="remote-models" bind:value={aiDraft.model} placeholder="输入或拉取模型 ID" /><button disabled={modelListLoading || !aiDraft.endpoint} on:click={loadRemoteModels}>{modelListLoading ? '拉取中…' : '↻ 拉取列表'}</button></div>
                  <datalist id="remote-models">{#each modelList as model}<option value={model.id}>{model.ownedBy ?? ''}</option>{/each}</datalist>
                </label>
                <label><span>接口密钥</span><input type="password" bind:value={aiDraft.apiKey} placeholder={aiDraft.provider === 'ollama' ? 'Ollama 可留空' : 'sk-…'} autocomplete="off" /></label>
              </div>
              {#if modelList.length}<div class="model-chips">{#each modelList.slice(0, 8) as model}<button on:click={() => (aiDraft = { ...aiDraft, model: model.id })}>{model.id}</button>{/each}{#if modelList.length > 8}<span>另有 {modelList.length - 8} 个</span>{/if}</div>{/if}
              <div class="privacy-note"><span>⌂</span><p>密钥仅保存在当前设备。AI 请求由 Tauri 后端直接发往你配置的服务商；所有本地工具不依赖 AI。</p></div>
              {#if aiTestStatus !== 'idle'}
                <div class:success={aiTestStatus === 'success'} class:error={aiTestStatus === 'error'} class="test-result">
                  {aiTestStatus === 'testing' ? '正在连接并读取模型列表…' : aiTestMessage}
                </div>
              {/if}
              <div class="settings-ai-actions">
                {#if aiStore.profiles.some((profile) => profile.id === aiDraft.id)}<button class="delete-model" on:click={removeAiProfile}>删除配置</button>{/if}
                <div class="control-spacer"></div>
                <button class="test-button" disabled={aiTestStatus === 'testing' || !aiDraft.endpoint} on:click={testConnection}>测试连接</button>
                <button class="save-button" disabled={!aiDraft.endpoint || !aiDraft.model} on:click={saveAiSettings}>保存并切换</button>
              </div>
            {:else}
              <div class="about-hero"><span class="brand-mark large"><i></i><i></i></span><div><h3>Spurh</h3><p>AI Native Developer Toolbox</p></div><b>v0.1.0</b></div>
              <div class="about-grid"><article><small>作者</small><b>xuning</b></article><article><small>版本</small><b>0.1.0</b></article><article><small>技术栈</small><b>Svelte 5 · Tauri 2</b></article><article><small>许可</small><b>MIT</b></article></div>
              <div class="about-note"><b>设计原则</b><p>本地优先、自动分发、插件扩展。没有 AI 配置时，所有确定性处理仍在本机即时完成。</p></div>
            {/if}
          </section>
        </div>
      </div>
    </div>
  {/if}

  {#if contextMenu}
    <div class="context-menu" role="menu" tabindex="-1" aria-label="编辑操作" style={`left:${contextMenu.x}px;top:${contextMenu.y}px`} on:contextmenu|preventDefault>
      {#if contextMenu.target === 'input'}
        <button on:click={() => runContextAction('paste')}><span>⌘</span>粘贴<kbd>Ctrl V</kbd></button>
        <button on:click={() => runContextAction('cut')}><span>✂</span>剪切<kbd>Ctrl X</kbd></button>
        <button on:click={() => runContextAction('copy')}><span>▣</span>复制<kbd>Ctrl C</kbd></button>
        <button on:click={() => runContextAction('select-all')}><span>□</span>全选<kbd>Ctrl A</kbd></button>
        <i></i>
        <button disabled={!activeSession.input.trim()} on:click={() => runContextAction('ai')}><span class="spark">✦</span>AI 处理</button>
        <button on:click={() => runContextAction('clear')}><span>×</span>清空输入</button>
      {:else}
        <button disabled={!visibleResult} on:click={() => runContextAction('copy-result')}><span>▣</span>复制完整结果</button>
        <button disabled={!activeSession.input.trim()} on:click={() => runContextAction('ai')}><span class="spark">✦</span>重新 AI 处理</button>
      {/if}
    </div>
  {/if}
</div>
