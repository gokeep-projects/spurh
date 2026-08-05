<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { UI_ICONS, TOOL_ICONS, iconHtml } from '../icons';
  import TerminalView, { type RemoteSession } from './TerminalView.svelte';

  const STORAGE_KEY = 'spurh.remote.sessions.v1';

  function loadSessions(): RemoteSession[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as RemoteSession[];
      return parsed.filter((item) => item && typeof item.id === 'string' && typeof item.host === 'string');
    } catch {
      return [];
    }
  }

  function saveSessions(list: RemoteSession[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

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
  let activeId = $state(initialSessions[0]?.id ?? '');
  let editing = $state(false);
  let draft = $state<RemoteSession | null>(null);
  let openTabs = $state<string[]>([]);
  let nonceMap = $state<Record<string, number>>({});
  let statusMap = $state<Record<string, SessionState>>({});
  let busy = $state(false);
  let showSecret = $state(false);
  let testing = $state(false);
  let testMessage = $state('');

  type PortProbe = { port: number; open: boolean; elapsedMs: number };

  async function testDraft(): Promise<void> {
    if (!draft || !draft.host.trim()) { testMessage = '请先填写主机地址'; return; }
    testing = true;
    testMessage = '';
    const port = Math.min(65535, Math.max(1, Math.floor(Number(draft.port) || 22)));
    try {
      const results = await invoke<PortProbe[]>('net_port_scan', { host: draft.host.trim(), ports: String(port) });
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
  }

  function addSession(): void {
    const created = freshSession();
    sessions = [...sessions, created];
    activeId = created.id;
    draft = { ...created };
    editing = true;
  }

  function editSession(): void {
    if (!active) return;
    draft = { ...active };
    editing = true;
  }

  function deleteSession(id: string): void {
    const target = sessionById(id);
    if (!target) return;
    if (openTabs.includes(id)) {
      invoke('ssh_close', { sessionId: id }).catch(() => undefined);
    }
    sessions = sessions.filter((item) => item.id !== id);
    openTabs = openTabs.filter((tabId) => tabId !== id);
    statusMap = { ...statusMap };
    delete statusMap[id];
    if (activeId === id) activeId = sessions[0]?.id ?? '';
    saveSessions(sessions);
    if (editing && draft?.id === id) editing = false;
  }

  function saveDraft(): void {
    if (!draft) return;
    const cleaned: RemoteSession = {
      ...draft,
      name: draft.name.trim() || (draft.user || 'root') + '@' + (draft.host || 'host'),
      host: draft.host.trim(),
      user: draft.user.trim(),
      port: Math.min(65535, Math.max(1, Math.floor(Number(draft.port) || 22))),
    };
    const exists = sessions.some((item) => item.id === cleaned.id);
    sessions = exists ? sessions.map((item) => (item.id === cleaned.id ? cleaned : item)) : [...sessions, cleaned];
    saveSessions(sessions);
    activeId = cleaned.id;
    editing = false;
  }

  function connect(): void {
    if (!active) return;
    if (openTabs.includes(active.id)) {
      nonceMap = { ...nonceMap, [active.id]: (nonceMap[active.id] ?? 0) + 1 };
    } else {
      openTabs = [...openTabs, active.id];
      nonceMap = { ...nonceMap, [active.id]: 0 };
    }
    statusMap = { ...statusMap, [active.id]: { status: 'connecting', message: '正在连接 ' + active.host + ':' + active.port + ' …' } };
  }

  function closeTab(id: string): void {
    invoke('ssh_close', { sessionId: id }).catch(() => undefined);
    openTabs = openTabs.filter((tabId) => tabId !== id);
  }

  function handleTerminalState(id: string, state: SessionState): void {
    statusMap = { ...statusMap, [id]: state };
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

<div class="remote-panel">
  <aside class="remote-side">
    <div class="remote-side-head"><b>会话</b><button class="remote-add" title="新建会话" onclick={addSession}><span>{@html UI_ICONS.plus}</span></button></div>
    <div class="remote-sessions">
      {#each sessions as item}
        <button class="remote-session" class:active={activeId === item.id} onclick={() => select(item.id)}>
          <span class="rs-icon">{@html iconHtml(TOOL_ICONS['spurh.remote'])}</span>
          <span class="rs-copy"><b>{item.name || (item.user || 'root') + '@' + item.host}</b><small>{item.host}:{item.port}</small></span>
          <i class="rs-dot" class:connected={statusMap[item.id]?.status === 'connected'} class:busy={statusMap[item.id]?.status === 'connecting' || statusMap[item.id]?.status === 'idle'}></i>
        </button>
      {/each}
      {#if sessions.length === 0}
        <div class="rs-empty">还没有会话<br />点击右上角 + 新建</div>
      {/if}
    </div>
  </aside>

  <main class="remote-main">
    {#if editing && draft}
      {@const d = draft}
      <div class="remote-form">
        <header><b>{d.id && sessions.some((item) => item.id === d.id) ? '编辑会话' : '新建会话'}</b><button class="form-close" onclick={() => (editing = false)} aria-label="关闭">{@html UI_ICONS.close}</button></header>
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
          <button class="form-cancel" onclick={() => { editing = false; testMessage = ''; }}>取消</button>
          <button class="form-save" disabled={!d.host.trim() || !d.user.trim()} onclick={saveDraft}>保存</button>
        </footer>
      </div>
    {:else if active}
      <div class="remote-toolbar">
        <div class="rt-identity">
          <span class="rs-icon">{@html iconHtml(TOOL_ICONS['spurh.remote'])}</span>
          <div><b>{active.name || (active.user || 'root') + '@' + active.host}</b><small>{active.user}@{active.host}:{active.port}</small></div>
        </div>
        <div class="rt-status" class:connected={activeStatus.status === 'connected'} class:error={activeStatus.status === 'error'} class:connecting={activeStatus.status === 'connecting'}>
          <i></i><span>{statusLabel(activeStatus)}{activeStatus.message ? ' · ' + activeStatus.message : ''}</span>
        </div>
        <div class="rt-actions">
          <button class="rt-connect" onclick={connect}><span class="rt-dot"></span>{activeStatus.status === 'connected' ? '重连' : '连接'}</button>
          <button class="rt-quiet" onclick={editSession}>编辑</button>
          <button class="rt-quiet danger" onclick={() => deleteSession(active.id)}>删除</button>
        </div>
      </div>
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
      <div class="remote-terminal">
        {#each openTabs as tabId}
          {#key tabId + ':' + (nonceMap[tabId] ?? 0)}
            {@const tab = sessionById(tabId)}
            {#if tab}
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
  .remote-panel { min-width: 0; min-height: 0; flex: 1; display: grid; grid-template-columns: 232px minmax(0, 1fr); overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); }
  .remote-side { min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--panel); }
  .remote-side-head { height: 44px; flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 0 10px 0 14px; border-bottom: 1px solid var(--line); }
  .remote-side-head b { font-size: 11px; letter-spacing: .2px; }
  .remote-add { width: 26px; height: 26px; display: grid; place-items: center; cursor: pointer; color: var(--muted); border: 1px solid var(--line); border-radius: 7px; background: transparent; transition: all .15s ease; }
  .remote-add span { display: inline-flex; }
  :global(.remote-add span svg) { width: 12px; height: 12px; }
  .remote-add:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .remote-sessions { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; padding: 8px; overflow-y: auto; }
  .remote-session { width: 100%; min-height: 52px; display: flex; align-items: center; gap: 9px; padding: 7px 9px; cursor: pointer; text-align: left; color: var(--text); border: 1px solid transparent; border-radius: 9px; background: transparent; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease; }
  .remote-session:hover { background: var(--hover); }
  .remote-session.active { border-color: color-mix(in srgb, var(--accent) 22%, var(--line)); background: var(--panel-2); box-shadow: inset 2px 0 0 var(--accent), 0 2px 10px rgba(0, 0, 0, .08); }
  .rs-icon { width: 32px; height: 32px; display: grid; place-items: center; flex: 0 0 auto; color: var(--accent); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  :global(.rs-icon svg) { width: 16px; height: 16px; }
  .rs-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .rs-copy b { overflow: hidden; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
  .rs-copy small { overflow: hidden; color: var(--muted); font: 500 8.5px 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .rs-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--muted-2); transition: background .2s ease, box-shadow .2s ease; }
  .rs-dot.connected { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .rs-dot.busy { background: var(--blue); box-shadow: 0 0 8px var(--blue); animation: rem-pulse 1s ease-in-out infinite; }
  @keyframes rem-pulse { 50% { opacity: .35; } }
  .rs-empty { padding: 26px 10px; color: var(--muted-2); font-size: 9.5px; line-height: 1.8; text-align: center; }
  .remote-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--panel-2); }
  .remote-toolbar { min-height: 54px; flex: 0 0 auto; display: flex; align-items: center; gap: 12px; padding: 8px 13px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .rt-identity { min-width: 0; display: flex; align-items: center; gap: 10px; }
  .rt-identity > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rt-identity b { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .rt-identity small { color: var(--muted); font: 500 9px 'Cascadia Code', monospace; }
  .rt-status { display: flex; align-items: center; gap: 7px; padding: 5px 10px; color: var(--muted); font-size: 9.5px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); transition: all .2s ease; }
  .rt-status i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-2); }
  .rt-status.connected { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); background: var(--accent-soft); }
  .rt-status.connected i { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .rt-status.connecting { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 30%, var(--line)); background: color-mix(in srgb, var(--blue) 8%, transparent); }
  .rt-status.connecting i { background: var(--blue); box-shadow: 0 0 8px var(--blue); animation: rem-pulse 1s ease-in-out infinite; }
  .rt-status.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, var(--line)); background: color-mix(in srgb, var(--danger) 7%, transparent); }
  .rt-status.error i { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .rt-actions { display: flex; gap: 6px; margin-left: auto; }
  .rt-connect { height: 30px; display: inline-flex; align-items: center; gap: 7px; padding: 0 14px; cursor: pointer; color: #fff; font-size: 10.5px; font-weight: 700; border: 0; border-radius: 7px; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 5px 16px color-mix(in srgb, var(--accent) 20%, transparent); transition: transform .12s ease, box-shadow .15s ease; }
  .rt-connect:hover { transform: translateY(-1px); box-shadow: 0 8px 20px color-mix(in srgb, var(--accent) 30%, transparent); }
  .rt-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
  .rt-quiet { height: 30px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: 10px; border: 1px solid var(--line); border-radius: 7px; background: transparent; transition: all .15s ease; }
  .rt-quiet:hover { color: var(--text); border-color: var(--line-2); background: var(--hover); }
  .rt-quiet.danger:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .remote-tabs { flex: 0 0 auto; display: flex; gap: 4px; padding: 7px 10px 0; border-bottom: 1px solid var(--line); background: var(--panel); }
  .remote-tab { position: relative; height: 31px; display: flex; align-items: center; gap: 7px; padding: 0 8px 0 11px; cursor: pointer; color: var(--muted); font-size: 10px; border: 1px solid var(--line); border-radius: 8px 8px 0 0; border-bottom: 0; background: var(--bg); transition: color .15s ease, background .15s ease; }
  .remote-tab:hover { color: var(--text); }
  .remote-tab.active { color: var(--text); background: var(--panel-2); box-shadow: inset 0 2px 0 color-mix(in srgb, var(--accent) 85%, transparent); }
  .remote-tab i { width: 5px; height: 5px; border-radius: 50%; background: var(--muted-2); }
  .remote-tab i.connected { background: var(--accent); box-shadow: 0 0 7px var(--accent); }
  .remote-tab i.error { background: var(--danger); box-shadow: 0 0 7px var(--danger); }
  .remote-tab b { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .tab-close { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; cursor: pointer; color: var(--muted-2); font-size: 12px; line-height: 1; border: 0; border-radius: 4px; background: transparent; }
  .tab-close:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .remote-terminal { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
  .rt-empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 8px; color: var(--muted); text-align: center; }
  .rt-empty > span { width: 46px; height: 46px; display: grid; place-items: center; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 13px; background: var(--accent-soft); }
  :global(.rt-empty > span svg) { width: 22px; height: 22px; }
  .rt-empty b { color: var(--text); font-size: 12.5px; }
  .rt-empty p { margin: 0; font-size: 9.5px; }
  .rt-empty.main > button { margin-top: 8px; }
  .remote-form { min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: auto; }
  .remote-form > header { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .remote-form > header b { font-size: 12.5px; }
  .form-close { width: 28px; height: 28px; display: grid; place-items: center; cursor: pointer; color: var(--muted); border: 0; border-radius: 7px; background: transparent; }
  .form-close:hover { color: var(--text); background: var(--hover); }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; padding: 18px; }
  .form-grid label { display: flex; flex-direction: column; gap: 6px; }
  .form-grid label > span { color: var(--muted); font-size: 10px; }
  .form-grid input { height: 33px; padding: 0 11px; color: var(--text); font: 500 11px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 7px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .form-grid input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .form-grid .form-port input { max-width: 130px; }
  .form-grid .form-full { grid-column: 1 / -1; }
  .secret-wrap { position: relative; display: flex; align-items: center; }
  .secret-wrap input { width: 100%; padding-right: 34px; }
  .secret-toggle { position: absolute; right: 5px; width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer; color: var(--muted-2); font-size: 12px; border: 0; border-radius: 5px; background: transparent; }
  :global(.secret-toggle svg) { width: 13px; height: 13px; }
  .secret-toggle:hover { color: var(--text); background: var(--hover); }
  .form-auth { display: flex; flex-direction: column; gap: 6px; }
  .form-auth > span { color: var(--muted); font-size: 10px; }
  .auth-chips { display: inline-flex; gap: 2px; align-self: flex-start; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .auth-chips button { height: 26px; padding: 0 14px; cursor: pointer; color: var(--muted); font-size: 10px; border: 0; border-radius: 6px; background: transparent; transition: all .15s ease; }
  .auth-chips button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .auth-chips button.active { color: #fff; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .remote-form > footer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--panel); }
  .form-hint { flex: 1; color: var(--muted-2); font-size: 9px; }
  .form-test { color: var(--danger); font-size: 10px; white-space: nowrap; }
  .form-test.ok { color: var(--accent); }
  .form-cancel { height: 30px; padding: 0 12px; cursor: pointer; color: var(--muted); font-size: 10px; border: 1px solid var(--line); border-radius: 7px; background: transparent; transition: all .15s ease; }
  .form-cancel:hover { color: var(--text); border-color: var(--line-2); }
  .form-save { height: 30px; padding: 0 16px; cursor: pointer; color: #fff; font-size: 10.5px; font-weight: 700; border: 0; border-radius: 7px; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 5px 16px color-mix(in srgb, var(--accent) 20%, transparent); transition: transform .12s ease, box-shadow .15s ease, opacity .15s ease; }
  .form-save:hover:not(:disabled) { transform: translateY(-1px); }
  .form-save:disabled { cursor: default; opacity: .4; }
</style>
