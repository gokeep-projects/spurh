<script lang="ts">
  import type { PluginResult } from '../plugins/types';

  let { session, onChangeAction, onChangeOption, onChangeInput, onClear }:
  {
    session: { actionId:string; options:Record<string,string>; input:string; result:PluginResult|null; error:string; processing:boolean };
    onChangeAction: (id:string)=>void; onChangeOption:(id:string,v:string)=>void;
    onChangeInput: (v:string)=>void; onClear:()=>void;
  } = $props();
</script>

<div class="regex-panel">
  <div class="regex-row">
    <label><span>表达式</span>
      <input class="regex-pat" value={session.options.pattern||''} placeholder="/pattern/flags" oninput={e => onChangeOption('pattern', e.currentTarget.value)} />
    </label>
    <label><span>标志</span>
      <input class="regex-flags" value={session.options.flags||''} placeholder="g" maxlength="6" oninput={e => onChangeOption('flags', e.currentTarget.value)} />
    </label>
    <label style="display:{session.actionId==='replace'?'flex':'none'}"><span>替换为</span>
      <input class="regex-repl" value={session.options.replacement||''} placeholder="替换文本" oninput={e => onChangeOption('replacement', e.currentTarget.value)} />
    </label>
  </div>
  <div class="regex-actions">
    <button class:active={session.actionId==='test'} onclick={()=>onChangeAction('test')}>测试匹配</button>
    <button class:active={session.actionId==='replace'} onclick={()=>onChangeAction('replace')}>替换</button>
    <button class:active={session.actionId==='explain'} onclick={()=>onChangeAction('explain')}>解析</button>
    <div class="control-spacer"></div>
    <button class="regex-clear" onclick={onClear}>清空</button>
  </div>
</div>

<style>
  .regex-panel { display:flex; flex-direction:column; gap:8px; width:100%; }
  .regex-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .regex-row label { display:flex; align-items:center; gap:5px; white-space:nowrap; }
  .regex-row label > span { color:var(--muted); font-size:11px; min-width:36px; }
  .regex-row input { height:32px; color:var(--text); font:500 12px 'Cascadia Code',monospace; border:1px solid var(--line); border-radius:5px; outline:0; background:var(--bg); padding:0 8px; }
  .regex-pat { width:220px; } .regex-flags { width:64px; } .regex-repl { width:160px; }
  .regex-actions { display:flex; gap:4px; align-items:center; }
  .regex-actions button { height:30px; padding:0 12px; cursor:pointer; color:var(--muted); font-size:11px; border:1px solid var(--line); border-radius:5px; background:transparent; }
  .regex-actions button.active { color:var(--text); background:var(--panel-2); border-color:var(--line-2); }
  .regex-actions button:hover { background:var(--hover); }
  .regex-clear { height:30px; padding:0 10px; cursor:pointer; color:var(--muted); font-size:10px; border:1px solid transparent; border-radius:5px; background:transparent; }
  .regex-clear:hover { color:var(--text); border-color:var(--line); }
  .control-spacer { flex:1; }
</style>
