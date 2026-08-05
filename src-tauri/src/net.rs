// 网络小工具：端口探测 / DNS 查询 / IP 归属地
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortResult {
    pub port: u16,
    pub open: bool,
    pub elapsed_ms: u64,
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

    let mut tasks = tokio::task::JoinSet::new();
    for port in targets {
        let host = host.clone();
        tasks.spawn(async move {
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

    let url = format!(
        "http://ip-api.com/json/{ip}?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,isp,org,as,lat,lon,timezone,query"
    );
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("创建查询客户端失败：{error}"))?
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("IP 归属地查询失败（请检查网络）：{error}"))?;
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("返回数据解析失败：{error}"))?;
    let info: GeoInfo = serde_json::from_value(value).map_err(|error| format!("返回数据格式异常：{error}"))?;
    if info.status == "fail" {
        return Err(info.message.clone().unwrap_or_else(|| "查询失败，请确认输入的是合法 IP 或域名".into()));
    }
    Ok(info)
}
