// 网络小工具：端口探测 / DNS 查询 / TCP/UDP 发送 / 路由追踪
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;
use std::time::{Duration, Instant};
#[cfg(not(windows))]
use socket2::{Domain, Protocol, Socket, Type};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortResult {
    pub port: u16,
    pub open: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpSendResult {
    pub ok: bool,
    pub message: String,
    pub response: String,
    pub response_hex: String,
    pub elapsed_ms: u64,
}

/// 解析 HEX 字符串为字节（容忍空格/逗号等分隔符），供 TCP/UDP 发送二进制数据使用
fn parse_hex_payload(text: &str) -> Result<Vec<u8>, String> {
    let clean: String = text.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if clean.is_empty() {
        return Err("HEX 数据为空".into());
    }
    if clean.len() % 2 != 0 {
        return Err("HEX 数据必须为偶数位".into());
    }
    let mut bytes = Vec::with_capacity(clean.len() / 2);
    let chars: Vec<char> = clean.chars().collect();
    for pair in chars.chunks(2) {
        let hex: String = pair.iter().collect();
        bytes.push(u8::from_str_radix(&hex, 16).map_err(|_| format!("HEX 数据无效：{hex}"))?);
    }
    Ok(bytes)
}

fn hex_string(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceHop {
    pub hop: u32,
    pub ip: String,
    pub ms: Vec<u32>,
}

/// TCP/UDP 数据发送与响应接收（UDP 无响应属正常，等待超时返回空响应）

/// TCP 持久连接会话表：连接后保持存活，可多次发送（模拟 telnet/nc 交互）
static TCP_SESSIONS: OnceLock<Mutex<HashMap<String, tokio::net::TcpStream>>> = OnceLock::new();
fn tcp_sessions() -> &'static Mutex<HashMap<String, tokio::net::TcpStream>> {
    TCP_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 建立到目标主机的 TCP 长连接，返回会话 ID（前端据此发送/断开）
#[tauri::command]
pub async fn net_tcp_open(host: String, port: u16, timeout_ms: Option<u64>) -> Result<String, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("请输入主机地址".into());
    }
    if port == 0 {
        return Err("端口无效".into());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5000).clamp(500, 15_000));
    let stream = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| format!("连接超时（{} ms）", timeout.as_millis()))?
        .map_err(|error| format!("连接失败：{error}"))?;
    let id = format!(
        "{host}:{port}@{:x}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    );
    tcp_sessions().lock().await.insert(id.clone(), stream);
    Ok(id)
}

/// 向已建立的 TCP 连接发送数据并读取响应（连接不存在时返回提示）
#[tauri::command]
pub async fn net_tcp_write(
    session_id: String,
    data: String,
    hex: Option<bool>,
    timeout_ms: Option<u64>,
) -> Result<TcpSendResult, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(3000).clamp(500, 15_000));
    let bytes = if hex.unwrap_or(false) {
        parse_hex_payload(&data)?
    } else {
        data.into_bytes()
    };
    let started = Instant::now();
    let mut sessions = tcp_sessions().lock().await;
    let stream = sessions.get_mut(&session_id).ok_or("连接不存在或已断开，请先建立连接")?;
    let mut sent = 0usize;
    if !bytes.is_empty() {
        tokio::time::timeout(timeout, stream.write_all(&bytes))
            .await
            .map_err(|_| "发送超时".to_string())?
            .map_err(|error| format!("发送失败：{error}"))?;
        sent = bytes.len();
    }
    // 读取响应：收到首字节后进入“空闲 250ms”模式，避免空等满超时；总超时仍兜底
    let deadline = tokio::time::Instant::now() + timeout;
    let idle = Duration::from_millis(250);
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let mut got_data = false;
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let read_deadline = if got_data {
            std::cmp::min(now + idle, deadline)
        } else {
            deadline
        };
        match tokio::time::timeout_at(read_deadline, stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&chunk[..n]);
                got_data = true;
                if buf.len() > 65536 {
                    break;
                }
            }
            _ => break,
        }
    }
    let response = String::from_utf8_lossy(&buf).to_string();
    Ok(TcpSendResult {
        ok: true,
        message: format!("已发送 {sent} 字节，收到 {} 字节响应", buf.len()),
        response,
        response_hex: hex_string(&buf),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 断开指定 TCP 连接
#[tauri::command]
pub async fn net_tcp_close(session_id: String) -> Result<(), String> {
    tcp_sessions().lock().await.remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn net_tcp_send(
    host: String,
    port: u16,
    protocol: String,
    data: Option<String>,
    hex: Option<bool>,
    timeout_ms: Option<u64>,
) -> Result<TcpSendResult, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("请输入主机地址".into());
    }
    if port == 0 {
        return Err("端口无效".into());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(3000).clamp(500, 15_000));
    let started = Instant::now();
    let raw = data.unwrap_or_default();
    let bytes = if hex.unwrap_or(false) {
        parse_hex_payload(&raw)?
    } else {
        raw.into_bytes()
    };

    match protocol.as_str() {
        "tcp" => {
            let mut stream = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port)))
                .await
                .map_err(|_| format!("连接超时（{} ms）", timeout.as_millis()))?
                .map_err(|error| format!("连接失败：{error}"))?;
            let mut sent = 0usize;
            if !bytes.is_empty() {
                stream
                    .write_all(&bytes)
                    .await
                    .map_err(|error| format!("发送失败：{error}"))?;
                sent = bytes.len();
            }
            // 读取响应（收到首字节后空闲 250ms 即结束，避免空等满超时；总超时仍兜底）
            let deadline = tokio::time::Instant::now() + timeout;
            let idle = Duration::from_millis(250);
            let mut buf: Vec<u8> = Vec::with_capacity(1024);
            let mut chunk = [0u8; 2048];
            let mut got_data = false;
            loop {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    break;
                }
                let read_deadline = if got_data {
                    std::cmp::min(now + idle, deadline)
                } else {
                    deadline
                };
                match tokio::time::timeout_at(read_deadline, stream.read(&mut chunk)).await {
                    Ok(Ok(0)) => break,
                    Ok(Ok(n)) => {
                        buf.extend_from_slice(&chunk[..n]);
                        got_data = true;
                        if buf.len() > 65536 {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            let response = String::from_utf8_lossy(&buf).to_string();
            Ok(TcpSendResult {
                ok: true,
                message: format!("TCP 连接成功，发送 {sent} 字节，收到 {} 字节响应", buf.len()),
                response,
                response_hex: hex_string(&buf),
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        }
        "udp" => {
            let socket = tokio::net::UdpSocket::bind("0.0.0.0:0")
                .await
                .map_err(|error| format!("创建 UDP 套接字失败：{error}"))?;
            socket
                .connect((host.as_str(), port))
                .await
                .map_err(|error| format!("连接失败：{error}"))?;
            let mut sent = 0usize;
            if !bytes.is_empty() {
                socket
                    .send(&bytes)
                    .await
                    .map_err(|error| format!("发送失败：{error}"))?;
                sent = bytes.len();
            }
            let mut buf = [0u8; 2048];
            let received_len = tokio::time::timeout(timeout, socket.recv(&mut buf))
                .await
                .map(|result| result.unwrap_or(0))
                .unwrap_or(0)
                .min(buf.len());
            let response = String::from_utf8_lossy(&buf[..received_len]).to_string();
            Ok(TcpSendResult {
                ok: true,
                message: if received_len == 0 {
                    format!("UDP 数据已发送 {sent} 字节，未收到响应（目标可能无监听或已丢弃）")
                } else {
                    format!("UDP 发送完成 {sent} 字节，收到 {received_len} 字节响应")
                },
                response,
                response_hex: hex_string(&buf[..received_len]),
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        }
        _ => Err("协议仅支持 tcp / udp".into()),
    }
}

/// 链路追踪：纯 Rust 实现（ICMP Echo + TTL），不依赖任何外部命令。
/// Windows 使用系统 ICMP API（IcmpSendEcho，无需管理员权限）；
/// macOS/Linux 使用无特权 DGRAM ICMP 套接字。

#[cfg(not(windows))]
fn icmp_checksum(data: &[u8]) -> u16 {
    let mut sum = 0u32;
    for pair in data.chunks_exact(2) {
        sum += u16::from_le_bytes([pair[0], pair[1]]) as u32;
    }
    if let [last] = data.chunks_exact(2).remainder() {
        sum += *last as u32;
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

#[cfg(not(windows))]
fn build_echo_request(ident: u16, seq: u16) -> Vec<u8> {
    let mut packet = Vec::with_capacity(16);
    packet.push(8); // ICMP Echo Request
    packet.push(0); // code
    packet.extend_from_slice(&[0u8; 2]); // checksum 占位
    packet.extend_from_slice(&ident.to_be_bytes());
    packet.extend_from_slice(&seq.to_be_bytes());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    packet.extend_from_slice(&stamp.to_be_bytes());
    let sum = icmp_checksum(&packet);
    packet[2..4].copy_from_slice(&sum.to_be_bytes());
    packet
}

/// 解析收到的 ICMP 报文，返回 (icmp_type, identifier, 是否为匹配本会话的错误报文)。
/// RAW 套接字收到的数据含 IP 头，DGRAM 套接字不含，按首字节版本号自动识别。
#[cfg(not(windows))]
fn parse_reply(buf: &[u8], ident: u16) -> Option<(u8, u16, bool)> {
    let mut offset = 0usize;
    if buf.len() >= 1 && (buf[0] >> 4) == 4 {
        let ihl = ((buf[0] & 0x0f) as usize) * 4;
        if ihl >= 20 && buf.len() >= ihl + 8 {
            offset = ihl;
        }
    }
    let icmp = &buf[offset..];
    if icmp.len() < 8 {
        return None;
    }
    let icmp_type = icmp[0];
    let reply_ident = u16::from_be_bytes([icmp[4], icmp[5]]);
    // ICMP 错误报文（time exceeded / unreachable）内嵌原始 IP 头 + 原始 ICMP 头：
    // 偏移 28 处为原始 Echo 类型，偏移 32 处为原始 identifier。
    let mut embedded = false;
    if icmp.len() >= 36 && icmp[28] == 8 {
        embedded = u16::from_be_bytes([icmp[32], icmp[33]]) == ident;
    }
    Some((icmp_type, reply_ident, embedded))
}

#[cfg(not(windows))]
fn create_icmp_socket() -> Result<Socket, String> {
    // macOS/Linux 无特权 DGRAM ICMP
    if let Ok(socket) = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4)) {
        return Ok(socket);
    }
    Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4))
        .map_err(|error| format!("无法创建 ICMP 套接字：{error}"))
}

/// 单跳探测：发送 probes 个 Echo 请求，收集该 TTL 的响应 IP 与往返时延。
#[cfg(not(windows))]
fn probe_hop(
    socket: &Socket,
    dest: Ipv4Addr,
    ttl: u8,
    ident: u16,
    seq: &mut u16,
    probes: usize,
) -> (Option<Ipv4Addr>, Vec<u32>, bool) {
    let _ = socket.set_ttl_v4(ttl as u32);
    let started = Instant::now();
    let deadline = Duration::from_millis(500 * probes as u64 + 400);
    let target = socket2::SockAddr::from(std::net::SocketAddr::new(IpAddr::V4(dest), 0));
    for _ in 0..probes {
        *seq = seq.wrapping_add(1);
        let packet = build_echo_request(ident, *seq);
        let _ = socket.send_to(&packet, &target);
    }
    let mut ms: Vec<u32> = Vec::new();
    let mut hop: Option<Ipv4Addr> = None;
    let mut reached = false;
    let mut buf = [std::mem::MaybeUninit::<u8>::uninit(); 600];
    while started.elapsed() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((n, addr)) => {
                let Some(src) = addr.as_socket_ipv4().map(|sa| *sa.ip()) else { continue };
                // SAFETY: recv_from 已填充前 n 字节（n <= 600）
                let bytes: &[u8] = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, n) };
                let Some((icmp_type, reply_ident, embedded)) = parse_reply(bytes, ident) else {
                    continue;
                };
                match icmp_type {
                    0 => {
                        // Echo Reply：到达目标
                        if reply_ident != ident {
                            continue;
                        }
                        ms.push(started.elapsed().as_millis() as u32);
                        if hop.is_none() {
                            hop = Some(src);
                        }
                        reached = true;
                    }
                    11 | 3 => {
                        // Time Exceeded（中间路由） / Destination Unreachable（目标端口不可达）
                        if !embedded {
                            continue;
                        }
                        ms.push(started.elapsed().as_millis() as u32);
                        if hop.is_none() {
                            hop = Some(src);
                        }
                        if icmp_type == 3 {
                            reached = true;
                        }
                    }
                    _ => {}
                }
            }
            Err(_) => break,
        }
    }
    (hop, ms, reached)
}

#[cfg(not(windows))]
fn run_icmp_traceroute(
    socket: &Socket,
    dest: Ipv4Addr,
    emit: &mut impl FnMut(TraceHop),
) -> Result<Vec<TraceHop>, String> {
    let ident = (std::process::id() as u16).wrapping_add(dest.octets()[3] as u16);
    socket
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| format!("设置套接字超时失败：{error}"))?;
    let mut hops: Vec<TraceHop> = Vec::new();
    let mut seq: u16 = 0;
    for ttl in 1..=20u8 {
        let (ip, ms, done) = probe_hop(socket, dest, ttl, ident, &mut seq, 3);
        if ip.is_some() || !ms.is_empty() {
            let item = TraceHop {
                hop: ttl as u32,
                ip: ip.map(|value| value.to_string()).unwrap_or_default(),
                ms,
            };
            emit(item.clone());
            hops.push(item);
        }
        if done {
            break;
        }
    }
    if hops.is_empty() {
        return Err("未收到任何路由节点响应，请检查目标主机或网络".into());
    }
    Ok(hops)
}

/// Windows 链路追踪：基于系统 ICMP API（IcmpSendEcho），普通权限即可使用。
#[cfg(windows)]
mod windows_icmp {
    use std::net::Ipv4Addr;
    use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, HANDLE};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, IP_OPTION_INFORMATION,
        IP_DEST_HOST_UNREACHABLE, IP_DEST_NET_UNREACHABLE, IP_SUCCESS, IP_TTL_EXPIRED_TRANSIT,
    };

    fn to_ipaddr(addr: Ipv4Addr) -> u32 {
        u32::from_le_bytes(addr.octets())
    }

    fn from_ipaddr(value: u32) -> Ipv4Addr {
        Ipv4Addr::from(value.to_le_bytes())
    }

    /// 单跳探测：每跳发送 probes 个 Echo（TTL 相同），收集响应 IP 与往返时延。
    fn probe_hop(
        handle: HANDLE,
        dest: Ipv4Addr,
        ttl: u8,
        probes: usize,
    ) -> (Option<Ipv4Addr>, Vec<u32>, bool) {
        let options = IP_OPTION_INFORMATION {
            Ttl: ttl,
            Tos: 0,
            Flags: 0,
            OptionsSize: 0,
            OptionsData: std::ptr::null_mut(),
        };
        let mut payload = [0u8; 8];
        let reply_size = (std::mem::size_of::<ICMP_ECHO_REPLY>() + 256) as u32;
        let mut reply = vec![0u8; reply_size as usize];
        let mut ms: Vec<u32> = Vec::new();
        let mut hop: Option<Ipv4Addr> = None;
        let mut reached = false;
        for _ in 0..probes {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            payload.copy_from_slice(&stamp.to_le_bytes());
            // IcmpSendEcho：无特权系统 API，一次调用一轮探测
            let count = unsafe {
                IcmpSendEcho(
                    handle,
                    to_ipaddr(dest),
                    payload.as_ptr() as *const core::ffi::c_void,
                    payload.len() as u16,
                    &options,
                    reply.as_mut_ptr() as *mut core::ffi::c_void,
                    reply_size,
                    500,
                )
            };
            if count == 0 {
                ms.push(0); // 超时
                continue;
            }
            let entry = unsafe { &*(reply.as_ptr() as *const ICMP_ECHO_REPLY) };
            let addr = from_ipaddr(entry.Address);
            match entry.Status {
                IP_SUCCESS | IP_DEST_HOST_UNREACHABLE | IP_DEST_NET_UNREACHABLE => reached = true,
                IP_TTL_EXPIRED_TRANSIT | _ => {}
            }
            ms.push(entry.RoundTripTime);
            if hop.is_none() && addr != Ipv4Addr::UNSPECIFIED {
                hop = Some(addr);
            }
        }
        (hop, ms, reached)
    }

    pub(super) fn run(
        dest: Ipv4Addr,
        emit: &mut impl FnMut(super::TraceHop),
    ) -> Result<Vec<super::TraceHop>, String> {
        let handle = unsafe { IcmpCreateFile() };
        if handle == INVALID_HANDLE_VALUE {
            return Err("无法创建 ICMP 句柄（IcmpCreateFile 失败）".into());
        }
        let mut hops: Vec<super::TraceHop> = Vec::new();
        for ttl in 1..=20u8 {
            let (ip, ms, done) = probe_hop(handle, dest, ttl, 3);
            if ip.is_some() || !ms.is_empty() {
                let item = super::TraceHop {
                    hop: ttl as u32,
                    ip: ip.map(|value| value.to_string()).unwrap_or_default(),
                    ms,
                };
                emit(item.clone());
                hops.push(item);
            }
            if done {
                break;
            }
        }
        unsafe { IcmpCloseHandle(handle) };
        if hops.is_empty() {
            return Err("未收到任何路由节点响应，请检查目标主机或网络".into());
        }
        Ok(hops)
    }
}

fn run_traceroute_blocking(
    dest: Ipv4Addr,
    mut emit: impl FnMut(TraceHop),
) -> Result<Vec<TraceHop>, String> {
    #[cfg(windows)]
    {
        windows_icmp::run(dest, &mut emit)
    }
    #[cfg(not(windows))]
    {
        let socket = create_icmp_socket()?;
        run_icmp_traceroute(&socket, dest, &mut emit)
    }
}

async fn resolve_ipv4(host: &str) -> Result<Ipv4Addr, String> {
    let host = host.trim();
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(ip);
    }
    if host.parse::<std::net::Ipv6Addr>().is_ok() {
        return Err("链路追踪暂不支持 IPv6 目标".into());
    }
    let resolver = hickory_resolver::Resolver::builder_tokio()
        .map_err(|error| format!("DNS 解析器初始化失败：{error}"))?
        .build()
        .map_err(|error| format!("DNS 解析器初始化失败：{error}"))?;
    let lookup = resolver
        .lookup_ip(host)
        .await
        .map_err(|error| format!("域名解析失败：{error}"))?;
    lookup
        .iter()
        .find_map(|addr| match addr {
            IpAddr::V4(v4) => Some(v4),
            _ => None,
        })
        .ok_or_else(|| "域名没有 IPv4 解析结果".to_string())
}

#[tauri::command]
pub async fn net_traceroute(host: String) -> Result<Vec<TraceHop>, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("请输入目标主机".into());
    }
    if host.starts_with('-') {
        return Err("主机名不能以 - 开头".into());
    }
    let dest = resolve_ipv4(&host).await?;
    // 回环地址：Windows IcmpSendEcho 对 127.0.0.0/8 与 ::1 不响应，直接返回本机一跳，避免误报超时
    if dest.is_loopback() {
        return Ok(vec![TraceHop { hop: 1, ip: dest.to_string(), ms: vec![1] }]);
    }
    tokio::task::spawn_blocking(move || run_traceroute_blocking(dest, |_| {}))
        .await
        .map_err(|error| format!("链路追踪任务失败：{error}"))?
}

#[tauri::command]
pub async fn net_port_scan(host: String, ports: String, timeout_ms: Option<u64>) -> Result<Vec<PortResult>, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("请输入主机地址".into());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2000).clamp(200, 10_000));
    let mut targets: Vec<u16> = Vec::new();
    for part in ports.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((start, end)) = part.split_once('-') {
            let start: u16 = start.trim().parse().map_err(|_| format!("端口范围无效：{part}"))?;
            let end: u16 = end.trim().parse().map_err(|_| format!("端口范围无效：{part}"))?;
            if start > end || end - start > 4000 {
                return Err("端口范围过大（单个范围最多 4000 个端口）".into());
            }
            for port in start..=end {
                targets.push(port);
            }
        } else {
            targets.push(part.parse().map_err(|_| format!("端口无效：{part}"))?);
        }
    }
    if targets.is_empty() {
        return Err("请输入要探测的端口，例如 80,443,8000-8100".into());
    }
    if targets.len() > 4096 {
        return Err("端口数量过多（最多 4096 个）".into());
    }

    // 并发上限：避免 4096 个端口同时建连耗尽本地 socket
    let semaphore = Arc::new(tokio::sync::Semaphore::new(256));
    let mut tasks = tokio::task::JoinSet::new();
    for port in targets {
        let host = host.clone();
        let permit = semaphore.clone();
        tasks.spawn(async move {
            let _guard = permit.acquire_owned().await.expect("信号量关闭");
            let started = Instant::now();
            let open = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port)))
                .await
                .map(|result| result.is_ok())
                .unwrap_or(false);
            (port, open, started.elapsed().as_millis() as u64)
        });
    }
    let mut results = Vec::new();
    while let Some(output) = tasks.join_next().await {
        if let Ok((port, open, elapsed_ms)) = output {
            results.push(PortResult { port, open, elapsed_ms });
        }
    }
    results.sort_by_key(|item| item.port);
    Ok(results)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsRecord {
    pub name: String,
    pub ttl: u32,
    pub data: String,
}

fn rdata_text(record_type: &str, record: &hickory_resolver::proto::rr::Record) -> Option<String> {
    use hickory_resolver::proto::rr::RData;
    let data = &record.data;
    match record_type {
        "A" => match data {
            RData::A(address) => Some(address.0.to_string()),
            _ => None,
        },
        "AAAA" => match data {
            RData::AAAA(address) => Some(address.0.to_string()),
            _ => None,
        },
        "CNAME" => match data {
            RData::CNAME(name) => Some(name.to_string()),
            _ => None,
        },
        "MX" => match data {
            RData::MX(mx) => Some(format!("{} {}", mx.preference, mx.exchange)),
            _ => None,
        },
        "NS" => match data {
            RData::NS(name) => Some(name.to_string()),
            _ => None,
        },
        "TXT" => match data {
            RData::TXT(txt) => Some(
                txt.txt_data.iter()
                    .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                    .collect::<Vec<_>>()
                    .join(""),
            ),
            _ => None,
        },
        "SOA" => match data {
            RData::SOA(soa) => Some(format!("{} {} ({})", soa.mname, soa.rname, soa.serial)),
            _ => None,
        },
        "PTR" => match data {
            RData::PTR(name) => Some(name.to_string()),
            _ => None,
        },
        "SRV" => match data {
            RData::SRV(srv) => Some(format!("{} {} {} {}", srv.priority, srv.weight, srv.port, srv.target)),
            _ => None,
        },
        _ => None,
    }
}

#[tauri::command]
pub async fn net_dns_lookup(host: String, record_type: String) -> Result<Vec<DnsRecord>, String> {
    use hickory_resolver::proto::rr::RecordType;
    use hickory_resolver::proto::rr::Name;
    use hickory_resolver::Resolver;

    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("请输入域名".into());
    }
    let record_type = record_type.to_uppercase();
    let supported = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "PTR", "SRV"];
    if !supported.contains(&record_type.as_str()) {
        return Err(format!("暂不支持 {} 记录（支持 {}）", record_type, supported.join(" / ")));
    }

    let resolver = Resolver::builder_tokio()
        .map_err(|error| format!("DNS 解析器初始化失败：{error}"))?
        .build()
        .map_err(|error| format!("DNS 解析器初始化失败：{error}"))?;

    let name = Name::from_str_relaxed(&host).map_err(|error| format!("域名无效：{error}"))?;
    let record_type_enum: RecordType = match record_type.as_str() {
        "A" => RecordType::A,
        "AAAA" => RecordType::AAAA,
        "CNAME" => RecordType::CNAME,
        "MX" => RecordType::MX,
        "NS" => RecordType::NS,
        "TXT" => RecordType::TXT,
        "SOA" => RecordType::SOA,
        "PTR" => RecordType::PTR,
        _ => RecordType::SRV,
    };
    let lookup = resolver
        .lookup(name, record_type_enum)
        .await
        .map_err(|error| format!("DNS 查询失败：{error}"))?;
    let mut records = Vec::new();
    for record in lookup.answers() {
        if let Some(data) = rdata_text(&record_type, record) {
            records.push(DnsRecord {
                name: record.name.to_string(),
                ttl: record.ttl,
                data,
            });
        }
    }
    if records.is_empty() {
        return Err(format!("未找到 {record_type} 记录（域名可能不存在或该类型无记录）"));
    }
    Ok(records)
}

// 网络会话事件：发送/接收数据流，支持 IPv4 / IPv6 与 TCP / UDP
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNetInfo {
    pub hostname: String,
    pub ips: Vec<String>,
    pub gateways: Vec<String>,
}

#[tauri::command]
pub async fn net_local_info() -> Result<LocalNetInfo, String> {
    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    let mut ips: Vec<String> = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for iface in interfaces {
            if iface.is_loopback() {
                continue;
            }
            match iface.addr.ip() {
                IpAddr::V4(ip) if !ip.is_link_local() && !ip.is_unspecified() => ips.push(ip.to_string()),
                IpAddr::V6(ip) if !ip.is_loopback() && !ip.is_unspecified() => ips.push(ip.to_string()),
                _ => {}
            }
        }
    }
    if ips.is_empty() {
        ips.push("127.0.0.1".to_string());
    }
    let mut gateways: Vec<String> = Vec::new();
    if let Ok(gateway) = default_net::get_default_gateway() {
        gateways.push(gateway.ip_addr.to_string());
    }
    Ok(LocalNetInfo { hostname, ips, gateways })
}

// 网络会话：TCP / UDP 交互式会话
#[tauri::command]
pub async fn net_traceroute_stream(
    host: String,
    channel: tauri::ipc::Channel<TraceHop>,
) -> Result<Vec<TraceHop>, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("请输入目标主机".into());
    }
    if host.starts_with('-') {
        return Err("主机名不能以 - 开头".into());
    }
    let dest = resolve_ipv4(&host).await?;
    // 回环地址：Windows IcmpSendEcho 对 127.0.0.0/8 与 ::1 不响应，直接返回本机一跳，避免误报超时
    if dest.is_loopback() {
        let hop = TraceHop { hop: 1, ip: dest.to_string(), ms: vec![1] };
        let _ = channel.send(hop.clone());
        return Ok(vec![hop]);
    }
    tokio::task::spawn_blocking(move || {
        run_traceroute_blocking(dest, |hop| {
            if channel.send(hop).is_err() {
                // 前端已关闭：停止发送
            }
        })
    })
    .await
    .map_err(|error| format!("链路追踪任务失败：{error}"))?
}


#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetSessionEvent {
    pub kind: String, // "data" | "closed" | "error"
    pub data: String, // UTF-8 文本表示
    pub hex: String,
    pub bytes: usize,
}

type SessionWriter = tokio::sync::mpsc::Sender<Vec<u8>>;

struct NetSession {
    tx: SessionWriter,
}

static SESSIONS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u64, NetSession>>> =
    std::sync::OnceLock::new();
static NEXT_SESSION_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn sessions() -> &'static std::sync::Mutex<std::collections::HashMap<u64, NetSession>> {
    SESSIONS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn emit_session(
    out: &tauri::ipc::Channel<NetSessionEvent>,
    kind: &str,
    data: &[u8],
) -> bool {
    let hex: String = data.iter().map(|b| format!("{:02x}", b)).collect();
    out.send(NetSessionEvent {
        kind: kind.to_string(),
        data: String::from_utf8_lossy(data).to_string(),
        hex,
        bytes: data.len(),
    })
    .is_ok()
}

/// 打开 TCP/UDP 交互式会话，通过 channel 推送实时事件
#[tauri::command]
pub async fn net_session_open(
    host: String,
    port: u16,
    protocol: String,
    timeout_ms: Option<u64>,
    out: tauri::ipc::Channel<NetSessionEvent>,
) -> Result<u64, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("主机地址不能为空".into());
    }
    if port == 0 {
        return Err("端口无效".into());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(4000).clamp(500, 15_000));
    let session_id = NEXT_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

    match protocol.as_str() {
        "tcp" => {
            let stream = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port)))
                .await
                .map_err(|_| format!("连接超时（{} ms）", timeout.as_millis()))?
                .map_err(|error| format!("TCP 连接失败：{error}"))?;
            let (mut rd, mut wr) = stream.into_split();
            tokio::spawn(async move {
                let mut buf = [0u8; 8192];
                loop {
                    tokio::select! {
                        n = rd.read(&mut buf) => {
                            match n {
                                Ok(0) => {
                                    let _ = emit_session(&out, "closed", b"");
                                    break;
                                }
                                Ok(n) => {
                                    if !emit_session(&out, "data", &buf[..n]) {
                                        break;
                                    }
                                }
                                Err(error) => {
                                    let _ = emit_session(&out, "error", format!("TCP 发送错误：{error}").as_bytes());
                                    break;
                                }
                            }
                        }
                        pkt = rx.recv() => {
                            match pkt {
                                Some(pkt) => {
                                    if let Err(error) = wr.write_all(&pkt).await {
                                        let _ = emit_session(&out, "error", format!("TCP 发送错误：{error}").as_bytes());
                                        break;
                                    }
                                }
                                None => break, // 发送通道关闭，退出
                            }
                        }
                    }
                }
            });
        }
        "udp" => {
            let socket = tokio::net::UdpSocket::bind("0.0.0.0:0")
                .await
                .map_err(|error| format!("UDP 套接字初始化失败：{error}"))?;
            socket
                .connect((host.as_str(), port))
                .await
                .map_err(|error| format!("UDP 连接失败：{error}"))?;
            let socket = std::sync::Arc::new(socket);
            let send_socket = socket.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 8192];
                loop {
                    tokio::select! {
                        n = socket.recv(&mut buf) => {
                            match n {
                                Ok(0) => break,
                                Ok(n) => {
                                    if !emit_session(&out, "data", &buf[..n]) {
                                        break;
                                    }
                                }
                                Err(error) => {
                                    let _ = emit_session(&out, "error", format!("UDP 读取错误：{error}").as_bytes());
                                    break;
                                }
                            }
                        }
                        pkt = rx.recv() => {
                            match pkt {
                                Some(pkt) => {
                                    if let Err(error) = send_socket.send(&pkt).await {
                                        let _ = emit_session(&out, "error", format!("UDP 读取错误：{error}").as_bytes());
                                        break;
                                    }
                                }
                                None => break, // 发送通道关闭，退出
                            }
                        }
                    }
                }
            });
        }
        _ => return Err("不支持的协议，仅支持 tcp / udp".into()),
    }

    sessions().lock().unwrap().insert(session_id, NetSession { tx });
    Ok(session_id)
}

/// 向指定会话发送数据
#[tauri::command]
pub async fn net_session_send(session_id: u64, data: String) -> Result<usize, String> {
    let tx = sessions()
        .lock()
        .unwrap()
        .get(&session_id)
        .map(|session| session.tx.clone())
        .ok_or("会话不存在或已关闭")?;
    let bytes = data.into_bytes();
    let len = bytes.len();
    tx.send(bytes).await.map_err(|_| "发送失败：会话已关闭".to_string())?;
    Ok(len)
}

/// 关闭指定会话，释放连接
#[tauri::command]
pub async fn net_session_close(session_id: u64) -> Result<(), String> {
    let removed = sessions().lock().unwrap().remove(&session_id);
    if let Some(session) = removed {
        drop(session.tx); // 触发读取循环退出，释放连接
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{net_local_info, net_tcp_send, parse_hex_payload};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn local_info_collects_hostname_and_ips() {
        let info = net_local_info().await.expect("net_local_info ????");
        assert!(!info.hostname.is_empty(), "???????");
        assert!(!info.ips.is_empty(), "?????? IP");
        assert!(info.ips.iter().any(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok()), "IP ????? IPv4");
    }

    #[tokio::test]
    async fn tcp_send_roundtrip_local() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("???????");
        let addr = listener.local_addr().expect("??????");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept ??");
            let mut buf = [0u8; 1024];
            let n = stream.read(&mut buf).await.expect("read ??");
            let received = String::from_utf8_lossy(&buf[..n]).to_string();
            stream.write_all(b"PONG:").await.expect("write ??");
            stream.write_all(&buf[..n]).await.expect("write ??");
            stream.flush().await.ok();
            received
        });
        let result = net_tcp_send("127.0.0.1".into(), addr.port(), "tcp".into(), Some("HELLO".into()), Some(false), Some(3000))
            .await
            .expect("net_tcp_send ??");
        assert!(result.ok, "TCP ?????");
        assert_eq!(result.response, "PONG:HELLO", "??????");
        assert_eq!(result.response_hex, "504f4e473a48454c4c4f", "HEX ????");
        let echoed = server.await.expect("server ????");
        assert_eq!(echoed, "HELLO", "??????????");
    }

    #[tokio::test]
    async fn udp_send_roundtrip_local() {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.expect("?? UDP ??");
        let addr = socket.local_addr().expect("??????");
        let server = tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let (n, peer) = socket.recv_from(&mut buf).await.expect("recv ??");
            let received = String::from_utf8_lossy(&buf[..n]).to_string();
            socket.send_to(b"UDP-ACK", peer).await.expect("send_to ??");
            received
        });
        let result = net_tcp_send("127.0.0.1".into(), addr.port(), "udp".into(), Some("PING".into()), Some(false), Some(3000))
            .await
            .expect("net_tcp_send(udp) ??");
        assert!(result.ok, "UDP ?????");
        assert_eq!(result.response, "UDP-ACK", "UDP ????");
        let echoed = server.await.expect("server ????");
        assert_eq!(echoed, "PING", "UDP ???????");
    }

    #[test]
    fn hex_payload_parses_and_rejects() {
        let parsed = parse_hex_payload("48 65 6C 6C 6F").expect("HEX ????");
        assert_eq!(parsed, b"Hello");
        assert!(parse_hex_payload("4").is_err(), "??????");
        assert!(parse_hex_payload("").is_err(), "????");
    }
}
