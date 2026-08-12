<script lang="ts">
  import {
    onMount,
  } from 'svelte';
  import { safeInvoke } from '../env';
  import { UI_ICONS } from '../icons';

  type ConnKind = 'mysql' | 'postgres' | 'sqlite';
  type SavedConn = {
    id: string;
    name: string;
    kind: ConnKind;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    file: string;
    ssl: boolean;
    createdAt: number;
  };
  type DbNode = { name: string; expanded: boolean; tables: Array<{ name: string; kind: string }> | null; loading: boolean };

  let { conn, databases }: {
    conn: SavedConn | null;
    databases: DbNode[];
  } = $props();

  function profileOf(c: SavedConn) {
    return {
      kind: c.kind,
      host: c.host,
      port: c.port ? Number(c.port) : undefined,
      user: c.user || undefined,
      password: c.password || undefined,
      database: c.database || undefined,
      file: c.file || undefined,
      ssl: c.ssl,
    };
  }

  const PRIVILEGE_OPTIONS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALL PRIVILEGES'];
  type SqlUser = { name: string; host: string | null; attributes: Array<{ key: string; value: string }> };
  let users = $state<SqlUser[]>([]);
  let usersLoading = $state(false);
  let usersError = $state('');
  let grantsError = $state('');
  let usersMsg = $state('');
  let showCreate = $state(false);
  let sqliteMode = $derived(conn?.kind === 'sqlite');
  let newUserName = $state('');
  let newUserHost = $state('%');
  let newUserPassword = $state('');
  let newShowPwd = $state(false);
  let creating = $state(false);
  let grantsMap = $state<Record<string, string[]>>({});
  let grantsLoading = $state('');
  let pwdFor = $state('');
  let pwdValue = $state('');
  let pwdShow = $state(false);
  let savingPwd = $state(false);
  let dropFor = $state('');
  let dropping = $state(false);
  let grantDb = $state('');
  let grantPrivs = $state<Record<string, Set<string>>>({});
  const DEFAULT_PRIVS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  function privsFor(key: string): Set<string> {
    return grantPrivs[key] ?? DEFAULT_PRIVS;
  }
  let grantBusy = $state(false);
  let grantMsg = $state('');

  function userKey(u: SqlUser): string {
    return u.host ? u.name + '@' + u.host : u.name;
  }

  async function loadUsers(): Promise<void> {
    if (!conn || conn.kind === 'sqlite') {
      users = [];
      usersError = '';
      return;
    }
    usersLoading = true;
    usersError = '';
    usersMsg = '';
    try {
      users = await safeInvoke<SqlUser[]>('sql_users', { profile: profileOf(conn) });
      grantsMap = {};
    } catch (cause) {
      usersError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      usersLoading = false;
    }
  }

  async function loadGrantsFor(u: SqlUser): Promise<void> {
    if (!conn) return;
    const key = userKey(u);
    grantsLoading = key;
    grantsError = '';
    try {
      const lines = await safeInvoke<string[]>('sql_user_grants', { profile: profileOf(conn), name: u.name, host: u.host });
      grantsMap = { ...grantsMap, [key]: lines };
      if (!grantPrivs[key]) grantPrivs = { ...grantPrivs, [key]: new Set(DEFAULT_PRIVS) };
    } catch (cause) {
      grantsError = (cause instanceof Error ? cause.message : String(cause)) + '（' + key + '）';
    } finally {
      grantsLoading = '';
    }
  }

  function toggleGrants(u: SqlUser): void {
    const key = userKey(u);
    if (grantsMap[key]) {
      const next = { ...grantsMap };
      delete next[key];
      grantsMap = next;
      return;
    }
    loadGrantsFor(u);
  }

  async function createUser(): Promise<void> {
    if (!conn || !newUserName.trim()) return;
    creating = true;
    usersError = '';
    usersMsg = '';
    try {
      const stmt = await safeInvoke<string>('sql_create_user', {
        profile: profileOf(conn),
        name: newUserName.trim(),
        host: conn.kind === 'mysql' ? newUserHost.trim() || '%' : '',
        password: newUserPassword,
      });
      usersMsg = '用户创建成功：' + stmt;
      showCreate = false;
      newUserName = '';
      newUserHost = '%';
      newUserPassword = '';
      await loadUsers();
    } catch (cause) {
      usersError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      creating = false;
    }
  }

  async function dropUser(u: SqlUser): Promise<void> {
    if (!conn) return;
    const key = userKey(u);
    if (dropFor !== key) {
      dropFor = key;
      return;
    }
    dropFor = '';
    dropping = true;
    usersError = '';
    usersMsg = '';
    try {
      const stmt = await safeInvoke<string>('sql_drop_user', { profile: profileOf(conn), name: u.name, host: u.host ?? '' });
      usersMsg = '用户已删除：' + stmt;
      await loadUsers();
    } catch (cause) {
      usersError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      dropping = false;
    }
  }

  async function savePassword(u: SqlUser): Promise<void> {
    if (!conn || !pwdValue) return;
    savingPwd = true;
    usersError = '';
    usersMsg = '';
    try {
      const stmt = await safeInvoke<string>('sql_set_password', { profile: profileOf(conn), name: u.name, host: u.host ?? '', password: pwdValue });
      usersMsg = '密码已更新：' + stmt;
      pwdFor = '';
      pwdValue = '';
    } catch (cause) {
      usersError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      savingPwd = false;
    }
  }

  function togglePriv(key: string, p: string, on: boolean): void {
    const next = new Set(privsFor(key));
    if (on) next.add(p);
    else next.delete(p);
    grantPrivs = { ...grantPrivs, [key]: next };
  }

  async function applyPrivileges(u: SqlUser, grant: boolean): Promise<void> {
    if (!conn) return;
    const key = userKey(u);
    const privileges = Array.from(privsFor(key));
    if (privileges.length === 0) {
      grantMsg = '请至少勾选一项权限';
      return;
    }
    grantBusy = true;
    grantMsg = '';
    usersError = '';
    try {
      await safeInvoke<string[]>('sql_grant_privileges', {
        profile: profileOf(conn),
        name: u.name,
        host: u.host ?? '',
        database: grantDb,
        privileges,
        grant,
      });
      grantMsg = (grant ? '已授权：' : '已回收：') + privileges.join(', ') + (grantDb ? ' @ ' + grantDb : '（全部数据库）');
      if (grantsMap[userKey(u)]) await loadGrantsFor(u);
    } catch (cause) {
      grantMsg = '';
      usersError = (cause instanceof Error ? cause.message : String(cause)) + '（' + userKey(u) + '）';
    } finally {
      grantBusy = false;
    }
  }


  onMount(() => {
    loadUsers();
  });
</script>

<div class="sql-users">
          {#if sqliteMode}
            <div class="sql-users-guide">
              <span class="sql-users-guide-ico">{@html UI_ICONS.users}</span>
              <b>当前连接为 SQLite</b>
              <p>SQLite 是嵌入式数据库，没有用户与权限体系。连接 MySQL 或 PostgreSQL 后即可使用「用户管理」：创建 / 删除用户、修改密码、授权与回收权限。</p>
              <em>在左侧数据库树顶部「＋ 新建连接」中选择 MySQL / PostgreSQL 即可体验</em>
            </div>
          {:else}
          <div class="sql-users-bar">
            <div class="sql-data-title">
              <span class="tbl-ico big">{@html UI_ICONS.users}</span>
              <b>用户管理</b>
              <em>{conn?.kind === 'mysql' ? 'MySQL' : 'PostgreSQL'}</em>
              <small>{users.length} 个账号 · 创建 / 删除用户、修改密码、授权与回收</small>
            </div>
            <div class="sql-data-actions">
              <button class="sql-btn ghost" disabled={usersLoading} onclick={loadUsers} title="刷新用户列表">{@html UI_ICONS.refresh}刷新</button>
              <button class="sql-btn primary" onclick={() => (showCreate = true)}>{@html UI_ICONS.plus} 新建用户</button>
            </div>
          </div>
          {#if usersError}<div class="sql-error"><i></i>{usersError}</div>{/if}
          {#if grantsError}<div class="sql-error"><i></i>{grantsError}</div>{/if}
          {#if usersMsg}<div class="sql-ok"><i></i>{usersMsg}</div>{/if}
          {#if showCreate}
            <div class="sql-user-create">
              <b>新建用户</b>
              <label><span>用户名</span><input bind:value={newUserName} placeholder="例如 alice" spellcheck="false" /></label>
              {#if conn?.kind === 'mysql'}
                <label><span>主机</span><input bind:value={newUserHost} placeholder="% 或 localhost" spellcheck="false" /></label>
              {/if}
              <label><span>密码</span>
                <span class="sql-secret">
                  <input type={newShowPwd ? 'text' : 'password'} bind:value={newUserPassword} placeholder="登录密码" spellcheck="false" />
                  <button class="sql-secret-toggle" onclick={() => (newShowPwd = !newShowPwd)} title="显示 / 隐藏密码">{@html newShowPwd ? UI_ICONS.eyeOff : UI_ICONS.eye}</button>
                </span>
              </label>
              <button class="sql-btn primary" disabled={creating || !newUserName.trim()} onclick={createUser}>{creating ? '创建中…' : '创建'}</button>
              <button class="sql-btn ghost" onclick={() => (showCreate = false)}>取消</button>
            </div>
          {/if}
          {#if usersLoading}
            <div class="sql-users-empty">正在读取用户列表…</div>
          {:else if users.length === 0}
            <div class="sql-users-empty">未读取到用户（当前账号可能缺少 mysql.user / pg_roles 读取权限）</div>
          {:else}
            <div class="sql-users-list">
              {#each users as u}
                {@const key = userKey(u)}
                <div class="sql-user-card">
                  <div class="sql-user-head">
                    <span class="sql-user-avatar">{u.name.slice(0, 1).toUpperCase()}</span>
                    <div class="sql-user-id">
                      <b>{u.name}</b><small>{u.host ? '@' + u.host : '（角色）'}</small>
                    </div>
                    <div class="sql-user-attrs">
                      {#each u.attributes as attr}<em title={`${attr.key}: ${attr.value}`}>{attr.key} {attr.value}</em>{/each}
                    </div>
                    <div class="sql-user-actions">
                      <button class="sql-btn ghost" disabled={grantsLoading === key} onclick={() => toggleGrants(u)} title="查看 / 管理该账号权限">
                        {grantsLoading === key ? '读取中…' : grantsMap[key] ? '收起权限' : '权限'}
                      </button>
                      <button class="sql-btn ghost" onclick={() => (pwdFor = pwdFor === key ? '' : key)} title="修改密码">{@html UI_ICONS.key}改密</button>
                      <button class="sql-btn ghost danger" disabled={dropping} onclick={() => dropUser(u)} title="删除该账号">
                        {dropFor === key ? '确认删除？' : ''}{@html UI_ICONS.trash}删除
                      </button>
                    </div>
                  </div>
                  {#if pwdFor === key}
                    <div class="sql-user-panel">
                      <label><span>新密码</span>
                        <span class="sql-secret">
                          <input type={pwdShow ? 'text' : 'password'} bind:value={pwdValue} placeholder="输入新密码" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && savePassword(u)} />
                          <button class="sql-secret-toggle" onclick={() => (pwdShow = !pwdShow)} title="显示 / 隐藏密码">{@html pwdShow ? UI_ICONS.eyeOff : UI_ICONS.eye}</button>
                        </span>
                      </label>
                      <button class="sql-btn primary" disabled={savingPwd || !pwdValue} onclick={() => savePassword(u)}>{savingPwd ? '保存中…' : '保存密码'}</button>
                      <button class="sql-btn ghost" onclick={() => (pwdFor = '')}>取消</button>
                    </div>
                  {/if}
                  {#if grantsMap[key]}
                    <div class="sql-user-panel grants">
                      <div class="sql-grants-head">
                        <b>权限管理</b>
                        <select bind:value={grantDb} title="授权作用数据库（默认全部）">
                          <option value="">全部数据库</option>
                          {#each databases as db}<option value={db.name}>{db.name}</option>{/each}
                        </select>
                        <span class="sql-privs">
                          {#each ['SELECT','INSERT','UPDATE','DELETE','CREATE','DROP','ALL PRIVILEGES'] as p}
                            <label><input type="checkbox" checked={privsFor(key).has(p)} onchange={(e) => togglePriv(key, p, (e.currentTarget as HTMLInputElement).checked)} />{p}</label>
                          {/each}
                        </span>
                        <button class="sql-btn ghost" disabled={grantBusy} onclick={() => applyPrivileges(u, true)}>授权</button>
                        <button class="sql-btn ghost danger" disabled={grantBusy} onclick={() => applyPrivileges(u, false)}>回收</button>
                      </div>
                      {#if grantMsg}<div class="sql-grants-msg">{grantMsg}</div>{/if}
                      <div class="sql-grants-lines">
                        {#each grantsMap[key] as line}<code>{line}</code>{/each}
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/if}
</div>

<style>
  .sql-users { display: flex; flex-direction: column; gap: 10px; }
  .sql-users-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .sql-users-empty { padding: 34px 16px; color: var(--muted); font-size: var(--fs-xs); text-align: center; border: 1px dashed var(--line-2); border-radius: 8px; }
  .sql-users-list { display: flex; flex-direction: column; gap: 8px; }
  .sql-user-card { border: 1px solid var(--line); border-radius: 11px; background: var(--panel); }
  .sql-user-head { display: flex; align-items: center; gap: 12px; padding: 10px 12px; flex-wrap: wrap; }
  .sql-user-avatar { width: 34px; height: 34px; display: grid; place-items: center; flex: 0 0 auto; color: var(--accent); font: 700 14px 'Cascadia Code', monospace; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius: 8px; background: var(--accent-soft); }
  .sql-user-id { min-width: 120px; display: flex; flex-direction: column; gap: 2px; }
  .sql-user-id b { font-size: var(--fs-xs); }
  .sql-user-id small { color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', monospace; }
  .sql-user-attrs { display: flex; gap: 5px; flex-wrap: wrap; }
  .sql-user-attrs em { padding: 2px 7px; color: var(--muted); font-size: var(--fs-xs); font-style: normal; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
  .sql-user-actions { display: flex; gap: 6px; margin-left: auto; }
  .sql-user-panel { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border-top: 1px solid var(--line); background: var(--panel-2); }
  .sql-user-panel label { display: flex; flex-direction: column; gap: 4px; min-width: 220px; flex: 1; }
  .sql-user-panel label span { color: var(--muted); font-size: var(--fs-xs); }
  .sql-user-panel.grants { flex-direction: column; align-items: stretch; }
  .sql-grants-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sql-grants-head b { font-size: var(--fs-xs); }
  .sql-grants-head select { height: 30px; padding: 0 8px; color: var(--text); font-size: var(--fs-sm); border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel); outline: 0; }
  .sql-privs { display: flex; gap: 4px 10px; flex-wrap: wrap; }
  .sql-privs label { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: var(--fs-xs); flex: 0 0 auto; min-width: 0; }
  .sql-privs input { width: auto; accent-color: var(--accent); cursor: pointer; }
  .sql-privs label:hover { color: var(--text); }
  .sql-grants-msg { color: var(--accent); font-size: var(--fs-xs); }
  .sql-grants-lines { display: flex; flex-direction: column; gap: 3px; max-height: 220px; overflow: auto; }
  .sql-grants-lines code { padding: 4px 8px; color: var(--text); font: 450 var(--fs-xs)/1.5 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); white-space: pre-wrap; word-break: break-all; }
  .sql-user-create { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; padding: 12px; border: 1px dashed var(--line-2); border-radius: 11px; background: var(--panel-2); }
  .sql-user-create > b { width: 100%; font-size: var(--fs-xs); }
  .sql-user-create label { display: flex; flex-direction: column; gap: 4px; min-width: 160px; flex: 1; }
  .sql-user-create label span { color: var(--muted); font-size: var(--fs-xs); }
  .sql-user-create .sql-secret { display: flex; align-items: center; gap: 6px; position: relative; }
  .sql-user-panel .sql-secret { display: flex; align-items: center; gap: 6px; position: relative; }
  .sql-user-create .sql-secret input, .sql-user-panel .sql-secret input { padding-right: 34px; }
  .sql-secret-toggle { position: absolute; right: 5px; width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer; color: var(--muted-2); border: 0; border-radius: 8px; background: transparent; }
  .sql-secret-toggle:hover { color: var(--text); background: var(--hover); }
  .sql-user-create input[type='text'], .sql-user-create input[type='password'], .sql-user-panel input[type='text'], .sql-user-panel input[type='password'] { height: 30px; padding: 0 10px; color: var(--text); font-size: var(--fs-sm); border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel); outline: 0; }
  .sql-user-create input:focus, .sql-user-panel input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line-2)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .sql-error { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; color: var(--danger); font-size: var(--fs-xs); line-height: 1.5; border: 1px solid color-mix(in srgb, var(--danger) 28%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .sql-error i { width: 6px; height: 6px; flex: 0 0 auto; margin-top: 4px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .sql-ok { display: flex; align-items: center; gap: 8px; padding: 7px 12px; color: var(--accent); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line)); border-radius: 8px; background: var(--accent-soft); }
  .sql-ok i { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }

  .sql-users-guide { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 42px 24px; text-align: center; border: 1px dashed var(--line-strong); border-radius: 14px; background: var(--w-02); }
  .sql-users-guide-ico { display: grid; place-items: center; width: 54px; height: 54px; border-radius: 16px; color: var(--accent); background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); }
  .sql-users-guide-ico svg { width: 24px; height: 24px; }
  .sql-users-guide b { font-size: var(--fs); }
  .sql-users-guide p { max-width: 520px; margin: 0; color: var(--muted); font-size: var(--fs-sm); line-height: 1.7; }
  .sql-users-guide em { font-style: normal; color: var(--muted-2); font-size: var(--fs-xs); }

</style>
