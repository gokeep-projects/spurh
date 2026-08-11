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
  const closedPorts = $derived(portResults.filter((item) => !item.open));
  const scanPercent = $derived(portTotal > 0 ? Math.round((portDone / portTotal) * 100) : 0);
  const PORT_SERVICES: Record<number, string> = {
    20: 'FTP-Data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 67: 'DHCP', 68: 'DHCP',
    69: 'TFTP', 80: 'HTTP', 110: 'POP3', 111: 'RPC', 123: 'NTP', 135: 'RPC', 137: 'NetBIOS', 139: 'NetBIOS',
    143: 'IMAP', 161: 'SNMP', 179: 'BGP', 194: 'IRC', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS',
    514: 'Syslog', 587: 'SMTP', 636: 'LDAPS', 873: 'Rsync', 993: 'IMAPS', 995: 'POP3S', 1080: 'SOCKS',
    1433: 'MSSQL', 1521: 'Oracle', 2049: 'NFS', 2181: 'ZooKeeper', 2375: 'Docker', 3000: 'Dev', 3001: 'Dev', 4200: 'Angular', 5173: 'Vite', 5174: 'Vite',
    3306: 'MySQL', 3389: 'RDP', 4369: 'Erlang', 5000: 'Dev', 5432: 'PostgreSQL', 5900: 'VNC',
    6379: 'Redis', 6443: 'K8s API', 7001: 'WebLogic', 8000: 'HTTP-Alt', 8008: 'HTTP-Alt',
    8080: 'HTTP-Alt', 8081: 'HTTP-Alt', 8443: 'HTTPS-Alt', 8500: 'Consul', 8888: 'HTTP-Alt',
    9000: 'Dev', 9092: 'Kafka', 9200: 'Elasticsearch', 9300: 'Elasticsearch', 9418: 'Git',
    11211: 'Memcached', 15672: 'RabbitMQ', 27017: 'MongoDB', 28017: 'MongoDB', 50070: 'HDFS',
  };
  function serviceName(port: number): string { return PORT_SERVICES[port] || '未知服务'; }
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
  /* 浏览器模式降级：HTTP 探测 / DoH 查询 */
  /** 浏览器模式把 localhost 同时按 127.0.0.1 探测，兼容本机 IPv4/IPv6 差异 */
  async function httpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
    const hosts = /^(localhost|127\.0\.0\.1|::1)$/i.test(host) ? ['localhost', '127.0.0.1'] : [host];
    for (const candidate of hosts) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const proto = port === 443 || port === 8443 ? 'https' : 'http';
        await fetch(`${proto}://${candidate}:${port}/`, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' });
        return true;
      } catch {
        /* 连接失败，尝试下一个候选地址 */
      } finally {
        clearTimeout(timer);
      }
    }
    return false;
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
    const started = performance.now();
    if (!isTauri) {
      // 浏览器模式：无法裸 TCP，使用 HTTP 探测常见 Web 端口
      const chunk = 16;
      for (let idx = 0; idx < targets.length; idx += chunk) {
        if (scanCanceled) break;
        const batch = targets.slice(idx, idx + chunk);
        const batchResults = await Promise.all(batch.map(async (port) => {
          const pstart = performance.now();
          const open = await httpProbe(portHost.trim(), port);
          return { port, open, elapsedMs: Math.round(performance.now() - pstart) };
        }));
        portResults = [...portResults, ...batchResults];
        portDone = Math.min(portTotal, portDone + batch.length);
      }
      portElapsed = Math.round(performance.now() - started);
      portResults = [...portResults].sort((a, b) => a.port - b.port);
      portScanning = false;
      return;
    }
    try {
      const chunk = 64;
      for (let idx = 0; idx < targets.length; idx += chunk) {
        if (scanCanceled) break;
        const batch = targets.slice(idx, idx + chunk);
        const batchResults = await safeInvoke<PortResult[]>('net_port_scan', { host: portHost.trim(), ports: batch.join(','), timeoutMs: 600 });
        portResults = [...portResults, ...batchResults];
        portDone = Math.min(portTotal, portDone + batch.length);
      }
      portResults = [...portResults].sort((a, b) => a.port - b.port);
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

  /* ── TCP / UDP 单次发送 ── */
  type TcpSendResult = { ok: boolean; message: string; response: string; responseHex: string; elapsedMs: number };
  let tcpHost = $state('127.0.0.1');
  let tcpPort = $state('80');
  let tcpProtocol = $state('tcp');
  let tcpData = $state('');
  let tcpHexMode = $state(false);
  let tcpSending = $state(false);
  let tcpError = $state('');
  let tcpResult = $state<TcpSendResult | null>(null);
  let tcpSessionId = $state('');
  let tcpConnecting = $state(false);
  const tcpConnected = $derived(!!tcpSessionId);

  async function sendTcp(): Promise<void> {
    const port = Number(tcpPort);
    if (!tcpHost.trim()) { tcpError = '请输入目标主机地址'; return; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { tcpError = '端口无效（1-65535）'; return; }
    if (!tcpData) { tcpError = '请输入要发送的数据'; return; }
    if (tcpHexMode) {
      const clean = tcpData.replace(/[^0-9a-fA-F]/g, '');
      if (clean.length % 2 !== 0) { tcpError = 'HEX 数据必须为偶数位，如 48 65 6C 6C 6F'; return; }
    }
    tcpSending = true; tcpError = ''; tcpResult = null;
    try {
      if (tcpProtocol === 'tcp' && !tcpSessionId) {
        // 未连接时先自动建立连接
        tcpConnecting = true;
        tcpSessionId = await safeInvoke<string>('net_tcp_open', { host: tcpHost.trim(), port, timeoutMs: 4000 });
      }
      if (tcpProtocol === 'tcp') {
        tcpResult = await safeInvoke<TcpSendResult>('net_tcp_write', {
          sessionId: tcpSessionId, data: tcpData, hex: tcpHexMode, timeoutMs: 4000,
        });
      } else {
        tcpResult = await safeInvoke<TcpSendResult>('net_tcp_send', {
          host: tcpHost.trim(), port, protocol: tcpProtocol, data: tcpData, hex: tcpHexMode, timeoutMs: 4000,
        });
      }
    } catch (cause) {
      tcpError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      tcpConnecting = false;
      tcpSending = false;
    }
  }

  /** 快捷载荷：按场景填充常用报文 */
  function usePayload(kind: string): void {
    const host = tcpHost.trim() || '127.0.0.1';
    const port = Number(tcpPort) || 80;
    switch (kind) {
      case 'httpGet':
        tcpData = `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: Spurh/0.1\r\nConnection: close\r\n\r\n`;
        break;
      case 'httpPost':
        tcpData = `POST /api/echo HTTP/1.1\r\nHost: ${host}:${port}\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{"hello":"world"}`;
        break;
      case 'redisPing':
        tcpData = '*1\r\n$4\r\nPING\r\n';
        break;
      case 'smtpEhlo':
        tcpData = 'EHLO spurh.local\r\n';
        break;
      case 'dnsQuery':
        tcpData = '\x00\x01\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01';
        tcpHexMode = true;
        break;
    }
  }


  /** 建立 TCP 长连接 */
  async function openTcp(): Promise<void> {
    const port = Number(tcpPort);
    if (!tcpHost.trim()) { tcpError = '请输入目标主机地址'; return; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { tcpError = '端口无效（1-65535）'; return; }
    tcpConnecting = true; tcpError = '';
    try {
      tcpSessionId = await safeInvoke<string>('net_tcp_open', { host: tcpHost.trim(), port, timeoutMs: 5000 });
    } catch (cause) {
      tcpError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      tcpConnecting = false;
    }
  }

  /** 断开 TCP 长连接 */
  async function closeTcp(): Promise<void> {
    const id = tcpSessionId;
    tcpSessionId = '';
    if (id) safeInvoke('net_tcp_close', { sessionId: id }).catch(() => undefined);
  }

  /** 一键复制全部开放端口（逗号分隔） */
  function copyPorts(): void {
    if (openPorts.length === 0) return;
    copyText(openPorts.map((item) => item.port).join(','), 'ports-all');
  }

  /* ── 链路追踪（实时逐跳拓扑） ── */
  type TraceHop = { hop: number; ip: string; ms: number[] };
  type LocalInfo = { hostname: string; ips: string[]; gateways: string[] };
  const TRACE_W = 860;
  const TRACE_SPINE = 430;
  const TRACE_START_Y = 128;     // 第一个路由节点 y
  const TRACE_HOP_GAP = 104;     // 节点垂直间距
  const TRACE_NODE_L = 300;      // 左侧节点 x
  const TRACE_NODE_R = 560;      // 右侧节点 x
  let traceHost = $state('127.0.0.1');
  let tracing = $state(false);
  let traceHops = $state<TraceHop[]>([]);
  let traceError = $state('');
  let localInfo = $state<LocalInfo | null>(null);
  let traceElapsed = $state(0);
  let traceZoom = $state(1);
  const MIN_ZOOM = 0.5, MAX_ZOOM = 2;
  function zoomTrace(delta: number): void {
    traceZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((traceZoom + delta) * 10) / 10));
  }

  let topoWrapEl = $state<HTMLDivElement | undefined>(undefined);
  let tracePan = $state({ x: 0, y: 0 });
  let dragging = false;
  let dragStart = { x: 0, y: 0, px: 0, py: 0 };
  function onTopoWheel(event: WheelEvent): void {
    event.preventDefault();
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((traceZoom - event.deltaY * 0.001) * 10) / 10));
    if (next !== traceZoom) {
      traceZoom = next;
      if (next === 1) tracePan = { x: 0, y: 0 };
    }
  }
  function onTopoPanStart(event: PointerEvent): void {
    dragging = true;
    dragStart = { x: event.clientX, y: event.clientY, px: tracePan.x, py: tracePan.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function onTopoPanMove(event: PointerEvent): void {
    if (!dragging) return;
    tracePan = { x: dragStart.px + event.clientX - dragStart.x, y: dragStart.py + event.clientY - dragStart.y };
  }
  function onTopoPanEnd(): void { dragging = false; }

  onMount(() => {
    if (!isTauri) {
      localInfo = { hostname: location.hostname || 'browser', ips: [], gateways: [] };
      return;
    }
    safeInvoke<LocalInfo>('net_local_info').then((info) => { localInfo = info; }).catch(() => undefined);
  });

  function traceNodeX(index: number): number { return index % 2 === 0 ? TRACE_NODE_L : TRACE_NODE_R; }
  function traceY(index: number): number { return TRACE_START_Y + index * TRACE_HOP_GAP; }
  /** 本机节点坐标 */
  const LOCAL_POS = { x: TRACE_SPINE, y: 62 };
  /** 节点坐标：-1 表示本机节点 */
  function nodePos(index: number): { x: number; y: number } {
    if (index < 0) return { x: TRACE_SPINE, y: 62 };
    return { x: traceNodeX(index), y: traceY(index) };
  }
  const traceSvgH = $derived(TRACE_START_Y + traceHops.length * TRACE_HOP_GAP + 96);
  const traceReached = $derived(traceHops.length > 0 && traceHops[traceHops.length - 1].ms.some((m) => m > 0) && traceHops[traceHops.length - 1].ip !== '');
  const traceProbing = $derived(tracing ? `正在探测第 ${traceHops.length + 1} 跳…` : '');
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
      tracing = true; traceError = ''; traceHops = []; traceElapsed = 0;
      const traceStart = performance.now();
      const liveTimer = setInterval(() => { traceElapsed = Math.round(performance.now() - traceStart); }, 200);
      const ok = await httpProbe(traceHost.trim().replace(/^https?:\/\//, ''), 443, 4000);
      const ms = Math.round(performance.now() - traceStart);
      clearInterval(liveTimer);
      traceHops = [{ hop: 1, ip: ok ? 'HTTP 探测成功' : '无法连接', ms: ok ? [ms] : [] }];
      traceElapsed = ms;
      tracing = false;
      return;
    }
    tracing = true; traceError = ''; traceHops = []; traceElapsed = 0;
    const started = performance.now();
    const liveTimer = setInterval(() => { traceElapsed = Math.round(performance.now() - started); }, 200);
    const channel = new Channel<TraceHop>();
    channel.onmessage = (hop) => {
      traceHops = [...traceHops, hop];
    };
    try {
      await safeInvoke<TraceHop[]>('net_traceroute_stream', { host: traceHost.trim(), channel });
    } catch (cause) {
      traceError = cause instanceof Error ? cause.message : String(cause);
    }
    clearInterval(liveTimer);
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
    const { copyText: nativeCopy } = await import('../env');
    await nativeCopy(text);
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = ''; }, 1200);
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
        {#if tcpProtocol === 'tcp'}
          {#if tcpConnected}
            <span class="net-conn-status" title="长连接已建立，可多次发送数据"><i></i>已连接 {tcpHost.trim()}:{Number(tcpPort) || '?'}</span>
            <button class="net-run ghost" onclick={closeTcp} title="断开当前长连接">断开</button>
          {:else}
            <button class="net-run ghost" class:busy={tcpConnecting} disabled={tcpConnecting} onclick={openTcp} title="建立 TCP 长连接，之后可多次发送数据">
              <span class="net-dot"></span>{tcpConnecting ? '连接中…' : '连接'}
            </button>
          {/if}
        {/if}
        {#if tcpProtocol === 'tcp' && !tcpConnected && !tcpConnecting}
          <span class="net-tcp-hint"><i></i>请先点击「连接」建立长连接，再发送数据（UDP 无需连接）</span>
        {/if}
        <label class="net-field grow net-data"><span>数据</span><textarea rows={tcpHexMode ? 5 : 16} value={tcpData} oninput={(e) => (tcpData = e.currentTarget.value)} placeholder="要发送的内容，如 GET / HTTP/1.1" spellcheck="false" onkeydown={(e) => e.ctrlKey && e.key === 'Enter' && sendTcp()}></textarea><small class="net-data-hint">Ctrl+Enter 发送 · 支持多行报文 · 可拖拽调整高度</small></label>
        <label class="tcp-hex"><input type="checkbox" checked={tcpHexMode} onchange={(e) => (tcpHexMode = e.currentTarget.checked)} />HEX</label>
        <button class="net-run" class:busy={tcpSending} disabled={tcpSending || (tcpProtocol === 'tcp' && !tcpConnected && !tcpConnecting)} onclick={sendTcp} title={tcpProtocol === 'tcp' && !tcpConnected ? '请先点击「连接」建立长连接' : '发送数据并等待响应'}>
          <span class="net-dot"></span>{tcpSending ? '发送中…' : '发送'}
        </button>
        {#if tcpResult}<span class="net-summary">{tcpResult.elapsedMs} ms</span>{/if}
      {:else if tab === 'trace'}
        <label class="net-field grow"><span>目标</span><input value={traceHost} oninput={(e) => (traceHost = e.currentTarget.value)} placeholder="127.0.0.1 或目标域名" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && runTrace()} /></label>
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
      {#if portScanning && portTotal > 0}
        <div class="scan-progress">
          <div class="scan-progress-head">
            <span class="scan-progress-title"><i></i>正在扫描 {portHost.trim()}：{portDone}/{portTotal}</span>
            <span class="scan-progress-pct">{scanPercent}%</span>
          </div>
          <div class="scan-progress-bar"><div class="scan-progress-fill" style={`width:${scanPercent}%`}></div></div>
          <small class="scan-progress-hint">已发现 {openPorts.length} 个开放端口 · 扫描中请稍候</small>
        </div>
      {/if}
      {#if portResults.length > 0}
        <div class="port-summary">
          <span class="port-summary-open">开放 {openPorts.length} 个</span>
          <span class="port-summary-closed">关闭 {closedPorts.length} 个</span>
          <span class="port-summary-time">共 {portResults.length} 个端口 · 耗时 {portElapsed} ms</span>
          {#if openPorts.length > 0}
            <button class="port-copy-all" onclick={copyPorts} title="复制全部开放端口（逗号分隔）">{copiedKey === 'ports-all' ? '已复制 ✓' : `复制全部 ${openPorts.length} 个`}</button>
          {/if}
        </div>
        {#if openPorts.length > 0}
          <div class="port-open-chips">
            {#each openPorts as item (item.port)}
              <button class="port-chip" onclick={() => copyText(String(item.port), 'p' + item.port)} title="{item.port}：{serviceName(item.port)} · 点击复制">
                <b>{item.port}</b><small>{serviceName(item.port)}</small>
              </button>
            {/each}
          </div>
        {/if}
        <div class="net-result-title">
          <span>探测结果</span>
          <small>点击行复制端口号 · 按端口升序排列</small>
        </div>
        <div class="port-table-wrap">
          <table class="port-table">
            <thead><tr><th>端口</th><th>服务</th><th>状态</th><th>耗时</th></tr></thead>
            <tbody>
              {#each portResults as item}
                <tr class:open={item.open} onclick={() => copyText(String(item.port), 'p' + item.port)} title={`${item.port}（${serviceName(item.port)}）${item.open ? '开放' : '关闭'} · 点击复制`}>
                  <td class="port-num">{item.port}</td>
                  <td class="port-svc">{serviceName(item.port)}</td>
                  <td class="port-status-cell">
                    <span class="port-status" class:open={item.open}>{item.open ? '开放' : '关闭'}</span>
                    {#if copiedKey === 'p' + item.port}<em class="port-copied">已复制</em>{/if}
                  </td>
                  <td class="port-time">{item.elapsedMs}ms</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if !portError && !portScanning}
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
      <div class="tcp-payloads">
        <span>快捷载荷</span>
        <button onclick={() => usePayload('httpGet')} title="生成 HTTP GET 请求报文（自动填入 Host 头）">HTTP GET</button>
        <button onclick={() => usePayload('httpPost')} title="生成 HTTP POST JSON 报文">HTTP POST</button>
        <button onclick={() => usePayload('redisPing')} title="Redis PING 协议报文">Redis PING</button>
        <button onclick={() => usePayload('smtpEhlo')} title="SMTP EHLO 命令">SMTP EHLO</button>
        <button onclick={() => usePayload('dnsQuery')} title="example.com A 记录 DNS 查询（自动开启 HEX 模式，发往 :53）">DNS 查询</button>
        <button class="ghost" onclick={() => (tcpData = '')} title="清空发送内容">清空</button>
      </div>
      {#if !isTauri}
        <div class="net-error"><i></i>浏览器预览模式无法建立裸 TCP/UDP 连接，请运行 npm run tauri dev 使用完整版</div>
      {/if}
      {#if tcpError}<div class="net-error"><i></i>{tcpError}</div>{/if}
      {#if tcpResult}
        {@const r = tcpResult}
        <div class="net-result-title">
          <span>发送结果</span>
          <small>{tcpProtocol.toUpperCase()} {tcpHost.trim()}:{Number(tcpPort)} · 耗时 {r.elapsedMs} ms</small>
        </div>
        <div class="tcp-result" class:ok={r.ok}>
          <div class="tcp-result-line">
            <b class="tcp-result-badge" class:ok={r.ok}>{r.ok ? '✓ 成功' : '✕ 失败'}</b>
            <span>{r.message}</span>
          </div>
          {#if r.response}
            <div class="tcp-response">
              <div class="tcp-response-head">
                <span>收到响应（{r.responseHex.length / 2} 字节）</span>
                <button onclick={() => copyText(r.responseHex, 'tcphex')}>{copiedKey === 'tcphex' ? '已复制 HEX ✓' : '复制 HEX'}</button>
              </div>
              <pre class="tcp-response-text">{r.response}</pre>
              <div class="tcp-response-hex">{r.responseHex}</div>
            </div>
          {:else}
            <div class="tcp-no-response">未收到响应数据{tcpProtocol === 'udp' ? '（UDP 目标无监听或已丢弃数据包属正常）' : ''}</div>
          {/if}
        </div>
      {:else if !tcpError && !tcpSending}
        <div class="net-empty">
          <span class="net-empty-tile">⇄</span>
          <b>TCP / UDP 数据发送</b>
          <small>输入目标主机、端口与数据后发送，展示连接结果与收到的响应；HEX 模式可发送二进制数据</small>
        </div>
      {/if}
    {:else if tab === 'trace'}
      {#if traceError}<div class="net-error"><i></i>{traceError}</div>{/if}
      {#if tracing || traceHops.length > 0 || localInfo}
        <div class="net-result-title">
          <span>{tracing ? `正在实时追踪 ${traceHost}…` : `到 ${traceHost} 的链路拓扑`}</span>
          <small>{traceProbing || `${traceHops.length} 跳 · ${traceElapsed} ms · ${traceReached ? '已到达目标' : '目标未到达'}`}</small>
          <span class="topo-zoom">
            <button onclick={() => zoomTrace(-0.2)} title="缩小" disabled={traceZoom <= MIN_ZOOM}>−</button>
            <b>{Math.round(traceZoom * 100)}%</b>
            <button onclick={() => zoomTrace(0.2)} title="放大" disabled={traceZoom >= MAX_ZOOM}>＋</button>
            <button onclick={() => (traceZoom = 1)} title="重置缩放" disabled={traceZoom === 1}>⟳</button>
          </span>
        </div>
        <div class="topo-wrap" bind:this={topoWrapEl} onwheel={onTopoWheel} onpointerdown={onTopoPanStart} onpointermove={onTopoPanMove} onpointerup={onTopoPanEnd} onpointerleave={onTopoPanEnd} class:panning={dragging} style={traceZoom !== 1 || tracePan.x !== 0 || tracePan.y !== 0 ? `transform: translate(${tracePan.x}px, ${tracePan.y}px) scale(${traceZoom});` : ''}>
          <svg class="trace-topo" viewBox="0 0 {TRACE_W} {traceSvgH}" role="img" aria-label="链路拓扑图">
            <defs>
              <filter id="topo-blur"><feGaussianBlur stdDeviation="4"/></filter>
            </defs>

            <!-- 本机节点 -->
            <g class="topo-local" transform={`translate(${LOCAL_POS.x} ${LOCAL_POS.y})`}>
              <circle class="local-ring" r="26" />
              <circle class="local-core" r="17" />
              <text class="topo-num" y="4.5" text-anchor="middle">本机</text>
            </g>
            <text class="topo-ip local-ip" x={LOCAL_POS.x} y={LOCAL_POS.y + 38} text-anchor="middle">{localInfo ? `${localInfo.hostname} · ${localInfo.ips[0] || ''}` : '本机'}</text>
            {#if localInfo && localInfo.gateways.length > 0}
              <text class="topo-gw" x={LOCAL_POS.x} y={LOCAL_POS.y + 54} text-anchor="middle">网关 {localInfo.gateways[0]}</text>
            {/if}

            {#each traceHops as hop, index}
              {@const pos = nodePos(index)}
              {@const prev = nodePos(index - 1)}
              {@const stats = hopStats(hop.ms)}
              {@const status = hopStatus(hop.ms)}
              {@const pending = tracing && index === traceHops.length - 1}
              <line class="topo-edge" x1={prev.x} y1={prev.y} x2={pos.x} y2={pos.y} />
              <g class="topo-node {status}" class:pending={pending} transform={`translate(${pos.x} ${pos.y})`} style={`animation-delay: ${index * 0.22}s`}>
                <circle class="node-halo" r="22" />
                <circle r="15" />
                <text class="topo-num" y="4.5" text-anchor="middle">{hop.hop}</text>
                <title>{hop.ip || '超时'}{hop.ms.some((m) => m > 0) ? ' · ' + hop.ms.filter((m) => m > 0).join(' / ') + ' ms' : ' · 超时'}</title>
              </g>
              <text class="topo-ip" x={pos.x} y={pos.y - 24} text-anchor="middle">{hop.ip || '超时'}</text>
              <text class="topo-ms" x={pos.x} y={pos.y + 30} text-anchor="middle">{hopLabel(hop.ms)}{stats.loss > 0 ? ` · 丢包 ${stats.loss}%` : ''}</text>
            {/each}

            <!-- 目标节点 -->
            {#if traceHops.length > 0}
              {@const last = nodePos(traceHops.length - 1)}
              {@const targetY = last.y + 64}
              <line class="topo-edge" x1={last.x} y1={last.y} x2={TRACE_SPINE} y2={targetY} />
              <g class="topo-target" class:reached={traceReached} class:timeout={!traceReached && !tracing} transform={`translate(${TRACE_SPINE} ${targetY})`}>
                <circle class="target-halo" r="22" />
                <circle r="16" />
                <text class="topo-num" y="4.5" text-anchor="middle">⌖</text>
              </g>
              <text class="topo-ip target-ip" x={TRACE_SPINE} y={targetY + 32} text-anchor="middle">{traceHost}</text>
              <text class="topo-target-status" x={TRACE_SPINE} y={targetY + 46} text-anchor="middle">{tracing ? '追踪中…' : (traceReached ? '✓ 已到达目标' : '✕ 目标超时或不可达')}</text>
            {/if}
          </svg>
        </div>
        <div class="topo-legend">
          <span class="lg ok">低延迟 ≤80ms</span>
          <span class="lg warn">中 80–200ms</span>
          <span class="lg slow">高 &gt;200ms</span>
          <span class="lg timeout">超时</span>
          <span class="lg target">目标节点</span>
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
  .net-modes button { height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 11px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 0; border-radius: 8px; background: transparent; white-space: nowrap; transition: all .15s ease; }
  .net-modes button span { display: inline-flex; }
  :global(.net-modes button span svg) { width: 13px; height: 13px; }
  .net-modes button:hover:not(.active) { color: var(--text); background: var(--hover); }
  .net-modes button.active { color: #fff; background: var(--btn-gradient); box-shadow: 0 3px 12px color-mix(in srgb, var(--accent) 30%, transparent); }
  .net-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .net-field { display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; height: 34px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-2); transition: border-color var(--transition), box-shadow var(--transition); }
  .net-field:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, var(--line-2)); box-shadow: 0 0 0 3px var(--accent-soft); }
  .net-field span { color: var(--muted-2); font-size: var(--fs-xs); white-space: nowrap; }
  .net-field input { min-width: 0; flex: 1; width: 100%; height: 100%; padding: 0; color: var(--text); font-size: var(--fs-sm); border: 0; outline: 0; background: transparent; }
  .net-field.grow { flex: 1 1 260px; min-width: 220px; }
  .net-field.net-data { height: auto; min-height: 30px; align-items: flex-start; padding: 7px 9px; flex-direction: column; gap: 4px; }
  .net-field.net-data textarea { width: 100%; min-height: 52px; padding: 0; color: var(--text); font: 500 13px/1.55 'Cascadia Code', Consolas, monospace; resize: vertical; border: 0; outline: 0; background: transparent; }
  .net-field.net-data .net-data-hint { color: var(--muted-2); font-size: var(--fs-tiny); line-height: 1; }
  .net-select select { height: 100%; color: var(--text); font-size: var(--fs-xs); border: 0; outline: 0; background: transparent; cursor: pointer; }
  .net-run { height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 13px; cursor: pointer; color: #fff; font-size: var(--fs-sm); font-weight: 600; border: 0; border-radius: 8px; background: var(--btn-gradient); box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 28%, transparent); transition: filter var(--transition), transform var(--transition); }
  .net-run:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
  .net-run:disabled { opacity: .55; cursor: default; }
  .net-run.ghost { color: var(--muted); background: var(--panel-2); border: 1px solid var(--line); box-shadow: none; }
  .net-run.ghost:hover:not(:disabled) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
  .net-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; animation: net-pulse 1.2s ease-in-out infinite; }
  .net-run.busy .net-dot { animation: net-spin .8s linear infinite; }
  @keyframes net-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
  @keyframes net-spin { to { transform: rotate(360deg); } }
  .net-summary { color: var(--muted); font-size: var(--fs-xs); white-space: nowrap; }
  .net-common-ports { display: inline-flex; gap: 4px; flex-wrap: wrap; flex-basis: 100%; }
  .net-common-ports button { height: 30px; padding: 0 10px; cursor: pointer; color: var(--muted); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); transition: all .15s ease; }
  .net-common-ports button:hover { color: var(--text); border-color: var(--line-2); }
  .net-common-ports button.active { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); }
  .net-body { flex: 1; min-height: 0; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .net-error { display: flex; align-items: center; gap: 8px; padding: 9px 12px; color: var(--danger); font-size: var(--fs-sm); border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 8%, transparent); }
  .net-error i { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  .net-browser-note { display: flex; align-items: center; gap: 8px; padding: 9px 12px; color: var(--muted); font-size: var(--fs-xs); border: 1px dashed var(--line-2); border-radius: 8px; background: var(--panel); }
  .net-browser-note i { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 8px var(--warn); }
  .net-result-title { display: flex; align-items: baseline; gap: 8px; }
  .net-result-title span { font-size: var(--fs-sm); font-weight: 700; }
  .net-result-title small { color: var(--muted-2); font-size: var(--fs-xs); }
  .net-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 220px; color: var(--muted); text-align: center; }
  .net-empty-tile { display: grid; place-items: center; width: 54px; height: 54px; border-radius: 15px; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 12px 30px var(--w-12); }
  :global(.net-empty-tile svg) { width: 26px; height: 26px; }
  .net-empty b { color: var(--text); font-size: var(--fs-xs); }
  .net-empty small { font-size: var(--fs-xs); }
  /* 端口扫描：进度 / 汇总 / 表格 */
  .scan-progress { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .scan-progress-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .scan-progress-title { display: inline-flex; align-items: center; gap: 7px; color: var(--text); font-size: var(--fs-xs); font-weight: 600; }
  .scan-progress-title i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); animation: net-pulse 1.2s ease-in-out infinite; }
  .scan-progress-pct { color: var(--accent); font-size: var(--fs-xs); font-weight: 700; font-family: 'Cascadia Code', Consolas, monospace; }
  .scan-progress-bar { height: 6px; overflow: hidden; border-radius: 4px; background: var(--w-06); }
  .scan-progress-fill { height: 100%; border-radius: 4px; background: var(--btn-gradient); transition: width .25s ease; }
  .scan-progress-hint { color: var(--muted); font-size: var(--fs-tiny); }
  .port-summary { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .port-summary-open { display: inline-flex; align-items: center; gap: 6px; color: var(--c-green); font-size: var(--fs-xs); font-weight: 700; }
  .port-summary-open::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--c-green); box-shadow: 0 0 8px var(--c-green); }
  .port-summary-closed { color: var(--muted); font-size: var(--fs-xs); }
  .port-summary-time { margin-left: auto; color: var(--muted-2); font-size: var(--fs-xs); }
  .port-copy-all { height: 24px; padding: 0 10px; cursor: pointer; color: var(--c-cyan); font-size: var(--fs-xs); font-weight: 600; border: 1px solid color-mix(in srgb, var(--c-cyan) 40%, var(--line)); border-radius: 999px; background: transparent; transition: all var(--transition); }
  .port-copy-all:hover { background: color-mix(in srgb, var(--c-cyan) 10%, transparent); box-shadow: 0 0 12px color-mix(in srgb, var(--c-cyan) 25%, transparent); }
  .port-open-chips { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--c-green) 28%, var(--line)); border-radius: 10px; background: color-mix(in srgb, var(--c-green) 4%, var(--panel)); }
  .port-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px; cursor: pointer; color: var(--text); border: 1px solid color-mix(in srgb, var(--c-green) 34%, var(--line)); border-radius: 999px; background: var(--panel); transition: all var(--transition); }
  .port-chip:hover { transform: translateY(-1px); border-color: var(--c-green); box-shadow: 0 4px 14px color-mix(in srgb, var(--c-green) 22%, transparent); }
  .port-chip b { color: var(--c-green); font-size: var(--fs-xs); font-weight: 700; }
  .port-chip small { color: var(--muted); font-size: var(--fs-xs); }
  .port-table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .port-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  .port-table th { position: sticky; top: 0; padding: 8px 12px; color: var(--muted-2); font-size: var(--fs-xs); font-weight: 600; text-align: left; background: var(--panel-2); border-bottom: 1px solid var(--line); }
  .port-table td { padding: 7px 12px; color: var(--text); border-bottom: 1px solid var(--line); }
  .port-table tr:last-child td { border-bottom: 0; }
  .port-table tbody tr { cursor: pointer; transition: background var(--transition); }
  .port-table tbody tr:hover { background: var(--hover); }
  .port-table tbody tr.open { background: color-mix(in srgb, var(--c-green) 5%, transparent); }
  .port-table tbody tr.open:hover { background: color-mix(in srgb, var(--c-green) 10%, var(--hover)); }
  .port-num { font-family: 'Cascadia Code', Consolas, monospace; font-weight: 700; }
  .port-table tr.open .port-num { color: var(--c-green); }
  .port-svc { color: var(--muted); font-size: var(--fs-xs); }
  .port-status-cell { position: relative; }
  .port-status { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); font-weight: 600; }
  .port-status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--muted-2); }
  .port-status.open { color: var(--c-green); }
  .port-status.open::before { background: var(--c-green); box-shadow: 0 0 8px var(--c-green); }
  .port-copied { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text); font-size: var(--fs-xs); font-style: normal; border-radius: 6px; background: var(--glass-strong); backdrop-filter: blur(3px); }
  .port-time { color: var(--muted-2); font-size: var(--fs-xs); font-family: 'Cascadia Code', Consolas, monospace; }
  .dns-card { overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .dns-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  .dns-table th { position: sticky; top: 0; padding: 8px 12px; color: var(--muted-2); font-size: var(--fs-xs); text-align: left; background: var(--panel-2); border-bottom: 1px solid var(--line); }
  .dns-table td { padding: 7px 12px; color: var(--text); border-bottom: 1px solid var(--line); }
  .dns-table tr:last-child td { border-bottom: 0; }
  .dns-table tr:hover td { background: var(--hover); }
  .dns-copy button { height: 28px; padding: 0 9px; cursor: pointer; color: var(--accent); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 8px; background: var(--accent-soft); }
  /* TCP / UDP 发送 */
  .tcp-hex { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px; color: var(--muted); font-size: var(--fs-xs); cursor: pointer; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
  .tcp-hex input { accent-color: var(--accent); }
  .tcp-result { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .tcp-result.ok { border-color: color-mix(in srgb, var(--c-green) 40%, var(--line)); }
  .tcp-result-line { display: flex; align-items: center; gap: 10px; font-size: var(--fs-xs); }
  .tcp-result-badge { flex: 0 0 auto; padding: 3px 10px; color: var(--danger); font-size: var(--fs-xs); font-weight: 700; border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .tcp-result-badge.ok { color: var(--c-green); border-color: color-mix(in srgb, var(--c-green) 40%, var(--line)); background: color-mix(in srgb, var(--c-green) 10%, transparent); }
  .tcp-result-line span { color: var(--text); word-break: break-all; }
  .tcp-no-response { padding: 10px 12px; color: var(--muted); font-size: var(--fs-xs); border: 1px dashed var(--line-2); border-radius: 8px; }
  .tcp-response { display: flex; flex-direction: column; gap: 8px; }
  .tcp-response-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted-2); font-size: var(--fs-xs); }
  .tcp-response-head button { height: 26px; padding: 0 10px; cursor: pointer; color: var(--accent); font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line)); border-radius: 8px; background: var(--accent-soft); }
  .tcp-response-text { margin: 0; max-height: 380px; min-height: 120px; overflow: auto; padding: 10px 12px; white-space: pre-wrap; word-break: break-all; color: var(--text); font-family: 'Cascadia Code', Consolas, monospace; font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .tcp-response-hex { max-height: 120px; overflow: auto; padding: 8px 12px; color: var(--muted); font-family: 'Cascadia Code', Consolas, monospace; font-size: var(--fs-tiny); word-break: break-all; border: 1px dashed var(--line); border-radius: 8px; background: var(--w-03); }
  /* 链路拓扑 */
  .topo-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 12px; background: radial-gradient(ellipse 70% 45% at 50% 0%, var(--accent-soft), transparent 65%), var(--bg); }
  .trace-topo { display: block; min-width: 100%; }
  .topo-edge { stroke: var(--line-2); stroke-width: 1.6; stroke-dasharray: 5 5; animation: topo-dash 1.6s linear infinite; opacity: .8; }
  @keyframes topo-dash { to { stroke-dashoffset: -20; } }
  .topo-local .local-ring { fill: color-mix(in srgb, var(--c-green) 12%, transparent); stroke: var(--c-green); stroke-width: 1.5; animation: local-ring 2.4s ease-out infinite; transform-origin: center; }
  @keyframes local-ring { 0% { transform: scale(.75); opacity: .9; } 100% { transform: scale(1.35); opacity: 0; } }
  .topo-local .local-core { fill: var(--btn-gradient); filter: drop-shadow(0 0 10px color-mix(in srgb, var(--c-green) 55%, transparent)); }
  .topo-local text { fill: #fff; font-size: var(--fs-xs); font-weight: 700; }
  .topo-ip { fill: var(--text); font-size: var(--fs-xs); font-family: 'Cascadia Code', Consolas, monospace; }
  .topo-ip.local-ip { font-size: var(--fs-xs); font-weight: 700; fill: var(--c-green); }
  .topo-gw { fill: var(--muted-2); font-size: var(--fs-tiny); font-family: 'Cascadia Code', Consolas, monospace; }
  .topo-node { opacity: 0; animation: node-in .4s cubic-bezier(.34,1.56,.64,1) forwards; transform-origin: center; }
  @keyframes node-in { from { opacity: 0; transform: scale(.3); } to { opacity: 1; transform: scale(1); } }
  .topo-node circle { stroke-width: 2; }
  .topo-node .node-halo { fill: none; opacity: .35; }
  .topo-node.ok circle:not(.node-halo) { fill: color-mix(in srgb, var(--c-green) 16%, transparent); stroke: var(--c-green); filter: drop-shadow(0 0 8px color-mix(in srgb, var(--c-green) 55%, transparent)); }
  .topo-node.ok .node-halo { stroke: var(--c-green); }
  .topo-node.warn circle:not(.node-halo) { fill: color-mix(in srgb, var(--c-amber) 16%, transparent); stroke: var(--c-amber); filter: drop-shadow(0 0 8px color-mix(in srgb, var(--c-amber) 50%, transparent)); }
  .topo-node.warn .node-halo { stroke: var(--c-amber); }
  .topo-node.slow circle:not(.node-halo) { fill: color-mix(in srgb, var(--c-red) 16%, transparent); stroke: var(--c-red); filter: drop-shadow(0 0 8px color-mix(in srgb, var(--c-red) 50%, transparent)); }
  .topo-node.slow .node-halo { stroke: var(--c-red); }
  .topo-node.timeout circle:not(.node-halo) { fill: var(--w-05); stroke: var(--muted-2); }
  .topo-node.timeout .node-halo { stroke: var(--muted-2); }
  .topo-node.pending .node-halo { animation: node-pulse 1s ease-in-out infinite; }
  @keyframes node-pulse { 0%, 100% { opacity: .2; transform: scale(.9); } 50% { opacity: .9; transform: scale(1.25); } }
  .topo-num { fill: var(--text); font-size: var(--fs-xs); font-weight: 700; }
  .topo-ms { fill: var(--muted); font-size: var(--fs-xs); font-family: 'Cascadia Code', Consolas, monospace; }
  .topo-target circle { stroke-width: 2; stroke-dasharray: 5 4; }
  .topo-target circle:not(.target-halo) { fill: color-mix(in srgb, var(--c-blue) 15%, transparent); stroke: var(--c-blue); filter: drop-shadow(0 0 10px color-mix(in srgb, var(--c-blue) 55%, transparent)); }
  .topo-target .target-halo { fill: none; stroke: var(--c-blue); opacity: .3; }
  .topo-target.reached circle:not(.target-halo) { fill: color-mix(in srgb, var(--c-green) 16%, transparent); stroke: var(--c-green); filter: drop-shadow(0 0 10px color-mix(in srgb, var(--c-green) 55%, transparent)); }
  .topo-target.reached .target-halo { stroke: var(--c-green); }
  .topo-target.timeout circle:not(.target-halo) { fill: var(--w-05); stroke: var(--c-red); }
  .topo-target.timeout .target-halo { stroke: var(--c-red); }
  .topo-target text { fill: #fff; font-size: var(--fs); }
  .target-ip { fill: var(--text); font-size: var(--fs-xs); font-weight: 700; }
  .topo-target-status { font-size: var(--fs-xs); font-family: 'Cascadia Code', Consolas, monospace; }
  .topo-target.reached + text, .topo-target.reached ~ .topo-target-status { fill: var(--c-green); }
  .topo-target.timeout ~ .topo-target-status { fill: var(--c-red); }
  .topo-legend { display: flex; gap: 14px; flex-wrap: wrap; }
  .topo-legend .lg { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: var(--fs-xs); }
  .topo-legend .lg::before { content: ''; width: 8px; height: 8px; border-radius: 50%; }
  .lg.ok::before { background: var(--c-green); box-shadow: 0 0 6px var(--c-green); }
  .lg.warn::before { background: var(--c-amber); box-shadow: 0 0 6px var(--c-amber); }
  .lg.slow::before { background: var(--c-red); box-shadow: 0 0 6px var(--c-red); }
  .lg.timeout::before { background: var(--muted-2); }
  .lg.target::before { background: var(--c-blue); box-shadow: 0 0 6px var(--c-blue); }
  .status-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 7px; }
  .status-chip { display: flex; align-items: center; gap: 8px; padding: 8px 11px; cursor: pointer; color: var(--muted); text-align: left; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); transition: all .15s ease; }
  .status-chip:hover { transform: translateY(-1px); border-color: var(--line-2); }
  .status-chip b { font-size: var(--fs-xs); font-family: 'Cascadia Code', Consolas, monospace; }
  .status-chip small { font-size: var(--fs-xs); }
  :global(.status-chip.tone-ok b) { color: var(--c-green); }
  :global(.status-chip.tone-info b) { color: var(--c-blue); }
  :global(.status-chip.tone-redirect b) { color: var(--c-amber); }
  :global(.status-chip.tone-error b) { color: var(--c-red); }
  .mime-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 7px; }
  .mime-chip { display: flex; flex-direction: column; gap: 2px; padding: 8px 11px; cursor: pointer; color: var(--muted); text-align: left; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); transition: all .15s ease; }
  .mime-chip:hover { transform: translateY(-1px); border-color: var(--line-2); }
  .mime-chip b { color: var(--text); font-size: var(--fs-sm); font-family: 'Cascadia Code', Consolas, monospace; }
  .mime-chip small { font-size: var(--fs-xs); }
  .tcp-payloads { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 2px 0 4px; }
  .tcp-payloads > span { color: var(--muted-2); font-size: var(--fs-xs); }
  .tcp-payloads button { height: 26px; padding: 0 10px; cursor: pointer; color: var(--c-cyan); font-size: var(--fs-xs); font-weight: 600; border: 1px dashed color-mix(in srgb, var(--c-cyan) 40%, var(--line)); border-radius: 999px; background: transparent; white-space: nowrap; transition: all var(--transition); }
  .tcp-payloads button:hover { background: color-mix(in srgb, var(--c-cyan) 10%, transparent); border-style: solid; }
  .tcp-payloads button.ghost { color: var(--muted); border-style: solid; border-color: var(--line); }
  .tcp-payloads button.ghost:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); background: color-mix(in srgb, var(--danger) 6%, transparent); }


  .topo-node { cursor: pointer; }
  .topo-node:hover circle:not(.node-halo) { filter: drop-shadow(0 0 12px color-mix(in srgb, var(--accent) 70%, transparent)); stroke: var(--c-cyan); stroke-width: 2; }
  .topo-node .node-halo { animation: node-halo-pulse 2.2s ease-in-out infinite; }
  @keyframes node-halo-pulse { 0%, 100% { opacity: .25; transform: scale(.92); } 50% { opacity: .55; transform: scale(1.12); } }
  .topo-target { cursor: default; }
  .topo-target .target-halo { animation: target-halo-pulse 2.6s ease-in-out infinite; transform-origin: center; }
  @keyframes target-halo-pulse { 0%, 100% { opacity: .3; transform: scale(.9); } 50% { opacity: .7; transform: scale(1.18); } }
  .topo-edge { transition: stroke .2s ease, stroke-width .2s ease; }
  .topo-node:hover ~ .topo-edge, .topo-node.pending ~ .topo-edge { stroke: color-mix(in srgb, var(--c-cyan) 60%, var(--line-2)); }

  .topo-zoom { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; }
  .topo-zoom button { width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer; color: var(--muted); font-size: var(--fs-sm); border: 1px solid var(--line); border-radius: 7px; background: var(--bg); transition: all .15s ease; }
  .topo-zoom button:hover:not(:disabled) { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: var(--accent-soft); }
  .topo-zoom button:disabled { opacity: .35; cursor: default; }
  .topo-zoom b { min-width: 38px; text-align: center; color: var(--muted); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
  .net-conn-status { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; color: var(--c-green); font-size: var(--fs-xs); font-weight: 600; border: 1px solid color-mix(in srgb, var(--c-green) 35%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--c-green) 8%, transparent); white-space: nowrap; }
  .net-conn-status i { width: 7px; height: 7px; border-radius: 50%; background: var(--c-green); box-shadow: 0 0 8px var(--c-green); animation: net-pulse 1.2s ease-in-out infinite; }
  .topo-wrap { position: relative; overflow: auto; max-height: 52vh; border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--bg) 55%, var(--panel)); cursor: grab; user-select: none; touch-action: none; }
  .topo-wrap.panning { cursor: grabbing; }
  .trace-topo { display: block; max-width: none; transform-origin: top left; transition: transform .18s ease; }
  .topo-edge { stroke-dasharray: 7 5; animation: topo-edge-flow .9s linear infinite; }
  @keyframes topo-edge-flow { to { stroke-dashoffset: -12; } }
  .topo-wrap:has(.topo-node.pending) .topo-edge { animation-duration: .45s; }
</style>
