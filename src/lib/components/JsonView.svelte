<script lang="ts">
  let { jsonString = '' }: { jsonString?: string } = $props();
  let parsed: unknown = $derived.by(() => { try { return JSON.parse(jsonString); } catch { return null; } });
  let collapsed = $state<Set<string>>(new Set());
  function toggle(path: string) { const n = new Set(collapsed); if (n.has(path)) n.delete(path); else n.add(path); collapsed = n; }
</script>

{#snippet node(value: unknown, path: string, depth: number, key?: string, last?: boolean)}
  {#if value === null}
    <div class="jv-row"><span class="jv-gutter"></span><span class="jv-content" style="padding-left:{depth*16}px">{#if key!=null}<span class="jv-key">"{key}": </span>{/if}<span class="jv-null">null</span></span></div>
  {:else if value === undefined}
    <div class="jv-row"><span class="jv-gutter"></span><span class="jv-content" style="padding-left:{depth*16}px">{#if key!=null}<span class="jv-key">"{key}": </span>{/if}<span class="jv-null">—</span></span></div>
  {:else if typeof value === 'boolean'}
    <div class="jv-row"><span class="jv-gutter"></span><span class="jv-content" style="padding-left:{depth*16}px">{#if key!=null}<span class="jv-key">"{key}": </span>{/if}<span class="jv-bool">{value}</span></span></div>
  {:else if typeof value === 'number'}
    <div class="jv-row"><span class="jv-gutter"></span><span class="jv-content" style="padding-left:{depth*16}px">{#if key!=null}<span class="jv-key">"{key}": </span>{/if}<span class="jv-num">{value}</span></span></div>
  {:else if typeof value === 'string'}
    {@const s = value as string}
    {@const d = s.length > 120 ? s.slice(0,120)+'…' : s}
    <div class="jv-row"><span class="jv-gutter"></span><span class="jv-content" style="padding-left:{depth*16}px">{#if key!=null}<span class="jv-key">"{key}": </span>{/if}<span class="jv-str">"{d}"</span>{#if s.length > 120}<em>{s.length}</em>{/if}</span></div>
  {:else if Array.isArray(value)}
    {@const arr = value as unknown[]}
    {@const f = collapsed.has(path)}
    {#if arr.length === 0}
      <div class="jv-row"><span class="jv-gutter"></span><span class="jv-content" style="padding-left:{depth*16}px">{#if key!=null}<span class="jv-key">"{key}": </span>{/if}<span class="jv-bracket">[]</span></span></div>
    {:else}
      <div class="jv-row"><span class="jv-gutter"><button class="jv-toggle" onclick={() => toggle(path)}>{f?'▸':'▾'}</button></span><span class="jv-content" style="padding-left:{depth*16}px">{#if key!=null}<span class="jv-key">"{key}": </span>{/if}<span class="jv-bracket">[</span>{#if f}<span class="jv-ellipsis">{arr.length} items</span><span class="jv-bracket">]</span>{/if}</span></div>
      {#if !f}{#each arr as item, i}{@render node(item, `${path}.${i}`, depth+1, undefined, i === arr.length-1)}{/each}{/if}
      {#if !f}<div class="jv-row"><span class="jv-gutter"></span><span class="jv-content" style="padding-left:{depth*16}px"><span class="jv-bracket">]</span></span></div>{/if}
    {/if}
  {:else if typeof value === 'object'}
    {@const obj = value as Record<string,unknown>}
    {@const ks = Object.keys(obj)}
    {@const f = collapsed.has(path)}
    {#if ks.length === 0}
      <div class="jv-row"><span class="jv-gutter"></span><span class="jv-content" style="padding-left:{depth*16}px">{#if key!=null}<span class="jv-key">"{key}": </span>{/if}<span class="jv-bracket">{'{}'}</span></span></div>
    {:else}
      <div class="jv-row"><span class="jv-gutter"><button class="jv-toggle" onclick={() => toggle(path)}>{f?'▸':'▾'}</button></span><span class="jv-content" style="padding-left:{depth*16}px">{#if key!=null}<span class="jv-key">"{key}": </span>{/if}<span class="jv-bracket">{'{'}</span>{#if f}<span class="jv-ellipsis">{ks.length} keys</span><span class="jv-bracket">{'}'}</span>{/if}</span></div>
      {#if !f}{#each ks as k}{@render node(obj[k], path?`${path}.${k}`:k, depth+1, k, ks.indexOf(k)===ks.length-1)}{/each}{/if}
      {#if !f}<div class="jv-row"><span class="jv-gutter"></span><span class="jv-content" style="padding-left:{depth*16}px"><span class="jv-bracket">{'}'}</span></span></div>{/if}
    {/if}
  {:else}
    <div class="jv-row"><span class="jv-gutter"></span><span class="jv-content">{String(value)}</span></div>
  {/if}
{/snippet}

<div class="json-tree">
  {#if parsed != null}{@render node(parsed, 'root', 0)}{:else}<span class="jv-error">Invalid JSON</span>{/if}
</div>

<style>
  .json-tree { height:100%; overflow:auto; font:450 12px/1.75 'Cascadia Code',Consolas,monospace; color:var(--text); background:var(--panel-2); padding:6px 0; }
  .jv-row { display:grid; grid-template-columns:18px 1fr; min-height:22px; line-height:22px; border-radius:3px; }
  .jv-row:hover { background:var(--hover); }
  .jv-gutter { width:18px; display:flex; align-items:center; justify-content:center; }
  .jv-toggle { width:14px; height:14px; padding:0; cursor:pointer; color:var(--muted-2); font:9px monospace; font-weight:700; border:0; border-radius:2px; background:transparent; line-height:1; display:flex; align-items:center; justify-content:center; }
  .jv-toggle:hover { color:var(--accent); background:var(--hover); }
  .jv-content { white-space:nowrap; padding-right:8px; }
  .jv-key { color:#79c7ff; } .jv-str { color:#9ee7bd; } .jv-num { color:#d8a6ff; }
  .jv-bool { color:#ffb86b; } .jv-null { color:#84909b; font-style:italic; }
  .jv-bracket { color:var(--muted-2); } .jv-ellipsis { color:var(--muted); font-style:italic; margin:0 5px; font-size:10px; }
  .jv-error { color:var(--danger); padding:20px; display:block; }
  em { color:var(--muted); font-size:9px; font-style:normal; margin-left:4px; }
</style>
