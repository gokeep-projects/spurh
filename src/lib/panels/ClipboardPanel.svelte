<script lang="ts">
  import { onMount } from 'svelte';
  import { isTauri, safeInvoke, safeListen } from '../env';
  import { UI_ICONS } from '../icons';
  import { trimImageHistory, type ClipItem } from '../clipHistory';

  let { onChangeInput }: { onChangeInput?: (v: string) => void } = $props();

  let items = $state<ClipItem[]>([]);
  let query = $state('');
  let copiedId = $state('');
  let filledId = $state('');
  let loaded = $state(false);
  let selected = $state(0);
  let confirmingClear = $state(false);
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  const filtered = $derived(query
    ? items.filter((item) => item.text.toLowerCase().includes(query.toLowerCase()))
    : items);

  type DayGroup = { label: string; items: ClipItem[] };
  const groups = $derived<DayGroup[]>((() => {
    const result: DayGroup[] = [];
    for (const item of filtered) {
      const key = dayKey(item.ts);
      const last = result[result.length - 1];
      if (last && last.label === key) last.items.push(item);
      else result.push({ label: key, items: [item] });
    }
    return result;
  })());

  function dayKey(ts: number): string {
    const date = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (day.getTime() === new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) return '今天';
    if (day.getTime() === yesterday.getTime()) return '昨天';
    return (date.getFullYear() === today.getFullYear() ? '' : date.getFullYear() + ' 年 ') + (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
  }

  function timeLabel(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
    const date = new Date(ts);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function preview(text: string): string {
    const first = text.split(/\r?\n/)[0].trim();
    return first || '(空内容)';
  }

  async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
    const [head, body] = dataUrl.split(',');
    const mime = head.match(/^data:([^;]+)/)?.[1] ?? 'image/png';
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  async function reuse(item: ClipItem): Promise<void> {
    try {
      if (item.kind === 'image' && item.image) {
        // atob 解码，避免 fetch(data:) 被生产 CSP connect-src 拦截
        const blob = await dataUrlToBlob(item.image);
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      } else if (isTauri) {
        await safeInvoke('clipboard_write_text', { text: item.text });
      } else {
        // 浏览器模式回退到 Web Clipboard API，保持复制功能可用
        await navigator.clipboard.writeText(item.text);
      }
      copiedId = item.id;
      setTimeout(() => { if (copiedId === item.id) copiedId = ''; }, 1200);
    } catch { /* 剪贴板不可用时静默 */ }
  }

  function fill(item: ClipItem): void {
    onChangeInput?.(item.text);
    filledId = item.id;
    setTimeout(() => { if (filledId === item.id) filledId = ''; }, 1200);
  }

  function handleKeys(event: KeyboardEvent): void {
    const count = filtered.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); selected = Math.min(selected + 1, Math.max(0, count - 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(selected - 1, 0); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = filtered[selected] ?? filtered[0];
      if (item) reuse(item);
    }
  }

  function clearHistory(): void {
    if (!confirmingClear) {
      confirmingClear = true;
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => (confirmingClear = false), 3000);
      return;
    }
    confirmingClear = false;
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    safeInvoke('clipboard_clear_history').catch(() => undefined);
    items = [];
  }

  onMount(() => {
    safeInvoke<ClipItem[]>('clipboard_history').then((snapshot) => {
      items = snapshot;
      loaded = true;
    }).catch(() => { loaded = true; });
    const unlisten1 = safeListen<ClipItem[]>('clipboard:history', (event) => {
      // 后端历史不含图片，合并保留本地图片项，避免被全量替换清掉
      const images = items.filter((item) => item.kind === 'image');
      items = trimImageHistory([...images, ...event.payload].slice(0, 100));
    });
    const unlisten2 = safeListen<ClipItem>('clipboard:item', (event) => {
      // 图片去重：同图仅保留最新一条
      if (event.payload.kind === 'image' && event.payload.image) {
        const dup = items.find((other) => other.kind === 'image' && other.image === event.payload.image);
        if (dup) {
          items = [{ ...dup, ts: event.payload.ts }, ...items.filter((other) => other.id !== dup.id)].slice(0, 100);
          return;
        }
      } else {
        const dup = items.find((item) => item.kind !== 'image' && item.text === event.payload.text);
        if (dup) {
          items = [{ ...dup, ts: event.payload.ts }, ...items.filter((item) => item.id !== dup.id)].slice(0, 100);
          return;
        }
      }
      items = trimImageHistory([event.payload, ...items].slice(0, 100));
    });
    return () => {
      unlisten1.then((fn) => fn()).catch(() => undefined);
      unlisten2.then((fn) => fn()).catch(() => undefined);
    };
  });
</script>

<div class="clipboard-panel">
  <header class="clip-bar">
    <label class="clip-search">
      <span>{@html UI_ICONS.search}</span>
      <input bind:value={query} onkeydown={handleKeys} placeholder="搜索剪贴板历史… ↑↓ 选择 ↵ 复制" spellcheck="false" />
      {#if query}<button class="clip-search-x" onclick={() => (query = '')} aria-label="清除搜索">×</button>{/if}
    </label>
    <span class="clip-count">{filtered.length} / {items.length}</span>
    <button class="clip-clear" class:confirming={confirmingClear} onclick={clearHistory} title="清空全部剪贴板历史">
      <span>{@html UI_ICONS.trash}</span>{confirmingClear ? '再点一次确认' : '清空历史'}
    </button>
  </header>

  {#if !loaded}
    <div class="clip-loading"><span class="spinner"></span>加载剪贴板历史…</div>
  {:else if filtered.length > 0}
    <div class="clip-list">
      {#each groups as group}
        <div class="clip-day"><span>{group.label}</span><i>{group.items.length}</i></div>
        {#each group.items as item, gi}
          {@const flatIndex = filtered.indexOf(item)}
          <article class="clip-item" class:active={flatIndex === selected} class:hot={flatIndex === 0 && !query}>
            <button class="clip-main" onclick={() => { selected = flatIndex; reuse(item); }} title="点击复制到系统剪贴板">
              {#if item.kind === 'image' && item.image && item.image.startsWith('data:image/') && !item.image.includes('image/svg')}
                <img class="clip-img" src={item.image} alt="剪贴板图片" />
                <small>图片 · {timeLabel(item.ts)}</small>
              {:else}
                <code>{preview(item.text)}</code>
                <small>{item.text.length} 字符 · {timeLabel(item.ts)}</small>
              {/if}
            </button>
            <div class="clip-actions">
              {#if onChangeInput && item.kind !== 'image'}
                <button class="clip-act fill" onclick={() => { selected = flatIndex; fill(item); }} title="填入当前工具输入区">
                  {filledId === item.id ? '已填入 ✓' : '填入'}
                </button>
              {/if}
              <button class="clip-act" onclick={() => { selected = flatIndex; reuse(item); }} title="复制到系统剪贴板">
                {copiedId === item.id ? '已复制 ✓' : '复制'}
              </button>
            </div>
          </article>
        {/each}
      {/each}
    </div>
  {:else}
    <div class="clip-empty">
      <span class="clip-empty-tile">{@html UI_ICONS.copy}</span>
      <b>{query ? '没有匹配的内容' : '剪贴板历史为空'}</b>
      <small>{query ? '换个关键词试试' : '复制任意文本后会自动记录在这里'}</small>
    </div>
  {/if}
</div>

<style>
  .clipboard-panel { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); }
  .clip-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .clip-search { min-width: 180px; height: 30px; display: flex; align-items: center; gap: 8px; flex: 1; padding: 0 10px; color: var(--muted); border: 1px solid var(--line); border-radius: 7px; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .clip-search:focus-within { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .clip-search span { display: inline-flex; }
  :global(.clip-search span svg) { width: 13px; height: 13px; }
  .clip-search input { min-width: 0; flex: 1; color: var(--text); font-size: 12.5px; border: 0; outline: 0; background: transparent; }
  .clip-search-x { width: 18px; height: 18px; display: grid; place-items: center; padding: 0; cursor: pointer; color: var(--muted-2); font-size: 13px; line-height: 1; border: 0; border-radius: 4px; background: transparent; }
  .clip-search-x:hover { color: var(--text); background: var(--hover); }
  .clip-count { color: var(--muted); font: 500 11px 'Cascadia Code', monospace; white-space: nowrap; }
  .clip-clear { height: 30px; display: flex; align-items: center; gap: 6px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); transition: all .15s ease; }
  .clip-clear span { display: inline-flex; }
  :global(.clip-clear span svg) { width: 12px; height: 12px; }
  .clip-clear:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--line)); }
  .clip-clear.confirming { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); background: color-mix(in srgb, var(--danger) 8%, transparent); }
  .clip-loading { display: grid; place-content: center; gap: 10.5px; flex: 1; color: var(--muted); font-size: 11.5px; }
  .clip-list { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; overflow-y: auto; }
  .clip-day { display: flex; align-items: center; gap: 7px; padding: 8px 2px 3px; color: var(--muted-2); font-size: 10.5px; font-weight: 700; letter-spacing: .8px; }
  .clip-day i { padding: 1px 6px; color: var(--muted); font-size: 10px; font-style: normal; border: 1px solid var(--line); border-radius: 8px; }
  .clip-item { display: flex; align-items: stretch; gap: 0; border: 1px solid var(--line); border-radius: 10.5px; background: var(--panel); overflow: hidden; transition: border-color .15s ease, box-shadow .15s ease; }
  .clip-item:hover { border-color: var(--line-2); }
  .clip-item.active { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .clip-item.hot { border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); }
  .clip-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 5px; padding: 10px 13px; cursor: pointer; text-align: left; border: 0; background: transparent; }
  .clip-main:hover { background: var(--hover); }
  .clip-main code { display: -webkit-box; overflow: hidden; color: var(--text); font: 450 13px/1.5 'Cascadia Code', monospace; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; }
  .clip-img { max-width: 220px; max-height: 130px; object-fit: contain; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
  .clip-main small { color: var(--muted-2); font: 500 11px 'Cascadia Code', monospace; }
  .clip-actions { display: flex; flex-direction: column; gap: 5px; justify-content: center; padding: 8px 10.5px; border-left: 1px solid var(--line); background: var(--panel-2); }
  .clip-act { height: 24px; padding: 0 10.5px; cursor: pointer; color: var(--muted); font-size: 10.5px; white-space: nowrap; border: 1px solid var(--line); border-radius: 5px; background: var(--panel); transition: all .15s ease; }
  .clip-act:hover { color: var(--text); border-color: var(--line-2); }
  .clip-act.fill { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 28%, var(--line)); background: var(--accent-soft); }
  .clip-act.fill:hover { color: var(--accent); }
  .clip-empty { display: grid; place-content: center; justify-items: center; gap: 8px; flex: 1; color: var(--muted); text-align: center; }
  .clip-empty-tile { width: 46px; height: 46px; display: grid; place-items: center; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 13px; background: var(--accent-soft); }
  :global(.clip-empty-tile svg) { width: 22px; height: 22px; }
  .clip-empty b { color: var(--text); font-size: 12.5px; }
  .clip-empty small { font-size: 11px; }
</style>
