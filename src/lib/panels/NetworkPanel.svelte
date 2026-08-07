<script lang="ts">
  import { onMount } from 'svelte';
  import { Channel } from '@tauri-apps/api/core';
  import { isTauri, safeInvoke } from '../env';
  import { TOOL_ICONS, UI_ICONS, iconHtml } from '../icons';

  type PortResult = { port: number; open: boolean; elapsedMs: number };
  type Tab = 'port' | 'dns' | 'tcp' | 'trace' | 'ref';
  let tab = $state<Tab>('port');

  /* ── 端口扫描 ── */
  const COMMON_PORTS = [
    { label: 'Web', ports: '80,443,8080,8443' },
    { label: '数据库', ports: '3306,5432,6379,27017' },
    { label: 'SSH/FTP', ports: '21,22,23' },
    { label: '邮件', ports: '25,110,143,465,587,993,995' },
    { label: '常用服务', ports: '53,135,139,445,3389,5900,9200,11211' },
  ];
  let portHost = $state('127.0.0.1');
  let portRange = $state('80,443,3306,5432,6379,8080');
  let portScanning = $state(false);
  let portResults = $state<PortResult[]>([]);
  let portError = $state('');
  let portElapsed = $state(0);
  let portTotal = $state(0);
  let portDone = $state(0);
  let scanCanceled = $state(false);
  const openPorts = $derived(portResults.filter((item) => item.open));
  const now = (): string => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  function parsePorts(text: string): number[] {
    const ports = new Set<number>();
    for (const part of text.split(',')) {
      const p = part.trim();
      if (!p) continue;
      if (p.includes('-')) {
        const [a, b] = p.split('-').map((v) => Number(v.trim()));
        if (Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b <= 65535 && a <= b) {
          for (let v = a; v <= b; v++) ports.add(v);
        }
      } else {
        const v = Number(p);
        if (v >= 1 && v <= 65535) ports.add(v);
      }
    }
    return [...ports].sort((a, b) => a - b);
  }
  let portLog = $state<{ ts: string; text: string; ok: boolean }[]>([]);
  /* 浏览器模式降级：HTTP 探测 / DoH 查询 */
  async function httpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const proto = port === 443 || port === 8443 ? 'https' : 'http';
      await fetch(`${proto}://${host}:${port}/`, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  async function browserLookupDns(host: string, type: string): Promise<{ name: string; ttl: number; data: string }[]> {
    // 多服务商 fallback：阿里云 DoH（国内可达）主，Google DoH 备用
    const endpoints = [
      `https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=${type}`,
      `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${type}`,
    ];
    let lastError: unknown = null;
    for (const url of endpoints) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`DoH 查询失败：HTTP ${res.status}`);
        const data = await res.json();
        if (data.Status !== 0) throw new Error(`DNS 查询失败：Status ${data.Status}`);
        return (data.Answer || []).map((a: { name: string; TTL: number; data: string }) => ({ name: a.name, ttl: a.TTL, data: a.data }));
      } catch (cause) {
        lastError = cause;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('DoH 查询失败');
  }

  function useCommonPorts(ports: string): void { portRange = ports; }
  async function scanPorts(): Promise<void> {
    if (!portHost.trim()) { portError = '请输入主机地址'; return; }
    const targets = parsePorts(portRange);
    if (targets.length === 0) { portError = '端口列表无效，例如 80,443,8000-8100'; return; }
    portScanning = true; scanCanceled = false; portError = '';
    portResults = []; portElapsed = 0; portTotal = targets.length; portDone = 0;
    portLog = [{ ts: now(), text: `开始扫描 ${portHost.trim()} 的 ${targets.length} 个端口…`, ok: true }];
    const started = performance.now();
    if (!isTauri) {
      // 浏览器模式：无法裸 TCP，使用 HTTP 探测常见 Web 端口
      const chunk = 16;
      for (let idx = 0; idx < targets.length; idx += chunk) {
        if (scanCanceled) { portLog = [...portLog, { ts: now(), text: '已手动停止扫描', ok: false }]; break; }
        const batch = targets.slice(idx, idx + chunk);
        const batchResults = await Promise.all(batch.map(async (port) => {
          const pstart = performance.now();
          const open = await httpProbe(portHost.trim(), port);
          return { port, open, elapsedMs: Math.round(performance.now() - pstart) };
        }));
        portResults = [...portResults, ...batchResults];
        portDone = Math.min(portTotal, portDone + batch.length);
        portLog = [...portLog, { ts: now(), text: `已探测 ${portDone}/${portTotal}，发现 ${portResults.filter((r) => r.open).length} 个开放端口（HTTP 探测）`, ok: true }];
      }
      portElapsed = Math.round(performance.now() - started);
      portScanning = false;
      return;
    }
    try {
      const chunk = 64;
      for (let idx = 0; idx < targets.length; idx += chunk) {
        if (scanCanceled) { portLog = [...portLog, { ts: now(), text: '已手动停止扫描', ok: false }]; break; }
        const batch = targets.slice(idx, idx + chunk);
        const batchResults = await safeInvoke<PortResult[]>('net_port_scan', { host: portHost.trim(), ports: batch.join(','), timeoutMs: 600 });
        portResults = [...portResults, ...batchResults];
        portDone = Math.min(portTotal, portDone + batch.length);
        portLog = [...portLog, { ts: now(), text: `已探测 ${portDone}/${portTotal}，发现 ${portResults.filter((r) => r.open).length} 个开放端口`, ok: true }];
      }
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
  let dnsRecords = $state<{ name: string; ttl: number; data: string }[]>([]);
  let dnsLoading = $state(false);
  let dnsError = $state('');
  async function lookupDns(): Promise<void> {
    if (!dnsHost.trim()) { dnsError = '请输入域名'; return; }
    dnsLoading = true; dnsError = ''; dnsRecords = [];
    try {
      dnsRecords = isTauri
        ? await safeInvoke('net_dns_lookup', { host: dnsHost.trim(), recordType: dnsType })
        : await browserLookupDns(dnsHost.trim(), dnsType);
    } catch (cause) {
      dnsError = cause instanceof Error ? cause.message : String(cause);
    }
    dnsLoading = false;
  }

  /* ── TCP / UDP 交互会话 ── */
  type SessionEvent = { kind: string; data: string; hex: string; bytes: number };
  type ChatLog = { ts: string; dir: 'in' | 'out' | 'sys'; text: string; hex: string };
  let tcpHost = $state('127.0.0.1');
  let tcpPort = $state('80');
  let tcpProtocol = $state('tcp');
  let tcpConnected = $state(false);
  let tcpConnecting = $state(false);
  let tcpSessionId = $state<number | null>(null);
  let tcpChannel: Channel<SessionEvent> | undefined;
  let tcpLogs = $state<ChatLog[]>([]);
  let tcpSendText = $state('');
  let tcpHexMode = $state(false);
  let tcpError = $state('');
  let tcpBytesIn = $state(0);
  let tcpBytesOut = $state(0);

  function tcpLog(dir: 'in' | 'out' | 'sys', text: string, hex = ''): void {
    tcpLogs = [...tcpLogs, { ts: now(), dir, text, hex }];
  }
  async function openSession(): Promise<void> {
    const port = Number(tcpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { tcpError = '端口无效'; return; }
    if (!tcpHost.trim()) { tcpError = '请输入主机地址'; return; }
    if (!isTauri) { tcpError = '浏览器预览模式不支持裸 TCP/UDP 会话，请运行 npm run tauri dev 使用完整版'; return; }
    tcpConnecting = true; tcpError = ''; tcpLogs = []; tcpBytesIn = 0; tcpBytesOut = 0;
    try {
      const channel = new Channel<SessionEvent>();
      tcpChannel = channel;
      channel.onmessage = (event) => {
        if (event.kind === 'data') {
          tcpBytesIn += event.bytes;
          tcpLog('in', event.data.length > 0 ? event.data : `[二进制 ${event.bytes} 字节]`, event.hex);
        } else if (event.kind === 'closed') {
          tcpConnected = false; tcpSessionId = null;
          tcpLog('sys', '连接已关闭');
        } else if (event.kind === 'error') {
          tcpConnected = false; tcpSessionId = null;
          tcpError = event.data;
          tcpLog('sys', event.data);
        }
      };
      const id = await safeInvoke<number>('net_session_open', {
        host: tcpHost.trim(), port, protocol: tcpProtocol, timeoutMs: 4000, out: channel,
      });
      tcpSessionId = id;
      tcpConnected = true;
      tcpLog('sys', `已连接 ${tcpProtocol.toUpperCase()} ${tcpHost.trim()}:${port}`);
    } catch (cause) {
      tcpError = cause instanceof Error ? cause.message : String(cause);
      tcpConnected = false; tcpSessionId = null;
    }
    tcpConnecting = false;
  }
  async function closeSession(): Promise<void> {
    if (tcpSessionId !== null) {
      try { await safeInvoke('net_session_close', { sessionId: tcpSessionId }); } catch { /* 忽略 */ }
      tcpSessionId = null;
    }
    tcpConnected = false;
    tcpLog('sys', '已断开连接');
  }
  async function sendData(): Promise<void> {
    if (tcpSessionId === null) { tcpError = '请先建立连接'; return; }
    const text = tcpSendText;
    if (!text) return;
    let payload = text;
    if (tcpHexMode) {
      const clean = text.replace(/[^0-9a-fA-F]/g, '');
      if (clean.length % 2 !== 0) { tcpError = 'HEX 数据必须为偶数位'; return; }
      const bytes: number[] = [];
      for (let idx = 0; idx < clean.length; idx += 2) bytes.push(parseInt(clean.slice(idx, idx + 2), 16));
      payload = String.fromCharCode(...bytes);
    }
    try {
      const sent = await safeInvoke<number>('net_session_send', { sessionId: tcpSessionId, data: payload });
      tcpBytesOut += sent;
      tcpLog('out', tcpHexMode ? `[HEX ${sent} 字节]` : text);
      tcpSendText = '';
    } catch (cause) {
      tcpError = cause instanceof Error ? cause.message : String(cause);
      tcpLog('sys', cause instanceof Error ? cause.message : String(cause));
    }
  }

  /* ── 链路追踪（实时逐跳） ── */
  type TraceHop = { hop: number; ip: string; ms: number[] };
  type LocalInfo = { hostname: string; ips: string[]; gateways: string[] };
  const TRACE_W = 900;
  const TRACE_HOP = 88;
  const TRACE_SPINE = 330;
  const TRACE_NODE_X = [170, 460, 610, 750];
  let traceHost = $state('www.baidu.com');
  let tracing = $state(false);
  let traceHops = $state<TraceHop[]>([]);
  let traceError = $state('');
  let localInfo = $state<LocalInfo | null>(null);
  let traceElapsed = $state(0);
  let traceChanged = $state<Set<number>>(new Set());
  let prevTraceIps = $state<string[]>([]);

  onMount(() => {
    if (!isTauri) {
      localInfo = { hostname: location.hostname || 'browser', ips: [], gateways: [] };
      return;
    }
    safeInvoke<LocalInfo>('net_local_info').then((info) => { localInfo = info; }).catch(() => undefined);
  });

  function traceY(index: number): number { return (index + 1) * TRACE_HOP; }
  function traceNodeX(index: number): number { return TRACE_NODE_X[index % TRACE_NODE_X.length]; }
  function hopStatus(ms: number[]): 'ok' | 'warn' | 'slow' | 'timeout' {
    const vals = ms.filter((m) => m > 0);
    if (vals.length === 0) return 'timeout';
    const best = Math.min(...vals);
    if (best <= 80) return 'ok';
    if (best <= 200) return 'warn';
    return 'slow';
  }
  function hopLabel(ms: number[]): string {
    const vals = ms.filter((m) => m > 0);
    return vals.length ? `${Math.min(...vals)}ms` : '超时';
  }
  function hopStats(ms: number[]): { avg: number; loss: number } {
    const vals = ms.filter((m) => m > 0);
    if (vals.length === 0) return { avg: 0, loss: 100 };
    return { avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), loss: Math.round((1 - vals.length / ms.length) * 100) };
  }
  async function runTrace(): Promise<void> {
    if (!traceHost.trim()) { traceError = '请输入目标主机'; return; }
    if (!isTauri) {
      // 浏览器模式：HTTP 延迟探测（完整 traceroute 需桌面版）
      tracing = true; traceError = ''; traceHops = [];
      const traceStart = performance.now();
      const ok = await httpProbe(traceHost.trim().replace(/^https?:\/\//, ''), 443, 4000);
      const ms = Math.round(performance.now() - traceStart);
      traceHops = [{ hop: 1, ip: ok ? 'HTTP 探测成功' : '无法连接', ms: ok ? [ms] : [] }];
      traceElapsed = ms;
      tracing = false;
      return;
    }
    tracing = true; traceError = ''; traceHops = [];
    const started = performance.now();
    const channel = new Channel<TraceHop>();
    channel.onmessage = (hop) => {
      traceHops = [...traceHops, hop];
    };
    try {
      const all = await safeInvoke<TraceHop[]>('net_traceroute_stream', { host: traceHost.trim(), channel });
      const changed = new Set<number>();
      all.forEach((hop, index) => {
        const prev = prevTraceIps[index];
        if (prev && prev !== hop.ip) changed.add(index);
      });
      traceChanged = changed;
      prevTraceIps = all.map((hop) => hop.ip);
    } catch (cause) {
      traceError = cause instanceof Error ? cause.message : String(cause);
    }
    traceElapsed = Math.round(performance.now() - started);
    tracing = false;
  }

  /* ── HTTP / MIME 速查表 ── */
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
  const filteredMimes = $derived(MIME_TYPES.filter(([mime, desc]) => (mime + desc).toLowerCase().includes(refSearch.toLowerCase())));
  const filteredStatusGroups = $derived(STATUS_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter(([code, desc]) => (code + desc).toLowerCase().includes(refSearch.toLowerCase())),
  })).filter((g) => g.items.length > 0));
  let copiedKey = $state('');
  async function copyText(text: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copiedKey = key;
      setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 1200);
    } catch { /* ?? */ }
  }
</script>

<div class="network-panel">
  <div class="net-head">
    <div class="net-modes">
      <button class:active={tab === 'port'} role="tab" aria-selected={tab === 'port'} onclick={() => (tab = 'port')}><span>{@html iconHtml(TOOL_ICONS['spurh.network'])}</span>端口扫描</button>
      <button class:active={tab === 'dns'} role="tab" aria-selected={tab === 'dns'} onclick={() => (tab = 'dns')}><span>◈</span>DNS</button>
      <button class:active={tab === 'tcp'} role="tab" aria-selected={tab === 'tcp'} onclick={() => (tab = 'tcp')}><span>⇄</span>TCP / UDP</button>
      <button class:active={tab === 'trace'} role="tab" aria-selected={tab === 'trace'} onclick={() => (tab = 'trace')}><span>◎</span>链路追踪</button>
      <button class:active={tab === 'ref'} role="tab" aria-selected={tab === 'ref'} onclick={() => (tab = 'ref')}><span>{@html UI_ICONS.shield}</span>速查表</button>
    </div>

    <div class="net-tools">
      {#if tab === 'port'}
        <label class="net-field"><span>主机</span><input value={portHost} oninput={(e) => (portHost = e.currentTarget.value)} placeholder="127.0.0.1 或域名" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && scanPorts()} /></label>
        <label class="net-field grow"><span>端口</span><input value={portRange} oninput={(e) => (portRange = e.currentTarget.value)} placeholder="80,443,8000-8100" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && scanPorts()} /></label>
        {#if portScanning}
          <button class="net-run ghost" onclick={() => (scanCanceled = true)} title="停止扫描">停止</button>
        {:else}
          <button class="net-run" disabled={portScanning} onclick={scanPorts} title="开始端口探测">
            <span class="net-dot"></span>开始扫描
          </button>
        {/if}
        {#if portScanning && portTotal > 0}
          <span class="net-summary">已扫描 {portDone}/{portTotal}</span>
        {:else if portResults.length > 0}
          <span class="net-summary">{openPorts.length}/{portResults.length} 开放 · {portElapsed} ms</span>
        {/if}
        <div class="net-common-ports">
          {#each COMMON_PORTS as preset}
            <button class:active={portRange === preset.ports} onclick={() => useCommonPorts(preset.ports)} title={preset.ports}>{preset.label}</button>
          {/each}
        </div>
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
      {:else if tab === 'tcp'}
        <label class="net-field"><span>主机</span><input value={tcpHost} oninput={(e) => (tcpHost = e.currentTarget.value)} placeholder="127.0.0.1" spellcheck="false" /></label>
        <label class="net-field"><span>端口</span><input value={tcpPort} oninput={(e) => (tcpPort = e.currentTarget.value)} placeholder="80" spellcheck="false" style="width:64px" /></label>
        <label class="net-field net-select"><span>协议</span>
          <select value={tcpProtocol} onchange={(e) => (tcpProtocol = e.currentTarget.value)}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        </label>
        {#if tcpConnected}
          <button class="net-run ghost" onclick={closeSession} title="断开连接">断开</button>
          <span class="net-link-on"><i></i>已连接</span>
        {:else}
          <button class="net-run" class:busy={tcpConnecting} disabled={tcpConnecting} onclick={openSession} title="建立连接">
            <span class="net-dot"></span>{tcpConnecting ? '连接中…' : '连接'}
          </button>
        {/if}
        {#if tcpLogs.length > 0}
          <span class="net-summary">↓ {tcpBytesIn}B · ↑ {tcpBytesOut}B</span>
        {/if}
      {:else if tab === 'trace'}
        <label class="net-field grow"><span>目标</span><input value={traceHost} oninput={(e) => (traceHost = e.currentTarget.value)} placeholder="www.baidu.com" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && runTrace()} /></label>
        <button class="net-run" class:busy={tracing} disabled={tracing} onclick={runTrace} title="实时追踪到目标主机的路由">
          <span class="net-dot"></span>{tracing ? '追踪中…' : '开始追踪'}
        </button>
        {#if traceHops.length > 0}<span class="net-summary">{traceHops.length} 跳 · {traceElapsed} ms</span>{/if}
      {:else}
        <label class="net-field grow"><span>搜索</span><input value={refSearch} oninput={(e) => (refSearch = e.currentTarget.value)} placeholder="状态码 / MIME / 关键字…" spellcheck="false" /></label>
        <span class="net-summary">{filteredMimes.length} MIME · {filteredStatusGroups.reduce((acc, g) => acc + g.items.length, 0)} 状态码</span>
      {/if}
    </div>
  </div>

  <div class="net-body">
    {#if !isTauri}<div class="net-browser-note"><i></i>浏览器预览模式：端口扫描使用 HTTP 探测、DNS 走 DoH；TCP/UDP 与 traceroute 需桌面版（npm run tauri dev）</div>{/if}
    {#if tab === 'port'}
      {#if portError}<div class="net-error"><i></i>{portError}</div>{/if}
      {#if portLog.length > 0}
        <div class="net-result-title"><span>运行日志</span><small>每次扫描的实时记录</small></div>
        <div class="send-log">
          {#each portLog as log}
            <div class="send-log-line" class:bad={!log.ok}><i>{log.ts}</i><b>{log.ok ? '✓' : '✕'}</b><span>{log.text}</span></div>
          {/each}
        </div>
      {/if}
      {#if portResults.length > 0}
        <div class="net-result-title">
          <span>探测结果</span>
          <small>点击端口复制</small>
        </div>
        <div class="net-results">
          {#each portResults as item}
            <button class="port-chip" class:open={item.open} onclick={() => copyText(String(item.port), 'p' + item.port)} title={item.open ? `端口开放 · ${item.elapsedMs}ms · 点击复制` : '端口关闭 · 点击复制'}>
              <b>{item.port}</b>
              <small>{item.open ? 'OPEN' : 'CLOSED'}</small>
              {#if item.open}<i></i>{/if}
              {#if copiedKey === 'p' + item.port}<em>已复制</em>{/if}
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
    {:else if tab === 'tcp'}
      {#if tcpError}<div class="net-error"><i></i>{tcpError}</div>{/if}
      {#if tcpLogs.length > 0}
        <div class="chat-head">
          <div class="chat-status" class:on={tcpConnected}>
            <i></i><span>{tcpConnected ? `${tcpProtocol.toUpperCase()} 会话已建立` : '未连接'}</span>
          </div>
          <label class="chat-hex-toggle"><input type="checkbox" checked={tcpHexMode} onchange={(e) => (tcpHexMode = e.currentTarget.checked)} />HEX 模式</label>
          <span class="chat-bytes">↓ {tcpBytesIn} B · ↑ {tcpBytesOut} B</span>
        </div>
        <div class="chat-log">
          {#each tcpLogs as log}
            <div class="chat-line" class:in={log.dir === 'in'} class:out={log.dir === 'out'} class:sys={log.dir === 'sys'}>
              <i>{log.ts}</i>
              <b>{log.dir === 'in' ? '◀ 接收' : log.dir === 'out' ? '发送 ▶' : '◆'}</b>
              <span title={log.hex}>{log.text}</span>
            </div>
          {/each}
        </div>
        <div class="chat-send">
          <input value={tcpSendText} oninput={(e) => (tcpSendText = e.currentTarget.value)} placeholder={tcpHexMode ? 'HEX 数据，如 48 65 6C 6C 6F' : '输入要发送的内容，回车发送'} spellcheck="false" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendData(); } }} disabled={!tcpConnected} />
          <button onclick={sendData} disabled={!tcpConnected || !tcpSendText}>发送</button>
        </div>
      {:else}
        <div class="net-empty">
          <span class="net-empty-tile">⇄</span>
          <b>TCP / UDP 交互式会话</b>
          <small>建立连接后可多次收发，支持文本与 HEX 模式，实时查看收发日志</small>
        </div>
      {/if}
    {:else if tab === 'trace'}
      {#if traceError}<div class="net-error"><i></i>{traceError}</div>{/if}
      {#if tracing || traceHops.length > 0 || localInfo}
        <div class="net-result-title">
          <span>{tracing ? `正在实时追踪 ${traceHost}…` : `到 ${traceHost} 的链路拓扑`}</span>
          <small>{tracing ? '逐跳实时渲染中' : `${traceHops.length} 跳 · ${traceElapsed} ms · 绿=低延迟 黄=中 红=高 灰=超时`}</small>
        </div>
        <div class="topo-wrap">
          <svg class="trace-topo" viewBox="0 0 {TRACE_W} {Math.max(130, traceHops.length * TRACE_HOP + 130)}" role="img" aria-label="链路拓扑图">
            <defs>
              <linearGradient id="topo-spine-g" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#3ecf8e" stop-opacity=".75"/><stop offset="1" stop-color="#2f9de4" stop-opacity=".2"/>
              </linearGradient>
              <filter id="topo-blur"><feGaussianBlur stdDeviation="4"/></filter>
            </defs>

            {#if traceHops.length > 0}
              <path class="topo-spine" d="M {TRACE_SPINE} 96 V {traceHops.length * TRACE_HOP + 92}" />
            {/if}

            <!-- 本机节点 -->
            <g class="topo-local" transform="translate({TRACE_SPINE} 46)">
              <circle class="local-ring" r="30" />
              <circle class="local-core" r="20" />
              <text class="topo-num" y="5" text-anchor="middle">本机</text>
            </g>
            <text class="topo-ip local-ip" x={TRACE_SPINE} y="12" text-anchor="middle">{localInfo ? `${localInfo.hostname} · ${localInfo.ips[0] || ''}` : '本机'}</text>
            {#if localInfo && localInfo.gateways.length > 0}
              <text class="topo-gw" x={TRACE_SPINE} y="86" text-anchor="middle">网关 {localInfo.gateways[0]}</text>
            {/if}

            {#each traceHops as hop, index}
              {@const y = traceY(index)}
              {@const x = traceNodeX(index)}
              {@const prevY = index === 0 ? 96 : traceY(index - 1)}
              {@const stats = hopStats(hop.ms)}
              <line class="topo-edge" x1={TRACE_SPINE} y1={prevY} x2={TRACE_SPINE} y2={y} />
              <line class="topo-branch" x1={TRACE_SPINE} y1={y} x2={x} y2={y} />
              <circle class="topo-packet" r="3.5" style={`offset-path: path('M ${TRACE_SPINE} ${prevY} L ${TRACE_SPINE} ${y}'); animation-delay: ${index * 0.18}s;`} />
              <g class="topo-node {hopStatus(hop.ms)}" transform={`translate(${x} ${y})`} style={`animation-delay: ${index * 0.12}s`}>
                <circle class="node-halo" r="24" />
                <circle r="16" />
                <text class="topo-num" y="4.5" text-anchor="middle">{hop.hop}</text>
                <title>{hop.ip || '超时'}{hop.ms.some((m) => m > 0) ? ' · ' + hop.ms.filter((m) => m > 0).join(' / ') + ' ms' : ' · 超时'}</title>
              </g>
              {#if traceChanged.has(index)}
                <g class="topo-change" transform={`translate(${x + 24} ${y - 24})`}>
                  <circle r="9" /><text y="3.5" text-anchor="middle" font-size="9">Δ</text>
                </g>
              {/if}
              <text class="topo-ip" x={x} y={y - 26} text-anchor="middle">{hop.ip || '超时'}</text>
              <text class="topo-ms" x={x} y={y + 34} text-anchor="middle">{hopLabel(hop.ms)}</text>
              <g class="topo-bars" transform={`translate(${x - 15} ${y + 42})`}>
                {#each hop.ms as m, mi}
                  <rect x={mi * 11} y={m > 0 ? 10 - Math.min(m, 60) / 6 : 9} width="7" height={m > 0 ? Math.max(2, Math.min(m, 60) / 6) : 2} rx="1.5" class:bar-timeout={m === 0} style={`animation-delay: ${index * 0.12 + mi * 0.06}s`} />
                {/each}
              </g>
              <text class="topo-loss" x={x} y={y + 60} text-anchor="middle">{stats.loss > 0 ? `丢包 ${stats.loss}%` : '丢包 0%'}</text>
            {/each}

            <!-- 目标节点 -->
            {#if traceHops.length > 0}
              {@const lastY = traceHops.length * TRACE_HOP + 92}
              <g class="topo-target" transform={`translate(${TRACE_SPINE} ${lastY})`}>
                <circle class="target-halo" r="24" />
                <circle r="17" />
                <text class="topo-num" y="4.5" text-anchor="middle">⌖</text>
              </g>
              <text class="topo-ip" x={TRACE_SPINE} y={lastY + 36} text-anchor="middle">{traceHost}</text>
            {/if}
          </svg>
        </div>
        <div class="topo-legend">
          <span class="lg ok">低延迟 ≤80ms</span>
          <span class="lg warn">中 80–200ms</span>
          <span class="lg slow">高 &gt;200ms</span>
          <span class="lg timeout">超时</span>
          <span class="lg change">Δ 路由变化</span>
        </div>
      {:else}
        <div class="net-empty">
          <span class="net-empty-tile">{@html iconHtml(TOOL_ICONS['spurh.network'])}</span>
          <b>输入目标主机开始实时链路追踪</b>
          <small>从当前主机出发，逐跳实时渲染路由拓扑</small>
        </div>
      {/if}
    {:else}
      {#if refSearch || filteredStatusGroups.length > 0 || filteredMimes.length > 0}
        {#each filteredStatusGroups as group}
          <div class="net-result-title"><span>{group.name}</span></div>
          <div class="status-grid">
            {#each group.items as [code, desc]}
              <button class={`status-chip tone-${group.tone}`} onclick={() => copyText(code, 's' + code)} title="点击复制">
                <b>{code}</b><small>{desc}</small>
              </button>
            {/each}
          </div>
        {/each}
        <div class="net-result-title"><span>MIME 类型</span></div>
        <div class="mime-grid">
          {#each filteredMimes as [mime, desc]}
            <button class="mime-chip" onclick={() => copyText(mime, 'm' + mime)} title="点击复制">
              <b>{mime}</b><small>{desc}</small>
            </button>
          {/each}
        </div>
      {:else}
        <div class="net-empty">
          <span class="net-empty-tile">{@html UI_ICONS.search}</span>
          <b>没有匹配结果</b>
          <small>试试其他关键字</small>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .network-panel { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); }
  .net-head { flex: 0 0 auto; display: flex; flex-direction: column; gap: 10.5px; padding: 10px; border-bottom: 1px solid var(--line); background: var(--panel); }
  .net-modes { display: inline-flex; gap: 2px; align-self: flex-start; padding: 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .net-modes button { height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: 13px; border: 0; border-radius: 6px; background: transparent; white-space: nowrap; transition: all .15s ease; }
  .net-modes button span { display: inline-flex; }
  :global(.net-modes button span svg) { width: 13px; height: 13px; }
  .net-modes button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .net-modes button.active { color: #fff; background: var(--btn-gradient); box-shadow: 0 3px 12px color-mix(in srgb, var(--accent) 30%, transparent); }
  .net-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .net-field { display: inline-flex; align-items: center; gap: 6px; padding: 0 9px; height: 32px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); transition: border-color var(--transition), box-shadow var(--transition); }
  .net-field:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, var(--line-2)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .net-field span { color: var(--muted-2); font-size: 13px; white-space: nowrap; }
  .net-field input { min-width: 0; height: 100%; padding: 0; color: var(--text); font-size: 13px; border: 0; outline: 0; background: transparent; }
  .net-field.grow { flex: 1; min-width: 120px; }
  .net-select select { height: 100%; color: var(--text); font-size: 13px; border: 0; outline: 0; background: transparent; cursor: pointer; }
  .net-run { height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 13px; cursor: pointer; color: #fff; font-size: 13.5px; font-weight: 600; border: 0; border-radius: 8px; background: var(--btn-gradient); box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 28%, transparent); transition: filter var(--transition), transform var(--transition); }
  .net-run:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
  .net-run:disabled { opacity: .55; cursor: default; }
  .net-run.ghost { color: var(--muted); background: var(--panel-2); border: 1px solid var(--line); box-shadow: none; }
  .net-run.ghost:hover:not(:disabled) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .net-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; animation: net-pulse 1.2s ease-in-out infinite; }
  .net-run.busy .net-dot { animation: net-spin .8s linear infinite; }
  @keyframes net-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
  @keyframes net-spin { to { transform: rotate(360deg); } }
  .net-summary { color: var(--muted); font-size: 13px; white-space: nowrap; }
  .net-common-ports { display: inline-flex; gap: 4px; flex-wrap: wrap; }
  .net-common-ports button { height: 24px; padding: 0 8px; cursor: pointer; color: var(--muted); font-size: 13px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2); transition: all .15s ease; }
  .net-common-ports button:hover { color: var(--text); border-color: var(--line-2); }
  .net-common-ports button.active { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .net-body { flex: 1; min-height: 0; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .net-error { display: flex; align-items: center; gap: 8px; padding: 9px 12px; color: var(--danger); font-size: 13.5px; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--line)); border-radius: 9px; background: color-mix(in srgb, var(--danger) 8%, transparent); }
  .net-error i { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .net-result-title { display: flex; align-items: baseline; gap: 8px; }
  .net-result-title span { font-size: 13.5px; font-weight: 700; }
  .net-result-title small { color: var(--muted-2); font-size: 13px; }
  .net-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 220px; color: var(--muted); text-align: center; }
  .net-empty-tile { display: grid; place-items: center; width: 54px; height: 54px; border-radius: 15px; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 12px 30px rgba(0,0,0,.25); }
  :global(.net-empty-tile svg) { width: 26px; height: 26px; }
  .net-empty b { color: var(--text); font-size: 13px; }
  .net-empty small { font-size: 13px; }
  .send-log { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow: auto; }
  .send-log-line { display: flex; align-items: center; gap: 8px; padding: 4px 9px; font-size: 13px; border-radius: 6px; background: var(--panel); }
  .send-log-line i { color: var(--muted-2); font-style: normal; }
  .send-log-line b { color: #3ecf8e; }
  .send-log-line.bad b { color: var(--danger); }
  .send-log-line span { color: var(--muted); }
  .net-results { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
  .port-chip { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 9px 11px; cursor: pointer; color: var(--muted); text-align: left; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); transition: all .16s ease; }
  .port-chip:hover { transform: translateY(-2px); border-color: var(--line-2); box-shadow: 0 8px 20px rgba(0,0,0,.22); }
  .port-chip b { color: var(--text); font-size: 14px; font-family: 'Cascadia Code', Consolas, monospace; }
  .port-chip small { font-size: 9px; letter-spacing: .6px; }
  .port-chip.open { border-color: color-mix(in srgb, #3ecf8e 45%, var(--line)); background: linear-gradient(160deg, rgba(62,207,142,.09), var(--panel) 60%); }
  .port-chip.open b { color: #3ecf8e; }
  .port-chip.open small { color: #3ecf8e; }
  .port-chip.open i { position: absolute; top: 8px; right: 8px; width: 6px; height: 6px; border-radius: 50%; background: #3ecf8e; box-shadow: 0 0 8px #3ecf8e; }
  .port-chip em { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: 13px; font-style: normal; border-radius: 10px; background: rgba(16,20,28,.82); backdrop-filter: blur(3px); }
  .dns-card { overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .dns-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .dns-table th { position: sticky; top: 0; padding: 8px 12px; color: var(--muted-2); font-size: 13px; text-align: left; background: var(--panel-2); border-bottom: 1px solid var(--line); }
  .dns-table td { padding: 7px 12px; color: var(--text); border-bottom: 1px solid var(--line); }
  .dns-table tr:last-child td { border-bottom: 0; }
  .dns-table tr:hover td { background: var(--hover); }
  .dns-copy button { height: 24px; padding: 0 9px; cursor: pointer; color: var(--accent); font-size: 13px; border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 6px; background: var(--accent-soft); }
  /* TCP/UDP 会话 */
  .net-link-on { display: inline-flex; align-items: center; gap: 6px; color: #3ecf8e; font-size: 13px; }
  .net-link-on i { width: 8px; height: 8px; border-radius: 50%; background: #3ecf8e; box-shadow: 0 0 10px #3ecf8e; animation: net-pulse 1.4s ease-in-out infinite; }
  .chat-head { display: flex; align-items: center; gap: 12px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .chat-status { display: inline-flex; align-items: center; gap: 7px; color: var(--muted-2); font-size: 13px; }
  .chat-status i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted-2); }
  .chat-status.on { color: #3ecf8e; }
  .chat-status.on i { background: #3ecf8e; box-shadow: 0 0 10px #3ecf8e; animation: net-pulse 1.4s ease-in-out infinite; }
  .chat-hex-toggle { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 13px; cursor: pointer; }
  .chat-hex-toggle input { accent-color: var(--accent); }
  .chat-bytes { margin-left: auto; color: var(--muted-2); font-size: 13px; font-family: 'Cascadia Code', Consolas, monospace; }
  .chat-log { display: flex; flex-direction: column; gap: 3px; min-height: 140px; max-height: 46vh; overflow: auto; padding: 8px; border: 1px solid var(--line); border-radius: 9px; background: #0b0e14; }
  .chat-line { display: flex; align-items: flex-start; gap: 8px; padding: 5px 8px; font-size: 13px; border-radius: 6px; }
  .chat-line i { flex: 0 0 auto; color: var(--muted-2); font-size: 9.5px; font-style: normal; font-family: 'Cascadia Code', Consolas, monospace; }
  .chat-line b { flex: 0 0 auto; font-size: 9.5px; font-weight: 600; }
  .chat-line span { word-break: break-all; white-space: pre-wrap; font-family: 'Cascadia Code', Consolas, monospace; font-size: 13px; }
  .chat-line.in { background: rgba(47,157,228,.07); }
  .chat-line.in b { color: #4cc2ff; }
  .chat-line.out { background: rgba(62,207,142,.07); }
  .chat-line.out b { color: #3ecf8e; }
  .chat-line.sys { opacity: .7; }
  .chat-line.sys b { color: var(--muted); }
  .chat-send { display: flex; gap: 8px; }
  .chat-send input { flex: 1; height: 34px; padding: 0 12px; color: var(--text); font-size: 13px; border: 1px solid var(--line); border-radius: 8px; outline: 0; background: var(--panel); transition: border-color var(--transition), box-shadow var(--transition); }
  .chat-send input:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line-2)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .chat-send input:disabled { opacity: .5; }
  .chat-send button { height: 34px; padding: 0 16px; cursor: pointer; color: #fff; font-size: 13.5px; font-weight: 600; border: 0; border-radius: 8px; background: var(--btn-gradient); box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 28%, transparent); }
  .chat-send button:disabled { opacity: .45; cursor: default; }
  /* 链路拓扑 */
  .topo-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 12px; background: radial-gradient(ellipse 70% 45% at 50% 0%, rgba(47,157,228,.08), transparent 65%), #0b0e14; }
  .trace-topo { display: block; min-width: 100%; }
  .topo-spine { fill: none; stroke: url(#topo-spine-g); stroke-width: 2.5; stroke-dasharray: 7 6; animation: topo-dash 1.2s linear infinite; }
  @keyframes topo-dash { to { stroke-dashoffset: -26; } }
  .topo-edge { stroke: rgba(94,190,255,.16); stroke-width: 1.5; }
  .topo-branch { stroke: rgba(94,190,255,.22); stroke-width: 1.5; stroke-dasharray: 3 4; animation: topo-dash 2s linear infinite; }
  .topo-packet { fill: #4cc2ff; filter: url(#topo-blur); animation: topo-flow 1.3s ease-out infinite; }
  @keyframes topo-flow { 0% { offset-distance: 0%; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { offset-distance: 100%; opacity: 0; } }
  .topo-local .local-ring { fill: rgba(62,207,142,.1); stroke: rgba(62,207,142,.8); stroke-width: 1.5; animation: local-ring 2.4s ease-out infinite; transform-origin: center; }
  @keyframes local-ring { 0% { transform: scale(.75); opacity: .9; } 100% { transform: scale(1.35); opacity: 0; } }
  .topo-local .local-core { fill: url(#topo-spine-g); filter: drop-shadow(0 0 10px rgba(62,207,142,.65)); }
  .topo-local text { fill: #fff; font-size: 13px; font-weight: 700; }
  .topo-ip { fill: var(--text); font-size: 13px; font-family: 'Cascadia Code', Consolas, monospace; }
  .topo-ip.local-ip { font-size: 13px; font-weight: 700; fill: #3ecf8e; }
  .topo-gw { fill: var(--muted-2); font-size: 9.5px; font-family: 'Cascadia Code', Consolas, monospace; }
  .topo-node { opacity: 0; animation: node-in .4s cubic-bezier(.34,1.56,.64,1) forwards; transform-origin: center; }
  @keyframes node-in { from { opacity: 0; transform: scale(.3); } to { opacity: 1; transform: scale(1); } }
  .topo-node circle { stroke-width: 2; }
  .topo-node .node-halo { fill: none; opacity: .35; }
  .topo-node.ok circle:not(.node-halo) { fill: rgba(62,207,142,.16); stroke: #3ecf8e; filter: drop-shadow(0 0 8px rgba(62,207,142,.55)); }
  .topo-node.ok .node-halo { stroke: #3ecf8e; }
  .topo-node.warn circle:not(.node-halo) { fill: rgba(232,180,90,.16); stroke: #e8b45a; filter: drop-shadow(0 0 8px rgba(232,180,90,.5)); }
  .topo-node.warn .node-halo { stroke: #e8b45a; }
  .topo-node.slow circle:not(.node-halo) { fill: rgba(242,109,120,.16); stroke: #f26d78; filter: drop-shadow(0 0 8px rgba(242,109,120,.5)); }
  .topo-node.slow .node-halo { stroke: #f26d78; }
  .topo-node.timeout circle:not(.node-halo) { fill: rgba(138,148,166,.12); stroke: #5b6475; }
  .topo-node.timeout .node-halo { stroke: #5b6475; }
  .topo-num { fill: var(--text); font-size: 13px; font-weight: 700; }
  .topo-ms { fill: var(--muted); font-size: 13px; font-family: 'Cascadia Code', Consolas, monospace; }
  .topo-loss { fill: var(--muted-2); font-size: 9px; font-family: 'Cascadia Code', Consolas, monospace; }
  .topo-bars rect { fill: #4cc2ff; opacity: 0; animation: bar-in .4s ease forwards; }
  .topo-bars rect.bar-timeout { fill: #5b6475; }
  @keyframes bar-in { from { opacity: 0; transform: scaleY(0); transform-origin: bottom; } to { opacity: .9; transform: scaleY(1); transform-origin: bottom; } }
  .topo-change circle { fill: #e8b45a; filter: drop-shadow(0 0 6px rgba(232,180,90,.8)); }
  .topo-change text { fill: #0b0e14; font-weight: 800; }
  .topo-target circle { stroke-width: 2; stroke-dasharray: 5 4; }
  .topo-target circle:not(.target-halo) { fill: rgba(47,157,228,.15); stroke: #2f9de4; filter: drop-shadow(0 0 10px rgba(47,157,228,.55)); }
  .topo-target .target-halo { fill: none; stroke: #2f9de4; opacity: .3; }
  .topo-target text { fill: #fff; font-size: 14px; }
  .topo-legend { display: flex; gap: 14px; flex-wrap: wrap; }
  .topo-legend .lg { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 13px; }
  .topo-legend .lg::before { content: ''; width: 8px; height: 8px; border-radius: 50%; }
  .lg.ok::before { background: #3ecf8e; box-shadow: 0 0 6px #3ecf8e; }
  .lg.warn::before { background: #e8b45a; box-shadow: 0 0 6px #e8b45a; }
  .lg.slow::before { background: #f26d78; box-shadow: 0 0 6px #f26d78; }
  .lg.timeout::before { background: #5b6475; }
  .lg.change::before { background: #e8b45a; border-radius: 2px; transform: rotate(45deg); }
  .status-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 7px; }
  .status-chip { display: flex; align-items: center; gap: 8px; padding: 8px 11px; cursor: pointer; color: var(--muted); text-align: left; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); transition: all .15s ease; }
  .status-chip:hover { transform: translateY(-1px); border-color: var(--line-2); }
  .status-chip b { font-size: 13px; font-family: 'Cascadia Code', Consolas, monospace; }
  .status-chip small { font-size: 13px; }
  :global(.status-chip.tone-ok b) { color: #3ecf8e; }
  :global(.status-chip.tone-info b) { color: #4cc2ff; }
  :global(.status-chip.tone-redirect b) { color: #e8b45a; }
  :global(.status-chip.tone-error b) { color: #f26d78; }
  .mime-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 7px; }
  .mime-chip { display: flex; flex-direction: column; gap: 2px; padding: 8px 11px; cursor: pointer; color: var(--muted); text-align: left; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); transition: all .15s ease; }
  .mime-chip:hover { transform: translateY(-1px); border-color: var(--line-2); }
  .mime-chip b { color: var(--text); font-size: 13.5px; font-family: 'Cascadia Code', Consolas, monospace; }
  .mime-chip small { font-size: 13px; }
</style>
