<script lang="ts">
  let { jsonString = '' }: { jsonString?: string } = $props();

  let parsed: unknown = $derived.by(() => {
    try { return JSON.parse(jsonString); } catch { return null; }
  });
  const lineCount = $derived(jsonString.split('\n').length);

  // 折叠状态：节点路径 -> boolean。路径编码：对象 $['key']（含转义），数组 $[0]，保证无歧义
  let collapsed = $state<Set<string>>(new Set());
  // 深层结构（第 3 层起）与超大数组/对象默认折叠，避免大 JSON 一次性全部展开
  const DEEP_FOLD = 2;
  const MAX_ARRAY_OPEN = 500;
  const MAX_OBJECT_OPEN = 300;

  function childPath(path: string, key: string): string {
    return `${path}['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
  }
  function indexPath(path: string, index: number): string {
    return `${path}[${index}]`;
  }

  // 搜索时：匹配节点的祖先强制展开（即使原折叠），不修改 collapsed 本身
  const matchAncestors = $derived.by(() => {
    const set = new Set<string>();
    for (const path of matchPaths) {
      for (const ancestor of ancestorPaths(path)) set.add(ancestor);
    }
    return set;
  });

  function isCollapsed(path: string): boolean {
    return collapsed.has(path) && !matchAncestors.has(path);
  }

  // 首次渲染后把「隐式折叠」的节点物化进 collapsed，保证 toggle 语义一致（点展开真展开）
  function collectAutoFold(value: unknown, path: string, depth: number, out: Set<string>): void {
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      if (value.length > MAX_ARRAY_OPEN || depth >= DEEP_FOLD) {
        out.add(path);
        return;
      }
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') collectAutoFold(item, indexPath(path, i), depth + 1, out);
      });
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return;
      if (entries.length > MAX_OBJECT_OPEN || depth >= DEEP_FOLD) {
        out.add(path);
        return;
      }
      for (const [key, item] of entries) {
        if (item !== null && typeof item === 'object') collectAutoFold(item, childPath(path, key), depth + 1, out);
      }
    }
  }

  // JSON 变化时重置折叠：深层节点默认折叠；此后用户手动 toggle 的状态不会被覆盖
  $effect(() => {
    if (parsed != null) {
      const next = new Set<string>();
      collectAutoFold(parsed, '$', 0, next);
      collapsed = next;
    }
  });

  function toggle(path: string): void {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path); else next.add(path);
    collapsed = next;
  }

  function foldAll(): void {
    collapsed = collectPaths(parsed, '$');
  }

  function unfoldAll(): void {
    collapsed = new Set();
  }

  function collectPaths(value: unknown, path: string): Set<string> {
    const paths = new Set<string>();
    if (Array.isArray(value)) {
      if (value.length === 0) return paths;
      paths.add(path);
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          for (const p of collectPaths(item, indexPath(path, i))) paths.add(p);
        }
      });
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return paths;
      paths.add(path);
      for (const [key, item] of entries) {
        if (item !== null && typeof item === 'object') {
          for (const p of collectPaths(item, childPath(path, key))) paths.add(p);
        }
      }
    }
    return paths;
  }

  /* ── 搜索：匹配键/值，高亮并自动展开祖先，支持上下跳转 ── */
  let query = $state('');
  let matchPaths = $state<string[]>([]);
  let matchIndex = $state(0);
  const lowerQuery = $derived(query.trim().toLowerCase());

  function isMatch(path: string): boolean {
    return lowerQuery ? matchPaths.includes(path) : false;
  }
  function isCurrent(path: string): boolean {
    return Boolean(lowerQuery) && matchPaths[matchIndex] === path;
  }

  function collectMatches(value: unknown, path: string, key: string | undefined, out: string[]): void {
    const keyText = key ?? '';
    let valText = '';
    if (value === null) valText = 'null';
    else if (typeof value !== 'object') valText = String(value);
    if ((keyText + valText).toLowerCase().includes(lowerQuery)) out.push(path);
    if (Array.isArray(value)) {
      value.forEach((item, i) => collectMatches(item, indexPath(path, i), undefined, out));
    } else if (value !== null && typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).forEach(([k, v]) => collectMatches(v, childPath(path, k), k, out));
    }
  }

  function ancestorPaths(path: string): string[] {
    const out: string[] = [];
    let p = path;
    while (true) {
      const next = p.replace(/\[(?:'(?:[^'\\]|\\.)*'|\d+)\]$/, '');
      if (next === p) break;
      p = next;
      out.push(p);
    }
    return out;
  }

  $effect(() => {
    if (!lowerQuery) {
      matchPaths = [];
      matchIndex = 0;
      return;
    }
    const paths: string[] = [];
    collectMatches(parsed, '$', undefined, paths);
    matchPaths = paths;
    matchIndex = 0;
  });

  function jumpMatch(dir: 1 | -1): void {
    if (matchPaths.length === 0) return;
    matchIndex = (matchIndex + dir + matchPaths.length) % matchPaths.length;
    requestAnimationFrame(() => {
      document.querySelector('.jv-row.current')?.scrollIntoView({ block: 'center' });
    });
  }

  let copied = $state(false);
  async function copyJson(): Promise<void> {
    try { await navigator.clipboard.writeText(jsonString); copied = true; setTimeout(() => (copied = false), 1200); } catch { /* ignore */ }
  }

  function previewKeys(value: Record<string, unknown>): string {
    const keys = Object.keys(value).slice(0, 3);
    const rest = Object.keys(value).length - keys.length;
    return keys.map((k) => `"${k}"`).join(', ') + (rest > 0 ? ` … +${rest}` : '');
  }

  function previewItems(value: unknown[]): string {
    const head = value.slice(0, 3).map((item) =>
      typeof item === 'string' ? `"${item.length > 24 ? item.slice(0, 24) + '…' : item}"`
      : typeof item === 'object' && item !== null ? (Array.isArray(item) ? '[…]' : '{…}')
      : String(item));
    const rest = value.length - head.length;
    return head.join(', ') + (rest > 0 ? ` … +${rest}` : '');
  }
</script>

{#snippet node(value: unknown, path: string, depth: number, key?: string)}
  {#if value === null}
    <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px">
      {#if key != null}<span class="jv-fold ph" aria-hidden="true"></span>{/if}
      <span class="jv-content">{#if key != null}<span class="jv-key">"{key}"</span><span class="jv-colon">: </span>{/if}<span class="jv-null">null</span></span>
    </div>
  {:else if value === undefined}
    <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px">
      {#if key != null}<span class="jv-fold ph" aria-hidden="true"></span>{/if}
      <span class="jv-content">{#if key != null}<span class="jv-key">"{key}"</span><span class="jv-colon">: </span>{/if}<span class="jv-null">—</span></span>
    </div>
  {:else if typeof value === 'boolean'}
    <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px">
      {#if key != null}<span class="jv-fold ph" aria-hidden="true"></span>{/if}
      <span class="jv-content">{#if key != null}<span class="jv-key">"{key}"</span><span class="jv-colon">: </span>{/if}<span class="jv-bool">{value}</span></span>
    </div>
  {:else if typeof value === 'number'}
    <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px">
      {#if key != null}<span class="jv-fold ph" aria-hidden="true"></span>{/if}
      <span class="jv-content">{#if key != null}<span class="jv-key">"{key}"</span><span class="jv-colon">: </span>{/if}<span class="jv-num">{value}</span></span>
    </div>
  {:else if typeof value === 'string'}
    {@const s = value as string}
    {@const d = s.length > 160 ? s.slice(0, 160) + '…' : s}
    <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px">
      {#if key != null}<span class="jv-fold ph" aria-hidden="true"></span>{/if}
      <span class="jv-content">{#if key != null}<span class="jv-key">"{key}"</span><span class="jv-colon">: </span>{/if}<span class="jv-str">"{d}"</span>{#if s.length > 160}<em class="jv-len">{s.length}</em>{/if}</span>
    </div>
  {:else if Array.isArray(value)}
    {@const arr = value as unknown[]}
    {@const f = isCollapsed(path)}
    {#if arr.length === 0}
      <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px">
        {#if key != null}<span class="jv-fold ph" aria-hidden="true"></span>{/if}
        <span class="jv-content">{#if key != null}<span class="jv-key">"{key}"</span><span class="jv-colon">: </span>{/if}<span class="jv-bracket">[ ]</span></span>
      </div>
    {:else}
      <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px">
        <button class="jv-fold" class:folded={f} onclick={() => toggle(path)} aria-label={f ? '展开' : '折叠'}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2 5 4.5 7.5 2" /></svg>
        </button>
        <span class="jv-content">
          {#if key != null}<span class="jv-key">"{key}"</span><span class="jv-colon">: </span>{/if}
          <span class="jv-bracket">[</span>
          {#if f}<span class="jv-ellipsis">{arr.length} 项</span><span class="jv-bracket">]</span><span class="jv-preview">{previewItems(arr)}</span>{/if}
        </span>
      </div>
      {#if !f}
        {#each arr as item, i}
          {@render node(item, indexPath(path, i), depth + 1)}
        {/each}
        <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px"><span class="jv-fold ph" aria-hidden="true"></span><span class="jv-content"><span class="jv-bracket">]</span></span></div>
      {/if}
    {/if}
  {:else if typeof value === 'object'}
    {@const obj = value as Record<string, unknown>}
    {@const ks = Object.keys(obj)}
    {@const f = isCollapsed(path)}
    {#if ks.length === 0}
      <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px">
        {#if key != null}<span class="jv-fold ph" aria-hidden="true"></span>{/if}
        <span class="jv-content">{#if key != null}<span class="jv-key">"{key}"</span><span class="jv-colon">: </span>{/if}<span class="jv-bracket">{'{ }'}</span></span>
      </div>
    {:else}
      <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px">
        <button class="jv-fold" class:folded={f} onclick={() => toggle(path)} aria-label={f ? '展开' : '折叠'}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2 5 4.5 7.5 2" /></svg>
        </button>
        <span class="jv-content">
          {#if key != null}<span class="jv-key">"{key}"</span><span class="jv-colon">: </span>{/if}
          <span class="jv-bracket">{'{'}</span>
          {#if f}<span class="jv-ellipsis">{ks.length} 键</span><span class="jv-bracket">{'}'}</span><span class="jv-preview">{previewKeys(obj)}</span>{/if}
        </span>
      </div>
      {#if !f}
        {#each ks as k}
          {@render node(obj[k], childPath(path, k), depth + 1, k)}
        {/each}
        <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px"><span class="jv-fold ph" aria-hidden="true"></span><span class="jv-content"><span class="jv-bracket">{'}'}</span></span></div>
      {/if}
    {/if}
  {:else}
    <div class="jv-row" class:match={isMatch(path)} class:current={isCurrent(path)} style="padding-left:{depth * 14}px"><span class="jv-fold ph" aria-hidden="true"></span><span class="jv-content">{String(value)}</span></div>
  {/if}
{/snippet}

<div class="json-tree">
  {#if parsed != null}
    <div class="jv-toolbar">
      <span class="jv-count">{lineCount} 行</span>
      <div class="jv-search">
        <input bind:value={query} placeholder="搜索键 / 值…" spellcheck="false" />
        {#if lowerQuery}
          <span class="jv-search-count">{matchPaths.length ? (matchIndex + 1) + '/' + matchPaths.length : '0 匹配'}</span>
          <button onclick={() => jumpMatch(-1)} title="上一个匹配">↑</button>
          <button onclick={() => jumpMatch(1)} title="下一个匹配">↓</button>
          <button onclick={() => (query = '')} title="清除">×</button>
        {/if}
      </div>
      <div class="jv-tools">
        <button onclick={foldAll} title="全部折叠">折叠全部</button>
        <button onclick={unfoldAll} title="全部展开">展开全部</button>
        <button class:copied={copied} onclick={copyJson} title="复制 JSON">{copied ? '已复制 ✓' : '复制'}</button>
      </div>
    </div>
    <div class="jv-scroll">
      {@render node(parsed, '$', 0)}
    </div>
  {:else}
    <span class="jv-error">Invalid JSON</span>
  {/if}
</div>

<style>
  .json-tree { height: 100%; display: flex; flex-direction: column; background: var(--panel-2); }
  .jv-toolbar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--line); }
  .jv-count { color: var(--muted-2); font-size: 10px; }
  .jv-tools { display: flex; gap: 2px; }
  .jv-tools button { height: 22px; padding: 0 8px; cursor: pointer; color: var(--muted); font-size: 10px; border: 0; border-radius: 4px; background: transparent; }
  .jv-tools button:hover { color: var(--accent); background: var(--hover); }
  .jv-tools button.copied { color: var(--accent); }
  .jv-search { display: flex; align-items: center; gap: 3px; margin-left: auto; margin-right: 8px; }
  .jv-search input { width: 150px; height: 22px; padding: 0 8px; color: var(--text); font-size: 11.5px; border: 1px solid var(--line); border-radius: 5px; outline: 0; background: var(--bg); }
  .jv-search input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .jv-search input::placeholder { color: var(--muted-2); }
  .jv-search button { height: 22px; min-width: 22px; padding: 0 6px; cursor: pointer; color: var(--muted); font-size: 11.5px; border: 0; border-radius: 4px; background: transparent; }
  .jv-search button:hover { color: var(--accent); background: var(--hover); }
  .jv-search-count { color: var(--accent); font: 500 9.6px 'Cascadia Code', monospace; white-space: nowrap; }
  .jv-row.match { background: color-mix(in srgb, var(--warn) 16%, transparent); }
  .jv-row.current { background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
  .jv-scroll { min-height: 0; flex: 1; overflow: auto; padding: 4px 0 14px; }
  .jv-row { display: flex; align-items: stretch; min-width: max-content; min-height: 21px; padding-right: 18px; font: 450 12px/21px 'Cascadia Code', Consolas, monospace; color: var(--text); }
  .jv-row:hover { background: var(--hover); }
  .jv-fold { flex: 0 0 auto; width: 15px; display: grid; place-items: center; padding: 0; cursor: pointer; color: var(--muted-2); border: 0; background: transparent; }
  .jv-fold svg { width: 10.5px; height: 10.5px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; transition: transform .12s ease; }
  .jv-fold.folded svg { transform: rotate(-90deg); }
  .jv-fold:hover { color: var(--accent); }
  .jv-fold.ph { visibility: hidden; pointer-events: none; }
  .jv-content { white-space: nowrap; padding-left: 5px; }
  .jv-key { color: #79c7ff; } .jv-str { color: #9ee7bd; } .jv-num { color: #d8a6ff; }
  .jv-bool { color: #ffb86b; } .jv-null { color: #84909b; font-style: italic; }
  :global(.app.light) .jv-key { color: #0068a0; }
  :global(.app.light) .jv-str { color: #08784b; }
  :global(.app.light) .jv-num { color: #7c3fb2; }
  :global(.app.light) .jv-bool { color: #a34e00; }
  :global(.app.light) .jv-null { color: #6b7681; }
  .jv-colon { color: var(--muted-2); }
  .jv-bracket { color: var(--muted-2); }
  .jv-ellipsis { color: var(--muted); font-style: italic; margin: 0 5px; font-size: 10px; }
  .jv-preview { margin-left: 8px; color: var(--muted-2); font-size: 10px; opacity: .8; }
  .jv-len { color: var(--muted); font-size: 10.5px; font-style: normal; margin-left: 5px; }
  .jv-error { color: var(--danger); padding: 20px; display: block; }
</style>
