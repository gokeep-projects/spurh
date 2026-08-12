<script lang="ts">
  import { onMount } from 'svelte';
  import { safeInvoke } from '../env';
  import { UI_ICONS, TOOL_ICONS, iconHtml } from '../icons';
  import { deleteSecret, getSecret, setSecret } from '../secrets';
  import { base64ToBytes, decodeExecResult, escPath } from '../remoteExec';
  import { processWithAi, type AiConfig } from '../ai';
  import TerminalView, { type RemoteSession } from './TerminalView.svelte';

  const STORAGE_KEY = 'spurh.remote.sessions.v1';
  const TABS_KEY = 'spurh.remote.tabs.v1';
  const SIDE_KEY = 'spurh.remote.sideCollapsed.v1';

  let { aiConfig }: { aiConfig?: AiConfig | undefined } = $props();

  function loadSideCollapsed(): boolean {
    try { return localStorage.getItem(SIDE_KEY) === '1'; } catch { return false; }
  }
  function toggleSide(): void {
    sideCollapsed = !sideCollapsed;
    try { localStorage.setItem(SIDE_KEY, sideCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }

  function loadTabs(): { openTabs: string[]; activeId: string } {
    try {
      const raw = localStorage.getItem(TABS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        openTabs: Array.isArray(parsed.openTabs) ? parsed.openTabs.filter((x: unknown): x is string => typeof x === 'string') : [],
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : '',
      };
    } catch {
      return { openTabs: [], activeId: '' };
    }
  }

  function saveTabs(): void {
    localStorage.setItem(TABS_KEY, JSON.stringify({ openTabs, activeId }));
  }

  // 旧版 localStorage 中可能残留的明文密码/口令，等待初始化时迁移到系统钥匙串
  let legacySecrets: Array<{ id: string; key: string; value: string }> = [];

  function loadSessions(): RemoteSession[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as RemoteSession[];
      return parsed
        .filter((item) => item && typeof item.id === 'string' && typeof item.host === 'string')
        .map((item) => {
          if (item.password) legacySecrets.push({ id: item.id, key: 'password', value: item.password });
          if (item.passphrase) legacySecrets.push({ id: item.id, key: 'passphrase', value: item.passphrase });
          return { ...item, password: '', passphrase: '' };
        });
    } catch {
      return [];
    }
  }

  /** 密码/口令只存系统钥匙串：持久化时剥离，避免明文落盘。 */
  function saveSessions(list: RemoteSession[]): void {
    const stripped = list.map(({ password: _pw, passphrase: _pp, ...rest }) => rest);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
  }

  /** 迁移旧明文到钥匙串，并从钥匙串加载当前会话的密码/口令到内存。 */
  async function migrateAndHydrateSecrets(): Promise<void> {
    try {
      for (const item of legacySecrets) {
        try { await setSecret('ssh.' + item.id + '.' + item.key, item.value); } catch { /* 钥匙串不可用时忽略 */ }
      }
      legacySecrets = [];
      const hydrated = await Promise.all(sessions.map(async (session) => ({
        ...session,
        password: (await getSecret('ssh.' + session.id + '.password')) ?? '',
        passphrase: (await getSecret('ssh.' + session.id + '.passphrase')) ?? '',
      })));
      sessions = hydrated;
      // 恢复上次打开的标签页；过滤已删除的会话
      openTabs = openTabs.filter((id) => sessions.some((session) => session.id === id));
      if (activeId && !sessions.some((session) => session.id === activeId)) {
        activeId = sessions[0]?.id ?? '';
      }
      saveTabs();
    } finally {
      // 无论钥匙串是否可用都必须放行终端，避免"信息都对但进不了终端"
      secretsReady = true;
    }
  }

  onMount(() => { migrateAndHydrateSecrets(); });
  onMount(() => {
    const close = () => { sysPanel = false; filePanel = false; };
    window.addEventListener('spurh:settings-open', close);
    return () => window.removeEventListener('spurh:settings-open', close);
  });

  function freshSession(): RemoteSession {
    return {
      id: crypto.randomUUID(),
      name: '',
      host: '',
      port: 22,
      user: '',
      authType: 'password',
      password: '',
      keyPath: '',
      passphrase: '',
    };
  }

  type SessionState = { status: string; message?: string };

  const initialSessions = loadSessions();
  let sessions = $state<RemoteSession[]>(initialSessions);
  let sessionQuery = $state('');
  const filteredSessions = $derived(sessionQuery.trim()
    ? sessions.filter((item) =>
        (item.name + ' ' + item.host + ' ' + item.user + ' ' + item.port)
          .toLowerCase().includes(sessionQuery.trim().toLowerCase()))
    : sessions);
  const initialTabs = loadTabs();
  let activeId = $state(initialTabs.activeId || (initialSessions[0]?.id ?? ''));
  let editing = $state(false);
  let draft = $state<RemoteSession | null>(null);
  let draftIsNew = $state(false);
  let openTabs = $state<string[]>(initialTabs.openTabs);
  let nonceMap = $state<Record<string, number>>({});
  let statusMap = $state<Record<string, SessionState>>({});
  let busy = $state(false);
  let showSecret = $state(false);
  let testing = $state(false);
  let testMessage = $state('');
  /** 密钥从系统钥匙串加载完成前，不渲染终端，避免空密码触发"无法连接" */
  let secretsReady = $state(false);

  type PortProbe = { port: number; open: boolean; elapsedMs: number };

  async function testDraft(): Promise<void> {
    if (!draft || !draft.host.trim()) { testMessage = '请先填写主机地址'; return; }
    testing = true;
    testMessage = '';
    const port = Math.min(65535, Math.max(1, Math.floor(Number(draft.port) || 22)));
    try {
      const results = await safeInvoke<PortProbe[]>('net_port_scan', { host: draft.host.trim(), ports: String(port) });
      const open = results[0]?.open ?? false;
      testMessage = open ? `连接成功：${draft.host}:${port} 端口开放` : `端口不可达：${draft.host}:${port} 无响应`;
    } catch (cause) {
      testMessage = cause instanceof Error ? cause.message : String(cause);
    }
    testing = false;
  }

  const active = $derived(sessions.find((item) => item.id === activeId) ?? null);
  const activeStatus = $derived(active ? (statusMap[active.id] ?? { status: 'idle' }) : { status: 'idle' });

  function sessionById(id: string): RemoteSession | undefined {
    return sessions.find((item) => item.id === id);
  }

  function select(id: string): void {
    activeId = id;
    editing = false;
    saveTabs();
  }

  const QUICK_COMMANDS = [
    { label: '磁盘占用', cmd: 'df -h' },
    { label: '内存', cmd: 'free -m' },
    { label: '运行时长', cmd: 'uptime' },
    { label: '系统信息', cmd: 'uname -a' },
    { label: '当前目录', cmd: 'pwd' },
    { label: '当前用户', cmd: 'whoami' },
    { label: '目录列表', cmd: 'ls -la' },
    { label: '进程 TOP', cmd: 'top -bn1 | head -20' },
  ];
  const QUICK_PRIMARY = QUICK_COMMANDS.slice(0, 4);
  const QUICK_SECONDARY = QUICK_COMMANDS.slice(4);
  let termCollapsed = $state(false);
  let sideCollapsed = $state(loadSideCollapsed());
  let quickMore = $state(false);
  let quickMenuStyle = $state('');
  function toggleQuickMore(event: MouseEvent): void {
    quickMore = !quickMore;
    if (quickMore) {
      const btn = event.currentTarget as HTMLElement;
      const r = btn.getBoundingClientRect();
      const width = 250;
      const height = Math.min(QUICK_SECONDARY.length * 31 + 16, 300);
      let left = Math.min(r.right - width, window.innerWidth - width - 10);
      if (left < 10) left = 10;
      let top = r.bottom + 6;
      if (top + height > window.innerHeight - 10) top = r.top - height - 6;
      quickMenuStyle = `left:${left}px;top:${top}px;position:fixed;`;
    }
  }
  let quickHint = $state('');
  let quickHintTimer: ReturnType<typeof setTimeout> | undefined;
  function showQuickHint(message: string): void {
    quickHint = message;
    clearTimeout(quickHintTimer);
    quickHintTimer = setTimeout(() => (quickHint = ''), 2600);
  }
  let aiCmdInput = $state('');
  let aiCmdBusy = $state(false);
  let aiCmdError = $state('');
  let aiCmdElement = $state<HTMLInputElement | undefined>(undefined);
  let sysPanel = $state(false);
  let sysInfo = $state('');
  let sysLoading = $state(false);
  let filePanel = $state(false);
  let uploadFile = $state<File | null>(null);
  let remotePath = $state('');
  let transferStatus = $state('');
  let transferBusy = $state(false);

  async function loadSysInfo(): Promise<void> {
    if (!active) return;
    sysLoading = true;
    try {
      const base64 = await safeInvoke<string>('ssh_exec', {
        sessionId: active.id,
        command: 'echo ===SYS===; uname -a; echo ===MEM===; free -m; echo ===DISK===; df -h; echo ===UPTIME===; uptime; echo ===LOAD===; top -bn1 2>/dev/null | head -18; echo ===END===',
        stdin: null,
      });
      const decoded = decodeExecResult(base64);
      sysInfo = decoded.text + (decoded.stderr ? `\n\n[stderr]\n${decoded.stderr}` : '') + (decoded.truncated ? '\n\n[输出已截断]' : '');
    } catch (cause) {
      sysInfo = '获取失败: ' + (cause instanceof Error ? cause.message : String(cause));
    }
    sysLoading = false;
  }

  async function doUpload(): Promise<void> {
    if (!active || !uploadFile || !remotePath.trim()) return;
    transferBusy = true;
    transferStatus = '';
    try {
      // 文件读为 base64，远端用 base64 -d 解码写入，支持二进制内容
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(uploadFile as File);
      });
      const result = await safeInvoke<string>('ssh_exec', {
        sessionId: active.id,
        command: `base64 -d > '${escPath(remotePath.trim())}'`,
        stdin: base64,
      });
      const decoded = decodeExecResult(result);
      if (decoded.stderr.trim()) {
        transferStatus = `上传失败: ${decoded.stderr.trim().split('\n')[0]}`;
        transferBusy = false;
        return;
      }
      transferStatus = `上传完成: ${uploadFile.name}（${uploadFile.size} 字节）→ ${remotePath.trim()}`;
    } catch (cause) {
      transferStatus = '上传失败: ' + (cause instanceof Error ? cause.message : String(cause));
    }
    transferBusy = false;
  }

  async function doDownload(): Promise<void> {
    if (!active || !remotePath.trim()) return;
    transferBusy = true;
    transferStatus = '';
    try {
      // 远端 base64 编码输出（base64 命令在 GNU/BSD 下默认换行，atob 会忽略空白）；
      // ssh_exec 通道再 base64 一层，decodeExecResult 已解出内层 base64，此处只需解码一次
      const encoded = await safeInvoke<string>('ssh_exec', {
        sessionId: active.id,
        command: `base64 '${escPath(remotePath.trim())}'`,
        stdin: null,
      });
      const decoded = decodeExecResult(encoded);
      if (decoded.stderr.trim()) {
        transferStatus = `下载失败: ${decoded.stderr.trim().split('\n')[0]}`;
        transferBusy = false;
        return;
      }
      const bytes = base64ToBytes(decoded.text);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = remotePath.trim().split('/').pop() || 'download';
      anchor.click();
      URL.revokeObjectURL(url);
      transferStatus = `下载完成: ${remotePath.trim()}（${bytes.length} 字节）${decoded.truncated ? ' · 输出已截断，文件可能不完整' : ''}`;
    } catch (cause) {
      transferStatus = '下载失败: ' + (cause instanceof Error ? cause.message : String(cause));
    }
    transferBusy = false;
  }

  function addSession(): void {
    const created = freshSession();
    sessions = [...sessions, created];
    activeId = created.id;
    draft = { ...created };
    draftIsNew = true;
    editing = true;
  }

  function editSession(): void {
    if (!active) return;
    draft = { ...active };
    draftIsNew = false;
    editing = true;
  }

  function deleteSession(id: string): void {
    const target = sessionById(id);
    if (!target) return;
    if (openTabs.includes(id)) {
      safeInvoke('ssh_close', { sessionId: id }).catch(() => undefined);
    }
    deleteSecret('ssh.' + id + '.password').catch(() => undefined);
    deleteSecret('ssh.' + id + '.passphrase').catch(() => undefined);
    sessions = sessions.filter((item) => item.id !== id);
    openTabs = openTabs.filter((tabId) => tabId !== id);
    statusMap = { ...statusMap };
    delete statusMap[id];
    if (activeId === id) activeId = sessions[0]?.id ?? '';
    saveSessions(sessions);
    saveTabs();
    if (editing && draft?.id === id) editing = false;
  }

  function saveDraft(): void {
    if (!draft) return;
    const cleaned: RemoteSession = {
      ...draft,
      name: draft.name.trim() || (draft.user.trim() || 'root') + '@' + (draft.host || 'host'),
      host: draft.host.trim(),
      user: draft.user.trim() || 'root',
      port: Math.min(65535, Math.max(1, Math.floor(Number(draft.port) || 22))),
    };
    const exists = sessions.some((item) => item.id === cleaned.id);
    sessions = exists ? sessions.map((item) => (item.id === cleaned.id ? cleaned : item)) : [...sessions, cleaned];
    saveSessions(sessions);
    setSecret('ssh.' + cleaned.id + '.password', cleaned.password).catch(() => undefined);
    setSecret('ssh.' + cleaned.id + '.passphrase', cleaned.passphrase).catch(() => undefined);
    activeId = cleaned.id;
    draftIsNew = false;
    editing = false;
  }

  function cancelDraft(): void {
    const d = draft;
    if (d && draftIsNew) {
      // 新建但未保存的草稿：从列表移除，避免残留空会话
      sessions = sessions.filter((item) => item.id !== d.id);
      if (activeId === d.id) activeId = sessions[0]?.id ?? '';
    }
    editing = false;
    testMessage = '';
  }

  function connect(): void {
    if (!active) return;
    if (openTabs.includes(active.id)) {
      nonceMap = { ...nonceMap, [active.id]: (nonceMap[active.id] ?? 0) + 1 };
    } else {
      openTabs = [...openTabs, active.id];
      nonceMap = { ...nonceMap, [active.id]: 0 };
    }
    saveTabs();
    statusMap = { ...statusMap, [active.id]: { status: 'connecting', message: '正在连接 ' + active.host + ':' + active.port + ' …' } };
  }

  function closeTab(id: string): void {
    safeInvoke('ssh_close', { sessionId: id }).catch(() => undefined);
    openTabs = openTabs.filter((tabId) => tabId !== id);
    saveTabs();
  }

  /** 手动断开当前会话：关闭 Rust 侧会话并同步状态（终端保留输出与重连入口） */
  function disconnect(id: string): void {
    safeInvoke('ssh_close', { sessionId: id }).catch(() => undefined);
    statusMap = { ...statusMap, [id]: { status: 'disconnected', message: '已手动断开' } };
  }

  function handleTerminalState(id: string, state: SessionState): void {
    statusMap = { ...statusMap, [id]: state };
  }

  /** 向已连接会话发送一条命令（模拟输入 + 回车） */
  function runQuick(cmd: string): void {
    quickMore = false;
    if (!active || activeStatus.status !== 'connected') {
      showQuickHint('请先点击「连接」建立 SSH 连接，再使用快捷命令');
      return;
    }
    const bytes = new TextEncoder().encode(cmd + '\r');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    safeInvoke('ssh_write', { sessionId: active.id, data: btoa(binary) }).catch(() => undefined);
    showQuickHint(`已发送：${cmd}`);
  }

  /** AI 命令助手：自然语言 → shell 命令 → 发送到终端 */
  async function aiCommand(): Promise<void> {
    const text = aiCmdInput.trim();
    if (!text) return;
    if (!aiConfig || !aiConfig.apiKey) {
      aiCmdError = '未配置 AI 模型，请到 设置 → AI 模型 配置后使用';
      return;
    }
    aiCmdBusy = true; aiCmdError = '';
    try {
      const result = await processWithAi(aiConfig, text, {
        tool: 'SSH 远程命令',
        action: '生成 Linux shell 命令',
        expectJson: false,
        userPrompt: '根据用户的自然语言需求，生成一条安全、简洁、单行的 Linux shell 命令。只输出命令本身，不要解释、不要多行脚本、不要 markdown 代码块。如果需求含糊，选择最常见且安全的实现。',
      }, () => undefined);
      let cmd = result.output.trim();
      cmd = cmd.replace(/^```(bash|sh|shell)?s*/i, '').replace(/```s*$/, '').trim();
      if (!cmd) { aiCmdError = 'AI 未生成有效命令'; return; }
      runQuick(cmd);
      aiCmdInput = '';
    } catch (cause) {
      aiCmdError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      aiCmdBusy = false;
    }
  }

  function statusLabel(state: SessionState): string {
    switch (state.status) {
      case 'connected': return '已连接';
      case 'connecting': return '连接中…';
      case 'disconnected': return '已断开';
      case 'error': return '连接失败';
      default: return '未连接';
    }
  }
</script>

<div class="remote-panel" style={"grid-template-columns: " + (sideCollapsed ? "46px" : "232px") + " minmax(0, 1fr)"}>
  <aside class="remote-side" class:collapsed={sideCollapsed}>
    {#if sideCollapsed}
      <div class="remote-side-rail">
        <button class="remote-collapse" onclick={toggleSide} title="展开会话列表"><span>▶</span></button>
        <button class="remote-add" title="新建会话" onclick={addSession}><span>{@html UI_ICONS.plus}</span></button>
        <div class="remote-rail-list">
          {#each sessions.slice(0, 40) as item}
            <button class="rs-mini" class:active={activeId === item.id} onclick={() => select(item.id)} title={(item.name || (item.host ? item.host : '新会话')) + (item.host ? ' · ' + item.host + ':' + item.port : '')}>
              <span class="rs-mini-char">{(item.name || item.host || '?').charAt(0).toUpperCase()}</span>
              <i class="rs-dot" class:connected={statusMap[item.id]?.status === 'connected'} class:busy={statusMap[item.id]?.status === 'connecting' || statusMap[item.id]?.status === 'idle'}></i>
            </button>
          {/each}
        </div>
      </div>
    {:else}
    <div class="remote-side-head">
      <b>会话</b>
      <div class="remote-side-actions">
        <button class="remote-collapse" onclick={toggleSide} title="收起会话列表"><span>◀</span></button>
        <button class="remote-add" title="新建会话" onclick={addSession}><span>{@html UI_ICONS.plus}</span></button>
      </div>
    </div>
    <label class="remote-search"><span>{@html UI_ICONS.search}</span><input bind:value={sessionQuery} placeholder="搜索会话…" spellcheck="false" /></label>
    <div class="remote-sessions">
      {#each filteredSessions as item}
        <button class="remote-session" class:active={activeId === item.id} onclick={() => select(item.id)}>
          <span class="rs-icon">{@html iconHtml(TOOL_ICONS['spurh.remote'])}</span>
          <span class="rs-copy"><b>{item.name || (item.host ? (item.user || 'root') + '@' + item.host : '新会话')}</b><small>{item.host ? item.host + ':' + item.port : '未填写主机'}</small></span>
          <i class="rs-dot" class:connected={statusMap[item.id]?.status === 'connected'} class:busy={statusMap[item.id]?.status === 'connecting' || statusMap[item.id]?.status === 'idle'}></i>
        </button>
      {/each}
      {#if sessions.length === 0}
        <div class="rs-empty">还没有会话<br />点击右上角 + 新建</div>
      {:else if filteredSessions.length === 0}
        <div class="rs-empty">没有匹配「{sessionQuery.trim()}」的会话</div>
      {/if}
    </div>
    {/if}
  </aside>

  <main class="remote-main">
    {#if editing && draft}
      {@const d = draft}
      <div class="remote-form">
        <header><b>{d.id && sessions.some((item) => item.id === d.id) ? '编辑会话' : '新建会话'}</b><button class="form-close" onclick={cancelDraft} aria-label="关闭">{@html UI_ICONS.close}</button></header>
        <div class="form-grid">
          <label><span>名称</span><input bind:value={d.name} placeholder="例如：生产服务器" /></label>
          <label><span>主机</span><input bind:value={d.host} placeholder="192.168.1.10 或 ssh.example.com" /></label>
          <label class="form-port"><span>端口</span><input type="number" bind:value={d.port} placeholder="22" /></label>
          <label><span>用户名</span><input bind:value={d.user} placeholder="root" /></label>
          <div class="form-auth">
            <span>认证方式</span>
            <div class="auth-chips">
              <button class:active={d.authType === 'password'} onclick={() => (d.authType = 'password')}>密码</button>
              <button class:active={d.authType === 'key'} onclick={() => (d.authType = 'key')}>私钥</button>
            </div>
          </div>
          {#if d.authType === 'password'}
            <label class="form-full"><span>密码</span><span class="secret-wrap"><input type={showSecret ? 'text' : 'password'} autocomplete="off" bind:value={d.password} placeholder="••••••••" /><button class="secret-toggle" type="button" onclick={() => (showSecret = !showSecret)} title={showSecret ? '隐藏密码' : '显示密码'}>{@html showSecret ? UI_ICONS.eyeOff : UI_ICONS.eye}</button></span></label>
          {:else}
            <label class="form-full"><span>私钥路径</span><input bind:value={d.keyPath} placeholder="C:\Users\you\.ssh\id_ed25519" /></label>
            <label class="form-full"><span>密钥口令</span><input type="password" autocomplete="off" bind:value={d.passphrase} placeholder="可选" /></label>
          {/if}
        </div>
        <footer>
          <span class="form-hint">密码与密钥仅保存在本机</span>
          {#if testMessage}<span class="form-test" class:ok={testMessage.startsWith('连接成功')}>{testMessage}</span>{/if}
          <button class="form-cancel" disabled={testing} onclick={() => (testDraft())}>{testing ? '测试中…' : '测试连接'}</button>
          <button class="form-cancel" onclick={cancelDraft}>取消</button>
          <button class="form-save" disabled={!d.host.trim()} onclick={saveDraft}>保存</button>
        </footer>
      </div>
    {:else if active}
      <div class="remote-toolbar">
        <div class="rt-identity">
          <span class="rs-icon">{@html iconHtml(TOOL_ICONS['spurh.remote'])}</span>
          <div><b>{active.name || (active.user || 'root') + '@' + active.host}</b><small>{active.user}@{active.host}:{active.port}</small></div>
          <span class="rt-status" class:connected={activeStatus.status === 'connected'} class:error={activeStatus.status === 'error'} class:connecting={activeStatus.status === 'connecting'}><i></i>{statusLabel(activeStatus)}</span>
        </div>
        <div class="rt-actions">
          <button class="rt-connect" onclick={connect}><span class="rt-dot"></span>{activeStatus.status === 'connected' ? '重连' : (activeStatus.status === 'error' ? '重试' : '连接')}</button>
          <button class="rt-quiet" disabled={activeStatus.status !== 'connected'} onclick={() => disconnect(active.id)} title="断开当前连接（保留终端输出）">断开</button>
          <span class="rt-sep"></span>
          <button class="rt-quiet" disabled={activeStatus.status !== 'connected'} onclick={() => { sysPanel = true; loadSysInfo(); }} title="查看主机系统/内存/磁盘/负载">资源信息</button>
          <button class="rt-quiet" disabled={activeStatus.status !== 'connected'} onclick={() => (filePanel = true)} title="上传 / 下载文件（基于 cat）">传输文件</button>
          <button class="rt-quiet" onclick={() => aiCmdElement?.focus()} title="用 AI 根据自然语言生成命令并发送到终端">AI 命令</button>
          <span class="rt-sep"></span>
          <button class="rt-quiet" onclick={editSession}>编辑</button>
          <button class="rt-quiet danger" onclick={() => deleteSession(active.id)}>删除</button>
          <span class="rt-sep"></span>
          <button class="rt-quiet" onclick={() => (termCollapsed = !termCollapsed)} title="收起 / 展开终端区域">{termCollapsed ? '终端展开' : '终端收起'}</button>
        </div>
      </div>
      {#if quickHint}
        <div class="rt-quick-hint"><i></i>{quickHint}</div>
      {/if}
      {#if activeStatus.status === 'connected'}
        <div class="rt-cmdbar">
          <span class="rt-cmdbar-title">快捷命令</span>
          {#each QUICK_PRIMARY as item}
            <button class="rt-cmd-chip" onclick={() => runQuick(item.cmd)} title={item.cmd}>{item.label}</button>
          {/each}
          <div class="rt-quick-wrap">
            <button class="rt-cmd-chip more" onclick={toggleQuickMore}>{quickMore ? '收起 ▴' : '更多 ▾'}</button>
            {#if quickMore}
              <div class="rt-quick" style={quickMenuStyle}>
                {#each QUICK_SECONDARY as item}
                  <button onclick={() => runQuick(item.cmd)}><code>{item.cmd}</code><small>{item.label}</small></button>
                {/each}
              </div>
            {/if}
          </div>
          <span class="rt-cmdbar-grow"></span>
          <div class="rt-ai">
            <span class="rt-ai-ico" title="AI 生成命令">{@html UI_ICONS.sparkle}</span>
            <input bind:this={aiCmdElement} value={aiCmdInput} oninput={(e) => (aiCmdInput = e.currentTarget.value)} placeholder="例如：查看服务器上有几个文件 / 查询磁盘剩余空间" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && aiCommand()} />
            <button class="rt-ai-btn" disabled={aiCmdBusy || !aiCmdInput.trim()} onclick={aiCommand}>{aiCmdBusy ? '生成中…' : '生成并发送'}</button>
          </div>
          {#if aiCmdError}<span class="rt-ai-error" title={aiCmdError}>{aiCmdError}</span>{/if}
        </div>
      {:else}
        <div class="rt-cmdbar rt-cmdbar-idle">
          <span class="rt-cmdbar-title">快捷命令</span>
          {#each QUICK_PRIMARY as item}
            <button class="rt-cmd-chip" disabled title={item.cmd}>{item.label}</button>
          {/each}
          <span class="rt-cmdbar-grow"></span>
          <div class="rt-ai">
            <span class="rt-ai-ico" title="AI 生成命令">{@html UI_ICONS.sparkle}</span>
            <input bind:this={aiCmdElement} value={aiCmdInput} oninput={(e) => (aiCmdInput = e.currentTarget.value)} placeholder="例如：查看服务器上有几个文件 / 查询磁盘剩余空间" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && aiCommand()} />
            <button class="rt-ai-btn" disabled={aiCmdBusy || !aiCmdInput.trim()} onclick={aiCommand}>{aiCmdBusy ? '生成中…' : '生成并发送'}</button>
          </div>
          {#if aiCmdError}<span class="rt-ai-error" title={aiCmdError}>{aiCmdError}</span>{/if}
          <span class="rt-cmdbar-idle-hint">连接后可一键发送快捷命令</span>
        </div>
      {/if}
      {#if sysPanel}
        <div class="rt-modal-backdrop" role="presentation" onkeydown={(event) => { if (event.key === 'Escape') sysPanel = false; }}>
          <div class="rt-modal" role="dialog" aria-modal="true">
            <header><b>主机资源信息</b><button onclick={() => (sysPanel = false)} aria-label="关闭">×</button></header>
            <div class="rt-modal-body">
              {#if sysLoading}<div class="rt-modal-loading"><span class="spinner"></span>正在读取主机信息…</div>
              {:else}<pre class="sys-info">{sysInfo || '无数据'}</pre>{/if}
            </div>
            <footer><button class="rt-quiet" onclick={() => loadSysInfo()}>刷新</button><button class="rt-quiet" onclick={() => (sysPanel = false)}>关闭</button></footer>
          </div>
        </div>
      {/if}
      {#if filePanel}
        <div class="rt-modal-backdrop" role="presentation" onkeydown={(event) => { if (event.key === 'Escape') filePanel = false; }}>
          <div class="rt-modal" role="dialog" aria-modal="true">
            <header><b>文件传输</b><button onclick={() => (filePanel = false)} aria-label="关闭">×</button></header>
            <div class="rt-modal-body">
              <label class="rt-file-row"><span>远端路径</span><input type="text" value={remotePath} oninput={(e) => (remotePath = e.currentTarget.value)} placeholder="/root/logs/app.log" spellcheck="false" /></label>
              <div class="rt-file-row"><span>上传文件</span>
                <input type="file" onchange={(e) => (uploadFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
                <span class="rt-file-size">{uploadFile ? uploadFile.name + '（' + (uploadFile.size / 1024 / 1024).toFixed(2) + ' MB）' : '未选择文件'}</span>
                <button class="rt-quiet" disabled={transferBusy || !uploadFile} onclick={doUpload}>{transferBusy ? '传输中…' : '上传'}</button>
              </div>
              <div class="rt-file-row"><span>下载远端文件</span>
                <button class="rt-quiet" disabled={transferBusy || !remotePath.trim()} onclick={doDownload}>{transferBusy ? '传输中…' : '下载'}</button>
              </div>
              {#if transferStatus}<p class="rt-transfer-status">{transferStatus}</p>{/if}
              <small class="rt-file-note">上传经 base64 -d 解码写入、下载经 base64 编码读取，支持任意二进制文件；建议单个文件 ≤ 8MB。</small>
            </div>
            <footer><button class="rt-quiet" onclick={() => (filePanel = false)}>关闭</button></footer>
          </div>
        </div>
      {/if}
      {#if openTabs.length > 0}
        <div class="remote-tabs">
          {#each openTabs as tabId}
            {@const tab = sessionById(tabId)}
            {#if tab}
              <div class="remote-tab" class:active={tabId === activeId} role="button" tabindex="0" onclick={() => select(tabId)} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(tabId); } }}>
                <i class:connected={statusMap[tabId]?.status === 'connected'} class:error={statusMap[tabId]?.status === 'error'}></i>
                <b>{tab.name || tab.host}</b>
                <button class="tab-close" onclick={(event) => { event.stopPropagation(); closeTab(tabId); }} aria-label="关闭会话">×</button>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      <div class="remote-terminal" class:collapsed={termCollapsed}>
        {#each openTabs as tabId}
          {#key tabId + ':' + (nonceMap[tabId] ?? 0)}
            {@const tab = sessionById(tabId)}
            {#if secretsReady && tab}
              <TerminalView session={tab} active={tabId === activeId} onState={handleTerminalState} />
            {/if}
          {/key}
        {/each}
        {#if openTabs.length === 0}
          <div class="rt-empty">
            <span>{@html iconHtml(TOOL_ICONS['spurh.remote'])}</span>
            <b>尚未连接</b>
            <p>点击「连接」打开 xterm.js 终端，支持多会话标签页</p>
          </div>
        {/if}
      </div>
    {:else}
      <div class="rt-empty main">
        <span>{@html iconHtml(TOOL_ICONS['spurh.remote'])}</span>
        <b>没有会话</b>
        <p>新建一个 SSH 会话并保存，即可开始远程操作</p>
        <button class="rt-connect" onclick={addSession}><span class="rt-dot"></span>新建会话</button>
      </div>
    {/if}
  </main>
</div>

<style>
  .remote-panel { min-width: 0; min-height: 0; flex: 1; display: grid; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); }
  .remote-side-actions { display: flex; align-items: center; gap: 6px; }
  .remote-collapse { width: 26px; height: 26px; display: grid; place-items: center; cursor: pointer; color: var(--muted); border: 1px solid var(--line); border-radius: 8px; background: transparent; transition: all .15s ease; }
  .remote-collapse span { display: inline-flex; }
  :global(.remote-collapse span svg) { width: 12px; height: 12px; }
  .remote-collapse:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .remote-side.collapsed { border-right: 1px solid var(--line); }
  .remote-side-rail { min-height: 0; flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 10px 0; overflow-y: auto; }
  .remote-rail-list { min-height: 0; flex: 1; display: flex; flex-direction: column; align-items: center; gap: 7px; overflow-y: auto; }
  .rs-mini { position: relative; width: 34px; height: 34px; display: grid; place-items: center; cursor: pointer; color: var(--text); border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); transition: all .15s ease; }
  .rs-mini:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--hover); }
  .rs-mini.active { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: var(--accent-soft); box-shadow: 0 0 0 3px var(--accent-soft); }
  .rs-mini-char { font-size: 13px; font-weight: 700; }
  .rs-mini .rs-dot { position: absolute; top: 3px; right: 3px; width: 5px; height: 5px; }
  .rt-sep { width: 1px; height: 18px; flex: 0 0 auto; background: var(--line); margin: 0 2px; }
  .rt-cmdbar { min-height: 38px; display: flex; align-items: center; gap: 6px; padding: 5px 12px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
  .rt-cmdbar-title { color: var(--muted-2); font-size: var(--fs-xs); font-weight: 600; letter-spacing: .3px; margin-right: 2px; }
  .rt-cmd-chip { height: 26px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); font-weight: 600; border: 1px solid var(--line); border-radius: 999px; background: transparent; transition: all .15s ease; }
  .rt-cmd-chip:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); }
  .rt-cmd-chip:disabled { opacity: .45; cursor: default; }
  .rt-cmd-chip:disabled:hover { color: var(--muted); border-color: var(--line); background: transparent; }
  .rt-cmdbar-idle { opacity: .88; }
  .rt-cmdbar-idle-hint { flex: 0 0 auto; color: var(--muted-2); font-size: var(--fs-tiny); }
  .rt-cmd-chip.more { color: var(--muted-2); }
  .rt-cmdbar-grow { flex: 1; }
  .rt-ai { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; justify-content: flex-end; }
  .rt-ai-ico { display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 auto; color: var(--c-violet); border: 1px solid color-mix(in srgb, var(--c-violet) 40%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--c-violet) 10%, transparent); }
  :global(.rt-ai-ico svg) { width: 13px; height: 13px; }
  .rt-ai input { width: min(300px, 34vw); height: 30px; min-width: 120px; padding: 0 11px; color: var(--text); font-size: var(--fs-sm); border: 1px solid var(--line-strong); border-radius: 9px; outline: 0; background: var(--bg2); transition: border-color .15s ease, box-shadow .15s ease; }
  .rt-ai input:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .rt-ai input::placeholder { color: var(--muted-2); }
  .rt-ai-btn { height: 30px; padding: 0 14px; cursor: pointer; color: #fff; font-size: var(--fs-xs); font-weight: 700; border: 0; border-radius: 9px; background: linear-gradient(120deg, var(--c-violet), var(--c-blue)); box-shadow: 0 4px 14px color-mix(in srgb, var(--c-violet) 35%, transparent); transition: all .18s ease; }
  .rt-ai-btn:hover:not(:disabled) { filter: brightness(1.12); transform: translateY(-1px); }
  .rt-ai-btn:disabled { opacity: .45; cursor: not-allowed; }
  .rt-ai-error { max-width: 260px; overflow: hidden; color: var(--c-red); font-size: var(--fs-tiny); text-overflow: ellipsis; white-space: nowrap; }
  .remote-side { min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--panel); }
  .remote-side-head { height: 44px; flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 0 10px 0 14px; border-bottom: 1px solid var(--line); }
  .remote-side-head b { font-size: var(--fs-xs); letter-spacing: .2px; }
  .remote-add { width: 26px; height: 26px; display: grid; place-items: center; cursor: pointer; color: var(--muted); border: 1px solid var(--line); border-radius: 8px; background: transparent; transition: all .15s ease; }
  .remote-add span { display: inline-flex; }
  :global(.remote-add span svg) { width: 12px; height: 12px; }
  .remote-add:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .remote-search { height: 30px; flex: 0 0 auto; display: flex; align-items: center; gap: 6px; margin: 8px 8px 0; padding: 0 10.5px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  :global(.remote-search svg) { width: 12px; height: 12px; color: var(--muted-2); }
  .remote-search:focus-within { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .remote-search input { min-width: 0; flex: 1; color: var(--text); font-size: var(--fs-xs); border: 0; outline: 0; background: transparent; }
  .remote-search input::placeholder { color: var(--muted-2); }
  .remote-sessions { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; padding: 8px; overflow-y: auto; }
  .remote-session { width: 100%; min-height: 52px; display: flex; align-items: center; gap: 10.5px; padding: 7px 10.5px; cursor: pointer; text-align: left; color: var(--text); border: 1px solid transparent; border-radius: 10.5px; background: transparent; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease; }
  .remote-session:hover { background: var(--hover); }
  .remote-session.active { border-color: color-mix(in srgb, var(--accent) 22%, var(--line)); background: var(--panel-2); box-shadow: inset 2px 0 0 var(--accent), 0 2px 10px rgba(0, 0, 0, .08); }
  .rs-icon { width: 32px; height: 32px; display: grid; place-items: center; flex: 0 0 auto; color: var(--accent); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  :global(.rs-icon svg) { width: 16px; height: 16px; }
  .rs-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .rs-copy b { overflow: hidden; font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
  .rs-copy small { overflow: hidden; color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .rs-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--muted-2); transition: background .2s ease, box-shadow .2s ease; }
  .rs-dot.connected { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .rs-dot.busy { background: var(--blue); box-shadow: 0 0 8px var(--blue); animation: rem-pulse 1s ease-in-out infinite; }
  @keyframes rem-pulse { 50% { opacity: .35; } }
  .rs-empty { padding: 26px 10px; color: var(--muted-2); font-size: var(--fs-xs); line-height: 1.8; text-align: center; }
  .remote-main { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--panel-2); }
  .remote-toolbar { min-height: 54px; flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; gap: 12px; row-gap: 8px; padding: 8px 13px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .rt-identity { flex: 1 1 220px; min-width: 170px; display: flex; align-items: center; gap: 10px; }
  .rt-identity > div { min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 2px; }
  .rt-identity b { max-width: 100%; overflow: hidden; font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
  .rt-identity small { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', monospace; }
  .rt-status { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; white-space: nowrap; padding: 5px 10px; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 999px; background: var(--bg); transition: all .2s ease; }
  .rt-status i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-2); }
  .rt-status.connected { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); background: var(--accent-soft); }
  .rt-status.connected i { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .rt-status.connecting { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 30%, var(--line)); background: color-mix(in srgb, var(--blue) 8%, transparent); }
  .rt-status.connecting i { background: var(--blue); box-shadow: 0 0 8px var(--blue); animation: rem-pulse 1s ease-in-out infinite; }
  .rt-status.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, var(--line)); background: color-mix(in srgb, var(--danger) 7%, transparent); }
  .rt-status.error i { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .rt-quick-hint { position: absolute; z-index: 60; top: 56px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 9px 16px; color: var(--text); font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--warn) 12%, var(--panel-2)); box-shadow: 0 10px 30px color-mix(in srgb, var(--warn) 18%, transparent); animation: rtHintIn .22s cubic-bezier(.2,.9,.3,1.15); }
  .rt-quick-hint i { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--warn); box-shadow: 0 0 8px var(--warn); }
  @keyframes rtHintIn { from { opacity: 0; transform: translate(-50%, -8px); } to { opacity: 1; transform: translate(-50%, 0); } }
  .rt-actions { display: flex; flex-wrap: wrap; gap: 6px; row-gap: 6px; margin-left: auto; }
  .rt-connect { height: 30px; display: inline-flex; align-items: center; gap: 7px; padding: 0 14px; cursor: pointer; color: #fff; font-size: var(--fs-sm); font-weight: 700; white-space: nowrap; border: 0; border-radius: 8px; background: var(--btn-gradient); box-shadow: 0 5px 16px color-mix(in srgb, var(--accent) 20%, transparent); transition: transform .12s ease, box-shadow .15s ease; }
  .rt-connect:hover { transform: translateY(-1px); box-shadow: 0 8px 20px color-mix(in srgb, var(--accent) 30%, transparent); }
  .rt-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
  .rt-quiet { height: 30px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); white-space: nowrap; border: 1px solid var(--line); border-radius: 8px; background: transparent; transition: all .15s ease; }
  .rt-quiet:hover { color: var(--text); border-color: var(--line-2); background: var(--hover); }
  .rt-quiet.danger:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .remote-tabs { flex: 0 0 auto; display: flex; gap: 4px; padding: 7px 10px 0; border-bottom: 1px solid var(--line); background: var(--panel); }
  .remote-tab { position: relative; height: 31px; display: flex; align-items: center; gap: 7px; padding: 0 8px 0 11px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px 8px 0 0; border-bottom: 0; background: var(--bg); transition: color .15s ease, background .15s ease; }
  .remote-tab:hover { color: var(--text); }
  .remote-tab.active { color: var(--text); background: var(--panel-2); box-shadow: inset 0 2px 0 color-mix(in srgb, var(--accent) 85%, transparent); }
  .remote-tab i { width: 5px; height: 5px; border-radius: 50%; background: var(--muted-2); }
  .remote-tab i.connected { background: var(--accent); box-shadow: 0 0 7px var(--accent); }
  .remote-tab i.error { background: var(--danger); box-shadow: 0 0 7px var(--danger); }
  .remote-tab b { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .tab-close { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; cursor: pointer; color: var(--muted-2); font-size: var(--fs-xs); line-height: 1; border: 0; border-radius: 4px; background: transparent; }
  .tab-close:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .remote-terminal { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
  .rt-empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 8px; color: var(--muted); text-align: center; }
  .rt-empty > span { width: 46px; height: 46px; display: grid; place-items: center; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 13px; background: var(--accent-soft); }
  :global(.rt-empty > span svg) { width: 22px; height: 22px; }
  .rt-empty b { color: var(--text); font-size: var(--fs-sm); }
  .rt-empty p { margin: 0; font-size: var(--fs-xs); }
  .rt-empty.main > button { margin-top: 8px; }
  .remote-form { min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: auto; }
  .remote-form > header { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .remote-form > header b { font-size: var(--fs-sm); }
  .form-close { width: 28px; height: 28px; display: grid; place-items: center; cursor: pointer; color: var(--muted); border: 0; border-radius: 8px; background: transparent; }
  .form-close:hover { color: var(--text); background: var(--hover); }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; padding: 18px; }
  .form-grid label { display: flex; flex-direction: column; gap: 6px; }
  .form-grid label > span { color: var(--muted); font-size: var(--fs-xs); }
  .form-grid input { height: 30px; padding: 0 11px; color: var(--text); font: 500 13px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .form-grid input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .form-grid .form-port input { max-width: 130px; }
  .form-grid .form-full { grid-column: 1 / -1; }
  .secret-wrap { position: relative; display: flex; align-items: center; }
  .secret-wrap input { width: 100%; padding-right: 34px; }
  .secret-toggle { position: absolute; right: 5px; width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer; color: var(--muted-2); font-size: var(--fs-xs); border: 0; border-radius: 8px; background: transparent; }
  :global(.secret-toggle svg) { width: 13px; height: 13px; }
  .secret-toggle:hover { color: var(--text); background: var(--hover); }
  .form-auth { display: flex; flex-direction: column; gap: 6px; }
  .form-auth > span { color: var(--muted); font-size: var(--fs-xs); }
  .auth-chips { display: inline-flex; gap: 2px; align-self: flex-start; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .auth-chips button { height: 26px; padding: 0 14px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 0; border-radius: 8px; background: transparent; transition: all .15s ease; }
  .auth-chips button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .auth-chips button.active { color: #fff; background: var(--btn-gradient); box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .remote-form > footer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--panel); }
  .form-hint { flex: 1; color: var(--muted-2); font-size: var(--fs-xs); }
  .form-test { color: var(--danger); font-size: var(--fs-xs); white-space: nowrap; }
  .form-test.ok { color: var(--accent); }
  .form-cancel { height: 30px; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: transparent; transition: all .15s ease; }
  .form-cancel:hover { color: var(--text); border-color: var(--line-2); }
  .form-save { height: 30px; padding: 0 16px; cursor: pointer; color: #fff; font-size: var(--fs-sm); font-weight: 700; border: 0; border-radius: 8px; background: var(--btn-gradient); box-shadow: 0 5px 16px color-mix(in srgb, var(--accent) 20%, transparent); transition: transform .12s ease, box-shadow .15s ease, opacity .15s ease; }
  .form-save:hover:not(:disabled) { transform: translateY(-1px); }
  .form-save:disabled { cursor: default; opacity: .4; }
  .rt-quiet:disabled { opacity: .4; cursor: default; }
  .rt-modal-backdrop { position: fixed; z-index: 320; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(4, 6, 10, .68); backdrop-filter: blur(12px); animation: fade-in .14s ease-out; }
  .rt-modal { width: min(560px, 100%); overflow: hidden; border: 1px solid var(--line-2); border-radius: 14px; background: var(--panel-2); box-shadow: 0 30px 100px rgba(0, 0, 0, .55); }
  .rt-modal > header { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--line); }
  .rt-modal > header b { font-size: var(--fs-xs); }
  .rt-modal > header button { width: 28px; height: 28px; cursor: pointer; color: var(--muted); font-size: 17px; border: 0; border-radius: 8px; background: transparent; }
  .rt-modal > header button:hover { color: var(--text); background: var(--hover); }
  .rt-modal-body { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; max-height: 60vh; overflow-y: auto; }
  .rt-modal-body pre.sys-info { margin: 0; padding: 11px 13px; overflow: auto; color: var(--text); font: 450 13.5px/1.65 'Cascadia Code', monospace; white-space: pre-wrap; border: 1px solid var(--line); border-radius: 10.5px; background: var(--bg); }
  .rt-modal-loading { display: flex; align-items: center; gap: 8px; padding: 18px; color: var(--muted); font-size: var(--fs-xs); }
  .rt-modal > footer { display: flex; justify-content: flex-end; gap: 6px; padding: 11px 16px; border-top: 1px solid var(--line); }
  .rt-file-row { display: flex; align-items: center; gap: 10.5px; }
  .rt-file-row > span { flex: 0 0 auto; width: 82px; color: var(--muted); font-size: var(--fs-sm); }
  .rt-file-row input[type='text'], .rt-file-row input:not([type]) { min-width: 0; flex: 1; height: 32px; padding: 0 10.5px; color: var(--text); font: 500 13.5px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--bg); }
  .rt-file-row input:focus { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .rt-file-row input[type='file'] { font-size: var(--fs-sm); }
  .rt-file-size { min-width: 0; flex: 1; overflow: hidden; color: var(--muted); font-size: var(--fs-tiny); text-overflow: ellipsis; white-space: nowrap; }
  .rt-transfer-status { margin: 0; color: var(--accent); font-size: var(--fs-xs); }
  .rt-file-note { color: var(--muted-2); font-size: var(--fs-xs); line-height: 1.6; }
  .rt-quick-wrap { position: relative; }
  .rt-quick { position: absolute; z-index: 30; width: 250px; max-height: 300px; overflow-y: auto; padding: 5px; border: 1px solid var(--line-2); border-radius: 10.5px; background: var(--panel-2); box-shadow: 0 12px 32px rgba(0, 0, 0, .35); }
  .rt-quick button { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 10.5px; cursor: pointer; text-align: left; border: 0; border-radius: 8px; background: transparent; }
  .rt-quick button:hover { background: var(--hover); }
  .rt-quick code { color: var(--text); font: 500 13px 'Cascadia Code', monospace; }
  .rt-quick small { color: var(--muted-2); font-size: var(--fs-tiny); }
</style>
