<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { TOOL_ICONS, UI_ICONS, iconHtml } from '../icons';
  import AiAssist from './AiAssist.svelte';
  import type { AiConfig } from '../ai';

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
    createdAt: number;
  };
  type ColumnInfo = { name: string; dataType: string; nullable: boolean; key: string; default: string | null; extra: string; comment?: string };
  type TableInfo = { name: string; kind: string };
  type RowsResult = { columns: ColumnInfo[]; rows: Array<Array<string | number | boolean | null>>; total: number; offset: number };
  type ExecResult = { columns: string[]; rows: Array<Array<string | number | boolean | null>>; affected: number; elapsedMs: number; truncated: boolean; isQuery: boolean };
  type DbNode = { name: string; expanded: boolean; tables: TableInfo[] | null; loading: boolean };

  const STORAGE_KEY = 'spurh.sql.connections.v1';
  const PAGE_SIZE = 100;
  const KIND_LABEL: Record<ConnKind, string> = { mysql: 'MySQL', postgres: 'PostgreSQL', sqlite: 'SQLite' };

  function loadConnections(): SavedConn[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as SavedConn[];
      return parsed.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string');
    } catch {
      return [];
    }
  }

  function saveConnections(list: SavedConn[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function freshConn(): SavedConn {
    return { id: crypto.randomUUID(), name: '', kind: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '', file: '', createdAt: Date.now() };
  }

  function profileOf(conn: SavedConn) {
    return {
      kind: conn.kind,
      host: conn.host,
      port: conn.port || undefined,
      user: conn.user || undefined,
      password: conn.password || undefined,
      database: conn.database || undefined,
      file: conn.file || undefined,
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
  let tab = $state<'data' | 'sql' | 'design'>('data');
  let sqlText = $state('');
  let sqlRunning = $state(false);
  let sqlResult = $state<ExecResult | null>(null);
  let sqlError = $state('');
  let copiedKey = $state('');

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
  let confirmDeleteId = $state('');
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  function selectConn(id: string): void {
    activeId = id;
    connected = false;
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
      const names = await invoke<string[]>('sql_databases', { profile: profileOf(activeConn) });
      connected = true;
      databases = names.map((name) => ({ name, expanded: false, tables: null, loading: false }));
      // 默认展开第一个数据库
      if (databases.length > 0) {
        databases[0].expanded = true;
        await loadTables(databases[0].name);
      }
      invoke('sql_test', { profile: profileOf(activeConn) }).then((t) => {
        serverVersion = (t as { serverVersion: string }).serverVersion;
      }).catch(() => undefined);
    } catch (cause) {
      connError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      connecting = false;
    }
  }

  function disconnect(): void {
    if (activeConn) invoke('sql_disconnect', { profile: profileOf(activeConn) }).catch(() => undefined);
    connected = false;
    databases = [];
    selectedTable = '';
    selectedDb = '';
    meta = null;
    rows = [];
    sqlResult = null;
    connError = '';
  }

  async function loadTables(dbName: string): Promise<void> {
    if (!activeConn) return;
    const node = databases.find((item) => item.name === dbName);
    if (!node) return;
    node.loading = true;
    try {
      node.tables = await invoke<TableInfo[]>('sql_tables', { profile: profileOf(activeConn), database: dbName });
    } catch (cause) {
      node.tables = [];
      connError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      node.loading = false;
    }
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
      const names = await invoke<string[]>('sql_databases', { profile: profileOf(activeConn) });
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

  async function selectTable(dbName: string, table: TableInfo): Promise<void> {
    selectedDb = dbName;
    selectedTable = table.name;
    tableKind = table.kind;
    page = 0;
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
      const result = await invoke<RowsResult>('sql_table_rows', {
        profile: profileOf(activeConn),
        database: selectedDb,
        table: selectedTable,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      meta = { columns: result.columns };
      rows = result.rows;
      total = result.total;
      draft = {};
      newRowDrafts = [];
      selectedRows = new Set();
      pendingDeletes = [];
      // 建表语句（异步、失败不阻塞）
      invoke<string>('sql_table_ddl', { profile: profileOf(activeConn), database: selectedDb, table: selectedTable })
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
    if (next < 0 || next * PAGE_SIZE >= total) return;
    page = next;
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
    const keyCol = pkCols.length > 0 ? pkCols[0].name : meta!.columns[0].name;
    const keyIndex = colIndex(keyCol);
    const values = [...selectedRows].map((ri) => cellText(rows[ri]?.[keyIndex]) ?? '');
    rowError = '';
    saveMessage = '';
    try {
      await invoke('sql_delete_rows', { profile: profileOf(activeConn!), database: selectedDb, table: selectedTable, keyColumn: keyCol, keyValues: values });
      saveMessage = '已删除 ' + values.length + ' 行';
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
      // 更新已修改行
      for (const ri of dirtyRows) {
        const changes: Array<{ column: string; value: string | null }> = [];
        for (let ci = 0; ci < meta!.columns.length; ci++) {
          if (isDirty(ri, ci)) changes.push({ column: meta!.columns[ci].name, value: draftKey(ri, ci) ?? null });
        }
        updated += await invoke<number>('sql_update_row', {
          profile: profileOf(activeConn),
          database: selectedDb,
          table: selectedTable,
          keys: keyRefs(ri),
          changes,
        });
      }
      // 插入新增行
      for (const row of newRowDrafts) {
        const values = meta!.columns.map((col) => row[col.name] ?? null);
        inserted += await invoke<number>('sql_insert_row', {
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
    try { await navigator.clipboard.writeText(value); } catch { return; }
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 1100);
  }

  /* ── SQL 编辑器 ── */
  function handleSqlKeys(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      runSql();
    }
  }

  async function runSql(): Promise<void> {
    const sql = sqlText.trim();
    if (!sql || sqlRunning || !activeConn) return;
    sqlRunning = true;
    sqlError = '';
    sqlResult = null;
    try {
      sqlResult = await invoke<ExecResult>('sql_execute', { profile: profileOf(activeConn), sql });
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
      const cols = await invoke<ColumnInfo[]>('sql_table_columns', { profile: profileOf(activeConn), database: selectedDb, table: selectedTable });
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
        await invoke<number>('sql_create_table', {
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
        await invoke<number>('sql_alter_table', {
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
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      if (tab === 'design') saveDesign();
      else if (tab === 'data' && hasPending) saveChanges();
    }
  }

  /* ── 连接表单 ── */
  function openNewConn(): void {
    editingConn = null;
    formDraft = { ...freshConn() };
    formError = '';
    formOk = '';
    showSecret = false;
    formOpen = true;
  }

  function openEditConn(): void {
    if (!activeConn) return;
    editingConn = activeConn;
    formDraft = { ...activeConn };
    formError = '';
    formOk = '';
    showSecret = false;
    formOpen = true;
  }

  function openEditConnFor(conn: SavedConn): void {
    editingConn = conn;
    formDraft = { ...conn };
    formError = '';
    formOk = '';
    showSecret = false;
    formOpen = true;
  }

  async function testForm(): Promise<void> {
    if (!formDraft) return;
    testing = true;
    formError = '';
    formOk = '';
    try {
      const result = await invoke<{ serverVersion: string; elapsedMs: number }>('sql_test', { profile: profileOf(formDraft) });
      formOk = '连接成功 · ' + result.serverVersion + ' · ' + result.elapsedMs + ' ms';
    } catch (cause) {
      formError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      testing = false;
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
    activeId = cleaned.id;
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
    invoke('sql_disconnect', { profile: profileOf(target) }).catch(() => undefined);
    connections = connections.filter((item) => item.id !== id);
    saveConnections(connections);
    if (activeId === id) {
      activeId = connections[0]?.id ?? '';
      connected = false;
      databases = [];
      selectedTable = '';
    }
  }

  function connErrorFor(conn: SavedConn): string {
    if (conn.kind === 'sqlite') return 'SQLite · ' + (conn.file || '未指定文件');
    return '连接 ' + conn.host + ':' + (conn.port || (conn.kind === 'mysql' ? 3306 : 5432)) + ' · 用户 ' + (conn.user || '—');
  }

  function ddlDisplay(): string {
    return ddl || '';
  }
</script>

<svelte:window onkeydown={handlePanelKeys} />

<div class="sql-panel">
  <header class="sql-bar">
    <div class="sql-bar-id">
      <span class="sql-bar-ico">{@html iconHtml(TOOL_ICONS['spurh.sql'])}</span>
      <div><b>{activeConn ? activeConn.name : 'SQL 工具'}</b><small>{activeConn ? connSubtitle(activeConn) : 'MySQL · SQLite · PostgreSQL 数据库管理'}</small></div>
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

  <div class="sql-body">
    <aside class="sql-side">
      <div class="sql-side-head"><span>连接</span><button class="sql-side-add" title="新建连接" onclick={openNewConn}>{@html UI_ICONS.plus}</button></div>
      <div class="sql-conns">
        {#each connections as conn}
          <div class="sql-conn" class:active={conn.id === activeId} class:live={connected && conn.id === activeId}>
            <button class="sql-conn-main" onclick={() => selectConn(conn.id)} ondblclick={() => { selectConn(conn.id); if (activeId === conn.id) connect(); }} title={connSubtitle(conn) + '（双击连接）'}>
              <span class="sql-conn-ico">{@html dbIcon(conn.kind)}</span>
              <span class="sql-conn-copy"><b>{conn.name}</b><small>{connSubtitle(conn)}</small></span>
              <i class="sql-conn-dot" class:on={connected && conn.id === activeId}></i>
            </button>
            <div class="sql-conn-ops">
              <button title="编辑连接" onclick={() => openEditConnFor(conn)}><span>{@html UI_ICONS.sliders}</span></button>
              <button class:confirm={confirmDeleteId === conn.id} title="删除连接" onclick={() => deleteConn(conn.id)}><span>{confirmDeleteId === conn.id ? '确认' : UI_ICONS.trash}</span></button>
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
              <button class="sql-db-row" onclick={() => toggleDb(db.name)} title={db.name}>
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
                      <button class="sql-table-row" class:active={selectedTable === table.name && selectedDb === db.name} onclick={() => selectTable(db.name, table)}>
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
    </aside>

    <main class="sql-main">
      {#if !activeConn}
        <div class="sql-empty">
          <span class="sql-empty-tile">{@html iconHtml(TOOL_ICONS['spurh.sql'])}</span>
          <b>还没有数据库连接</b>
          <p>新建连接后即可浏览库表、编辑数据、执行 SQL</p>
          <button class="sql-btn primary big" onclick={openNewConn}>＋ 新建连接</button>
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
          </div>
          <div class="sql-tabs-info">
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
                </div>
                <div class="sql-data-actions">
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
                      <th class="chk"><input type="checkbox" checked={selectedRows.size > 0 && selectedRows.size === rows.length} onchange={(e) => toggleAll((e.currentTarget as HTMLInputElement).checked)} title="全选" /></th>
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
                    {#each newRowDrafts as row, ni}
                      <tr class="is-new">
                        <td class="chk"><span class="badge-new">新</span></td>
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
                              <button class="cell-view" onclick={() => startNewEdit(ni, ci)} title="点击编辑">
                                {#if nval === null}<em class="null-tag">NULL</em>{:else}{nval}{/if}
                              </button>
                            {/if}
                          </td>
                        {/each}
                      </tr>
                    {/each}
                    {#each rows as row, ri}
                      <tr class:selected={selectedRows.has(ri)}>
                        <td class="chk"><input type="checkbox" checked={selectedRows.has(ri)} onchange={(e) => toggleRow(ri, (e.currentTarget as HTMLInputElement).checked)} /></td>
                        {#each meta.columns as col, ci}
                          {@const key = ri + ':' + ci}
                          {@const original = cellText(row[ci])}
                          {@const cur = draft[key] !== undefined ? draft[key] : original}
                          {@const dirty = draft[key] !== undefined && draft[key] !== original}
                          <td class="cell" class:dirty={dirty} class:null={cur === null}>
                            {#if editing === key}
                              <span class="cell-edit">
                                <input value={editBuf} oninput={(e) => (editBuf = e.currentTarget.value)} onkeydown={handleEditKeydown} bind:this={editingInput} spellcheck="false" />
                                <button class="cell-null" title="设为 NULL" onclick={setNull}>NULL</button>
                              </span>
                            {:else}
                              <button class="cell-view" onclick={() => startEdit(ri, ci)} title="点击编辑">
                                {#if cur === null}<em class="null-tag">NULL</em>{:else}{cur}{/if}
                              </button>
                            {/if}
                          </td>
                        {/each}
                      </tr>
                    {/each}
                    {#if rows.length === 0 && newRowDrafts.length === 0}
                      <tr><td class="grid-empty" colspan={meta.columns.length + 1}>此表暂无数据，点击「＋ 新增行」添加</td></tr>
                    {/if}
                  </tbody>
                </table>
              </div>
              <div class="sql-pager">
                <span>{total > 0 ? (page * PAGE_SIZE + 1) + ' – ' + Math.min((page + 1) * PAGE_SIZE, total) + ' / 共 ' + total + ' 行' : '共 0 行'}</span>
                <div>
                  <button disabled={page === 0 || loadingRows} onclick={() => goPage(page - 1)}>‹ 上一页</button>
                  <span>第 {page + 1} 页</span>
                  <button disabled={(page + 1) * PAGE_SIZE >= total || loadingRows} onclick={() => goPage(page + 1)}>下一页 ›</button>
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
          {:else}
            <div class="sql-empty small">
              <span class="sql-empty-tile">{@html TABLE_ICON}</span>
              <b>选择一张表或新建一张</b>
              <p>在左侧展开数据库，点击表查看数据并编辑</p>
              <button class="sql-btn primary big" onclick={openNewTable}>＋ 新建表</button>
            </div>
          {/if}
        {:else if tab === 'sql'}
          <div class="sql-editor">
            <div class="sql-editor-bar">
              <button class="sql-btn primary" disabled={sqlRunning || !sqlText.trim()} onclick={runSql}><span class="sql-dot"></span>{sqlRunning ? '执行中…' : '运行 SQL'}</button>
              <kbd>Ctrl ↵</kbd>
              <span class="sql-editor-note">SELECT 显示结果 · 其它语句显示影响行数 · 最多 500 行</span>
              <div class="flex-spacer"></div>
              <button class="sql-btn ghost" disabled={!sqlText} onclick={() => (sqlText = '')}>清空</button>
              <button class="sql-btn ghost" onclick={() => copyText(sqlText, 'sql')}>{copiedKey === 'sql' ? '已复制 ✓' : '复制'}</button>
            </div>
            <textarea bind:value={sqlText} onkeydown={handleSqlKeys} placeholder={'-- 在此输入 SQL，例如：\nSELECT * FROM users LIMIT 100;\n\n-- Ctrl + Enter 执行'} spellcheck="false"></textarea>
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
                {/if}
              </div>
              {#if sqlResult.isQuery}
                <div class="sql-grid-wrap sql-result-grid">
                  <table class="sql-grid readonly">
                    <thead><tr><th class="idx">#</th>{#each sqlResult.columns as col}<th><span class="col-name">{col}</span></th>{/each}</tr></thead>
                    <tbody>
                      {#each sqlResult.rows as row, ri}
                        <tr>
                          <td class="idx">{ri + 1}</td>
                          {#each row as cell}
                            <td class="cell"><span class:null-tag={cell === null}>{cell === null ? 'NULL' : String(cell)}</span></td>
                          {/each}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            {/if}
            <AiAssist
              config={aiConfig}
              tool="SQL 工具"
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
    </main>
  </div>

  {#if formOpen && formDraft}
    {@const d = formDraft}
    <div class="sql-modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) formOpen = false; }} onkeydown={(event) => { if (event.key === 'Escape') formOpen = false; }}>
      <div class="sql-modal">
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
            <label><span>用户名</span><input bind:value={d.user} placeholder="root" spellcheck="false" /></label>
            <label class="pwd"><span>密码</span>
              <span class="sql-secret">
                <input type={showSecret ? 'text' : 'password'} autocomplete="off" bind:value={d.password} placeholder="••••••••" spellcheck="false" />
                <button class="sql-secret-toggle" onclick={() => (showSecret = !showSecret)} title={showSecret ? '隐藏密码' : '显示密码'}>{@html showSecret ? UI_ICONS.eyeOff : UI_ICONS.eye}</button>
              </span>
            </label>
            <label class="full"><span>默认数据库（可选）</span><input bind:value={d.database} placeholder="留空则在连接后选择" spellcheck="false" /></label>
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
</div>

<style>
  .sql-panel { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); zoom: calc(var(--app-font-size, 14px) / 14); }

  /* ── 顶栏 ── */
  .sql-bar { min-height: 52px; flex: 0 0 auto; display: flex; align-items: center; gap: 12px; padding: 0 13px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, color-mix(in srgb, var(--panel) 92%, var(--accent-soft)), var(--panel)); }
  .sql-bar-id { min-width: 0; display: flex; align-items: center; gap: 10px; }
  .sql-bar-ico { width: 30px; height: 30px; display: grid; place-items: center; flex: 0 0 auto; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line)); border-radius: 8px; background: var(--accent-soft); }
  :global(.sql-bar-ico svg) { width: 15px; height: 15px; }
  .sql-bar-id > div { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .sql-bar-id b { overflow: hidden; font-size: 15px; letter-spacing: -.2px; text-overflow: ellipsis; white-space: nowrap; }
  .sql-bar-id small { overflow: hidden; color: var(--muted); font: 500 10.4px 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .sql-bar-status { display: flex; align-items: center; gap: 7px; padding: 5px 11px; color: var(--muted); font-size: 10.9px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); white-space: nowrap; }
  .sql-bar-status i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-2); }
  .sql-bar-status.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); background: var(--accent-soft); }
  .sql-bar-status.on i { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .sql-bar-status.err { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, var(--line)); background: color-mix(in srgb, var(--danger) 7%, transparent); }
  .sql-bar-status.err i { background: var(--danger); }
  .sql-bar-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }

  /* ── 按钮 ── */
  .sql-btn { height: 28px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; cursor: pointer; font-size: 11.5px; border-radius: 7px; white-space: nowrap; transition: all .15s ease; }
  :global(.sql-btn svg) { width: 12px; height: 12px; }
  .sql-btn.ghost { color: var(--muted); border: 1px solid var(--line); background: var(--bg); }
  .sql-btn.ghost:hover:not(:disabled) { color: var(--text); border-color: var(--line-2); background: var(--hover); }
  .sql-btn.ghost.danger:hover:not(:disabled) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .sql-btn.primary { color: #fff; font-weight: 700; border: 0; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 5px 14px color-mix(in srgb, var(--accent) 22%, transparent); }
  .sql-btn.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 7px 18px color-mix(in srgb, var(--accent) 32%, transparent); }
  .sql-btn:disabled { cursor: default; opacity: .4; }
  .sql-btn.big { height: 34px; padding: 0 18px; font-size: 12.6px; }
  .sql-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }

  /* ── 主体布局 ── */
  .sql-body { min-width: 0; min-height: 0; flex: 1; display: grid; grid-template-columns: 252px minmax(0, 1fr); }
  .sql-side { min-width: 0; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--panel); }
  .sql-side-head { height: 36px; flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 13px; color: var(--muted-2); font-size: 10.4px; font-weight: 700; letter-spacing: 1px; border-bottom: 1px solid var(--line); }
  .sql-side-add { width: 22px; height: 22px; display: grid; place-items: center; cursor: pointer; color: var(--muted); border: 0; border-radius: 5px; background: transparent; }
  :global(.sql-side-add svg) { width: 12px; height: 12px; }
  .sql-side-add:hover { color: var(--accent); background: var(--hover); }

  /* ── 连接列表 ── */
  .sql-conns { flex: 0 0 auto; max-height: 190px; display: flex; flex-direction: column; gap: 2px; padding: 7px; overflow-y: auto; border-bottom: 1px solid var(--line); }
  .sql-conn { position: relative; display: flex; align-items: center; border: 1px solid transparent; border-radius: 8px; transition: all .15s ease; }
  .sql-conn:hover { background: var(--hover); }
  .sql-conn.live { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: color-mix(in srgb, var(--accent) 5%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
  .sql-conn.active { border-color: color-mix(in srgb, var(--accent) 24%, var(--line)); background: var(--panel-2); box-shadow: inset 2px 0 0 var(--accent); }
  .sql-conn-main { min-width: 0; flex: 1; display: flex; align-items: center; gap: 8px; padding: 7px 6px 7px 9px; cursor: pointer; text-align: left; color: var(--text); border: 0; background: transparent; }
  .sql-conn-ico { width: 26px; height: 26px; display: grid; place-items: center; flex: 0 0 auto; color: var(--accent); border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
  :global(.sql-conn-ico svg) { width: 13px; height: 13px; }
  .sql-conn-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .sql-conn-copy b { overflow: hidden; font-size: 12.6px; text-overflow: ellipsis; white-space: nowrap; }
  .sql-conn-copy small { overflow: hidden; color: var(--muted); font: 500 9.8px 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .sql-conn-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--muted-2); }
  .sql-conn-dot.on { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .sql-conn-ops { display: none; align-items: center; gap: 2px; padding-right: 6px; }
  .sql-conn:hover .sql-conn-ops { display: flex; }
  .sql-conn-ops button { width: 20px; height: 20px; display: grid; place-items: center; cursor: pointer; color: var(--muted-2); border: 0; border-radius: 5px; background: transparent; }
  :global(.sql-conn-ops button svg) { width: 11px; height: 11px; }
  .sql-conn-ops button:hover { color: var(--text); background: var(--panel-2); }
  .sql-conn-ops button.confirm { color: #fff; background: var(--danger); font-size: 10.4px; }
  .sql-conns-empty { padding: 16px 10px; color: var(--muted-2); font-size: 10.9px; line-height: 1.8; text-align: center; }

  /* ── 库表树 ── */
  .sql-tree { min-height: 0; flex: 1; padding: 6px; overflow-y: auto; }
  .sql-db { position: relative; }
  .sql-db-row { width: 100%; height: 28px; display: flex; align-items: center; gap: 6px; padding: 0 8px; cursor: pointer; text-align: left; color: var(--text); border: 0; border-radius: 6px; background: transparent; }
  .sql-db-row:hover { background: var(--hover); }
  .chev { width: 12px; flex: 0 0 auto; color: var(--muted-2); font-size: 10.4px; transition: transform .15s ease; }
  .chev.open { transform: rotate(90deg); color: var(--muted); }
  .sql-db-ico { display: inline-flex; flex: 0 0 auto; color: var(--warn); }
  :global(.sql-db-ico svg) { width: 13px; height: 13px; }
  .sql-db-row b { min-width: 0; flex: 1; overflow: hidden; font-size: 12.6px; text-overflow: ellipsis; white-space: nowrap; }
  .sql-db-row small { color: var(--muted-2); font: 500 9.8px 'Cascadia Code', monospace; }
  .sql-tables { display: flex; flex-direction: column; gap: 1px; padding: 1px 0 4px 18px; }
  .sql-table-row { width: 100%; height: 25px; display: flex; align-items: center; gap: 7px; padding: 0 8px; cursor: pointer; text-align: left; color: var(--muted); border: 1px solid transparent; border-radius: 6px; background: transparent; transition: all .13s ease; }
  .sql-table-row:hover { color: var(--text); background: var(--hover); }
  .sql-table-row.active { color: var(--text); border-color: color-mix(in srgb, var(--accent) 26%, var(--line)); background: var(--accent-soft); }
  .tbl-ico { display: inline-flex; flex: 0 0 auto; color: var(--blue); }
  :global(.tbl-ico svg) { width: 12px; height: 12px; }
  .tbl-ico.big { width: 26px; height: 26px; display: grid; place-items: center; color: var(--accent); border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
  :global(.tbl-ico.big svg) { width: 13px; height: 13px; }
  .sql-table-row b { min-width: 0; flex: 1; overflow: hidden; font-size: 12.1px; text-overflow: ellipsis; white-space: nowrap; }
  .sql-table-row em { padding: 1px 5px; color: var(--muted-2); font-size: 9.2px; font-style: normal; border: 1px solid var(--line); border-radius: 4px; }
  .sql-tree-loading { padding: 14px 10px; color: var(--muted-2); font-size: 10.9px; text-align: center; }

  /* ── 主区 ── */
  .sql-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--panel-2); }
  .sql-tabs { height: 40px; flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-tabs-group { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .sql-tabs-group button { height: 24px; padding: 0 13px; cursor: pointer; color: var(--muted); font-size: 11.5px; border: 0; border-radius: 6px; background: transparent; transition: all .15s ease; }
  .sql-tabs-group button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .sql-tabs-group button.active { color: #fff; font-weight: 700; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 3px 9px color-mix(in srgb, var(--accent) 25%, transparent); }
  .sql-tabs-info { display: flex; align-items: center; gap: 9px; margin-left: auto; min-width: 0; }
  .sql-tabs-info .sql-ver { overflow: hidden; max-width: 220px; color: var(--muted); font: 500 9.8px 'Cascadia Code', monospace; text-overflow: ellipsis; white-space: nowrap; }
  .sql-tabs-info em { overflow: hidden; max-width: 200px; padding: 3px 8px; color: var(--accent); font-size: 10.4px; font-style: normal; text-overflow: ellipsis; white-space: nowrap; border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line)); border-radius: 5px; background: var(--accent-soft); }

  .sql-empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 8px; padding: 20px; color: var(--muted); text-align: center; }
  .sql-empty.small { min-height: 260px; }
  .sql-empty-tile { width: 52px; height: 52px; display: grid; place-items: center; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 14px; background: var(--accent-soft); }
  :global(.sql-empty-tile svg) { width: 26px; height: 26px; }
  .sql-empty b { color: var(--text); font-size: 15px; }
  .sql-empty p { margin: 0; font-size: 11.5px; }
  .sql-empty .sql-btn { margin-top: 6px; }
  .sql-loading { flex: 1; display: grid; place-content: center; justify-items: center; gap: 9px; color: var(--muted); font-size: 12.1px; }

  .sql-error { display: flex; align-items: flex-start; gap: 8px; margin: 9px 12px 0; padding: 8px 12px; color: var(--danger); font-size: 12.1px; line-height: 1.5; border: 1px solid color-mix(in srgb, var(--danger) 28%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 6%, transparent); }
  .sql-error i { width: 6px; height: 6px; flex: 0 0 auto; margin-top: 4px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .sql-ok { display: flex; align-items: center; gap: 8px; margin: 9px 12px 0; padding: 7px 12px; color: var(--accent); font-size: 12.1px; border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line)); border-radius: 8px; background: var(--accent-soft); }
  .sql-ok i { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }

  /* ── 表数据视图 ── */
  .sql-data { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
  .sql-data-bar { min-height: 46px; flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-data-title { min-width: 0; display: flex; align-items: center; gap: 8px; }
  .sql-data-title b { overflow: hidden; font-size: 13.8px; text-overflow: ellipsis; white-space: nowrap; }
  .sql-data-title em { padding: 2px 6px; color: var(--muted); font-size: 9.8px; font-style: normal; border: 1px solid var(--line); border-radius: 4px; }
  .sql-data-title small { color: var(--muted-2); font: 500 10.4px 'Cascadia Code', monospace; white-space: nowrap; }
  .sql-data-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }

  .sql-grid-wrap { min-height: 0; flex: 1; overflow: auto; }
  .sql-grid { width: 100%; border-collapse: collapse; font: 450 12.6px/1.45 'Cascadia Code', monospace; }
  .sql-grid th { position: sticky; top: 0; z-index: 2; padding: 7px 10px; text-align: left; font-weight: 600; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--panel-2); white-space: nowrap; }
  .sql-grid th .col-name { color: var(--text); font-size: 12.1px; }
  .sql-grid th small { margin-left: 5px; color: var(--muted-2); font-size: 9.2px; font-weight: 400; }
  .sql-grid th .pk { margin-left: 5px; padding: 1px 4px; color: var(--warn); font-size: 8.6px; font-style: normal; border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line)); border-radius: 3px; background: var(--warn-soft); }
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
  .null-tag { color: var(--muted-2); font-style: italic; font-size: 10.9px; }
  .cell-edit { position: relative; display: flex; align-items: center; }
  .cell-edit input { width: 100%; height: 28px; padding: 0 52px 0 10px; color: var(--text); font: 450 12.6px 'Cascadia Code', monospace; border: 0; outline: 0; background: color-mix(in srgb, var(--accent) 8%, var(--panel)); box-shadow: inset 0 0 0 2px var(--accent); }
  .cell-null { position: absolute; right: 4px; height: 19px; padding: 0 6px; cursor: pointer; color: var(--muted); font: 600 9.2px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 4px; background: var(--panel-2); }
  .cell-null:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .badge-new { display: inline-block; padding: 1px 5px; color: #fff; font-size: 8.6px; border-radius: 3px; background: linear-gradient(135deg, var(--blue), var(--accent)); }
  .sql-grid td.idx, .sql-grid th.idx { width: 42px; padding: 0 8px; color: var(--muted-2); text-align: right; }
  .sql-grid td.grid-empty { padding: 22px 14px; color: var(--muted-2); font-size: 12.1px; text-align: center; }
  .sql-grid.readonly td { cursor: default; }
  .sql-grid.readonly td.cell { padding: 0 10px; height: 28px; line-height: 28px; }

  .sql-pager { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 12px; border-top: 1px solid var(--line); background: var(--panel); }
  .sql-pager > span { color: var(--muted); font: 500 10.4px 'Cascadia Code', monospace; }
  .sql-pager > div { display: flex; align-items: center; gap: 8px; }
  .sql-pager button { height: 24px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: 10.9px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
  .sql-pager button:hover:not(:disabled) { color: var(--text); border-color: var(--line-2); }
  .sql-pager button:disabled { cursor: default; opacity: .35; }
  .sql-pager span { color: var(--muted); font-size: 10.9px; }

  .sql-ddl { flex: 0 0 auto; margin: 9px 12px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); overflow: hidden; }
  .sql-ddl summary { padding: 8px 12px; cursor: pointer; color: var(--muted); font-size: 11.5px; user-select: none; }
  .sql-ddl summary:hover { color: var(--text); }
  .sql-ddl pre { margin: 0; padding: 10px 12px; overflow: auto; color: var(--text); font: 450 12.1px/1.6 'Cascadia Code', monospace; border-top: 1px solid var(--line); background: var(--bg); white-space: pre-wrap; }
  .sql-ddl-note { flex: 0 0 auto; margin: 9px 12px 12px; padding: 8px 12px; color: var(--muted-2); font-size: 10.9px; border: 1px dashed var(--line-2); border-radius: 8px; }

  /* ── SQL 编辑器 ── */
  .sql-editor { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
  .sql-editor-bar { min-height: 44px; flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-editor-bar kbd { margin: 0; }
  .sql-editor-note { color: var(--muted-2); font-size: 10.4px; }
  .flex-spacer { flex: 1; }
  .sql-editor textarea { min-height: 120px; flex: 0 0 auto; padding: 12px 14px; color: var(--text); font: 450 13.8px/1.65 'Cascadia Code', monospace; resize: vertical; border: 0; border-bottom: 1px solid var(--line); outline: 0; background: var(--bg); }
  .sql-editor textarea:focus { box-shadow: inset 0 2px 0 var(--accent); }
  .sql-editor textarea::placeholder { color: var(--muted-2); }
  .sql-result-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 9px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-result-chip { padding: 2px 7px; color: var(--blue); font: 700 9.8px 'Cascadia Code', monospace; border-radius: 4px; background: color-mix(in srgb, var(--blue) 12%, transparent); }
  .sql-result-chip.query { color: var(--accent); background: var(--accent-soft); }
  .sql-result-bar b { font-size: 12.6px; }
  .sql-result-bar small { color: var(--muted); font: 500 10.4px 'Cascadia Code', monospace; }
  .sql-truncated { padding: 2px 7px; color: var(--warn); font-size: 10.4px; font-style: normal; border-radius: 4px; background: var(--warn-soft); }
  .sql-result-grid { flex: 1; }

  /* ── 连接表单 ── */
  .sql-modal-backdrop { position: fixed; z-index: 50; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(2, 4, 6, .5); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); animation: fade-in .14s ease-out; }
  .sql-modal { width: min(520px, 100%); max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line-2); border-radius: 14px; background: var(--panel-2); box-shadow: 0 30px 90px rgba(0, 0, 0, .45); animation: palette-in .18s cubic-bezier(.2, .9, .3, 1.2); }
  .sql-modal > header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .sql-modal > header b { font-size: 15px; }
  .sql-modal > header small { display: block; margin-top: 2px; color: var(--muted-2); font-size: 10.4px; }
  .sql-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 16px; overflow-y: auto; }
  .sql-form .full { grid-column: 1 / -1; }
  .sql-form label, .sql-form > div { display: flex; flex-direction: column; gap: 6px; }
  .sql-form label > span { color: var(--muted); font-size: 11.5px; }
  .sql-form input { height: 32px; padding: 0 11px; color: var(--text); font: 500 12.6px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 7px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .sql-form input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .sql-kind-chips { display: inline-flex; gap: 2px; align-self: flex-start; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .sql-kind-chips button { height: 26px; padding: 0 13px; cursor: pointer; color: var(--muted); font-size: 11.5px; border: 0; border-radius: 6px; background: transparent; transition: all .15s ease; }
  .sql-kind-chips button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .sql-kind-chips button.active { color: #fff; font-weight: 700; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .sql-secret { position: relative; display: flex; align-items: center; }
  .sql-secret input { width: 100%; padding-right: 34px; }
  .sql-secret-toggle { position: absolute; right: 5px; width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer; color: var(--muted-2); border: 0; border-radius: 5px; background: transparent; }
  :global(.sql-secret-toggle svg) { width: 13px; height: 13px; }
  .sql-secret-toggle:hover { color: var(--text); background: var(--hover); }
  .sql-modal > footer { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--panel); }
  .sql-form-hint { flex: 1; color: var(--muted-2); font-size: 10.4px; }

  @media (max-width: 900px) {
    .sql-body { grid-template-columns: 210px minmax(0, 1fr); }
  }

  /* ── 表设计器 ── */
  .sql-design { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 9px; padding: 12px; overflow: hidden; }
  .sql-design-name { width: 220px; height: 30px; padding: 0 10px; color: var(--text); font: 600 15px 'Cascadia Code', monospace; border: 1px solid var(--line); border-radius: 7px; outline: 0; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .sql-design-name:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .sql-design-wrap { min-height: 0; flex: 1; overflow: auto; border: 1px solid var(--line); border-radius: 9px; background: var(--bg); }
  .sql-grid.design { min-width: 860px; }
  .sql-grid.design th { position: sticky; top: 0; z-index: 2; }
  .sql-grid.design td input, .sql-grid.design td select { width: 100%; height: 26px; padding: 0 8px; color: var(--text); font: 500 12.1px 'Cascadia Code', monospace; border: 1px solid transparent; border-radius: 5px; outline: 0; background: transparent; transition: all .15s ease; }
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
  .sql-design-move, .sql-design-del { width: 22px; height: 22px; display: inline-grid; place-items: center; cursor: pointer; font-size: 12.6px; border: 1px solid var(--line); border-radius: 5px; background: var(--panel); transition: all .15s ease; }
  .sql-design-move { color: var(--muted); }
  .sql-design-move:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .sql-design-del { color: var(--danger); margin-left: 4px; }
  .sql-design-del:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .sql-design-note { display: flex; align-items: center; gap: 8px; padding: 8px 11px; color: var(--muted-2); font-size: 10.4px; border: 1px dashed var(--line-2); border-radius: 7px; background: var(--panel); }
  .sql-design-note span { color: var(--muted); font-weight: 700; }

</style>
