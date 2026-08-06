# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

p = Path(r"D:\work\spurh\src\lib\panels\SqlPanel.svelte")
text = p.read_text(encoding="utf-8")
orig = text
ok = []
miss = []

def rep(old, new, tag):
    global text
    if old not in text:
        miss.append(tag)
        return
    text = text.replace(old, new, 1)
    ok.append(tag)

# 1) profileOf：端口归一化为 number（表单中 input[type=text] 会把 port 写成字符串，直接传给 Rust u16 会反序列化失败）
rep("""      port: conn.port || undefined,""",
    """      port: conn.port ? Number(conn.port) : undefined,""",
    "profileOf port normalize")

# 2) 状态：dbFetching / dbList
rep("""  let testing = $state(false);
  let formError = $state('');
  let formOk = $state('');""",
    """  let testing = $state(false);
  let formError = $state('');
  let formOk = $state('');
  let dbFetching = $state(false);
  let dbList = $state<string[]>([]);""",
    "db state")

# 3) 拉取数据库函数（testForm 之后）
rep("""  function saveForm(): void {""",
    """  /** 从服务器拉取数据库列表，供默认数据库下拉选择（密码与端口均来自表单草稿） */
  async function fetchFormDatabases(): Promise<void> {
    if (!formDraft || formDraft.kind === 'sqlite') return;
    dbFetching = true;
    formError = '';
    formOk = '';
    try {
      const names = await safeInvoke<string[]>('sql_databases', { profile: profileOf(formDraft) });
      dbList = names;
      formOk = '已发现 ' + names.length + ' 个数据库，可在上方选择（留空 = 全部）';
    } catch (cause) {
      formError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      dbFetching = false;
    }
  }

  function saveForm(): void {""",
    "fetchFormDatabases")

# 4) 三处打开表单时重置 dbList
for old, tag in [
    ("""  function openNewConn(): void {
    editingConn = null;
    formDraft = { ...freshConn() };
    formError = '';
    formOk = '';
    showSecret = false;
    formOpen = true;
  }""", "openNewConn"),
    ("""  function openEditConn(): void {
    if (!activeConn) return;
    editingConn = activeConn;
    formDraft = { ...activeConn };
    formError = '';
    formOk = '';
    showSecret = false;
    formOpen = true;
  }""", "openEditConn"),
    ("""  function openEditConnFor(conn: SavedConn): void {
    editingConn = conn;
    formDraft = { ...conn };
    formError = '';
    formOk = '';
    showSecret = false;
    formOpen = true;
  }""", "openEditConnFor"),
]:
    rep(old, old.replace("    formOpen = true;", "    dbList = [];\n    formOpen = true;"), tag)

# 5) 模板：端口行加 SSL、默认数据库加 datalist + 拉取按钮
rep("""            <label class="port"><span>端口</span><input bind:value={d.port} placeholder={d.kind === 'mysql' ? '3306' : '5432'} spellcheck="false" /></label>""",
    """            <label class="port"><span>端口</span>
              <span class="port-ssl">
                <input bind:value={d.port} placeholder={d.kind === 'mysql' ? '3306' : '5432'} spellcheck="false" />
                <label class="ssl-inline" title="SSL 加密连接（远程数据库建议开启）"><input type="checkbox" bind:checked={d.ssl} /><span>SSL</span></label>
              </span>
            </label>""",
    "port ssl row")

rep("""            <label class="full"><span>默认数据库（可选）</span><input bind:value={d.database} placeholder="留空则在连接后选择" spellcheck="false" /></label>
            <label class="full ssl-row"><span>SSL 加密连接</span><input type="checkbox" bind:checked={d.ssl} /><i>连接远程数据库时建议开启，避免密码明文传输</i></label>""",
    """            <label class="full"><span>默认数据库</span>
              <span class="sql-db-picker">
                <input list="sql-db-list" bind:value={d.database} placeholder="全部（留空则连接后选择）" spellcheck="false" />
                <datalist id="sql-db-list">{#each dbList as name}<option value={name}></option>{/each}</datalist>
                <button class="sql-btn ghost" disabled={dbFetching || d.kind === 'sqlite'} onclick={fetchFormDatabases}>{dbFetching ? '拉取中…' : '拉取数据库'}</button>
              </span>
            </label>""",
    "database picker")

# 6) CSS 追加
rep("""  .sql-form-hint { flex: 1; color: var(--muted-2); font-size: 10.4px; }""",
    """  .sql-form-hint { flex: 1; color: var(--muted-2); font-size: 10.4px; }
  .sql-db-picker { display: flex; align-items: center; gap: 8px; }
  .sql-db-picker input { min-width: 0; flex: 1; }
  .sql-db-picker .sql-btn { flex: 0 0 auto; height: 32px; }
  .port-ssl { display: flex; align-items: center; gap: 8px; }
  .port-ssl input { width: 100%; }
  .ssl-inline { display: inline-flex; flex-direction: row; align-items: center; gap: 5px; white-space: nowrap; cursor: pointer; }
  .ssl-inline input { width: auto; }
  .ssl-inline span { color: var(--muted); font-size: 12.5px; }""",
    "css append")

if text != orig:
    p.write_text(text, encoding="utf-8", newline="")
print("OK:", ok)
print("MISS:", miss)