<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { TOOL_ICONS, UI_ICONS, iconHtml } from '../icons';

  type PortResult = { port: number; open: boolean; elapsedMs: number };
  type DnsRecord = { name: string; ttl: number; data: string };
  type GeoInfo = {
    query?: string; status?: string; message?: string | null; country?: string | null; countryCode?: string | null;
    regionName?: string | null; city?: string | null; isp?: string | null; org?: string | null; asn?: string | null;
    lat?: number | null; lon?: number | null; timezone?: string | null;
  };

  type Tab = 'port' | 'dns' | 'geo' | 'ref';
  let tab = $state<Tab>('port');

  /* ── 端口扫描 ── */
  let portHost = $state('127.0.0.1');
  let portRange = $state('80,443,3306,5432,6379,8080');
  let portScanning = $state(false);
  let portResults = $state<PortResult[]>([]);
  let portError = $state('');
  let portElapsed = $state(0);
  const openPorts = $derived(portResults.filter((item) => item.open));

  async function scanPorts(): Promise<void> {
    if (!portHost.trim()) { portError = '请输入主机地址'; return; }
    portScanning = true;
    portError = '';
    portResults = [];
    portElapsed = 0;
    const started = performance.now();
    try {
      portResults = await invoke<PortResult[]>('net_port_scan', { host: portHost.trim(), ports: portRange });
    } catch (cause) {
      portError = cause instanceof Error ? cause.message : String(cause);
    }
    portElapsed = Math.round(performance.now() - started);
    portScanning = false;
  }

  /* ── DNS 查询 ── */
  const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'PTR', 'SRV'];
  let dnsHost = $state('');
  let dnsType = $state('A');
  let dnsRecords = $state<DnsRecord[]>([]);
  let dnsLoading = $state(false);
  let dnsError = $state('');

  async function lookupDns(): Promise<void> {
    if (!dnsHost.trim()) { dnsError = '请输入域名'; return; }
    dnsLoading = true;
    dnsError = '';
    dnsRecords = [];
    try {
      dnsRecords = await invoke<DnsRecord[]>('net_dns_lookup', { host: dnsHost.trim(), recordType: dnsType });
    } catch (cause) {
      dnsError = cause instanceof Error ? cause.message : String(cause);
    }
    dnsLoading = false;
  }

  /* ── IP 归属地 ── */
  let geoTarget = $state('');
  let geoInfo = $state<GeoInfo | null>(null);
  let geoLoading = $state(false);
  let geoError = $state('');

  async function lookupGeo(): Promise<void> {
    if (!geoTarget.trim()) { geoError = '请输入 IP 地址或域名'; return; }
    geoLoading = true;
    geoError = '';
    geoInfo = null;
    try {
      geoInfo = await invoke<GeoInfo>('net_ip_geo', { target: geoTarget.trim() });
    } catch (cause) {
      geoError = cause instanceof Error ? cause.message : String(cause);
    }
    geoLoading = false;
  }

  /* ── 速查表 ── */
  const STATUS_GROUPS: Array<{ name: string; tone: string; items: Array<[string, string]> }> = [
    { name: '1xx · 信息响应', tone: 'info', items: [['100', 'Continue 继续'], ['101', 'Switching Protocols 切换协议'], ['102', 'Processing 处理中'], ['103', 'Early Hints 早期提示']] },
    { name: '2xx · 成功', tone: 'ok', items: [['200', 'OK'], ['201', 'Created 已创建'], ['202', 'Accepted 已接受'], ['203', 'Non-Authoritative Info'], ['204', 'No Content 无内容'], ['205', 'Reset Content'], ['206', 'Partial Content 部分内容'], ['207', 'Multi-Status'], ['208', 'Already Reported']] },
    { name: '3xx · 重定向', tone: 'redirect', items: [['300', 'Multiple Choices'], ['301', 'Moved Permanently 永久移动'], ['302', 'Found 临时移动'], ['303', 'See Other'], ['304', 'Not Modified 未修改'], ['307', 'Temporary Redirect'], ['308', 'Permanent Redirect']] },
    { name: '4xx · 客户端错误', tone: 'warn', items: [['400', 'Bad Request 请求错误'], ['401', 'Unauthorized 未认证'], ['403', 'Forbidden 禁止访问'], ['404', 'Not Found 未找到'], ['405', 'Method Not Allowed'], ['406', 'Not Acceptable'], ['408', 'Request Timeout'], ['409', 'Conflict 冲突'], ['410', 'Gone'], ['413', 'Payload Too Large'], ['415', 'Unsupported Media Type'], ['418', "I'm a teapot 我是茶壶"], ['422', 'Unprocessable Entity'], ['425', 'Too Early'], ['429', 'Too Many Requests 请求过多'], ['431', 'Request Header Fields Too Large'], ['451', 'Unavailable For Legal Reasons']] },
    { name: '5xx · 服务端错误', tone: 'error', items: [['500', 'Internal Server Error 内部错误'], ['501', 'Not Implemented'], ['502', 'Bad Gateway 网关错误'], ['503', 'Service Unavailable'], ['504', 'Gateway Timeout 网关超时'], ['505', 'HTTP Version Not Supported'], ['507', 'Insufficient Storage'], ['508', 'Loop Detected'], ['511', 'Network Authentication Required']] },
  ];
  const MIME_TYPES: Array<[string, string]> = [
    ['text/html', 'HTML 文档'], ['text/plain', '纯文本'], ['text/css', '样式表'], ['text/csv', 'CSV 表格'],
    ['application/json', 'JSON 数据'], ['application/xml', 'XML 数据'], ['application/javascript', 'JavaScript'],
    ['application/pdf', 'PDF 文档'], ['application/zip', 'ZIP 压缩包'], ['application/gzip', 'GZIP 压缩包'],
    ['application/x-tar', 'TAR 归档'], ['application/octet-stream', '二进制流'],
    ['image/png', 'PNG 图片'], ['image/jpeg', 'JPEG 图片'], ['image/gif', 'GIF 图片'], ['image/webp', 'WebP 图片'],
    ['image/svg+xml', 'SVG 矢量图'], ['image/x-icon', 'ICO 图标'],
    ['audio/mpeg', 'MP3 音频'], ['audio/ogg', 'OGG 音频'], ['audio/wav', 'WAV 音频'],
    ['video/mp4', 'MP4 视频'], ['video/webm', 'WebM 视频'],
    ['font/woff', 'WOFF 字体'], ['font/woff2', 'WOFF2 字体'],
    ['application/x-www-form-urlencoded', '表单编码'], ['multipart/form-data', '表单文件'],
    ['application/msgpack', 'MessagePack'], ['application/protobuf', 'Protobuf'], ['application/graphql', 'GraphQL'],
    ['application/x-sql', 'SQL 文件'], ['application/wasm', 'WebAssembly'], ['application/x-sh', 'Shell 脚本'],
    ['application/yaml', 'YAML'], ['application/toml', 'TOML'], ['application/ld+json', 'JSON-LD'],
  ];
  let refSearch = $state('');
  const query = $derived(refSearch.trim().toLowerCase());
  const filteredStatusGroups = $derived(query
    ? STATUS_GROUPS.map((group) => ({ ...group, items: group.items.filter(([code, label]) => (code + ' ' + label).toLowerCase().includes(query)) })).filter((group) => group.items.length > 0)
    : STATUS_GROUPS);
  const filteredMimes = $derived(query ? MIME_TYPES.filter(([mime, label]) => (mime + ' ' + label).toLowerCase().includes(query)) : MIME_TYPES);

  let copiedKey = $state('');
  async function copyText(value: string, key: string): Promise<void> {
    try { await navigator.clipboard.writeText(value); } catch { return; }
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 1100);
  }
</script>

<div class="network-panel">
  <div class="net-head">
    <div class="net-modes" role="tablist">
      <button class:active={tab === 'port'} role="tab" aria-selected={tab === 'port'} onclick={() => (tab = 'port')}><span>{@html iconHtml(TOOL_ICONS['spurh.network'])}</span>端口扫描</button>
      <button class:active={tab === 'dns'} role="tab" aria-selected={tab === 'dns'} onclick={() => (tab = 'dns')}><span>{@html UI_ICONS.search}</span>DNS 查询</button>
      <button class:active={tab === 'geo'} role="tab" aria-selected={tab === 'geo'} onclick={() => (tab = 'geo')}><span>{@html UI_ICONS.ticket}</span>IP 归属地</button>
      <button class:active={tab === 'ref'} role="tab" aria-selected={tab === 'ref'} onclick={() => (tab = 'ref')}><span>{@html UI_ICONS.shield}</span>HTTP / MIME 速查</button>
    </div>

    <div class="net-tools">
      {#if tab === 'port'}
        <label class="net-field"><span>主机</span><input value={portHost} oninput={(e) => (portHost = e.currentTarget.value)} placeholder="127.0.0.1 或域名" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && scanPorts()} /></label>
        <label class="net-field grow"><span>端口</span><input value={portRange} oninput={(e) => (portRange = e.currentTarget.value)} placeholder="80,443,8000-8100" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && scanPorts()} /></label>
        <button class="net-run" class:busy={portScanning} disabled={portScanning} onclick={scanPorts} title="开始端口探测">
          <span class="net-dot"></span>{portScanning ? '扫描中…' : '开始扫描'}
        </button>
        {#if portResults.length > 0}<span class="net-summary">{openPorts.length}/{portResults.length} 开放 · {portElapsed} ms</span>{/if}
      {:else if tab === 'dns'}
        <label class="net-field grow"><span>域名</span><input value={dnsHost} oninput={(e) => (dnsHost = e.currentTarget.value)} placeholder="example.com" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && lookupDns()} /></label>
        <label class="net-field net-select"><span>类型</span>
          <select value={dnsType} onchange={(e) => (dnsType = e.currentTarget.value)}>
            {#each DNS_TYPES as type}<option value={type}>{type}</option>{/each}
          </select>
        </label>
        <button class="net-run" class:busy={dnsLoading} disabled={dnsLoading} onclick={lookupDns} title="查询 DNS 记录">
          <span class="net-dot"></span>{dnsLoading ? '查询中…' : '查询'}
        </button>
        {#if dnsRecords.length > 0}<span class="net-summary">{dnsRecords.length} 条记录</span>{/if}
      {:else if tab === 'geo'}
        <label class="net-field grow"><span>IP 或域名</span><input value={geoTarget} oninput={(e) => (geoTarget = e.currentTarget.value)} placeholder="8.8.8.8 或 example.com" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && lookupGeo()} /></label>
        <button class="net-run" class:busy={geoLoading} disabled={geoLoading} onclick={lookupGeo} title="查询 IP 归属地">
          <span class="net-dot"></span>{geoLoading ? '查询中…' : '查询'}
        </button>
        <span class="net-summary">数据源 ip-api.com</span>
      {:else}
        <label class="net-field grow"><span>搜索</span><input value={refSearch} oninput={(e) => (refSearch = e.currentTarget.value)} placeholder="状态码 / MIME / 关键字…" spellcheck="false" /></label>
        <span class="net-summary">{filteredMimes.length} MIME · {filteredStatusGroups.reduce((acc, g) => acc + g.items.length, 0)} 状态码</span>
      {/if}
    </div>
  </div>

  <div class="net-body">
    {#if tab === 'port'}
      {#if portError}<div class="net-error"><i></i>{portError}</div>{/if}
      {#if portResults.length > 0}
        <div class="net-result-title">
          <span>探测结果</span>
          <small>点击端口复制</small>
        </div>
        <div class="net-results">
          {#each portResults as item}
            <button class="port-chip" class:open={item.open} onclick={() => copyText(String(item.port), 'p' + item.port)} title={item.open ? '端口开放 — 点击复制' : '端口关闭 — 点击复制'}>
              <b>{item.port}</b>
              <small>{item.open ? 'OPEN' : 'CLOSED'}</small>
              {#if copiedKey === 'p' + item.port}<i>已复制</i>{/if}
            </button>
          {/each}
        </div>
      {:else if !portError}
        <div class="net-empty">
          <span class="net-empty-tile">{@html iconHtml(TOOL_ICONS['spurh.network'])}</span>
          <b>输入主机与端口开始探测</b>
          <small>支持逗号分隔与范围：80,443,8000-8100</small>
        </div>
      {/if}
    {:else if tab === 'dns'}
      {#if dnsError}<div class="net-error"><i></i>{dnsError}</div>{/if}
      {#if dnsRecords.length > 0}
        <div class="net-result-title"><span>{dnsHost} 的 {dnsType} 记录</span><small>点击数据复制</small></div>
        <div class="dns-card">
          <table class="dns-table">
            <thead><tr><th>名称</th><th>TTL</th><th>数据</th><th></th></tr></thead>
            <tbody>
              {#each dnsRecords as record, i}
                <tr>
                  <td>{record.name}</td>
                  <td>{record.ttl}s</td>
                  <td title={record.data}>{record.data}</td>
                  <td class="dns-copy"><button onclick={() => copyText(record.data, 'd' + i)}>{copiedKey === 'd' + i ? '已复制 ✓' : '复制'}</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if !dnsError}
        <div class="net-empty">
          <span class="net-empty-tile">{@html UI_ICONS.search}</span>
          <b>查询域名的 {dnsType} 记录</b>
          <small>A / AAAA / CNAME / MX / NS / TXT / SOA / PTR / SRV</small>
        </div>
      {/if}
    {:else if tab === 'geo'}
      {#if geoError}<div class="net-error"><i></i>{geoError}</div>{/if}
      {#if geoInfo}
        <div class="net-result-title"><span>归属地信息</span><small>ip-api.com · 非商业免费接口</small></div>
        <div class="geo-grid">
          <article class="geo-card"><small>国家 / 地区</small><b>{geoInfo.country ?? '—'}{geoInfo.countryCode ? ' · ' + geoInfo.countryCode : ''}</b></article>
          <article class="geo-card"><small>省份</small><b>{geoInfo.regionName ?? '—'}</b></article>
          <article class="geo-card"><small>城市</small><b>{geoInfo.city ?? '—'}</b></article>
          <article class="geo-card"><small>ISP</small><b>{geoInfo.isp ?? '—'}</b></article>
          <article class="geo-card"><small>组织</small><b>{geoInfo.org ?? '—'}</b></article>
          <article class="geo-card"><small>ASN</small><b>{geoInfo.asn ?? '—'}</b></article>
          <article class="geo-card"><small>时区</small><b>{geoInfo.timezone ?? '—'}</b></article>
          <article class="geo-card coords"><small>坐标</small><b>{geoInfo.lat != null ? geoInfo.lat.toFixed(4) + ', ' + (geoInfo.lon != null ? geoInfo.lon.toFixed(4) : '—') : '—'}</b></article>
        </div>
      {:else if !geoError}
        <div class="net-empty">
          <span class="net-empty-tile">{@html UI_ICONS.ticket}</span>
          <b>查询 IP 归属地信息</b>
          <small>国家 / 城市 / ISP / ASN / 时区</small>
        </div>
      {/if}
    {:else}
      <div class="ref-layout">
        <section class="ref-col">
          <header><span>HTTP 状态码</span><small>{filteredStatusGroups.reduce((acc, g) => acc + g.items.length, 0)} 条</small></header>
          <div class="ref-scroll">
            {#each filteredStatusGroups as group}
              <div class="status-group">
                <b class="tone-{group.tone}">{group.name}</b>
                {#each group.items as [code, label]}
                  <button class="status-row" onclick={() => copyText(code + ' ' + label, 's' + code)} title="点击复制">
                    <span class="code tone-{group.tone}">{code}</span><span class="label">{label}</span>
                    {#if copiedKey === 's' + code}<i>已复制</i>{/if}
                  </button>
                {/each}
              </div>
            {/each}
            {#if filteredStatusGroups.length === 0}<div class="ref-none">无匹配的状态码</div>{/if}
          </div>
        </section>
        <section class="ref-col">
          <header><span>MIME 类型</span><small>{filteredMimes.length} 条</small></header>
          <div class="ref-scroll">
            {#each filteredMimes as [mime, label]}
              <button class="mime-row" onclick={() => copyText(mime, 'm' + mime)} title="点击复制">
                <code>{mime}</code><span>{label}</span>
                {#if copiedKey === 'm' + mime}<i>已复制</i>{/if}
              </button>
            {/each}
            {#if filteredMimes.length === 0}<div class="ref-none">无匹配的 MIME 类型</div>{/if}
          </div>
        </section>
      </div>
    {/if}
  </div>
</div>

<style>
  .network-panel { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); }
  .net-head { flex: 0 0 auto; display: flex; flex-direction: column; gap: 9px; padding: 10px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .net-modes { display: inline-flex; gap: 2px; align-self: flex-start; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .net-modes button { height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: 10px; border: 0; border-radius: 6px; background: transparent; white-space: nowrap; transition: all .15s ease; }
  .net-modes button span { display: inline-flex; }
  :global(.net-modes button span svg) { width: 13px; height: 13px; }
  .net-modes button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .net-modes button.active { color: #fff; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .net-tools { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .net-field { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); transition: border-color .15s ease, box-shadow .15s ease; }
  .net-field:focus-within { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .net-field > span { flex: 0 0 auto; color: var(--muted-2); font-size: 9px; white-space: nowrap; }
  .net-field input { min-width: 0; width: 130px; height: 100%; padding: 0; color: var(--text); font: 500 11px 'Cascadia Code', monospace; border: 0; outline: 0; background: transparent; }
  .net-field.grow { flex: 1; min-width: 200px; }
  .net-field.grow input { width: 100%; flex: 1; }
  .net-select select { height: 100%; padding: 0 16px 0 2px; cursor: pointer; color: var(--text); font: 600 11px 'Cascadia Code', monospace; border: 0; outline: 0; background: transparent; }
  .net-run { height: 28px; display: inline-flex; align-items: center; gap: 7px; padding: 0 14px; cursor: pointer; color: #fff; font-size: 10.5px; font-weight: 700; border: 0; border-radius: 7px; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 5px 14px color-mix(in srgb, var(--accent) 20%, transparent); transition: transform .12s ease, box-shadow .15s ease, opacity .15s ease; }
  .net-run:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 7px 18px color-mix(in srgb, var(--accent) 30%, transparent); }
  .net-run:disabled { cursor: default; opacity: .45; }
  .net-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
  .net-run.busy .net-dot { animation: net-pulse 1s ease-in-out infinite; }
  @keyframes net-pulse { 50% { opacity: .3; } }
  .net-summary { color: var(--muted); font: 500 9px 'Cascadia Code', monospace; white-space: nowrap; }
  .net-body { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 12px; overflow: auto; }
  .net-error { display: flex; align-items: center; gap: 8px; padding: 8px 12px; color: var(--danger); font-size: 10.5px; border: 1px solid color-mix(in srgb, var(--danger) 26%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 5%, transparent); }
  .net-error i { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .net-result-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .net-result-title span { font-size: 11.5px; font-weight: 700; }
  .net-result-title small { color: var(--muted-2); font-size: 9px; }
  .net-results { display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start; }
  .port-chip { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 66px; padding: 9px 12px; cursor: pointer; color: var(--muted); border: 1px solid var(--line); border-radius: 9px; background: var(--panel); transition: border-color .15s ease, transform .12s ease, box-shadow .15s ease; }
  .port-chip:hover { transform: translateY(-1px); border-color: var(--line-2); box-shadow: 0 5px 14px rgba(0, 0, 0, .10); }
  .port-chip b { color: var(--text); font: 650 13px 'Cascadia Code', monospace; }
  .port-chip small { font: 600 8px 'Cascadia Code', monospace; letter-spacing: .6px; }
  .port-chip.open { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); }
  .port-chip.open b { color: var(--accent); }
  .port-chip.open small { color: var(--accent); }
  .port-chip i { position: absolute; top: -8px; right: -6px; padding: 2px 6px; color: #fff; font-size: 8px; font-style: normal; border-radius: 4px; background: linear-gradient(135deg, var(--accent), var(--blue)); box-shadow: 0 3px 8px color-mix(in srgb, var(--accent) 30%, transparent); }
  .dns-card { overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .dns-table { width: 100%; border-collapse: collapse; font: 450 11px/1.5 'Cascadia Code', monospace; }
  .dns-table th { position: sticky; top: 0; z-index: 1; padding: 9px 12px; text-align: left; color: var(--accent); font-size: 9.5px; font-weight: 650; border-bottom: 1px solid var(--line); background: var(--panel-2); }
  .dns-table td { padding: 8px 12px; border-bottom: 1px solid var(--line); }
  .dns-table td:nth-child(2) { color: var(--muted); white-space: nowrap; }
  .dns-table td:nth-child(3) { max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dns-table tr:last-child td { border-bottom: 0; }
  .dns-table tbody tr:hover td { background: var(--hover); }
  .dns-table .dns-copy { width: 1%; text-align: right; }
  .dns-table button { height: 22px; padding: 0 9px; cursor: pointer; color: var(--muted); font-size: 9px; border: 1px solid var(--line); border-radius: 5px; background: transparent; transition: all .15s ease; }
  .dns-table button:hover { color: var(--text); border-color: var(--line-2); }
  .geo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 9px; }
  .geo-card { padding: 13px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); transition: border-color .15s ease; }
  .geo-card:hover { border-color: var(--line-2); }
  .geo-card small { display: block; margin-bottom: 7px; color: var(--muted); font-size: 8.5px; font-weight: 600; letter-spacing: .5px; }
  .geo-card b { font-size: 12.5px; overflow-wrap: anywhere; }
  .geo-card.coords { grid-column: span 2; }
  .net-empty { min-height: 220px; display: grid; place-content: center; justify-items: center; gap: 8px; color: var(--muted); text-align: center; border: 1px dashed var(--line-2); border-radius: 12px; background: color-mix(in srgb, var(--panel) 60%, transparent); }
  .net-empty-tile { width: 44px; height: 44px; display: grid; place-items: center; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 12px; background: var(--accent-soft); }
  :global(.net-empty-tile svg) { width: 22px; height: 22px; }
  .net-empty b { color: var(--text); font-size: 12.5px; }
  .net-empty small { font-size: 9.5px; }
  .ref-layout { min-height: 0; flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .ref-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); overflow: hidden; }
  .ref-col > header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 13px; border-bottom: 1px solid var(--line); background: var(--panel-2); }
  .ref-col > header span { font-size: 11.5px; font-weight: 700; }
  .ref-col > header small { color: var(--muted); font: 500 9px 'Cascadia Code', monospace; }
  .ref-scroll { min-height: 0; flex: 1; overflow: auto; }
  .status-group > b { position: sticky; top: 0; z-index: 1; display: block; padding: 6px 13px; font-size: 9px; font-weight: 700; border-bottom: 1px solid var(--line); background: var(--panel-2); }
  .status-row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 6px 13px; cursor: pointer; text-align: left; color: var(--muted); font-size: 10px; border: 0; background: transparent; }
  .status-row:hover { background: var(--hover); }
  .status-row .code { min-width: 36px; font: 650 10px 'Cascadia Code', monospace; }
  .status-row .label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status-row i { color: var(--accent); font-size: 9px; font-style: normal; white-space: nowrap; }
  .tone-info { color: var(--blue); }
  .tone-ok { color: var(--accent); }
  .tone-redirect { color: var(--warn); }
  .tone-warn { color: var(--warn); }
  .tone-error { color: var(--danger); }
  .mime-row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 13px; cursor: pointer; text-align: left; border: 0; background: transparent; }
  .mime-row:hover { background: var(--hover); }
  .mime-row code { color: var(--text); font: 500 10.5px 'Cascadia Code', monospace; }
  .mime-row span { min-width: 0; flex: 1; overflow: hidden; color: var(--muted); font-size: 9.5px; text-overflow: ellipsis; white-space: nowrap; }
  .mime-row i { color: var(--accent); font-size: 9px; font-style: normal; white-space: nowrap; }
  .ref-none { padding: 26px 13px; color: var(--muted-2); font-size: 10px; text-align: center; }
  @media (max-width: 980px) { .ref-layout { grid-template-columns: 1fr; } }
</style>
