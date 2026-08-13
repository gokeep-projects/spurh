<script lang="ts">
  import { onMount } from 'svelte';
  import { safeInvoke } from '../env';
  import { TOOL_ICONS, UI_ICONS, iconHtml } from '../icons';
  import AiAssist from './AiAssist.svelte';
  import SqlUsersPanel from './SqlUsersPanel.svelte';
  import type { AiConfig } from '../ai';
  import { deleteSecret, getSecret, setSecret } from '../secrets';
  import { highlightSql } from '../sqlHighlight';
  import { formatSql, SQL_COMPLETION_KEYWORDS } from '../sqlFormat';
  import { toCsv } from '../csv';

  let { aiConfig }: { aiConfig?: AiConfig | undefined } = $props();

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
  type ColumnInfo = { name: string; dataType: string; nullable: boolean; key: string; default: string | null; extra: string; comment?: string };
  type TableInfo = { name: string; kind: string };
  type RowsResult = { columns: ColumnInfo[]; rows: Array<Array<string | number | boolean | null>>; total: number; offset: number };
  type ExecResult = { columns: string[]; rows: Array<Array<string | number | boolean | null>>; affected: number; elapsedMs: number; truncated: boolean; isQuery: boolean };
  type DbNode = { name: string; expanded: boolean; tables: TableInfo[] | null; loading: boolean };

  const STORAGE_KEY = 'spurh.sql.connections.v1';
  const LAST_CONN_KEY = 'spurh.sql.lastConn.v1';
  const SQL_HISTORY_KEY = 'spurh.sql.history.v1';
  const PAGE_SIZE = 100;
  const PAGE_SIZES = [50, 100, 200, 500];
  const KIND_LABEL: Record<ConnKind, string> = { mysql: 'MySQL', postgres: 'PostgreSQL', sqlite: 'SQLite' };

  // 旧版 localStorage 中可能残留的明文密码，等待初始化时迁移到系统钥匙串
  let legacyPasswords: Array<{ id: string; password: string }> = [];

  function loadConnections(): SavedConn[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as SavedConn[];
      return parsed
        .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
        .map((item) => {
          if (item.password) legacyPasswords.push({ id: item.id, password: item.password });
          return { ...item, password: '' };
        });
    } catch {
      return [];
    }
  }

  /** 密码只存系统钥匙串：持久化时剥离，避免明文落盘。 */
  function saveConnections(list: SavedConn[]): void {
    const stripped = list.map(({ password: _pw, ...rest }) => rest);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
  }

  function loadSqlHistory(): string[] {
    try {
      const raw = localStorage.getItem(SQL_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 30) : [];
    } catch {
      return [];
    }
  }

  function saveSqlHistory(list: string[]): void {
    localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(list.slice(0, 30)));
  }

  /** 迁移旧明文密码到钥匙串，并从钥匙串加载当前连接的密码到内存。 */
  async function migrateAndHydrateSecrets(): Promise<void> {
    for (const item of legacyPasswords) {
      try { await setSecret('sql.' + item.id + '.password', item.password); } catch { /* 钥匙串不可用时忽略 */ }
    }
    legacyPasswords = [];
    try {
      const hydrated = await Promise.all(connections.map(async (conn) => ({
        ...conn,
        password: (await getSecret('sql.' + conn.id + '.password')) ?? '',
      })));
      connections = hydrated;
    } catch {
      // 浏览器预览模式：钥匙串不可用，保持密码为空，其余初始化不受影响
    }
    // 恢复上次使用的连接并自动连接（面板切换/重启后无需手动重连）
    const lastId = localStorage.getItem(LAST_CONN_KEY);
    if (lastId && connections.some((conn) => conn.id === lastId)) {
      activeId = lastId;
    }
    if (activeConn) connect();
  }

  onMount(() => { migrateAndHydrateSecrets(); });
  onMount(() => {
    const close = () => { formOpen = false; };
    window.addEventListener('spurh:settings-open', close);
    return () => window.removeEventListener('spurh:settings-open', close);
  });

  function freshConn(): SavedConn {
    return { id: crypto.randomUUID(), name: '', kind: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '', file: '', ssl: false, createdAt: Date.now() };
  }

  function profileOf(conn: SavedConn) {
    return {
      kind: conn.kind,
      host: conn.host,
      port: conn.port ? Number(conn.port) : undefined,
      user: conn.user || undefined,
      password: conn.password || undefined,
      database: conn.database || undefined,
      file: conn.file || undefined,
      ssl: conn.ssl,
    };
  }

  function cellText(value: string | number | boolean | null): string | null {
    if (value === null || value === undefined) return null;
    return String(value);
  }

  function connSubtitle(conn: SavedConn): string {
    if (conn.kind === 'sqlite') return 'SQLite · ' + (conn.file || '未指定文件');
    return conn.kind.toUpperCase() + ' · ' + (conn.host || '?') + (conn.port ? ':' + conn.port : '');
  }

  function dbIcon(kind: ConnKind): string {
    if (kind === 'mysql') return iconHtml(TOOL_ICONS['spurh.sql']);
    if (kind === 'postgres') return iconHtml(TOOL_ICONS['spurh.sql']);
    return iconHtml(TOOL_ICONS['spurh.sql']);
  }

  const DB_CYLINDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v13c0 1.55 3.58 2.8 8 2.8s8-1.25 8-2.8v-13"/><path d="M4 12c0 1.55 3.58 2.8 8 2.8s8-1.25 8-2.8"/></svg>`;
  const TABLE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9.5 9.5v10"/></svg>`;
  const VIEW_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5-9.5-6.5-9.5-6.5Z"/><circle cx="12" cy="12" r="2.8"/></svg>`;

  /* ── 连接状态 ── */
  let connections = $state<SavedConn[]>(loadConnections());
  let activeId = $state('');
  let connected = $state(false);
  let connecting = $state(false);
  let connError = $state('');
  let serverVersion = $state('');
  let databases = $state<DbNode[]>([]);
  let treeLoading = $state(false);

  const activeConn = $derived(connections.find((item) => item.id === activeId) ?? null);
  const activeDb = $derived(databases.find((db) => db.expanded)?.name ?? '');

  /* ── 表数据 ── */
  let selectedDb = $state('');
  let selectedTable = $state('');
  let tableKind = $state('TABLE');
  let meta = $state<{ columns: ColumnInfo[] } | null>(null);
  let rows = $state<Array<Array<string | number | boolean | null>>>([]);
  let total = $state(0);
  let page = $state(0);
  let pageSize = $state(PAGE_SIZE);
  let filterText = $state('');
  let filterEl = $state<HTMLInputElement | undefined>();
  let whereText = $state('');
  let loadingRows = $state(false);
  let rowError = $state('');
  let saveMessage = $state('');
  let ddl = $state('');
  let ddlError = $state('');

  // 编辑状态
  let draft = $state<Record<string, string | null>>({});
  let newRowDrafts = $state<Array<Record<string, string | null>>>([]);
  let editing = $state('');
  let editBuf = $state('');
  let editingInput = $state<HTMLInputElement | undefined>();
  let selectedRows = $state<Set<number>>(new Set());
  let pendingDeletes = $state<Array<string>>([]);
  let confirmDelete = $state(false);
  let deleteTimer: ReturnType<typeof setTimeout> | null = null;
  let saving = $state(false);

  const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));
  const isFiltered = $derived(filterText.trim().length > 0);
  const filteredRows = $derived.by(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => row.some((cell) => cell !== null && String(cell).toLowerCase().includes(q)));
  });
  const displayRows = $derived(isFiltered ? filteredRows : rows);
  const filteredCount = $derived(filteredRows.length);

  const pkCols = $derived(meta ? meta.columns.filter((col) => col.key === 'PRI') : []);
  const dirtyRows = $derived.by(() => {
    const set = new Set<number>();
    if (!meta) return set;
    for (let ri = 0; ri < rows.length; ri++) {
      for (let ci = 0; ci < meta.columns.length; ci++) {
        if (isDirty(ri, ci)) { set.add(ri); break; }
      }
    }
    return set;
  });
  const dirtyCount = $derived(dirtyRows.size);
  const draftCount = $derived(Object.keys(draft).length);
  const hasPending = $derived(draftCount > 0 || newRowDrafts.length > 0 || pendingDeletes.length > 0);

  /* ── SQL 编辑器 ── */
  let tab = $state<'data' | 'sql' | 'design' | 'users'>('data');
  let sqlText = $state('');
  let sqlRunning = $state(false);
  let sqlResult = $state<ExecResult | null>(null);
  let sqlError = $state('');
  let copiedKey = $state('');
  let sqlHistory = $state<string[]>(loadSqlHistory());
  let sqlHistoryOpen = $state(false);
  /* 连接级 Tab：后台连接保活 + 每连接 SQL 草稿 */
  let connectedIds = $state<string[]>([]);
  let queryDrafts = $state<Record<string, string>>({});
  let sqlEditorEl = $state<HTMLTextAreaElement | undefined>();
  let historyIndex = $state(-1);
  let sqlHelpOpen = $state(false);

  /** Ctrl+↑/↓ 在历史查询中前后切换（历史按最新在前存储） */
  function recallHistory(dir: 1 | -1): void {
    if (sqlHistory.length === 0) return;
    historyIndex = Math.max(-1, Math.min(sqlHistory.length - 1, historyIndex + dir));
    sqlText = historyIndex >= 0 ? sqlHistory[historyIndex] : '';
  }

  /* ── Ctrl+Space 智能补全：关键字 + 表名 + 当前表字段 ── */
  let completionOpen = $state(false);
  let completionItems = $state<string[]>([]);
  let completionIndex = $state(0);
  let completionPrefix = $state('');
  let completionGroup = $state('');

  // 表/字段名缓存（5 秒 TTL），避免每次补全都请求后端
  let schemaCache: { at: number; names: string[] } = { at: 0, names: [] };

  /** 异步获取当前库的表名（含树中已加载的表与字段） */
  async function ensureSchemaNames(): Promise<string[]> {
    const now = Date.now();
    if (now - schemaCache.at < 5000) return schemaCache.names;
    const treeNames: string[] = [];
    for (const db of databases) {
      for (const table of db.tables ?? []) treeNames.push(table.name);
    }
    try {
      const db = selectedDb || activeConn?.database || '';
      // SQLite 不依赖库名（连接即库）；MySQL/PG 需要库名才查询
      const needDb = activeConn?.kind === 'sqlite' || Boolean(db);
      const tables = needDb ? await safeInvoke<TableInfo[]>('sql_tables', { profile: profileOf(activeConn!), database: db }) : [];
      const names = Array.from(new Set([...treeNames, ...tables.map((table) => table.name)]));
      schemaCache = { at: now, names };
      return names;
    } catch {
      schemaCache = { at: now, names: treeNames };
      return treeNames;
    }
  }

  async function openCompletion(): Promise<void> {
    const el = sqlEditorEl;
    if (!el || !activeConn) return;
    const cursor = el.selectionStart ?? el.value.length;
    const before = sqlText.slice(0, cursor);
    const match = before.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    const prefix = match ? match[1] : '';
    completionPrefix = prefix;
    const lower = prefix.toLowerCase();
    const keywords = SQL_COMPLETION_KEYWORDS.filter((item) => item.toLowerCase().startsWith(lower));
    const schemaNames = await ensureSchemaNames();
    if (selectedTable && meta) {
      for (const col of meta.columns) schemaNames.push(col.name);
    }
    const schema = schemaNames.filter((item, index) => item.toLowerCase().startsWith(lower) && !keywords.includes(item) && schemaNames.indexOf(item) === index);
    const items = [...keywords, ...schema];
    if (items.length === 0) {
      completionOpen = false;
      return;
    }
    completionGroup = schema.length > 0 && prefix ? '关键字 + 表/字段' : '关键字';
    completionItems = items.slice(0, 30);
    completionIndex = 0;
    completionOpen = true;
  }

  function applyCompletion(): void {
    const el = sqlEditorEl;
    const item = completionItems[completionIndex];
    if (!el || !item) return;
    const cursor = el.selectionStart ?? el.value.length;
    const start = completionPrefix ? cursor - completionPrefix.length : cursor;
    const next = sqlText.slice(0, start) + item + sqlText.slice(cursor);
    sqlText = next;
    completionOpen = false;
    requestAnimationFrame(() => {
      const pos = start + item.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }
  // 查询结果客户端分页（后端最多返回 500 行）
  const RESULT_PAGE_SIZE = 100;
  let resultPage = $state(0);
  const resultTotalPages = $derived(sqlResult ? Math.max(1, Math.ceil(sqlResult.rows.length / RESULT_PAGE_SIZE)) : 1);
  const resultPageRows = $derived(sqlResult ? sqlResult.rows.slice(resultPage * RESULT_PAGE_SIZE, (resultPage + 1) * RESULT_PAGE_SIZE) : []);

  /* ── 表设计器 ── */
  type DesignColumn = {
    name: string;
    dataType: string;
    length: string;
    nullable: boolean;
    default: string;
    primaryKey: boolean;
    autoIncrement: boolean;
    comment: string;
  };

  const TYPE_OPTIONS: Record<ConnKind, string[]> = {
    mysql: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'VARCHAR', 'CHAR', 'TEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'DECIMAL', 'FLOAT', 'DOUBLE', 'BOOLEAN', 'BLOB', 'JSON'],
    postgres: ['INTEGER', 'BIGINT', 'SMALLINT', 'SERIAL', 'BIGSERIAL', 'VARCHAR', 'CHAR', 'TEXT', 'DATE', 'TIMESTAMP', 'TIME', 'NUMERIC', 'REAL', 'DOUBLE PRECISION', 'BOOLEAN', 'JSONB', 'UUID', 'BYTEA'],
    sqlite: ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'VARCHAR', 'DATE', 'DATETIME', 'BOOLEAN'],
  };

  let designTableName = $state('');
  let designIsNew = $state(true);
  let designColumns = $state<DesignColumn[]>([]);
  let designOriginal = $state<DesignColumn[]>([]);
  let designError = $state('');
  let designSaved = $state('');
  let designSaving = $state(false);

  /* ── 连接表单 ── */
  let formOpen = $state(false);
  let editingConn = $state<SavedConn | null>(null);
  let formDraft = $state<SavedConn | null>(null);
  let showSecret = $state(false);
  let testing = $state(false);
  let formError = $state('');
  let formOk = $state('');
  let dbFetching = $state(false);
  let dbList = $state<string[]>([]);
  let confirmDeleteId = $state('');
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  function selectConn(id: string): void {
    switchConn(id, false);
  }

  /** 切换连接：保留各连接的 SQL 草稿；已连接的后台保活，切回时快速重建树 */
  function switchConn(id: string, autoConnect: boolean): void {
    if (activeId && activeId !== id) queryDrafts[activeId] = sqlText;
    activeId = id;
    localStorage.setItem(LAST_CONN_KEY, id);
    const alreadyLive = connectedIds.includes(id);
    connected = alreadyLive;
    connError = '';
    serverVersion = '';
    databases = [];
    selectedTable = '';
    selectedDb = '';
    meta = null;
    rows = [];
    total = 0;
    sqlResult = null;
    sqlError = '';
    if (alreadyLive) {
      sqlText = queryDrafts[id] ?? sqlText;
      connected = false;
      void connect();
    } else if (autoConnect) {
      void connect();
    }
  }

  async function connect(): Promise<void> {
    if (!activeConn || connecting || connected) return;
    connecting = true;
    connError = '';
    connected = false;
    databases = [];
    selectedTable = '';
    meta = null;
    rows = [];
    try {
      const names = await safeInvoke<string[]>('sql_databases', { profile: profileOf(activeConn) });
      connected = true;
      if (!connectedIds.includes(activeId)) connectedIds = [...connectedIds, activeId];
      databases = names.map((name) => ({ name, expanded: false, tables: null, loading: false }));
      // 默认展开第一个数据库
      if (databases.length > 0) {
        databases[0].expanded = true;
        await loadTables(databases[0].name);
      }
      safeInvoke('sql_test', { profile: profileOf(activeConn) }).then((t) => {
        serverVersion = (t as { serverVersion: string }).serverVersion;
      }).catch(() => undefined);
    } catch (cause) {
      connError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      connecting = false;
    }
  }

  function disconnect(): void {
    disconnectId(activeId);
  }

  function disconnectId(id: string): void {
    const target = connections.find((item) => item.id === id);
    if (!target) return;
    safeInvoke('sql_disconnect', { profile: profileOf(target) }).catch(() => undefined);
    connectedIds = connectedIds.filter((cid) => cid !== id);
    if (activeId === id) {
      connected = false;
      databases = [];
      selectedTable = '';
      selectedDb = '';
      meta = null;
      rows = [];
      sqlResult = null;
      connError = '';
      const next = connectedIds[connectedIds.length - 1] ?? '';
      if (next) switchConn(next, false);
    }
  }

  async function loadTables(dbName: string): Promise<void> {
    if (!activeConn) return;
    const node = databases.find((item) => item.name === dbName);
    if (!node) return;
    node.loading = true;
    try {
      node.tables = await safeInvoke<TableInfo[]>('sql_tables', { profile: profileOf(activeConn), database: dbName });
    } catch (cause) {
      node.tables = [];
      connError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      node.loading = false;
    }
  }

  /** 打开数据库：展开并选中（下拉选择或双击调用） */
  async function openDb(name: string): Promise<void> {
    const node = databases.find((item) => item.name === name);
    if (!node) return;
    if (!node.expanded) await toggleDb(name);
    selectedDb = name;
  }

  async function toggleDb(name: string): Promise<void> {
    const node = databases.find((item) => item.name === name);
    if (!node) return;
    if (node.tables === null && !node.loading) {
      node.expanded = true;
      await loadTables(name);
    } else {
      node.expanded = !node.expanded;
    }
  }

  async function refreshTree(): Promise<void> {
    if (!activeConn || !connected) return;
    treeLoading = true;
    connError = '';
    try {
      const names = await safeInvoke<string[]>('sql_databases', { profile: profileOf(activeConn) });
      const keepExpanded = new Set(databases.filter((db) => db.expanded).map((db) => db.name));
      databases = names.map((name) => ({ name, expanded: keepExpanded.has(name), tables: null, loading: false }));
      for (const db of databases) {
        if (db.expanded) await loadTables(db.name);
      }
    } catch (cause) {
      connError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      treeLoading = false;
    }
  }

  type SqlExportResult = { filename: string; sql: string; rows: number; truncated: boolean };
  type CtxMenu = { x: number; y: number; db: string; table: string } | null;
  let contextMenu = $state<CtxMenu>(null);
  let exporting = $state(false);
  let exportNote = $state('');

  function openTableMenu(event: MouseEvent, dbName: string, table: string): void {
    event.preventDefault();
    contextMenu = { x: event.clientX, y: event.clientY, db: dbName, table };
  }

  async function doExport(withData: boolean): Promise<void> {
    if (!contextMenu || !activeConn) return;
    const target = contextMenu;
    contextMenu = null;
    exporting = true;
    exportNote = '';
    try {
      const result = await safeInvoke<SqlExportResult>('sql_export_table', {
        profile: profileOf(activeConn),
        database: target.db,
        table: target.table,
        withData,
      });
      const blob = new Blob([result.sql], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      exportNote = `已导出 ${target.table}：${result.rows} 行${result.truncated ? '（数据已截断）' : ''}`;
    } catch (cause) {
      exportNote = '导出失败: ' + (cause instanceof Error ? cause.message : String(cause));
    }
    exporting = false;
  }

  async function copyTableName(): Promise<void> {
    if (!contextMenu) return;
    const { copyText } = await import('../env');
    await copyText(contextMenu.table);
    contextMenu = null;
  }

  async function selectTable(dbName: string, table: TableInfo): Promise<void> {
    selectedDb = dbName;
    selectedTable = table.name;
    tableKind = table.kind;
    page = 0;
    whereText = '';
    filterText = '';
    draft = {};
    newRowDrafts = [];
    pendingDeletes = [];
    selectedRows = new Set();
    saveMessage = '';
    tab = 'data';
    await loadTableData();
  }

  async function loadTableData(): Promise<void> {
    if (!activeConn || !selectedTable) return;
    loadingRows = true;
    rowError = '';
    try {
      const result = await safeInvoke<RowsResult>('sql_table_rows', {
        profile: profileOf(activeConn),
        database: selectedDb,
        table: selectedTable,
        offset: page * pageSize,
        limit: pageSize,
        filter: whereText.trim() || null,
      });
      meta = { columns: result.columns };
      rows = result.rows;
      total = result.total;
      draft = {};
      newRowDrafts = [];
      selectedRows = new Set();
      pendingDeletes = [];
      // 建表语句（异步、失败不阻塞）
      safeInvoke<string>('sql_table_ddl', { profile: profileOf(activeConn), database: selectedDb, table: selectedTable })
        .then((text) => { ddl = text; ddlError = ''; })
        .catch((cause) => { ddl = ''; ddlError = cause instanceof Error ? cause.message : String(cause); });
    } catch (cause) {
      rowError = cause instanceof Error ? cause.message : String(cause);
      meta = null;
      rows = [];
      total = 0;
    } finally {
      loadingRows = false;
    }
  }

  async function goPage(next: number): Promise<void> {
    if (next < 0 || next * pageSize >= total) return;
    page = next;
    await loadTableData();
  }

  async function changePageSize(size: number): Promise<void> {
    pageSize = size;
    page = 0;
    await loadTableData();
  }

  /* ── 单元格编辑 ── */
  function colIndex(name: string): number {
    return meta ? meta.columns.findIndex((col) => col.name === name) : -1;
  }

  function cellAt(ri: number, ci: number): string | null {
    return cellText(rows[ri]?.[ci]);
  }

  function draftKey(ri: number, ci: number): string | null | undefined {
    return draft[ri + ':' + ci];
  }

  function isDirty(ri: number, ci: number): boolean {
    const value = draftKey(ri, ci);
    if (value === undefined) return false;
    return value !== cellAt(ri, ci);
  }

  function startEdit(ri: number, ci: number): void {
    const key = ri + ':' + ci;
    const current = draftKey(ri, ci);
    editing = key;
    editBuf = current === undefined ? (cellAt(ri, ci) ?? '') : (current ?? '');
  }

  function startNewEdit(ni: number, ci: number): void {
    editing = 'n' + ni + ':' + ci;
    editBuf = newRowDrafts[ni]?.[meta!.columns[ci].name] ?? '';
  }

  function commitEdit(): void {
    if (!editing) return;
    if (editing.startsWith('n')) {
      const [ni, ci] = editing.slice(1).split(':').map(Number);
      const col = meta!.columns[ci];
      newRowDrafts[ni] = { ...newRowDrafts[ni], [col.name]: editBuf };
    } else {
      const [ri, ci] = editing.split(':').map(Number);
      draft = { ...draft, [ri + ':' + ci]: editBuf };
    }
    editing = '';
  }

  function setNull(): void {
    if (!editing) return;
    if (editing.startsWith('n')) {
      const [ni, ci] = editing.slice(1).split(':').map(Number);
      const col = meta!.columns[ci];
      newRowDrafts[ni] = { ...newRowDrafts[ni], [col.name]: null };
    } else {
      const [ri, ci] = editing.split(':').map(Number);
      draft = { ...draft, [ri + ':' + ci]: null };
    }
    editing = '';
  }

  function handleEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') { event.preventDefault(); commitEdit(); }
    else if (event.key === 'Escape') { editing = ''; }
  }

  function revertAll(): void {
    draft = {};
    newRowDrafts = [];
    pendingDeletes = [];
    selectedRows = new Set();
    confirmDelete = false;
  }

  function addNewRow(): void {
    const row: Record<string, string | null> = {};
    for (const col of meta!.columns) row[col.name] = null;
    newRowDrafts = [...newRowDrafts, row];
  }

  function toggleRow(ri: number, checked: boolean): void {
    const next = new Set(selectedRows);
    if (checked) next.add(ri);
    else next.delete(ri);
    selectedRows = next;
  }

  function toggleAll(checked: boolean): void {
    selectedRows = checked ? new Set(rows.map((_, i) => i)) : new Set();
  }

  async function deleteSelected(): Promise<void> {
    if (selectedRows.size === 0) return;
    if (!confirmDelete) {
      confirmDelete = true;
      if (deleteTimer) clearTimeout(deleteTimer);
      deleteTimer = setTimeout(() => (confirmDelete = false), 3500);
      return;
    }
    confirmDelete = false;
    if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null; }
    // 无主键表按任意列定位可能一次删掉多行（NULL/重复值），直接禁止
    if (pkCols.length === 0) {
      rowError = '该表没有主键，无法安全删除行（可能误删多行）。请先在表设计中添加主键。';
      return;
    }
    const keyCol = pkCols[0].name;
    const keyIndex = colIndex(keyCol);
    const values = [...selectedRows].map((ri) => cellText(rows[ri]?.[keyIndex]));
    if (values.some((value) => value === null || value === undefined || value === '')) {
      rowError = '所选行包含空的主键值，已取消删除以避免误删数据';
      return;
    }
    rowError = '';
    saveMessage = '';
    try {
      const affected = await safeInvoke<number>('sql_delete_rows', { profile: profileOf(activeConn!), database: selectedDb, table: selectedTable, keyColumn: keyCol, keyValues: values as string[] });
      saveMessage = affected === values.length
        ? '已删除 ' + affected + ' 行'
        : `警告：请求删除 ${values.length} 行，实际影响 ${affected} 行`;
      await loadTableData();
    } catch (cause) {
      rowError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function keyRefs(ri: number): Array<{ column: string; value: string | null }> {
    const cols = pkCols.length > 0 ? pkCols : meta!.columns;
    return cols.map((col) => ({ column: col.name, value: cellAt(ri, colIndex(col.name)) }));
  }

  async function saveChanges(): Promise<void> {
    if (!hasPending || !activeConn) return;
    saving = true;
    rowError = '';
    saveMessage = '';
    let updated = 0;
    let inserted = 0;
    try {
      // 无主键表禁止更新已有行：全列 WHERE 对重复行会一次改多行，数据风险高
      if (dirtyRows.size > 0 && pkCols.length === 0) {
        throw new Error('该表没有主键，无法安全更新已有行；请先在表设计中添加主键');
      }
      // 更新已修改行
      for (const ri of dirtyRows) {
        const keys = keyRefs(ri);
        if (keys.some((k) => k.value === null || k.value === undefined)) {
          throw new Error('所选行包含空的主键值，已取消保存以避免误改数据');
        }
        const changes: Array<{ column: string; value: string | null }> = [];
        for (let ci = 0; ci < meta!.columns.length; ci++) {
          if (isDirty(ri, ci)) changes.push({ column: meta!.columns[ci].name, value: draftKey(ri, ci) ?? null });
        }
        updated += await safeInvoke<number>('sql_update_row', {
          profile: profileOf(activeConn),
          database: selectedDb,
          table: selectedTable,
          keys,
          changes,
        });
      }
      // 插入新增行
      for (const row of newRowDrafts) {
        const values = meta!.columns.map((col) => row[col.name] ?? null);
        inserted += await safeInvoke<number>('sql_insert_row', {
          profile: profileOf(activeConn),
          database: selectedDb,
          table: selectedTable,
          columns: meta!.columns.map((col) => col.name),
          values,
        });
      }
      saveMessage = '保存成功：更新 ' + updated + ' 行 · 新增 ' + inserted + ' 行';
      await loadTableData();
    } catch (cause) {
      rowError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving = false;
    }
  }

  async function copyText(value: string, key: string): Promise<void> {
    const { copyText: nativeCopy } = await import('../env');
    await nativeCopy(value);
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 1100);
  }

  /* ── 单元格右键菜单 ── */
  let cellMenu = $state<{ x: number; y: number; ri: number; ci: number } | null>(null);

  function openCellMenu(event: MouseEvent, ri: number, ci: number): void {
    event.preventDefault();
    cellMenu = { x: event.clientX, y: event.clientY, ri, ci };
  }

  function copyCellValue(): void {
    if (!cellMenu || !meta) return;
    const row = rows[cellMenu.ri];
    const value = row?.[cellMenu.ci] ?? null;
    import('../env').then(({ copyText }) => copyText(value === null ? 'NULL' : String(value))).catch(() => undefined);
    cellMenu = null;
  }

  function copyRowJson(): void {
    if (!cellMenu || !meta) return;
    const row = rows[cellMenu.ri];
    const record: Record<string, unknown> = {};
    meta.columns.forEach((col, index) => { record[col.name] = row?.[index] ?? null; });
    import('../env').then(({ copyText }) => copyText(JSON.stringify(record, null, 2))).catch(() => undefined);
    cellMenu = null;
  }

  /* ── 连接 / 数据库 右键菜单 ── */
  let connMenu = $state<{ x: number; y: number; id: string } | null>(null);
  let dbMenu = $state<{ x: number; y: number; name: string } | null>(null);

  function openConnMenu(event: MouseEvent, id: string): void {
    event.preventDefault();
    connMenu = { x: event.clientX, y: event.clientY, id };
  }

  function connMenuAction(action: 'connect' | 'edit' | 'copy' | 'delete'): void {
    const menu = connMenu;
    connMenu = null;
    if (!menu) return;
    const target = connections.find((item) => item.id === menu.id);
    if (!target) return;
    if (action === 'connect') { selectConn(target.id); connect(); }
    else if (action === 'edit') openEditConnFor(target);
    else if (action === 'copy') {
      import('../env').then(({ copyText }) => copyText(
        target.kind.toUpperCase() + '://' + (target.user || '') + '@' + target.host + ':' + (target.port || '') + (target.kind === 'sqlite' ? (target.file || '') : '/' + (target.database || ''))
      )).catch(() => undefined);
    }
    else if (action === 'delete') deleteConn(target.id);
  }

  function openDbMenu(event: MouseEvent, name: string): void {
    event.preventDefault();
    dbMenu = { x: event.clientX, y: event.clientY, name };
  }

  function dbMenuAction(action: 'open' | 'refresh' | 'copy'): void {
    const menu = dbMenu;
    dbMenu = null;
    if (!menu) return;
    if (action === 'open') openDb(menu.name);
    else if (action === 'refresh') loadTables(menu.name);
    else if (action === 'copy') import('../env').then(({ copyText }) => copyText(menu.name)).catch(() => undefined);
  }

  /* ── CSV 导出 ── */
  function downloadText(filename: string, text: string): void {
    // \uFEFF BOM 让 Excel 正确识别 UTF-8
    const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportPageCsv(): void {
    if (!meta || !selectedTable) return;
    downloadText(selectedTable + '-page' + (page + 1) + '.csv', toCsv(meta.columns.map((col) => col.name), displayRows));
  }

  function exportResultCsv(): void {
    if (!sqlResult || !sqlResult.isQuery) return;
    downloadText('query-result.csv', toCsv(sqlResult.columns, sqlResult.rows));
  }

  /* ── SQL 编辑器语法高亮（覆盖层方案，textarea 透明 + pre 着色） ── */
  let sqlHighlightElement = $state<HTMLPreElement | undefined>();

  function syncSqlScroll(): void {
    requestAnimationFrame(() => {
      if (sqlHighlightElement && sqlEditorEl) {
        sqlHighlightElement.scrollTop = sqlEditorEl.scrollTop;
        sqlHighlightElement.scrollLeft = sqlEditorEl.scrollLeft;
      }
    });
  }

  /* ── SQL 编辑器 ── */
  function handleSqlKeys(event: KeyboardEvent): void {
    if (completionOpen) {
      if (event.key === 'ArrowDown') { event.preventDefault(); completionIndex = (completionIndex + 1) % completionItems.length; return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); completionIndex = (completionIndex - 1 + completionItems.length) % completionItems.length; return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); applyCompletion(); return; }
      if (event.key === 'Escape') { event.preventDefault(); completionOpen = false; return; }
    }
    if (event.key === ' ' && event.ctrlKey) {
      event.preventDefault();
      openCompletion();
      return;
    }
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      runSql();
    } else if (event.key === 'F5') {
      event.preventDefault();
      runSql();
    } else if (event.ctrlKey && !event.shiftKey && event.key === 'ArrowUp') {
      event.preventDefault();
      recallHistory(1);
    } else if (event.ctrlKey && !event.shiftKey && event.key === 'ArrowDown') {
      event.preventDefault();
      recallHistory(-1);
    } else if (event.key === 'Escape' && sqlHelpOpen) {
      sqlHelpOpen = false;
    }
  }

  async function runSql(): Promise<void> {
    if (!activeConn) return;
    // 有选中文本时只执行选中部分（选中语句模式）
    const hasSelection = sqlEditorEl ? sqlEditorEl.selectionStart !== sqlEditorEl.selectionEnd : false;
    const sql = (hasSelection
      ? sqlText.slice(sqlEditorEl!.selectionStart, sqlEditorEl!.selectionEnd)
      : sqlText
    ).trim();
    if (!sql || sqlRunning) return;
    sqlRunning = true;
    sqlError = '';
    sqlResult = null;
    try {
      sqlResult = await safeInvoke<ExecResult>('sql_execute', { profile: profileOf(activeConn), sql });
      resultPage = 0;
      const next = [sql, ...sqlHistory.filter((item) => item !== sql)].slice(0, 30);
      sqlHistory = next;
      saveSqlHistory(next);
    } catch (cause) {
      sqlError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      sqlRunning = false;
    }
  }

  function sqlCell(value: string | number | boolean | null): string {
    return value === null ? 'NULL' : String(value);
  }

  function emptyDesignCol(): DesignColumn {
    return { name: '', dataType: 'VARCHAR', length: '255', nullable: true, default: '', primaryKey: false, autoIncrement: false, comment: '' };
  }

  async function openNewTable(): Promise<void> {
    if (!activeConn || !connected) return;
    designIsNew = true;
    designTableName = '';
    designError = '';
    designSaved = '';
    designColumns = [
      { name: 'id', dataType: 'INTEGER', length: '', nullable: false, default: '', primaryKey: true, autoIncrement: true, comment: '' },
      emptyDesignCol(),
    ];
    designOriginal = [];
    tab = 'design';
  }

  async function openDesigner(): Promise<void> {
    if (!activeConn || !connected || !selectedTable) return;
    designIsNew = false;
    designTableName = selectedTable;
    designError = '';
    designSaved = '';
    try {
      const cols = await safeInvoke<ColumnInfo[]>('sql_table_columns', { profile: profileOf(activeConn), database: selectedDb, table: selectedTable });
      const kind = activeConn.kind;
      designColumns = cols.map((col) => {
        const upper = col.dataType.toUpperCase();
        const match = /^([A-Za-z ]+?)(?:\((\d+)(?:,\d+)?\))?$/.exec(col.dataType);
        const type = match ? match[1].trim().toUpperCase() : upper;
        const length = match && match[2] ? match[2] : '';
        const extra = (col.extra || '').toLowerCase();
        const autoInc =
          kind === 'mysql' ? extra.includes('auto_increment') :
          kind === 'postgres' ? (type === 'SERIAL' || type === 'BIGSERIAL') :
          (col.key === 'PRI' && type === 'INTEGER');
        return {
          name: col.name,
          dataType: type,
          length: length || (type === 'VARCHAR' || type === 'CHAR' ? '255' : ''),
          nullable: col.nullable,
          default: col.default ?? '',
          primaryKey: col.key === 'PRI',
          autoIncrement: autoInc,
          comment: (col.comment ?? '').trim(),
        };
      });
      designOriginal = designColumns.map((col) => ({ ...col }));
      tab = 'design';
    } catch (cause) {
      rowError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function designColPayload(col: DesignColumn): Record<string, unknown> {
    return {
      name: col.name.trim(),
      dataType: col.dataType,
      length: col.length ? Number(col.length) : null,
      nullable: col.nullable,
      default: col.default.trim() === '' ? null : col.default,
      primaryKey: col.primaryKey,
      autoIncrement: col.autoIncrement,
      comment: col.comment.trim() === '' ? null : col.comment,
    };
  }

  async function saveDesign(): Promise<void> {
    if (!activeConn || !connected) return;
    const name = designTableName.trim();
    if (!name) { designError = '请输入表名'; return; }
    if (designColumns.some((col) => !col.name.trim())) { designError = '字段名不能为空'; return; }
    if (designColumns.some((col) => !col.dataType.trim())) { designError = '字段类型不能为空'; return; }
    designSaving = true;
    designError = '';
    designSaved = '';
    try {
      if (designIsNew) {
        await safeInvoke<number>('sql_create_table', {
          profile: profileOf(activeConn),
          database: selectedDb,
          table: name,
          columns: designColumns.map(designColPayload),
        });
      } else {
        const newNames = new Set(designColumns.map((col) => col.name.trim()));
        const oldNames = new Set(designOriginal.map((col) => col.name));
        const drops = [...oldNames].filter((oldName) => !newNames.has(oldName));
        const adds = designColumns.filter((col) => !oldNames.has(col.name.trim())).map(designColPayload);
        const modifies: Array<Record<string, unknown>> = [];
        for (const col of designColumns) {
          const original = designOriginal.find((item) => item.name === col.name.trim());
          if (!original) continue;
          const changed =
            original.dataType !== col.dataType ||
            original.length !== col.length ||
            original.nullable !== col.nullable ||
            (original.default ?? '') !== col.default.trim() ||
            original.primaryKey !== col.primaryKey ||
            original.autoIncrement !== col.autoIncrement ||
            original.comment !== col.comment.trim();
          if (changed) modifies.push({ ...designColPayload(col), oldName: original.name });
        }
        await safeInvoke<number>('sql_alter_table', {
          profile: profileOf(activeConn),
          database: selectedDb,
          table: selectedTable,
          adds,
          drops,
          modifies,
        });
      }
      designSaved = '表结构保存成功';
      await refreshTree();
      if (designIsNew) {
        const db = databases.find((item) => item.name === selectedDb);
        if (db && !db.expanded) { db.expanded = true; await loadTables(db.name); }
        selectedTable = name;
        tableKind = 'TABLE';
        page = 0;
        draft = {};
        newRowDrafts = [];
        pendingDeletes = [];
        selectedRows = new Set();
        await loadTableData();
        tab = 'data';
      } else {
        await loadTableData();
        tab = 'data';
      }
    } catch (cause) {
      designError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      designSaving = false;
    }
  }

  function addDesignColumn(): void {
    designColumns = [...designColumns, emptyDesignCol()];
  }

  function removeDesignColumn(index: number): void {
    designColumns = designColumns.filter((_, i) => i !== index);
  }

  function moveDesignColumn(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= designColumns.length) return;
    const next = [...designColumns];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    designColumns = next;
  }

  function handlePanelKeys(event: KeyboardEvent): void {
    if (event.key === 'Escape' && formOpen) {
      formOpen = false;
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 'w' || event.key === 'W')) {
      if (activeId && connectedIds.length > 0) {
        event.preventDefault();
        disconnectId(activeId);
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      if (tab === 'design') saveDesign();
      else if (tab === 'data' && hasPending) saveChanges();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 'f' || event.key === 'F')) {
      // 聚焦当前页筛选框
      if (tab === 'data') {
        event.preventDefault();
        filterEl?.focus();
      }
    }
  }

  /* ── 连接表单 ── */
  function openNewConn(): void {
    editingConn = null;
    formDraft = { ...freshConn() };
    formError = '';
    formOk = '';
    showSecret = false;
    dbList = [];
    formOpen = true;
  }

  function openEditConn(): void {
    if (!activeConn) return;
    editingConn = activeConn;
    formDraft = { ...activeConn };
    formError = '';
    formOk = '';
    showSecret = false;
    dbList = [];
    formOpen = true;
  }

  function openEditConnFor(conn: SavedConn): void {
    editingConn = conn;
    formDraft = { ...conn };
    formError = '';
    formOk = '';
    showSecret = false;
    dbList = [];
    formOpen = true;
  }

  async function testForm(): Promise<void> {
    if (!formDraft) return;
    testing = true;
    formError = '';
    formOk = '';
    try {
      const result = await safeInvoke<{ serverVersion: string; elapsedMs: number }>('sql_test', { profile: profileOf(formDraft) });
      formOk = '连接成功 · ' + result.serverVersion + ' · ' + result.elapsedMs + ' ms';
    } catch (cause) {
      formError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      testing = false;
    }
  }

  /** 从服务器拉取数据库列表，供默认数据库下拉选择（密码与端口均来自表单草稿） */
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

  function saveForm(): void {
    if (!formDraft) return;
    const cleaned: SavedConn = {
      ...formDraft,
      name: formDraft.name.trim(),
      host: formDraft.host.trim(),
      user: formDraft.user.trim(),
      port: Math.min(65535, Math.max(1, Math.floor(Number(formDraft.port) || (formDraft.kind === 'mysql' ? 3306 : 5432)))),
      database: formDraft.database.trim(),
      file: formDraft.file.trim(),
    };
    if (!cleaned.name) return;
    const exists = connections.some((item) => item.id === cleaned.id);
    connections = exists ? connections.map((item) => (item.id === cleaned.id ? cleaned : item)) : [...connections, cleaned];
    saveConnections(connections);
    setSecret('sql.' + cleaned.id + '.password', cleaned.password).catch(() => undefined);
    activeId = cleaned.id;
    localStorage.setItem(LAST_CONN_KEY, cleaned.id);
    formOpen = false;
    // 保存后自动连接
    connect();
  }

  function deleteConn(id: string): void {
    if (confirmDeleteId !== id) {
      confirmDeleteId = id;
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => (confirmDeleteId = ''), 3000);
      return;
    }
    confirmDeleteId = '';
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    const target = connections.find((item) => item.id === id);
    if (!target) return;
    safeInvoke('sql_disconnect', { profile: profileOf(target) }).catch(() => undefined);
    deleteSecret('sql.' + id + '.password').catch(() => undefined);
    const wasActive = activeId === id;
    connections = connections.filter((item) => item.id !== id);
    connectedIds = connectedIds.filter((cid) => cid !== id);
    saveConnections(connections);
    if (wasActive) {
      const next = connections[0]?.id ?? '';
      if (next) {
        switchConn(next, false);
      } else {
        activeId = '';
        localStorage.setItem(LAST_CONN_KEY, '');
        connected = false;
        databases = [];
        selectedTable = '';
      }
    }
    const drafts = { ...queryDrafts };
    delete drafts[id];
    queryDrafts = drafts;
  }

  function connErrorFor(conn: SavedConn): string {
    if (conn.kind === 'sqlite') return 'SQLite · ' + (conn.file || '未指定文件');
    return '连接 ' + conn.host + ':' + (conn.port || (conn.kind === 'mysql' ? 3306 : 5432)) + ' · 用户 ' + (conn.user || '—');
  }

  function ddlDisplay(): string {
    return ddl || '';
  }

  /* 表名过长时的面板内提示卡：fixed 定位并钳制在侧栏内，绝不越界 */
  let treeTip = $state<{ name: string; left: number; top: number; width: number } | null>(null);
  function showTableTip(event: MouseEvent, name: string): void {
    if (name.length <= 26) { treeTip = null; return; }
    const row = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const side = document.querySelector<HTMLElement>('.sql-side');
    if (!side) return;
    const sr = side.getBoundingClientRect();
    const tipHeight = 30;
    // 宽度按完整表名估算，最多 430px，确保完整展示不再被截断
    let tipWidth = Math.min(430, Math.max(140, Math.round(name.length * 7.4 + 28)));
    // 优先浮在侧栏右侧（编辑区一侧），空间不足再放左侧，绝不覆盖当前行
    let left = sr.right + 10;
    if (left + tipWidth > window.innerWidth - 12) left = sr.left - tipWidth - 10;
    let top = row.top - tipHeight - 6;
    if (top < sr.top + 4) top = row.bottom + 6;
    if (top + tipHeight > window.innerHeight - 8) top = row.bottom + 6;
    // ???????????????????????????????????
    tipWidth = Math.min(tipWidth, window.innerWidth - 16);
    left = Math.max(8, Math.min(left, window.innerWidth - tipWidth - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - tipHeight - 8));
    treeTip = { name, left, top, width: tipWidth };
  }

</script>

<svelte:window onkeydown={handlePanelKeys} />

<div class="sql-panel">
  <header class="sql-bar">
    <div class="sql-bar-id">
      <span class="sql-bar-ico">{@html iconHtml(TOOL_ICONS['spurh.sql'])}</span>
      <div><b>{activeConn ? activeConn.name : '数据库工具'}</b><small>{activeConn ? connSubtitle(activeConn) : 'MySQL · SQLite · PostgreSQL 数据库管理'}</small></div>
    </div>
    <div class="sql-bar-status" class:on={connected} class:err={Boolean(connError)} title={serverVersion || (connError || '')}>
      <i></i><span>{connected ? '已连接' : (connecting ? '连接中…' : (connError ? '连接失败' : '未连接'))}</span>
    </div>
    <div class="sql-bar-actions">
      {#if activeConn && !connected}
        <button class="sql-btn primary" disabled={connecting} onclick={connect}><span class="sql-dot"></span>{connecting ? '连接中…' : '连接'}</button>
      {:else if activeConn && connected}
        <button class="sql-btn ghost" onclick={disconnect}>断开</button>
      {/if}
      {#if activeConn}
        <button class="sql-btn ghost" onclick={openEditConn} title="编辑当前连接配置">编辑</button>
      {/if}
      <button class="sql-btn ghost" onclick={openNewConn}>＋ 新建连接</button>
      {#if connected}
        <button class="sql-btn ghost" disabled={treeLoading} onclick={refreshTree} title="刷新数据库与表">{@html UI_ICONS.refresh}{treeLoading ? '刷新中…' : '刷新'}</button>
      {/if}
    </div>
  </header>

  {#if connectedIds.length > 0}
    <div class="sql-conn-tabs" role="tablist" aria-label="已连接的数据库">
      {#each connectedIds as id}
        {@const conn = connections.find((item) => item.id === id)}
        {#if conn}
          <button class="sql-conn-tab" class:active={id === activeId} role="tab" aria-selected={id === activeId} onclick={() => switchConn(id, false)} title={connSubtitle(conn) + '（点击切换 · Ctrl+W 关闭）'}>
            <span class="sql-conn-ico small">{@html dbIcon(conn.kind)}</span>
            <b>{conn.name}</b>
            <i class="sql-conn-dot on"></i>
            <span class="sql-tab-x" onclick={(event) => { event.stopPropagation(); disconnectId(id); }} title="断开并关闭标签">×</span>
          </button>
        {/if}
      {/each}
      <button class="sql-tab-add" onclick={openNewConn} title="新建连接">＋</button>
    </div>
  {/if}

  <div class="sql-body">
    <aside class="sql-side">
      <div class="sql-side-head"><span>连接</span><button class="sql-side-add" title="新建连接" onclick={openNewConn}>{@html UI_ICONS.plus}</button></div>
      <div class="sql-conns">
        {#each connections as conn}
          <div class="sql-conn" class:active={conn.id === activeId} class:live={connected && conn.id === activeId}>
            <button class="sql-conn-main" onclick={() => selectConn(conn.id)} ondblclick={() => { selectConn(conn.id); if (activeId === conn.id) connect(); }} oncontextmenu={(e) => openConnMenu(e, conn.id)} title={connSubtitle(conn) + '（双击连接，右键更多）'}>
              <span class="sql-conn-ico">{@html dbIcon(conn.kind)}</span>
              <span class="sql-conn-copy"><b>{conn.name}</b><small>{connSubtitle(conn)}</small></span>
              <i class="sql-conn-dot" class:on={connected && conn.id === activeId}></i>
            </button>
            <div class="sql-conn-ops">
              <button title="编辑连接" onclick={() => openEditConnFor(conn)}><span>{@html UI_ICONS.sliders}</span></button>
              <button class:confirm={confirmDeleteId === conn.id} title="删除连接" onclick={() => deleteConn(conn.id)}>{#if confirmDeleteId === conn.id}<span>确认</span>{:else}<span>{@html UI_ICONS.trash}</span>{/if}</button>
            </div>
          </div>
        {/each}
        {#if connections.length === 0}
          <div class="sql-conns-empty">还没有连接<br />点击右上角 ＋ 新建</div>
        {/if}
      </div>

      {#if connected}
        <div class="sql-side-head"><span>数据库</span><button class="sql-side-add" title="刷新" onclick={refreshTree}>{@html UI_ICONS.refresh}</button></div>
        <div class="sql-tree">
          {#each databases as db}
            <div class="sql-db">
              <button class="sql-db-row" onclick={() => toggleDb(db.name)} ondblclick={() => openDb(db.name)} oncontextmenu={(e) => openDbMenu(e, db.name)} title={`${db.name}（单击展开，双击打开，右键更多）`}>
                <span class="chev" class:open={db.expanded}>▸</span>
                <span class="sql-db-ico">{@html DB_CYLINDER}</span>
                <b>{db.name}</b>
                {#if db.loading}<span class="spinner"></span>{/if}
                {#if db.expanded && db.tables}<small>{db.tables.length}</small>{/if}
              </button>
              {#if db.expanded}
                <div class="sql-tables">
                  {#if db.loading && db.tables === null}
                    <div class="sql-tree-loading">加载表…</div>
                  {:else if db.tables && db.tables.length > 0}
                    {#each db.tables as table}
                      <button class="sql-table-row" class:active={selectedTable === table.name && selectedDb === db.name} onclick={() => selectTable(db.name, table)} oncontextmenu={(event) => openTableMenu(event, db.name, table.name)} onmouseenter={(event) => showTableTip(event, table.name)} onmouseleave={() => (treeTip = null)}>
                        <span class="tbl-ico">{@html table.kind === 'VIEW' ? VIEW_ICON : TABLE_ICON}</span>
                        <b>{table.name}</b>
                        {#if table.kind === 'VIEW'}<em>视图</em>{/if}
                      </button>
                    {/each}
                  {:else if !db.loading}
                    <div class="sql-tree-loading">无表</div>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
          {#if databases.length === 0 && !treeLoading}
            <div class="sql-tree-loading">连接成功，点击刷新获取数据库</div>
          {/if}
        </div>
      {/if}
      {#if contextMenu}
        <button type="button" class="sql-ctx-backdrop" aria-label="关闭菜单" tabindex="-1" oncontextmenu={(event) => event.preventDefault()} onclick={() => (contextMenu = null)}></button>
        <div class="sql-ctx" style={`left:${Math.max(8, Math.min(contextMenu.x, window.innerWidth - 200))}px;top:${Math.max(8, Math.min(contextMenu.y, window.innerHeight - 180))}px`}>
          <b>{contextMenu.table}</b>
          <button disabled={exporting} onclick={() => doExport(false)}>导出表结构</button>
          <button disabled={exporting} onclick={() => doExport(true)}>导出结构 + 数据</button>
          <button onclick={() => copyTableName()}>复制表名</button>
          <button onclick={() => { const target = contextMenu; if (!target) return; const name = target.db; contextMenu = null; loadTables(name); }}>刷新表列表</button>
          {#if exportNote}<small class:err={exportNote.startsWith('导出失败')}>{exportNote}</small>{/if}
        </div>
      {/if}
      {#if exportNote}
        <div class="sql-export-note" class:err={exportNote.startsWith('导出失败')}>{exportNote}<button onclick={() => (exportNote = '')}>×</button></div>
      {/if}
      {#if cellMenu}
        <button type="button" class="sql-ctx-backdrop" aria-label="关闭菜单" tabindex="-1" oncontextmenu={(event) => event.preventDefault()} onclick={() => (cellMenu = null)}></button>
        <div class="sql-cell-menu" style={`left:${Math.max(8, Math.min(cellMenu.x, window.innerWidth - 190))}px;top:${Math.max(8, Math.min(cellMenu.y, window.innerHeight - 140))}px`}>
          <b>单元格操作</b>
          <button onclick={copyCellValue}>复制单元格</button>
          <button onclick={copyRowJson}>复制整行 JSON</button>
          <button onclick={() => (cellMenu = null)}>取消</button>
        </div>
      {/if}
      {#if connMenu}
        <button type="button" class="sql-ctx-backdrop" aria-label="关闭菜单" tabindex="-1" oncontextmenu={(event) => event.preventDefault()} onclick={() => (connMenu = null)}></button>
        <div class="sql-cell-menu" style={`left:${Math.max(8, Math.min(connMenu.x, window.innerWidth - 190))}px;top:${Math.max(8, Math.min(connMenu.y, window.innerHeight - 170))}px`}>
          <b>连接操作</b>
          <button onclick={() => connMenuAction('connect')}>连接</button>
          <button onclick={() => connMenuAction('edit')}>编辑</button>
          <button onclick={() => connMenuAction('copy')}>复制连接信息</button>
          <button onclick={() => connMenuAction('delete')}>删除</button>
        </div>
      {/if}
      {#if dbMenu}
        <button type="button" class="sql-ctx-backdrop" aria-label="关闭菜单" tabindex="-1" oncontextmenu={(event) => event.preventDefault()} onclick={() => (dbMenu = null)}></button>
        <div class="sql-cell-menu" style={`left:${Math.max(8, Math.min(dbMenu.x, window.innerWidth - 190))}px;top:${Math.max(8, Math.min(dbMenu.y, window.innerHeight - 140))}px`}>
          <b>{dbMenu.name}</b>
          <button onclick={() => dbMenuAction('open')}>打开</button>
          <button onclick={() => dbMenuAction('refresh')}>刷新表列表</button>
          <button onclick={() => dbMenuAction('copy')}>复制库名</button>
        </div>
      {/if}
    </aside>

    <main class="sql-main">
      {#if !activeConn}
        <div class="sql-empty">
          <span class="sql-empty-tile">{@html iconHtml(TOOL_ICONS['spurh.sql'])}</span>
          {#if connections.length === 0}
            <b>还没有数据库连接</b>
            <p>新建连接后即可浏览库表、编辑数据、执行 SQL</p>
            <div class="sql-steps" aria-hidden="true">
              <span><i>1</i><b>新建连接</b><small>填写主机、端口、账号密码</small></span>
              <span><i>2</i><b>测试连接</b><small>确认配置可用再保存</small></span>
              <span><i>3</i><b>浏览数据</b><small>库表树 · SQL 查询 · 用户权限</small></span>
            </div>
            <button class="sql-btn primary big" onclick={openNewConn}>＋ 新建连接</button>
          {:else}
            <b>选择要连接的数据库</b>
            <p>点击下方已保存的连接即可连接</p>
            <div class="sql-quick-conns">
              {#each connections as conn}
                <button class="sql-quick-conn" onclick={() => { selectConn(conn.id); connect(); }}>
                  <span class="sql-conn-ico">{@html dbIcon(conn.kind)}</span>
                  <span class="sql-quick-copy"><b>{conn.name}</b><small>{connSubtitle(conn)}</small></span>
                  <i>连接 ›</i>
                </button>
              {/each}
            </div>
            <button class="sql-btn ghost big" onclick={openNewConn}>＋ 新建连接</button>
          {/if}
        </div>
      {:else if !connected}
        <div class="sql-empty">
          <span class="sql-empty-tile">{@html dbIcon(activeConn.kind)}</span>
          <b>{activeConn.name}</b>
          <p>{connErrorFor(activeConn)}</p>
          {#if connError}<div class="sql-error">{connError}</div>{/if}
          <button class="sql-btn primary big" disabled={connecting} onclick={connect}><span class="sql-dot"></span>{connecting ? '连接中…' : '连接数据库'}</button>
        </div>
      {:else}
        <div class="sql-tabs">
          <div class="sql-tabs-group">
            <button class:active={tab === 'data'} onclick={() => (tab = 'data')}>表数据</button>
            <button class:active={tab === 'sql'} onclick={() => (tab = 'sql')}>SQL 查询</button>
            <button class:active={tab === 'users'} onclick={() => { tab = 'users' }} title={activeConn.kind === 'sqlite' ? 'SQLite 不支持用户管理，连接 MySQL / PostgreSQL 可用' : '用户管理与权限设置（MySQL / PostgreSQL）'}>用户管理</button>
          </div>
          <div class="sql-tabs-info">
            {#if databases.length > 0}
              <select class="sql-db-select" value={selectedDb || ''} onchange={(e) => { const name = e.currentTarget.value; if (name) openDb(name); }} title="选择数据库（默认全部）">
                <option value="">全部数据库</option>
                {#each databases as db}<option value={db.name}>{db.name}</option>{/each}
              </select>
            {/if}
            {#if serverVersion}<span class="sql-ver" title={serverVersion}>版本 {serverVersion.slice(0, 42)}</span>{/if}
            {#if selectedTable}<em>{selectedDb}.{selectedTable}</em>{/if}
          </div>
        </div>

        {#if tab === 'data'}
          {#if selectedTable && meta}
            <div class="sql-data">
              <div class="sql-data-bar">
                <div class="sql-data-title">
                  <span class="tbl-ico big">{@html tableKind === 'VIEW' ? VIEW_ICON : TABLE_ICON}</span>
                  <b>{selectedDb}.{selectedTable}</b>
                  <em>{tableKind === 'VIEW' ? '视图' : '表'}</em>
                  <small>{total} 行 · {meta.columns.length} 字段</small>
                  {#if isFiltered}<em class="sql-filter-hint">筛选 {filteredCount} / {total}</em>{/if}
                </div>
                <div class="sql-data-actions">
                  <div class="sql-where" class:active={Boolean(whereText.trim())}>
                    <span class="sql-where-tag">WHERE</span>
                    <input bind:value={whereText} placeholder="跨页条件，如 age > 18（回车应用）" spellcheck="false" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); page = 0; loadTableData(); } else if (e.key === 'Escape') { whereText = ''; page = 0; loadTableData(); } }} />
                    {#if whereText}<button class="sql-where-clear" onclick={() => { whereText = ''; page = 0; loadTableData(); }} title="清除条件">×</button>{/if}
                  </div>
                  <input class="sql-filter" bind:value={filterText} bind:this={filterEl} placeholder="筛选当前页…（Ctrl+F）" spellcheck="false" />
                  <button class="sql-btn ghost" disabled={loadingRows || displayRows.length === 0} onclick={exportPageCsv} title="导出当前页为 CSV">导出 CSV</button>
                  <button class="sql-btn ghost" disabled={loadingRows} onclick={loadTableData} title="刷新当前页">{@html UI_ICONS.refresh}刷新</button>
                  <button class="sql-btn ghost" onclick={openDesigner} title="设计表结构：新增/修改/删除字段">设计表</button>
                  <button class="sql-btn ghost" onclick={addNewRow} title="在网格底部新增一行">＋ 新增行</button>
                  <button class="sql-btn ghost danger" disabled={selectedRows.size === 0} onclick={deleteSelected} title="删除勾选的行">{confirmDelete ? '确认删除 ' + selectedRows.size + ' 行？' : '删除选中'}</button>
                  <button class="sql-btn ghost" disabled={!hasPending} onclick={revertAll} title="撤销所有未保存的更改">撤销</button>
                  <button class="sql-btn primary" disabled={!hasPending || saving} onclick={saveChanges} title="保存所有更改">
                    {saving ? '保存中…' : '保存更改'}{hasPending ? '（' + (dirtyCount + newRowDrafts.length + pendingDeletes.length) + '）' : ''}
                  </button>
                </div>
              </div>
              {#if rowError}<div class="sql-error"><i></i>{rowError}</div>{/if}
              {#if saveMessage}<div class="sql-ok"><i></i>{saveMessage}</div>{/if}
              <div class="sql-grid-wrap">
                <table class="sql-grid">
                  <thead>
                    <tr>
                      {#if !isFiltered}<th class="chk"><input type="checkbox" checked={selectedRows.size > 0 && selectedRows.size === rows.length} onchange={(e) => toggleAll((e.currentTarget as HTMLInputElement).checked)} title="全选" /></th>{/if}
                      {#if !isFiltered}<th class="idx">#</th>{/if}
                      {#each meta.columns as col}
                        <th title={col.dataType + (col.nullable ? '' : ' NOT NULL')}>
                          <span class="col-name">{col.name}</span>
                          {#if col.key === 'PRI'}<i class="pk">PK</i>{/if}
                          <small>{col.dataType}{col.nullable ? '' : ' *'}</small>
                        </th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#if !isFiltered}
                    {#each newRowDrafts as row, ni}
                      <tr class="is-new">
                        <td class="chk"><span class="badge-new">新</span></td>
                        <td class="idx">新</td>
                        {#each meta.columns as col, ci}
                          {@const nkey = 'n' + ni + ':' + ci}
                          {@const nval = row[col.name]}
                          <td class="cell" class:null={nval === null}>
                            {#if editing === nkey}
                              <span class="cell-edit">
                                <input value={editBuf} oninput={(e) => (editBuf = e.currentTarget.value)} onkeydown={handleEditKeydown} spellcheck="false" />
                                <button class="cell-null" title="设为 NULL" onclick={setNull}>NULL</button>
                              </span>
                            {:else}
                              <button class="cell-view" onclick={() => startNewEdit(ni, ci)} oncontextmenu={(e) => openCellMenu(e, ni, ci)} title="点击编辑 · 右键复制">
                                {#if nval === null}<em class="null-tag">NULL</em>{:else}{nval}{/if}
                              </button>
                            {/if}
                          </td>
                        {/each}
                      </tr>
                    {/each}
                    {/if}
                    {#each displayRows as row, ri}
                      <tr class:selected={!isFiltered && selectedRows.has(ri)}>
                        {#if !isFiltered}<td class="chk"><input type="checkbox" checked={selectedRows.has(ri)} onchange={(e) => toggleRow(ri, (e.currentTarget as HTMLInputElement).checked)} /></td>{/if}
                        {#if !isFiltered}<td class="idx">{page * pageSize + ri + 1}</td>{/if}
                        {#each meta.columns as col, ci}
                          {@const key = ri + ':' + ci}
                          {@const original = cellText(row[ci])}
                          {@const cur = draft[key] !== undefined ? draft[key] : original}
                          {@const dirty = draft[key] !== undefined && draft[key] !== original}
                          <td class="cell" class:dirty={!isFiltered && dirty} class:null={cur === null}>
                            {#if !isFiltered && editing === key}
                              <span class="cell-edit">
                                <input value={editBuf} oninput={(e) => (editBuf = e.currentTarget.value)} onkeydown={handleEditKeydown} bind:this={editingInput} spellcheck="false" />
                                <button class="cell-null" title="设为 NULL" onclick={setNull}>NULL</button>
                              </span>
                            {:else if !isFiltered}
                              <button class="cell-view" onclick={() => startEdit(ri, ci)} oncontextmenu={(e) => openCellMenu(e, ri, ci)} title="点击编辑 · 右键复制">
                                {#if cur === null}<em class="null-tag">NULL</em>{:else}{cur}{/if}
                              </button>
                            {:else}
                              <span class="cell-view read" title={String(cur ?? '')}>{#if cur === null}<em class="null-tag">NULL</em>{:else}{String(cur)}{/if}</span>
                            {/if}
                          </td>
                        {/each}
                      </tr>
                    {/each}
                    {#if displayRows.length === 0 && (!isFiltered ? newRowDrafts.length === 0 : true)}
                      <tr><td class="grid-empty" colspan={meta.columns.length + (isFiltered ? 0 : 2)}>{isFiltered ? '没有匹配「' + filterText.trim() + '」的行' : '此表暂无数据，点击「＋ 新增行」添加'}</td></tr>
                    {/if}
                  </tbody>
                </table>
              </div>
              <div class="sql-pager">
                <span>{total > 0 ? (page * pageSize + 1) + ' – ' + Math.min((page + 1) * pageSize, total) + ' / 共 ' + total + ' 行' : '共 0 行'}</span>
                <div>
                  <button disabled={page === 0 || loadingRows} onclick={() => goPage(page - 1)}>‹ 上一页</button>
                  <span>第 {page + 1} / {totalPages} 页</span>
                  <button disabled={(page + 1) * pageSize >= total || loadingRows} onclick={() => goPage(page + 1)}>下一页 ›</button>
                  <select class="sql-page-size" value={pageSize} onchange={(e) => changePageSize(Number(e.currentTarget.value))} title="每页行数">
                    {#each PAGE_SIZES as size}<option value={size}>{size} 行/页</option>{/each}
                  </select>
                </div>
              </div>
              {#if ddl}
                <details class="sql-ddl"><summary>查看建表语句</summary><pre>{ddl}</pre></details>
              {:else if ddlError}
                <div class="sql-ddl-note">{ddlError}</div>
              {/if}
            </div>
          {:else if loadingRows}
            <div class="sql-loading"><span class="spinner"></span>加载数据…</div>
          {:else if selectedTable && rowError}
            <div class="sql-data-error">
              <span class="sql-data-error-ico">{@html UI_ICONS.alert}</span>
              <div class="sql-data-error-copy"><b>表数据加载失败</b><p>{rowError}</p></div>
              <button class="sql-btn ghost" onclick={loadTableData} title="重新尝试加载当前表">重试</button>
            </div>
          {:else}
            <div class="sql-empty small">
              <span class="sql-empty-tile">{@html TABLE_ICON}</span>
              <b>选择一张表或新建一张</b>
              <p>在左侧展开数据库，点击表查看数据并编辑</p>
              <button class="sql-btn primary big" onclick={openNewTable}>＋ 新建表</button>
            </div>
          {/if}
        {/if}

        {#if tab === 'sql'}
          <div class="sql-editor">
            <div class="sql-editor-bar">
              <button class="sql-btn primary" disabled={sqlRunning || !sqlText.trim()} onclick={runSql}><span class="sql-dot"></span>{sqlRunning ? '执行中…' : '运行 SQL'}</button>
              <kbd>Ctrl ↵</kbd>
              <span class="sql-editor-note">有选中文本时只执行选中部分 · 最多 500 行</span>
              <div class="flex-spacer"></div>
              <div class="sql-help-wrap">
                <button class="sql-btn ghost" onclick={() => (sqlHelpOpen = !sqlHelpOpen)} title="快捷键帮助">?</button>
                {#if sqlHelpOpen}
                  <div class="sql-help">
                    <b>快捷键</b>
                    <span><kbd>Ctrl ↵</kbd> / <kbd>F5</kbd> 运行（有选中只执行选中）</span>
                    <span><kbd>Ctrl ↑</kbd> / <kbd>Ctrl ↓</kbd> 切换历史查询</span>
                    <span><kbd>Ctrl F</kbd> 聚焦当前页筛选</span>
                    <span><kbd>Ctrl S</kbd> 保存数据/表结构</span>
                    <span><kbd>右键</kbd> 单元格复制</span>
                  </div>
                {/if}
              </div>
              <div class="sql-history-wrap">
                <button class="sql-btn ghost" onclick={() => (sqlHistoryOpen = !sqlHistoryOpen)} title="最近执行的查询">{sqlHistoryOpen ? '收起历史' : '历史'}（{sqlHistory.length}）</button>
                {#if sqlHistoryOpen}
                  <div class="sql-history">
                    {#if sqlHistory.length === 0}
                      <div class="sql-history-empty">暂无历史查询</div>
                    {:else}
                      {#each sqlHistory as item, i}
                        <button onclick={() => { sqlText = item; sqlHistoryOpen = false; }} title={item}>
                          <span>{i + 1}</span><code>{item.length > 90 ? item.slice(0, 90) + '…' : item}</code>
                        </button>
                      {/each}
                    {/if}
                  </div>
                {/if}
              </div>
              <button class="sql-btn ghost" disabled={!sqlText} onclick={() => (sqlText = formatSql(sqlText))} title="格式化 SQL：关键字大写、从句换行">格式化</button>
              <button class="sql-btn ghost" disabled={!sqlText} onclick={() => (sqlText = '')}>清空</button>
              <button class="sql-btn ghost" onclick={() => copyText(sqlText, 'sql')}>{copiedKey === 'sql' ? '已复制 ✓' : '复制'}</button>
            </div>
            <div class="sql-editor-area">
              <pre class="sql-editor-hl" bind:this={sqlHighlightElement} aria-hidden="true">{@html highlightSql(sqlText)}</pre>
              <textarea bind:value={sqlText} bind:this={sqlEditorEl} onkeydown={handleSqlKeys} onscroll={syncSqlScroll} placeholder={'-- 在此输入 SQL，例如：\nSELECT * FROM users LIMIT 100;\n\n-- Ctrl + Enter / F5 执行，Ctrl + Space 补全'} spellcheck="false"></textarea>
              {#if completionOpen}
                <div class="sql-completion">
                  <small>{completionGroup}</small>
                  {#each completionItems as item, i}
                    <button class:active={i === completionIndex} onmousedown={(e) => e.preventDefault()} onclick={() => { completionIndex = i; applyCompletion(); }}>
                      <code>{item}</code>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            {#if sqlError}<div class="sql-error"><i></i>{sqlError}</div>{/if}
            {#if sqlResult}
              <div class="sql-result-bar">
                <span class="sql-result-chip" class:query={sqlResult.isQuery}>{sqlResult.isQuery ? 'QUERY' : 'DONE'}</span>
                <b>{sqlResult.isQuery ? sqlResult.rows.length + ' 行结果' : '影响 ' + sqlResult.affected + ' 行'}</b>
                <small>{sqlResult.elapsedMs} ms</small>
                {#if sqlResult.truncated}<em class="sql-truncated">结果已截断</em>{/if}
                <div class="flex-spacer"></div>
                {#if sqlResult.isQuery}
                  <button class="sql-btn ghost" onclick={() => copyText(JSON.stringify(sqlResult!.rows, null, 2), 'sqljson')}>{copiedKey === 'sqljson' ? '已复制 ✓' : '复制 JSON'}</button>
                  <button class="sql-btn ghost" onclick={exportResultCsv} title="导出查询结果为 CSV">导出 CSV</button>
                {/if}
              </div>
              {#if sqlResult.isQuery}
                <div class="sql-grid-wrap sql-result-grid">
                  <table class="sql-grid readonly">
                    <thead><tr><th class="idx">#</th>{#each sqlResult.columns as col}<th><span class="col-name">{col}</span></th>{/each}</tr></thead>
                    <tbody>
                      {#each resultPageRows as row, ri}
                        <tr>
                          <td class="idx">{resultPage * RESULT_PAGE_SIZE + ri + 1}</td>
                          {#each row as cell}
                            <td class="cell" title={cell === null ? 'NULL' : String(cell)}><span class:null-tag={cell === null}>{cell === null ? 'NULL' : String(cell)}</span></td>
                          {/each}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
                {#if resultTotalPages > 1}
                  <div class="sql-result-pager">
                    <button disabled={resultPage === 0} onclick={() => (resultPage -= 1)}>‹ 上一页</button>
                    <span>第 {resultPage + 1} / {resultTotalPages} 页 · 共 {sqlResult.rows.length} 行</span>
                    <button disabled={resultPage >= resultTotalPages - 1} onclick={() => (resultPage += 1)}>下一页 ›</button>
                  </div>
                {/if}
              {/if}
            {/if}
            <AiAssist
              config={aiConfig}
              tool="数据库工具"
              action="AI 助手"
              instruction="你是资深数据库工程师。生成可执行的 SQL 时只输出 SQL 语句本身（不要 Markdown 代码块、不要解释）；解释问题时给出原因和修复后的 SQL。"
              presets={[
                { label: '生成 SQL', text: '帮我写一条 SQL：' },
                { label: '优化 SQL', text: '优化以下 SQL 并简要说明优化点：\n' },
                { label: '解释报错', text: '解释以下报错的原因，并给出修复后的 SQL：\n' },
              ]}
              getContext={() => {
                const err = sqlError || rowError;
                if (err) return '本地执行报错：' + err;
                return sqlText;
              }}
              onResult={(output) => {
                const clean = output.replace(/^```(?:sql)?s*/i, '').replace(/s*```$/, '');
                if (clean && /(select|insert|update|delete|create|alter|drop|with|show|desc|pragma)/i.test(clean)) sqlText = clean;
              }}
            />
          </div>
        {/if}
        {#if tab === 'design'}
          <div class="sql-design">
            <div class="sql-data-bar">
              <div class="sql-data-title">
                <span class="tbl-ico big">{@html TABLE_ICON}</span>
                {#if designIsNew}
                  <input class="sql-design-name" bind:value={designTableName} placeholder="输入新表名…" spellcheck="false" />
                {:else}
                  <b>{selectedDb}.{selectedTable}</b>
                {/if}
                <em>{designIsNew ? '新建表' : '设计表'}</em>
                <small>{designColumns.length} 个字段</small>
              </div>
              <div class="sql-data-actions">
                <button class="sql-btn ghost" onclick={addDesignColumn}>＋ 添加字段</button>
                <button class="sql-btn ghost" onclick={() => (tab = 'data')}>取消</button>
                <button class="sql-btn primary" disabled={designSaving} onclick={saveDesign}>{designSaving ? '保存中…' : '保存表结构'}</button>
              </div>
            </div>
            {#if designError}<div class="sql-error"><i></i>{designError}</div>{/if}
            {#if designSaved}<div class="sql-ok"><i></i>{designSaved}</div>{/if}
            <div class="sql-design-wrap">
              <table class="sql-grid design">
                <thead>
                  <tr>
                    <th class="idx">#</th>
                    <th class="dg-name">字段名</th>
                    <th class="dg-type">类型</th>
                    <th class="dg-len">长度</th>
                    <th class="chk">可空</th>
                    <th class="dg-def">默认值</th>
                    <th class="chk">主键</th>
                    <th class="chk">自增</th>
                    <th class="dg-comment">注释</th>
                    <th class="dg-ops"></th>
                  </tr>
                </thead>
                <tbody>
                  {#each designColumns as col, ci}
                    <tr>
                      <td class="idx">{ci + 1}</td>
                      <td class="dg-name"><input bind:value={col.name} placeholder="字段名" spellcheck="false" /></td>
                      <td class="dg-type">
                        <select bind:value={col.dataType}>
                          {#each TYPE_OPTIONS[(activeConn?.kind ?? 'sqlite') as ConnKind] as t}<option value={t}>{t}</option>{/each}
                        </select>
                      </td>
                      <td class="dg-len"><input bind:value={col.length} placeholder="255" spellcheck="false" /></td>
                      <td class="chk"><input type="checkbox" bind:checked={col.nullable} title="允许 NULL" /></td>
                      <td class="dg-def"><input bind:value={col.default} placeholder="NULL" spellcheck="false" /></td>
                      <td class="chk"><input type="checkbox" bind:checked={col.primaryKey} title="主键" /></td>
                      <td class="chk"><input type="checkbox" bind:checked={col.autoIncrement} title="自增" /></td>
                      <td class="dg-comment"><input bind:value={col.comment} placeholder="注释" spellcheck="false" /></td>
                      <td class="dg-ops">
                        <button class="sql-design-move" title="上移" onclick={() => moveDesignColumn(ci, -1)}>↑</button>
                        <button class="sql-design-move" title="下移" onclick={() => moveDesignColumn(ci, 1)}>↓</button>
                        <button class="sql-design-del" title="删除字段" onclick={() => removeDesignColumn(ci)}>×</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <div class="sql-design-note">
              <span>提示</span>
              <small>SQLite 仅支持新增 / 删除字段（不支持修改已有字段类型）；自增字段需为 INTEGER PRIMARY KEY。主键列自动 NOT NULL。</small>
            </div>
          </div>
        {/if}
      {/if}

        {#if tab === 'users'}
        <div class="sql-users-scroll">
          <SqlUsersPanel conn={activeConn} databases={databases} />
        </div>
      {/if}
    </main>
  </div>

  {#if formOpen && formDraft}
    {@const d = formDraft}
    <div class="sql-modal-backdrop" role="presentation" onkeydown={(event) => { if (event.key === 'Escape') formOpen = false; }}>
      <div class="sql-modal" role="dialog" aria-modal="true">
        <header>
          <div><b>{editingConn ? '编辑连接' : '新建连接'}</b><small>连接信息仅保存在本机</small></div>
          <button class="sql-btn ghost" onclick={() => (formOpen = false)} aria-label="关闭">×</button>
        </header>
        <div class="sql-form">
          <label class="full"><span>连接名称</span><input bind:value={d.name} placeholder="例如：本地开发库" spellcheck="false" /></label>
          <div class="full"><span>数据库类型</span>
            <div class="sql-kind-chips">
              <button class:active={d.kind === 'mysql'} onclick={() => (d.kind = 'mysql')}>MySQL</button>
              <button class:active={d.kind === 'postgres'} onclick={() => (d.kind = 'postgres')}>PostgreSQL</button>
              <button class:active={d.kind === 'sqlite'} onclick={() => (d.kind = 'sqlite')}>SQLite</button>
            </div>
          </div>
          {#if d.kind !== 'sqlite'}
            <label><span>主机</span><input bind:value={d.host} placeholder="127.0.0.1" spellcheck="false" /></label>
<label class="port"><span>端口</span><input bind:value={d.port} placeholder={d.kind === 'mysql' ? '3306' : '5432'} spellcheck="false" /></label>
            <div class="ssl-cell"><span>SSL 加密</span><span class="sql-secret ssl-secret"><label class="ssl-inline" title="SSL 加密连接（远程数据库建议开启）"><input type="checkbox" bind:checked={d.ssl} /><span>启用</span></label></span></div>
            <label><span>用户名</span><input bind:value={d.user} placeholder="root" spellcheck="false" /></label>
            <label class="pwd"><span>密码</span>
              <span class="sql-secret">
                <input type={showSecret ? 'text' : 'password'} autocomplete="off" bind:value={d.password} placeholder="••••••••" spellcheck="false" />
                <button class="sql-secret-toggle" onclick={() => (showSecret = !showSecret)} title={showSecret ? '隐藏密码' : '显示密码'}>{@html showSecret ? UI_ICONS.eyeOff : UI_ICONS.eye}</button>
              </span>
            </label>

            <label class="full"><span>默认数据库</span>
              <span class="sql-db-picker">
                <input list="sql-db-list" bind:value={d.database} placeholder="全部（留空则连接后选择）" spellcheck="false" />
                <datalist id="sql-db-list">{#each dbList as name}<option value={name}></option>{/each}</datalist>
                <button class="sql-btn ghost" disabled={dbFetching || !d.host.trim() || !d.user.trim()} title={(!d.host.trim() || !d.user.trim()) ? '请先填写主机与用户名' : '从服务器拉取数据库列表'} onclick={fetchFormDatabases}>{dbFetching ? '拉取中…' : '拉取数据库'}</button>
              </span>
            </label>
          {:else}
            <label class="full"><span>数据库文件</span><input bind:value={d.file} placeholder="C:\path\to\app.db 或 :memory:" spellcheck="false" /></label>
          {/if}
        </div>
        {#if formError}<div class="sql-error"><i></i>{formError}</div>{/if}
        {#if formOk}<div class="sql-ok"><i></i>{formOk}</div>{/if}
        <footer>
          <span class="sql-form-hint">测试连接会立即尝试连接</span>
          <button class="sql-btn ghost" disabled={testing} onclick={testForm}>{testing ? '测试中…' : '测试连接'}</button>
          <button class="sql-btn ghost" onclick={() => (formOpen = false)}>取消</button>
          <button class="sql-btn primary" disabled={!d.name.trim() || (d.kind !== 'sqlite' && !d.host.trim())} onclick={saveForm}>保存</button>
        </footer>
      </div>
    </div>
  {/if}
  {#if treeTip}
    <div class="sql-tree-tip" style={`left:${treeTip.left}px;top:${treeTip.top}px;width:${treeTip.width}px`} role="tooltip">{treeTip.name}</div>
  {/if}
</div>

<style>
  .sql-panel { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2);  }

  /* ── 顶栏 ── */
  .sql-bar { min-height: 52px; flex: 0 0 auto; display: flex; align-items: center; gap: 12px; padding: 0 13px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, color-mix(in srgb, var(--panel) 92%, var(--accent-soft)), var(--panel)); }
  .sql-bar-id { min-width: 0; display: flex; align-items: center; gap: 10px; }
  .sql-bar-ico { width: 30px; height: 30px; display: grid; place-items: center; flex: 0 0 auto; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line)); border-radius: 8px; background: var(--accent-soft); }
  :global(.sql-bar-ico svg) { width: 15px; height: 15px; }
  .sql-bar-id > div { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .sql-bar-id b { overflow: hidden; font-size: var(--fs-lg); letter-spacing: -.2px; text-overflow: ellipsis; white-space: nowrap; }
  .sql-bar-id small { overflow: hidden; color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .sql-bar-status { display: flex; align-items: center; gap: 7px; padding: 5px 11px; color: var(--muted); font-size: var(--fs-tiny); border: 1px solid var(--line); border-radius: 999px; background: var(--bg); white-space: nowrap; }
  .sql-bar-status i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-2); }
  .sql-bar-status.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); background: var(--accent-soft); }
  .sql-bar-status.on i { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .sql-bar-status.err { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, var(--line)); background: color-mix(in srgb, var(--danger) 7%, transparent); }
  .sql-bar-status.err i { background: var(--danger); }
  .sql-bar-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }

  /* ── 按钮 ── */
  .sql-btn { height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; cursor: pointer; font-size: var(--fs-sm); border-radius: 8px; white-space: nowrap; transition: all .15s ease; }
  :global(.sql-btn svg) { width: 12px; height: 12px; }
  .sql-btn.ghost { color: var(--muted); border: 1px solid var(--line); background: var(--bg); }
  .sql-btn.ghost:hover:not(:disabled) { color: var(--text); border-color: var(--line-2); background: var(--hover); }
  .sql-btn.ghost.danger:hover:not(:disabled) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .sql-btn.primary { color: #fff; font-weight: 700; border: 0; background: var(--btn-gradient); box-shadow: 0 5px 14px color-mix(in srgb, var(--accent) 22%, transparent); }
  .sql-btn.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 7px 18px color-mix(in srgb, var(--accent) 32%, transparent); }
  .sql-btn:disabled { cursor: default; opacity: .4; }
  .sql-btn.big { height: 34px; padding: 0 18px; font-size: var(--fs-sm); }
  .sql-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }

  /* ── 主体布局 ── */
  .sql-body { min-width: 0; min-height: 0; flex: 1; display: grid; grid-template-columns: 300px minmax(0, 1fr); }
  .sql-side { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow-x: hidden; border-right: 1px solid var(--line); background: var(--panel); }
  .sql-side-head { height: 36px; flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 13px; color: var(--muted-2); font-size: var(--fs-tiny); font-weight: 700; letter-spacing: 1px; border-bottom: 1px solid var(--line); }
  .sql-side-add { width: 22px; height: 22px; display: grid; place-items: center; cursor: pointer; color: var(--muted); border: 0; border-radius: 8px; background: transparent; }
  :global(.sql-side-add svg) { width: 12px; height: 12px; }
  .sql-side-add:hover { color: var(--accent); background: var(--hover); }

  /* ── 连接列表 ── */
  .sql-conns { flex: 0 1 auto; max-height: 42%; min-height: 60px; display: flex; flex-direction: column; gap: 2px; padding: 7px; overflow-y: auto; overflow-x: hidden; border-bottom: 1px solid var(--line); scrollbar-width: none; }
  .sql-conns::-webkit-scrollbar { display: none; }
  .sql-conn { position: relative; min-width: 0; display: flex; align-items: center; gap: 4px; padding: 4px 8px; border: 1px solid transparent; border-radius: 8px; transition: all .15s ease; }
  .sql-conn:hover { background: var(--hover); }
  .sql-conn.live { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: color-mix(in srgb, var(--accent) 5%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
  .sql-conn.active { border-color: color-mix(in srgb, var(--accent) 24%, var(--line)); background: var(--panel-2); box-shadow: inset 2px 0 0 var(--accent); }
  .sql-conn-main { min-width: 0; flex: 1; display: flex; align-items: center; gap: 8px; padding: 7px 6px 7px 10.5px; cursor: pointer; text-align: left; color: var(--text); border: 0; background: transparent; }
  .sql-conn-ico { width: 26px; height: 26px; display: grid; place-items: center; flex: 0 0 auto; color: var(--accent); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  :global(.sql-conn-ico svg) { width: 13px; height: 13px; }
  .sql-conn-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .sql-conn-copy b { overflow: hidden; font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
  .sql-conn-copy small { overflow: hidden; color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .sql-conn-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--muted-2); }
  .sql-conn-dot.on { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .sql-conn-ops { display: none; align-items: center; gap: 2px; padding-right: 6px; }
  .sql-conn:hover .sql-conn-ops { display: flex; }
  .sql-conn-ops button { width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer; color: var(--muted-2); border: 0; border-radius: 8px; background: transparent; }
  :global(.sql-conn-ops button svg) { width: 11px; height: 11px; }
  .sql-conn-ops button:hover { color: var(--text); background: var(--panel-2); }
  .sql-conn-ops button.confirm { color: #fff; background: var(--danger); font-size: var(--fs-tiny); }
  .sql-conns-empty { padding: 16px 10px; color: var(--muted-2); font-size: var(--fs-tiny); line-height: 1.8; text-align: center; }
  .sql-quick-conns { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 4px 0 12px; }
  .sql-quick-conn { display: flex; align-items: center; gap: 10.5px; padding: 10.5px 13px; cursor: pointer; color: var(--text); text-align: left; border: 1px solid var(--line); border-radius: 10.5px; background: var(--panel-2); transition: border-color .15s ease, transform .12s ease, box-shadow .15s ease; }
  .sql-quick-conn:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 12%, transparent); transform: translateY(-1px); }
  .sql-quick-conn .sql-quick-copy { display: flex; flex-direction: column; gap: 2px; }
  .sql-quick-conn b { font-size: var(--fs-sm); }
  .sql-quick-conn small { color: var(--muted-2); font-size: var(--fs-tiny); }
  .sql-quick-conn i { color: var(--accent); font-size: var(--fs-tiny); font-style: normal; }

  /* ── 库表树 ── */
  .sql-tree { min-height: 0; flex: 1; padding: 6px; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; scrollbar-gutter: stable; }
  .sql-tree:hover { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--muted) 38%, transparent) transparent; }
  .sql-tree:hover::-webkit-scrollbar { display: block; width: 5px; }
  .sql-tree:hover::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 38%, transparent); border-radius: 3px; }
  .sql-tree::-webkit-scrollbar { display: none; width: 5px; }
  .sql-tables { overflow-y: auto; scrollbar-width: none; }
  .sql-tables::-webkit-scrollbar { display: none; }
  .sql-db { position: relative; }
  .sql-db-row { width: 100%; height: 28px; display: flex; align-items: center; gap: 6px; padding: 0 8px; cursor: pointer; text-align: left; color: var(--text); border: 0; border-radius: 8px; background: transparent; }
  .sql-ctx-backdrop { position: fixed; z-index: 40; inset: 0; background: transparent; }
  .sql-ctx { position: fixed; z-index: 41; width: 190px; display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel-2); box-shadow: 0 16px 48px rgba(0, 0, 0, .5); animation: fade-in .1s ease-out; }
  .sql-ctx > b { padding: 4px 8px 7px; overflow: hidden; color: var(--muted); font-size: var(--fs-xs); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--line); }
  .sql-ctx > button { height: 28px; padding: 0 10.5px; cursor: pointer; text-align: left; color: var(--text); font-size: var(--fs-xs); border: 0; border-radius: 8px; background: transparent; transition: background .12s ease; }
  .sql-ctx > button:hover:not(:disabled) { background: var(--hover); }
  .sql-ctx > button:disabled { opacity: .45; cursor: default; }
  .sql-ctx > small { padding: 5px 8px 2px; color: var(--accent); font-size: var(--fs-xs); }
  .sql-ctx > small.err { color: var(--danger); }
  .sql-cell-menu { position: fixed; z-index: 41; width: 190px; display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel-2); box-shadow: 0 16px 48px rgba(0, 0, 0, .5); animation: fade-in .1s ease-out; }
  .sql-cell-menu b { padding: 4px 8px 7px; color: var(--muted); font-size: var(--fs-xs); font-weight: 600; border-bottom: 1px solid var(--line); }
  .sql-cell-menu button { height: 28px; padding: 0 10.5px; cursor: pointer; text-align: left; color: var(--text); font-size: var(--fs-xs); border: 0; border-radius: 8px; background: transparent; transition: background .12s ease; }
  .sql-cell-menu button:hover { background: var(--hover); }
  .sql-export-note { position: fixed; z-index: 42; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 8px 14px; color: var(--accent); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 10.5px; background: var(--panel-2); box-shadow: 0 12px 36px rgba(0, 0, 0, .45); animation: fade-in .15s ease-out; }
  .sql-export-note.err { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
  .sql-export-note button { width: 20px; height: 20px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 0; border-radius: 8px; background: transparent; }
  .sql-export-note button:hover { color: var(--text); background: var(--hover); }
  .sql-db-row:hover { background: var(--hover); }
  .chev { width: 12px; flex: 0 0 auto; color: var(--muted-2); font-size: var(--fs-tiny); transition: transform .15s ease; }
  .chev.open { transform: rotate(90deg); color: var(--muted); }
  .sql-db-ico { display: inline-flex; flex: 0 0 auto; color: var(--warn); }
  :global(.sql-db-ico svg) { width: 13px; height: 13px; }
  .sql-db-row b { min-width: 0; flex: 1; overflow: hidden; font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
  .sql-db-row small { color: var(--muted-2); font: 500 var(--fs-tiny) 'Cascadia Code', monospace; }
  .sql-tables { display: flex; flex-direction: column; gap: 1px; padding: 1px 0 4px 18px; }
  .sql-table-row { width: 100%; height: 25px; display: flex; align-items: center; gap: 7px; padding: 0 8px; cursor: pointer; text-align: left; color: var(--muted); border: 1px solid transparent; border-radius: 8px; background: transparent; transition: all .13s ease; }
  .sql-table-row:hover { color: var(--text); background: var(--hover); }
  .sql-table-row.active { color: var(--text); border-color: color-mix(in srgb, var(--accent) 26%, var(--line)); background: var(--accent-soft); }
  .tbl-ico { display: inline-flex; flex: 0 0 auto; color: var(--blue); }
  :global(.tbl-ico svg) { width: 12px; height: 12px; }
  .tbl-ico.big { width: 26px; height: 26px; display: grid; place-items: center; color: var(--accent); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  :global(.tbl-ico.big svg) { width: 13px; height: 13px; }
  .sql-table-row b { min-width: 0; flex: 1; overflow: hidden; font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
  .sql-table-row em { padding: 1px 5px; color: var(--muted-2); font-size: var(--fs-tiny); font-style: normal; border: 1px solid var(--line); border-radius: 4px; }
  .sql-tree-loading { padding: 14px 10px; color: var(--muted-2); font-size: var(--fs-tiny); text-align: center; }
  .sql-tree-tip {
    position: fixed;
    z-index: 60;
    box-sizing: border-box;
    padding: 6px 10px;
    overflow: hidden;
    color: var(--text);
    font-size: var(--fs-xs);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--line-2);
    border-radius: 8px;
    background: var(--panel-2);
    box-shadow: 0 10px 26px rgba(0, 0, 0, .42);
    pointer-events: none;
    animation: fade-in .1s ease-out;
  }

  /* ── 主区 ── */
  .sql-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--panel-2); }
  .sql-users-scroll { flex: 1; min-height: 0; padding: 12px; overflow-y: auto; }
  .sql-tabs { height: 40px; flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-tabs-group { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .sql-tabs-group button { height: 26px; padding: 0 13px; cursor: pointer; color: var(--muted); font-size: var(--fs-sm); border: 0; border-radius: 8px; background: transparent; transition: all .15s ease; }
  .sql-tabs-group button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .sql-tabs-group button.active { color: #fff; font-weight: 700; background: var(--btn-gradient); box-shadow: 0 3px 10.5px color-mix(in srgb, var(--accent) 25%, transparent); }
  .sql-tabs-info { display: flex; align-items: center; gap: 10.5px; margin-left: auto; min-width: 0; }
  .sql-tabs-info .sql-db-select { height: 27px; max-width: 190px; padding: 0 8px; color: var(--text); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--panel); }
  .sql-tabs-info .sql-ver { overflow: hidden; max-width: 240px; color: var(--muted); font: 500 var(--fs-tiny) 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .sql-tabs-info em { overflow: hidden; max-width: 200px; padding: 3px 8px; color: var(--accent); font-size: var(--fs-tiny); font-style: normal; text-overflow: ellipsis; white-space: nowrap; border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line)); border-radius: 8px; background: var(--accent-soft); }

  .sql-empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 8px; padding: 20px; color: var(--muted); text-align: center; }
  .sql-empty.small { min-height: 260px; }
  .sql-empty-tile { width: 52px; height: 52px; display: grid; place-items: center; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 14px; background: var(--accent-soft); }
  :global(.sql-empty-tile svg) { width: 26px; height: 26px; }
  .sql-empty b { color: var(--text); font-size: var(--fs-lg); }
  .sql-empty p { margin: 0; font-size: var(--fs-sm); }
  .sql-empty .sql-btn { margin-top: 6px; }
  .sql-steps { display: flex; align-items: stretch; gap: 10px; margin-top: 6px; }
  .sql-steps > span { display: flex; flex-direction: column; gap: 3px; min-width: 132px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--w-025); text-align: left; }
  .sql-steps i { width: 20px; height: 20px; display: grid; place-items: center; color: #fff; font: 700 12px/1 sans-serif; font-style: normal; border-radius: 50%; background: var(--grad-main); box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 35%, transparent); }
  .sql-steps b { color: var(--text); font-size: var(--fs-sm); }
  .sql-steps small { color: var(--muted-2); font-size: var(--fs-xs); }
  .sql-loading { flex: 1; display: grid; place-content: center; justify-items: center; gap: 10.5px; color: var(--muted); font-size: var(--fs-xs); }

  .sql-error { display: flex; align-items: flex-start; gap: 8px; margin: 10.5px 12px 0; padding: 8px 12px; color: var(--danger); font-size: var(--fs-xs); line-height: 1.5; border: 1px solid color-mix(in srgb, var(--danger) 28%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .sql-error i { width: 6px; height: 6px; flex: 0 0 auto; margin-top: 4px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .sql-data-error { flex: 1; display: flex; align-items: center; justify-content: center; gap: 12px; padding: 18px 20px; }
  .sql-data-error-ico { display: grid; place-items: center; width: 38px; height: 38px; flex: 0 0 auto; color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 32%, var(--line)); border-radius: 12px; background: color-mix(in srgb, var(--danger) 8%, transparent); }
  :global(.sql-data-error-ico svg) { width: 19px; height: 19px; }
  .sql-data-error-copy { min-width: 0; }
  .sql-data-error-copy b { display: block; margin-bottom: 4px; color: var(--text); font-size: var(--fs-sm); }
  .sql-data-error-copy p { margin: 0; color: var(--muted); font-size: var(--fs-xs); line-height: 1.55; word-break: break-word; }
  .sql-ok { display: flex; align-items: center; gap: 8px; margin: 10.5px 12px 0; padding: 7px 12px; color: var(--accent); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line)); border-radius: 8px; background: var(--accent-soft); }
  .sql-ok i { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }

  /* ── 表数据视图 ── */
  .sql-data { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
  .sql-data-bar { min-height: 46px; flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-data-title { min-width: 0; display: flex; align-items: center; gap: 8px; }
  .sql-data-title b { overflow: hidden; font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
  .sql-data-title em { padding: 2px 6px; color: var(--muted); font-size: var(--fs-tiny); font-style: normal; border: 1px solid var(--line); border-radius: 4px; }
  .sql-data-title small { color: var(--muted-2); font: 500 var(--fs-xs) 'Cascadia Code', monospace; white-space: nowrap; }
  .sql-data-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }

  .sql-grid-wrap { min-height: 0; flex: 1; overflow: auto; }
  .sql-grid { width: 100%; border-collapse: collapse; font: 450 13.6px/1.45 'Cascadia Code', monospace; }
  .sql-grid th { position: sticky; top: 0; z-index: 2; padding: 7px 10px; text-align: left; font-weight: 600; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--panel-2); white-space: nowrap; }
  .sql-grid th .col-name { color: var(--text); font-size: var(--fs-xs); }
  .sql-grid th small { margin-left: 5px; color: var(--muted-2); font-size: var(--fs-tiny); font-weight: 400; }
  .sql-grid th .pk { margin-left: 5px; padding: 1px 4px; color: var(--warn); font-size: var(--fs-tiny); font-style: normal; border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line)); border-radius: 3px; background: var(--warn-soft); }
  .sql-grid th.chk, .sql-grid td.chk { width: 34px; padding: 0 8px; text-align: center; }
  .sql-grid td { max-width: 260px; padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-grid tbody tr:hover td { background: var(--hover); }
  .sql-grid tbody tr.selected td { background: color-mix(in srgb, var(--accent) 10%, var(--panel)); }
  .sql-grid tbody tr.is-new td { background: color-mix(in srgb, var(--blue) 7%, var(--panel)); }
  .sql-grid td.cell { color: var(--text); }
  .sql-grid td.cell.dirty { background: color-mix(in srgb, var(--warn) 14%, var(--panel)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 45%, transparent); }
  .sql-grid td.cell.null { color: var(--muted-2); font-style: italic; }
  .cell-view { width: 100%; height: 28px; display: block; padding: 0 10px; cursor: text; text-align: left; color: inherit; border: 0; background: transparent; }
  .cell-view:hover { color: var(--accent); }
  .null-tag { color: var(--muted-2); font-style: italic; font-size: var(--fs-tiny); }
  .cell-edit { position: relative; display: flex; align-items: center; }
  .cell-edit input { width: 100%; height: 28px; padding: 0 52px 0 10px; color: var(--text); font: 450 var(--fs-xs) 'Cascadia Code', monospace; border: 0; outline: 0; background: color-mix(in srgb, var(--accent) 8%, var(--panel)); box-shadow: inset 0 0 0 2px var(--accent); }
  .cell-null { position: absolute; right: 4px; height: 21px; padding: 0 6px; cursor: pointer; color: var(--muted); font: 600 var(--fs-tiny) 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 4px; background: var(--panel-2); }
  .cell-null:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .badge-new { display: inline-block; padding: 1px 5px; color: #fff; font-size: var(--fs-tiny); border-radius: 3px; background: linear-gradient(135deg, var(--blue), var(--accent)); }
  .sql-grid td.idx, .sql-grid th.idx { width: 42px; padding: 0 8px; color: var(--muted-2); text-align: right; }
  .sql-grid td.grid-empty { padding: 22px 14px; color: var(--muted-2); font-size: var(--fs-xs); text-align: center; }
  .sql-grid.readonly td { cursor: default; }
  .sql-grid.readonly td.cell { padding: 0 10px; height: 28px; line-height: 28px; }

  .sql-pager { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 12px; border-top: 1px solid var(--line); background: var(--panel); }
  .sql-pager > span { color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', monospace; }
  .sql-pager > div { display: flex; align-items: center; gap: 8px; }
  .sql-pager button { height: 28px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: var(--fs-tiny); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .sql-pager button:hover:not(:disabled) { color: var(--text); border-color: var(--line-2); }
  .sql-pager button:disabled { cursor: default; opacity: .35; }
  .sql-pager span { color: var(--muted); font-size: var(--fs-tiny); }
  .sql-pager .sql-page-size { height: 28px; padding: 0 6px; color: var(--muted); font-size: var(--fs-tiny); border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--bg); cursor: pointer; }
  .sql-filter { width: 180px; height: 25px; padding: 0 10.5px; color: var(--text); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .sql-filter:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .sql-filter::placeholder { color: var(--muted-2); }
  .sql-where { display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 4px 0 0; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .sql-where:focus-within { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .sql-where.active { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .sql-where-tag { height: 100%; display: grid; place-items: center; padding: 0 6px; color: var(--muted-2); font: 600 var(--fs-tiny) 'Cascadia Code', monospace; border-right: 1px solid var(--line); background: var(--panel-2); border-radius: 8px 0 0 8px; }
  .sql-where input { min-width: 150px; width: 150px; color: var(--text); font: 500 var(--fs-xs) 'Cascadia Code', monospace; border: 0; outline: 0; background: transparent; }
  .sql-where input::placeholder { color: var(--muted-2); }
  .sql-where-clear { width: 18px; height: 18px; display: grid; place-items: center; cursor: pointer; color: var(--muted-2); font-size: var(--fs-xs); border: 0; border-radius: 4px; background: transparent; }
  .sql-where-clear:hover { color: var(--danger); background: var(--hover); }
  .sql-result-pager { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 7px 12px; border-top: 1px solid var(--line); background: var(--panel); }
  .sql-result-pager button { height: 28px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: var(--fs-tiny); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .sql-result-pager button:hover:not(:disabled) { color: var(--text); border-color: var(--line-2); }
  .sql-result-pager button:disabled { cursor: default; opacity: .35; }
  .sql-result-pager span { color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', monospace; }
  .sql-filter-hint { padding: 2px 8px; color: var(--blue); font-size: var(--fs-tiny); font-style: normal; border: 1px solid color-mix(in srgb, var(--blue) 35%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--blue) 8%, transparent); }
  .cell-view.read { cursor: default; }
  .cell-view.read:hover { color: inherit; }
  .sql-history-wrap { position: relative; }
  .sql-history { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 360px; max-height: 260px; padding: 5px; overflow-y: auto; border: 1px solid var(--line-2); border-radius: 10.5px; background: var(--panel-2); box-shadow: 0 12px 32px rgba(0, 0, 0, .35); }
  .sql-history button { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; color: var(--text); font-size: var(--fs-xs); text-align: left; border: 0; border-radius: 8px; background: transparent; }
  .sql-history button:hover { background: var(--hover); }
  .sql-history button span { flex: 0 0 auto; color: var(--muted-2); font: 500 var(--fs-tiny) 'Cascadia Code', monospace; }
  .sql-history button code { min-width: 0; overflow: hidden; color: var(--muted); font: 400 var(--fs-xs)/1.5 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .sql-history-empty { padding: 14px; color: var(--muted-2); font-size: var(--fs-tiny); text-align: center; }
  .sql-help-wrap { position: relative; }
  .sql-help { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 300px; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 10.5px; background: var(--panel-2); box-shadow: 0 12px 32px rgba(0, 0, 0, .35); }
  .sql-help b { display: block; margin-bottom: 6px; color: var(--muted); font-size: var(--fs-xs); letter-spacing: .5px; }
  .sql-help span { display: flex; align-items: center; gap: 6px; padding: 3px 0; color: var(--text); font-size: var(--fs-tiny); }
  .sql-help kbd { margin: 0; }

  .sql-ddl { flex: 0 0 auto; margin: 10.5px 12px 12px; border: 1px solid var(--line); border-radius: 10.5px; background: var(--panel); overflow: hidden; }
  .sql-ddl summary { padding: 8px 12px; cursor: pointer; color: var(--muted); font-size: var(--fs-sm); user-select: none; }
  .sql-ddl summary:hover { color: var(--text); }
  .sql-ddl pre { margin: 0; padding: 10px 12px; overflow: auto; color: var(--text); font: 450 13.1px/1.6 'Cascadia Code', monospace; border-top: 1px solid var(--line); background: var(--bg); white-space: pre-wrap; }
  .sql-ddl-note { flex: 0 0 auto; margin: 10.5px 12px 12px; padding: 8px 12px; color: var(--muted-2); font-size: var(--fs-tiny); border: 1px dashed var(--line-2); border-radius: 8px; }

  /* ── SQL 编辑器 ── */
  .sql-editor { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
  .sql-editor-bar { min-height: 44px; flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-editor-bar kbd { margin: 0; }
  .sql-editor-note { color: var(--muted-2); font-size: var(--fs-tiny); }
  .flex-spacer { flex: 1; }
  .sql-editor-area { position: relative; min-height: 120px; flex: 0 0 auto; resize: vertical; overflow: hidden; border: 0; border-bottom: 1px solid var(--line); background: var(--bg); }
  .sql-editor-area pre.sql-editor-hl { position: absolute; inset: 0; z-index: 0; margin: 0; padding: 12px 14px; overflow: hidden; pointer-events: none; color: var(--text); font: 450 13.8px/1.65 'Cascadia Code', monospace; white-space: pre-wrap; word-break: break-word; }
  .sql-editor-area textarea { position: relative; z-index: 1; width: 100%; height: 100%; min-height: 120px; padding: 12px 14px; color: transparent; caret-color: var(--text); font: 450 13.8px/1.65 'Cascadia Code', monospace; resize: none; border: 0; outline: 0; background: transparent; }
  .sql-editor-area textarea::selection { background: var(--accent-soft); }
  .sql-editor-area textarea:focus { box-shadow: inset 0 2px 0 var(--accent); }
  .sql-editor-area textarea::placeholder { color: var(--muted-2); }
  :global(.sql-hl-keyword) { color: var(--c-violet); font-weight: 600; }
  :global(.sql-hl-string) { color: var(--c-green); }
  :global(.sql-hl-number) { color: var(--c-amber); }
  :global(.sql-hl-comment) { color: var(--muted); font-style: italic; }
  .sql-completion { position: absolute; top: 6px; right: 10px; z-index: 30; width: 240px; max-height: 260px; padding: 5px; overflow-y: auto; border: 1px solid var(--line-2); border-radius: 10.5px; background: var(--panel-2); box-shadow: 0 12px 32px rgba(0, 0, 0, .35); }
  .sql-completion small { display: block; padding: 4px 8px 5px; color: var(--muted-2); font-size: var(--fs-tiny); letter-spacing: .5px; }
  .sql-completion button { width: 100%; padding: 6px 8px; cursor: pointer; color: var(--text); text-align: left; border: 0; border-radius: 8px; background: transparent; }
  .sql-completion button:hover { background: var(--hover); }
  .sql-completion button.active { background: var(--accent-soft); }
  .sql-completion code { font: 500 13px 'Cascadia Code', monospace; }
  .sql-result-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 10.5px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-result-chip { padding: 2px 7px; color: var(--blue); font: 700 var(--fs-tiny) 'Cascadia Code', monospace; border-radius: 4px; background: color-mix(in srgb, var(--blue) 12%, transparent); }
  .sql-result-chip.query { color: var(--accent); background: var(--accent-soft); }
  .sql-result-bar b { font-size: var(--fs-sm); }
  .sql-result-bar small { color: var(--muted); font: 500 var(--fs-xs) 'Cascadia Code', monospace; }
  .sql-truncated { padding: 2px 7px; color: var(--warn); font-size: var(--fs-tiny); font-style: normal; border-radius: 4px; background: var(--warn-soft); }
  .sql-result-grid { flex: 1; }

  /* ── 连接表单 ── */
  .sql-modal-backdrop { position: fixed; z-index: 320; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(2, 4, 6, .5); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); animation: fade-in .14s ease-out; }
  .sql-modal { width: min(520px, 100%); max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line-2); border-radius: 14px; background: var(--panel-2); box-shadow: 0 30px 90px rgba(0, 0, 0, .45); animation: palette-in .18s cubic-bezier(.2, .9, .3, 1.2); }
  .sql-modal > header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-modal > header b { font-size: var(--fs-lg); }
  .sql-modal > header small { display: block; margin-top: 2px; color: var(--muted-2); font-size: var(--fs-tiny); }
  .sql-form { display: grid; grid-template-columns: minmax(0, 1fr) 108px minmax(0, 1fr); gap: 12px; padding: 16px; overflow-y: auto; }
  .sql-form .full { grid-column: 1 / -1; }
  .sql-form .port { grid-column: 2; }
  .sql-form .ssl-cell { grid-column: 3; }
  .sql-form .pwd { grid-column: 2 / -1; }
  .sql-form label, .sql-form > div { display: flex; flex-direction: column; gap: 6px; }
  .sql-form label > span { color: var(--muted); font-size: var(--fs-sm); }
  .sql-form input { height: 30px; padding: 0 11px; color: var(--text); font: 500 var(--fs-xs) 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .sql-form input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .sql-kind-chips { display: inline-flex; gap: 2px; align-self: flex-start; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .sql-kind-chips button { height: 26px; padding: 0 13px; cursor: pointer; color: var(--muted); font-size: var(--fs-sm); border: 0; border-radius: 8px; background: transparent; transition: all .15s ease; }
  .sql-kind-chips button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .sql-kind-chips button.active { color: #fff; font-weight: 700; background: var(--btn-gradient); box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .sql-secret { position: relative; display: flex; align-items: center; }
  .sql-secret input { width: 100%; padding-right: 34px; }
  .sql-secret-toggle { position: absolute; right: 5px; width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer; color: var(--muted-2); border: 0; border-radius: 8px; background: transparent; }
  :global(.sql-secret-toggle svg) { width: 13px; height: 13px; }
  .sql-secret-toggle:hover { color: var(--text); background: var(--hover); }
  .sql-modal > footer { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--panel); }
  .sql-form-hint { flex: 1; color: var(--muted-2); font-size: var(--fs-tiny); }
  .sql-db-picker { display: flex; align-items: center; gap: 8px; }
  .sql-db-picker input { min-width: 0; flex: 1; }
  .sql-db-picker .sql-btn { flex: 0 0 auto; height: 30px; }
  .ssl-cell { display: flex; flex-direction: column; gap: 6px; }
  .ssl-cell > span { color: var(--muted); font-size: var(--fs-sm); }
  .ssl-secret { display: flex; align-items: center; height: 30px; padding: 0 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--w-025); }
  .ssl-inline { display: inline-flex; flex-direction: row; align-items: center; gap: 5px; white-space: nowrap; cursor: pointer; }
  .ssl-inline input { width: auto; }
  .ssl-inline span { color: var(--muted); font-size: var(--fs-sm); }

  @media (max-width: 900px) {
    .sql-body { grid-template-columns: 210px minmax(0, 1fr); }
  }

  /* ── 表设计器 ── */
  .sql-design { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 10.5px; padding: 12px; overflow: hidden; }
  .sql-design-name { width: 220px; height: 30px; padding: 0 10px; color: var(--text); font: 600 15px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .sql-design-name:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .sql-design-wrap { min-height: 0; flex: 1; overflow: auto; border: 1px solid var(--line); border-radius: 10.5px; background: var(--bg); }
  .sql-grid.design { min-width: 860px; }
  .sql-grid.design th { position: sticky; top: 0; z-index: 2; }
  .sql-grid.design td input, .sql-grid.design td select { width: 100%; height: 26px; padding: 0 8px; color: var(--text); font: 500 var(--fs-xs) 'Cascadia Code', monospace; border: 1px solid transparent; border-radius: 8px; outline: 0; background: transparent; transition: all .15s ease; }
  .sql-grid.design td input:hover, .sql-grid.design td select:hover { border-color: var(--line); background: var(--panel); }
  .sql-grid.design td input:focus, .sql-grid.design td select:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: var(--bg); box-shadow: 0 0 0 2px var(--accent-soft); }
  .sql-grid.design td select { cursor: pointer; }
  .sql-grid.design td.chk { text-align: center; }
  .sql-grid.design td.chk input { width: 14px; height: 14px; accent-color: var(--accent); cursor: pointer; }
  .sql-grid.design .dg-name { min-width: 140px; }
  .sql-grid.design .dg-type { min-width: 130px; }
  .sql-grid.design .dg-len { width: 70px; }
  .sql-grid.design .dg-def { min-width: 110px; }
  .sql-grid.design .dg-comment { min-width: 150px; }
  .sql-grid.design .dg-ops { width: 78px; white-space: nowrap; }
  .sql-grid.design td.dg-ops { padding: 0 6px; }
  .sql-design-move, .sql-design-del { width: 22px; height: 22px; display: inline-grid; place-items: center; cursor: pointer; font-size: var(--fs-sm); border: 1px solid var(--line); border-radius: 8px; background: var(--panel); transition: all .15s ease; }
  .sql-design-move { color: var(--muted); }
  .sql-design-move:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .sql-design-del { color: var(--danger); margin-left: 4px; }
  .sql-design-del:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .sql-design-note { display: flex; align-items: center; gap: 8px; padding: 8px 11px; color: var(--muted-2); font-size: var(--fs-tiny); border: 1px dashed var(--line-2); border-radius: 8px; background: var(--panel); }
  .sql-design-note span { color: var(--muted); font-weight: 700; }

  /* 连接级 Tab 栏（Navicat 风格） */
  .sql-conn-tabs { display: flex; align-items: flex-end; gap: 3px; padding: 8px 12px 0; overflow-x: auto; scrollbar-width: thin; flex: 0 0 auto; background: var(--panel); border-bottom: 1px solid var(--line); }
  .sql-conn-tab { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 6px 0 10px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); white-space: nowrap; border: 1px solid var(--line); border-bottom: 0; border-radius: 10px 10px 0 0; background: var(--w-03); transition: all var(--transition); }
  .sql-conn-tab:hover { color: var(--text); background: var(--w-06); }
  .sql-conn-tab.active { color: var(--text); font-weight: 700; background: var(--panel-2); border-color: var(--line-strong); box-shadow: 0 -3px 12px color-mix(in srgb, var(--accent) 14%, transparent); }
  .sql-conn-tab b { max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
  .sql-conn-tab .sql-conn-ico.small { width: 20px; height: 20px; border-radius: 6px; }
  .sql-conn-tab .sql-conn-ico.small :global(svg) { width: 12px; height: 12px; }
  .sql-conn-tab .sql-conn-dot.on { width: 6px; height: 6px; border-radius: 50%; background: var(--c-green); box-shadow: 0 0 6px color-mix(in srgb, var(--c-green) 80%, transparent); }
  .sql-tab-x { display: grid; place-items: center; width: 17px; height: 17px; border-radius: 5px; color: var(--muted-2); font-size: 14px; line-height: 1; cursor: pointer; transition: all .12s ease; }
  .sql-tab-x:hover { background: var(--danger); color: #fff; }
  .sql-tab-add { display: grid; place-items: center; flex: 0 0 auto; width: 30px; height: 30px; margin-bottom: 2px; cursor: pointer; color: var(--muted-2); font-size: 15px; border: 1px dashed var(--line-strong); border-radius: 8px; background: transparent; transition: all var(--transition); }
  .sql-tab-add:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }

</style>
