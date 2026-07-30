<script lang="ts">
  import type { PluginResult } from '../plugins/types';

  let { session, onChangeAction, onChangeOption, onClear }:
  {
    session: { actionId:string; options:Record<string,string>; input:string; result:PluginResult|null; error:string; processing:boolean };
    onChangeAction: (id:string)=>void; onChangeOption:(id:string,v:string)=>void;
    onClear:()=>void;
  } = $props();

  const groups = [
    { label:'加解密', actions:[{id:'aes-encrypt',label:'AES加密'},{id:'aes-decrypt',label:'AES解密'},{id:'rsa-gen',label:'RSA密钥'}] },
    { label:'JWT', actions:[{id:'jwt-decode',label:'解码'},{id:'jwt-verify',label:'验签'},{id:'jwt-gen',label:'生成'}] },
    { label:'哈希', actions:[{id:'MD5',label:'MD5'},{id:'SHA-1',label:'SHA-1'},{id:'SHA-256',label:'SHA-256'},{id:'SHA-512',label:'SHA-512'},{id:'HMAC-SHA256',label:'HMAC256'},{id:'HMAC-SHA512',label:'HMAC512'}] },
  ];
</script>

<div class="crypto-panel">
  <div class="crypto-groups">
    {#each groups as grp}
      <div class="crypto-group">
        <span class="crypto-grp-label">{grp.label}</span>
        {#each grp.actions as act}
          <button class:active={session.actionId===act.id} onclick={()=>onChangeAction(act.id)}>{act.label}</button>
        {/each}
      </div>
    {/each}
  </div>
  {#if ['aes-encrypt','aes-decrypt','jwt-verify','jwt-gen','HMAC-SHA256','HMAC-SHA512'].includes(session.actionId)}
    <div class="crypto-key-row">
      <label><span>密钥</span>
        <input value={session.options.secret||''} placeholder="输入密钥" oninput={e=>onChangeOption('secret', e.currentTarget.value)} />
      </label>
      <div class="control-spacer"></div>
      <button class="crypto-clear" onclick={onClear}>清空</button>
    </div>
  {/if}
</div>

<style>
  .crypto-panel { display:flex; flex-direction:column; gap:8px; width:100%; }
  .crypto-groups { display:flex; gap:16px; flex-wrap:wrap; }
  .crypto-group { display:flex; gap:3px; align-items:center; }
  .crypto-grp-label { color:var(--muted); font-size:10px; font-weight:700; margin-right:4px; white-space:nowrap; }
  .crypto-group button { height:28px; padding:0 10px; cursor:pointer; color:var(--muted); font-size:10px; border:1px solid var(--line); border-radius:4px; background:transparent; white-space:nowrap; }
  .crypto-group button.active { color:var(--text); background:var(--panel-2); border-color:var(--accent); }
  .crypto-group button:hover { background:var(--hover); }
  .crypto-key-row { display:flex; gap:8px; align-items:center; }
  .crypto-key-row label { display:flex; align-items:center; gap:5px; }
  .crypto-key-row label > span { color:var(--muted); font-size:11px; }
  .crypto-key-row input { height:30px; width:200px; color:var(--text); font:500 11px 'Cascadia Code',monospace; border:1px solid var(--line); border-radius:5px; outline:0; background:var(--bg); padding:0 8px; }
  .crypto-clear { height:30px; padding:0 10px; cursor:pointer; color:var(--muted); font-size:10px; border:1px solid transparent; border-radius:5px; background:transparent; }
  .crypto-clear:hover { color:var(--text); border-color:var(--line); }
  .control-spacer { flex:1; }
</style>
