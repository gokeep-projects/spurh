// 网络小工具：端口探测 / DNS 查询 / TCP/UDP 发送 / 路由追踪
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

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
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceHop {
    pub hop: u32,
    pub ip: String,
    pub ms: Vec<u32>,
}

/// TCP/UDP 数据发送与响应接收（UDP 无响应属正常，等待超时返回空响应）
#[tauri::command]
pub async fn net_tcp_send(
    host: String,
    port: u16,
    protocol: String,
    data: Option<String>,
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
    let payload = data.unwrap_or_default();
    let bytes = payload.as_bytes();

    match protocol.as_str() {
        "tcp" => {
            let mut stream = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port)))
                .await
                .map_err(|_| format!("连接超时（{} ms）", timeout.as_millis()))?
                .map_err(|error| format!("连接失败：{error}"))?;
            if !bytes.is_empty() {
                stream
                    .write_all(bytes)
                    .await
                    .map_err(|error| format!("发送失败：{error}"))?;
            }
            // 读取响应（最多 64KB，空闲 800ms 或总超时即结束；总超时防止慢速服务器无限拖长）
            let deadline = tokio::time::Instant::now() + timeout;
            let mut buf: Vec<u8> = Vec::with_capacity(1024);
            let mut chunk = [0u8; 2048];
            loop {
                match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
                    Ok(Ok(0)) => break,
                    Ok(Ok(n)) => {
                        buf.extend_from_slice(&chunk[..n]);
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
                message: format!("TCP 发送完成，收到 {} 字节响应", buf.len()),
                response,
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
            if !bytes.is_empty() {
                socket
                    .send(bytes)
                    .await
                    .map_err(|error| format!("发送失败：{error}"))?;
            }
            let mut buf = [0u8; 2048];
            let received = tokio::time::timeout(timeout, socket.recv(&mut buf))
                .await
                .map(|result| {
                    result.map(|n| String::from_utf8_lossy(&buf[..n]).to_string())
                })
                .unwrap_or(Ok(String::new()))
                .map_err(|error| format!("接收失败：{error}"))?;
            Ok(TcpSendResult {
                ok: true,
                message: if received.is_empty() {
                    "UDP 数据已发送，未收到响应（目标可能无监听或已丢弃）".into()
                } else {
                    format!("UDP 发送完成，收到响应 {} 字节", received.len())
                },
                response: received,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        }
        _ => Err("协议仅支持 tcp / udp".into()),
    }
}

/// 路由追踪：调用系统 tracert（仅解析数字/IP 行，中文提示行自动忽略）
#[tauri::command]
pub async fn net_traceroute(host: String) -> Result<Vec<TraceHop>, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("请输入目标主机".into());
    }
    if host.starts_with('-') {
        return Err("主机名不能以 - 开头".into());
    }
    let output = tokio::process::Command::new("tracert")
        .args(["-d", "-h", "20", "-w", "500", &host])
        .output()
        .await
        .map_err(|error| format!("无法执行 tracert：{error}"))?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let mut hops: Vec<TraceHop> = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 2 {
            continue;
        }
        let Ok(hop) = fields[0].parse::<u32>() else { continue };
        let mut ms: Vec<u32> = Vec::new();
        let mut ip = String::new();
        let mut seen_time = false;
        for field in &fields[1..] {
            if *field == "*" {
                ms.push(0);
                seen_time = true;
            } else if let Some(value) = field.strip_suffix("ms") {
                if let Ok(v) = value.trim().parse::<u32>() {
                    ms.push(v);
                    seen_time = true;
                }
            } else if seen_time && ip.is_empty() && field.contains('.') {
                ip = field.to_string();
            }
        }
        if seen_time || !ip.is_empty() {
            hops.push(TraceHop { hop, ip, ms });
        }
    }
    if hops.is_empty() {
        return Err("tracert 未返回有效结果，请检查目标主机或网络".into());
    }
    Ok(hops)
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoInfo {
    pub query: String,
    pub status: String,
    pub message: Option<String>,
    pub country: Option<String>,
    pub country_code: Option<String>,
    pub region_name: Option<String>,
    pub city: Option<String>,
    pub isp: Option<String>,
    pub org: Option<String>,
    pub asn: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub timezone: Option<String>,
}

/// 构造 ip-api.com 查询 URL（免费版仅保证 HTTP，HTTPS 优先尝试后自动回退）
fn geo_api_url(ip: &str, scheme: &str) -> String {
    format!(
        "{scheme}://ip-api.com/json/{ip}?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,isp,org,as,lat,lon,timezone,query"
    )
}

#[tauri::command]
pub async fn net_ip_geo(target: String) -> Result<GeoInfo, String> {
    let target = target.trim().to_string();
    if target.is_empty() {
        return Err("请输入 IP 地址或域名".into());
    }
    let ip = if target.parse::<std::net::IpAddr>().is_ok() {
        target.clone()
    } else {
        let resolver = hickory_resolver::Resolver::builder_tokio()
            .map_err(|error| format!("DNS 解析器初始化失败：{error}"))?
            .build()
            .map_err(|error| format!("DNS 解析器初始化失败：{error}"))?;
        let lookup = resolver
            .lookup_ip(&target)
            .await
            .map_err(|error| format!("域名解析失败：{error}"))?;
        lookup
            .iter()
            .next()
            .map(|address| address.to_string())
            .ok_or_else(|| "域名没有解析结果".to_string())?
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("创建查询客户端失败：{error}"))?;
    let mut last_error: Option<String> = None;
    let mut info: Option<GeoInfo> = None;
    for scheme in ["https", "http"] {
        let response = match client.get(geo_api_url(&ip, scheme)).send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(format!("IP 归属地查询失败（{scheme}）：{error}"));
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = Some(format!("IP 归属地查询失败（{scheme}，HTTP {}）", response.status()));
            continue;
        }
        let value: Value = match response.json().await {
            Ok(value) => value,
            Err(error) => {
                last_error = Some(format!("返回数据解析失败（{scheme}）：{error}"));
                continue;
            }
        };
        match serde_json::from_value(value) {
            Ok(parsed) => {
                info = Some(parsed);
                break;
            }
            Err(error) => {
                last_error = Some(format!("返回数据格式异常（{scheme}）：{error}"));
            }
        }
    }
    let info = info.ok_or_else(|| last_error.unwrap_or_else(|| "IP 归属地查询失败".into()))?;
    if info.status == "fail" {
        return Err(info.message.clone().unwrap_or_else(|| "查询失败，请确认输入的是合法 IP 或域名".into()));
    }
    Ok(info)
}

// ?????????????? ?????????? / IPv4 / ????? ??????????????
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNetInfo {
    pub hostname: String,
    pub ips: Vec<String>,
    pub gateways: Vec<String>,
}

fn is_private_ish(ip: &str) -> bool {
    let Ok(addr) = ip.parse::<std::net::Ipv4Addr>() else { return true };
    addr.is_loopback() || addr.is_link_local() || addr.is_unspecified()
}

#[tauri::command]
pub async fn net_local_info() -> Result<LocalNetInfo, String> {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "??".to_string());
    let mut ips: Vec<String> = Vec::new();
    if let Ok(output) = tokio::process::Command::new("ipconfig").output().await {
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        for line in text.lines() {
            if !line.contains("IPv4") || !line.contains(':') {
                continue;
            }
            let value = line.split(':').next_back().unwrap_or("").trim();
            if value.is_empty() || is_private_ish(value) {
                continue;
            }
            if !ips.contains(&value.to_string()) {
                ips.push(value.to_string());
            }
        }
    }
    // ??????????????
    if ips.is_empty() {
        ips.push("127.0.0.1".to_string());
    }
    let mut gateways: Vec<String> = Vec::new();
    if let Ok(output) = tokio::process::Command::new("route")
        .args(["print", "-4"])
        .output()
        .await
    {
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        for line in text.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() >= 3 && fields[0] == "0.0.0.0" && fields[1] == "0.0.0.0" {
                if fields[2].parse::<std::net::Ipv4Addr>().is_ok() && !gateways.contains(&fields[2].to_string()) {
                    gateways.push(fields[2].to_string());
                }
            }
        }
    }
    Ok(LocalNetInfo { hostname, ips, gateways })
}

// ?????????????? ?????????????? ??????????????
#[tauri::command]
pub async fn net_traceroute_stream(
    host: String,
    channel: tauri::ipc::Channel<TraceHop>,
) -> Result<Vec<TraceHop>, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("???????".into());
    }
    if host.starts_with('-') {
        return Err("?????? - ??".into());
    }
    let mut child = tokio::process::Command::new("tracert")
        .args(["-d", "-h", "20", "-w", "500", &host])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("???? tracert?{error}"))?;
    let stdout = child.stdout.take().ok_or("???? tracert ??")?;
    let mut reader = tokio::io::BufReader::new(stdout).lines();
    let mut hops: Vec<TraceHop> = Vec::new();
    while let Ok(Some(line)) = reader.next_line().await {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 2 {
            continue;
        }
        let Ok(hop) = fields[0].parse::<u32>() else { continue };
        let mut ms: Vec<u32> = Vec::new();
        let mut ip = String::new();
        let mut seen_time = false;
        for field in &fields[1..] {
            if *field == "*" {
                ms.push(0);
                seen_time = true;
            } else if let Some(value) = field.strip_suffix("ms") {
                if let Ok(v) = value.trim().parse::<u32>() {
                    ms.push(v);
                    seen_time = true;
                }
            } else if seen_time && ip.is_empty() && field.contains('.') {
                ip = field.to_string();
            }
        }
        if seen_time || !ip.is_empty() {
            let item = TraceHop { hop, ip, ms };
            if channel.send(item.clone()).is_err() {
                break; // ?????
            }
            hops.push(item);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    if hops.is_empty() {
        return Err("tracert ??????????????????".into());
    }
    Ok(hops)
}

// ?????????????? TCP / UDP ???? ??????????????
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetSessionEvent {
    pub kind: String, // "data" | "closed" | "error"
    pub data: String, // UTF-8 ?????????????
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

/// ?? TCP/UDP ?????????? channel ?????????????
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
        return Err("???????".into());
    }
    if port == 0 {
        return Err("????".into());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(4000).clamp(500, 15_000));
    let session_id = NEXT_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

    match protocol.as_str() {
        "tcp" => {
            let stream = tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port)))
                .await
                .map_err(|_| format!("?????{} ms?", timeout.as_millis()))?
                .map_err(|error| format!("?????{error}"))?;
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
                                    let _ = emit_session(&out, "error", format!("?????{error}").as_bytes());
                                    break;
                                }
                            }
                        }
                        pkt = rx.recv() => {
                            match pkt {
                                Some(pkt) => {
                                    if let Err(error) = wr.write_all(&pkt).await {
                                        let _ = emit_session(&out, "error", format!("?????{error}").as_bytes());
                                        break;
                                    }
                                }
                                None => break, // ?????
                            }
                        }
                    }
                }
            });
        }
        "udp" => {
            let socket = tokio::net::UdpSocket::bind("0.0.0.0:0")
                .await
                .map_err(|error| format!("?? UDP ??????{error}"))?;
            socket
                .connect((host.as_str(), port))
                .await
                .map_err(|error| format!("?????{error}"))?;
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
                                    let _ = emit_session(&out, "error", format!("?????{error}").as_bytes());
                                    break;
                                }
                            }
                        }
                        pkt = rx.recv() => {
                            match pkt {
                                Some(pkt) => {
                                    if let Err(error) = send_socket.send(&pkt).await {
                                        let _ = emit_session(&out, "error", format!("?????{error}").as_bytes());
                                        break;
                                    }
                                }
                                None => break, // ?????
                            }
                        }
                    }
                }
            });
        }
        _ => return Err("????? tcp / udp".into()),
    }

    sessions().lock().unwrap().insert(session_id, NetSession { tx });
    Ok(session_id)
}

/// ???????????
#[tauri::command]
pub async fn net_session_send(session_id: u64, data: String) -> Result<usize, String> {
    let tx = sessions()
        .lock()
        .unwrap()
        .get(&session_id)
        .map(|session| session.tx.clone())
        .ok_or("?????????")?;
    let bytes = data.into_bytes();
    let len = bytes.len();
    tx.send(bytes).await.map_err(|_| "?????".to_string())?;
    Ok(len)
}

/// ????
#[tauri::command]
pub async fn net_session_close(session_id: u64) -> Result<(), String> {
    let removed = sessions().lock().unwrap().remove(&session_id);
    if let Some(session) = removed {
        drop(session.tx); // ?????????????
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{geo_api_url, net_local_info};

    #[test]
    fn geo_url_keeps_scheme_ip_and_fields() {
        let url = geo_api_url("8.8.8.8", "https");
        assert!(url.starts_with("https://ip-api.com/json/8.8.8.8?"));
        assert!(url.contains("lang=zh-CN"));
        assert!(url.contains("fields=status"));
        assert!(url.contains("query"));
        let http = geo_api_url("1.1.1.1", "http");
        assert!(http.starts_with("http://ip-api.com/json/1.1.1.1?"));
    }

    #[tokio::test]
    async fn local_info_collects_hostname_and_ips() {
        let info = net_local_info().await.expect("net_local_info ???");
        assert!(!info.hostname.is_empty(), "???????");
        assert!(!info.ips.is_empty(), "?????? IP");
        assert!(info.ips.iter().any(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok()), "IP ???? IPv4");
    }

    #[test]
    fn geo_url_accepts_ipv6() {
        // IPv6 地址同样可用于路径（IpAddr::to_string 输出不含非法路径字符）
        let url = geo_api_url("2001:db8::1", "https");
        assert!(url.contains("/json/2001:db8::1?"));
    }
}
