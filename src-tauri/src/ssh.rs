// SSH 远程终端：连接、读写、尺寸调整（配合前端 xterm.js）
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use russh::{client, ChannelMsg};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;
use tauri::Manager;

const CONNECT_TIMEOUT_SECS: u64 = 12;

/// 序列化 known_hosts 文件的读改写，避免并发连接互相覆盖
static KNOWN_HOSTS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub cols: u32,
    pub rows: u32,
    pub auth_type: String, // "password" | "key"
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEvent {
    pub kind: String, // "ready" | "data" | "exit" | "error"
    pub data: Option<String>, // base64 编码的终端输出
    pub message: Option<String>,
}

async fn known_hosts_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    Ok(dir.join("known_hosts.json"))
}

/// 读取 known_hosts；文件损坏时返回 Err（调用方应拒绝连接，避免 TOFU 被旁路重置）
async fn load_known_hosts(path: &std::path::Path) -> Result<HashMap<String, String>, ()> {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        Err(_) => return Ok(HashMap::new()), // 文件不存在视为空
    };
    serde_json::from_str(&content).map_err(|_| ())
}

/// 原子写入：先写临时文件再 rename，避免中途崩溃留下损坏的 known_hosts
async fn save_known_hosts(path: &std::path::Path, map: &HashMap<String, String>) {
    let Ok(json) = serde_json::to_string(map) else { return };
    let Some(dir) = path.parent() else { return };
    let _ = tokio::fs::create_dir_all(dir).await;
    let tmp = dir.join(format!("known_hosts.{}.tmp", std::process::id()));
    if tokio::fs::write(&tmp, &json).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, path).await;
    }
}

struct SshHandler {
    /// "host:port" 形式的主机标识
    host_key: String,
    app: tauri::AppHandle,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        let host_key = self.host_key.clone();
        let app = self.app.clone();
        async move {
            let fingerprint = server_public_key
                .fingerprint(russh::keys::HashAlg::Sha256)
                .to_string();
            let path = match known_hosts_path(&app).await {
                Ok(path) => path,
                Err(_) => return Ok(false),
            };
            // TOFU：首次连接记录指纹；后续连接必须匹配，否则拒绝（防中间人）
            let _guard = KNOWN_HOSTS_LOCK.lock().await;
            let known = match load_known_hosts(&path).await {
                Ok(known) => known,
                Err(()) => return Ok(false), // known_hosts 损坏时拒绝连接，防止信任被静默重置
            };
            match known.get(&host_key) {
                Some(expected) => Ok(expected == &fingerprint),
                None => {
                    let mut next = known;
                    next.insert(host_key, fingerprint);
                    save_known_hosts(&path, &next).await;
                    Ok(true)
                }
            }
        }
    }
}

enum SshCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Exec {
        command: String,
        stdin: Option<Vec<u8>>,
        reply: tokio::sync::oneshot::Sender<Result<String, String>>,
    },
    Close,
}

/// 在现有会话上执行一条命令并收集输出（上传文件 = 命令 + stdin 内容）
async fn exec_on(handle: &client::Handle<SshHandler>, command: &str, stdin: Option<Vec<u8>>) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("打开命令通道失败：{error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("执行命令失败：{error}"))?;
    if let Some(bytes) = stdin {
        channel
            .data_bytes(bytes)
            .await
            .map_err(|_| "写入输入失败".to_string())?;
    }
    let _ = channel.eof().await;
    // 总时长 15s / 总字节 8MB 硬上限：防止 tail -f 等长输出命令无限阻塞会话
    let started = std::time::Instant::now();
    let mut output: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        if started.elapsed() > Duration::from_secs(15) {
            truncated = true;
            break;
        }
        if output.len() + stderr.len() > 8 * 1024 * 1024 {
            truncated = true;
            break;
        }
        match tokio::time::timeout(Duration::from_secs(10), channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => output.extend_from_slice(data.as_ref()),
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => stderr.extend_from_slice(data.as_ref()),
            Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) => break,
            Ok(Some(_)) => {}
            Err(_) => {
                truncated = true;
                break;
            }
        }
    }
    let _ = channel.close().await;
    // base64 传输：stdout 主体 + 可选 __STDERR__ / __TRUNCATED__ 标记（TRUNCATED 必须最后，前端 endsWith 判定）
    let mut encoded = BASE64.encode(&output);
    if !stderr.is_empty() {
        encoded.push_str(&format!("__STDERR__{}", BASE64.encode(&stderr)));
    }
    if truncated {
        encoded.push_str("__TRUNCATED__");
    }
    Ok(encoded)
}

pub(crate) struct SshSession {
    tx: tokio::sync::mpsc::UnboundedSender<SshCommand>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct SshSessions {
    pub map: Mutex<HashMap<String, SshSession>>,
}

fn emit(out: &Channel<SshEvent>, kind: &str, data: Option<String>, message: Option<String>) -> bool {
    out.send(SshEvent { kind: kind.into(), data, message }).is_ok()
}

#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshSessions>,
    session_id: String,
    mut profile: SshProfile,
    out: Channel<SshEvent>,
) -> Result<(), String> {
    // 同一 session 重复连接时先断开旧的
    if let Some(previous) = state.map.lock().unwrap().remove(&session_id) {
        let _ = previous.tx.send(SshCommand::Close);
        previous.task.abort();
    }

    let host = profile.host.trim().to_string();
    if host.is_empty() {
        return Err("请输入主机地址".into());
    }
    if profile.user.trim().is_empty() {
        // 未填写用户名时使用默认 root
        profile.user = "root".into();
    }

    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });
    let mut handle = tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECS),
        client::connect(
            config,
            (host.as_str(), profile.port),
            SshHandler {
                host_key: format!("{host}:{}", profile.port),
                app,
            },
        ),
    )
    .await
    .map_err(|_| format!("连接超时（{CONNECT_TIMEOUT_SECS} 秒），请检查主机地址和端口"))?
    .map_err(|error| format!("SSH 连接失败：{error}"))?;

    let auth_result = match profile.auth_type.as_str() {
        "key" => {
            let key_path = profile
                .key_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .ok_or("请指定私钥文件路径")?;
            let pem = tokio::fs::read_to_string(key_path)
                .await
                .map_err(|error| format!("读取私钥失败：{error}"))?;
            let key = russh::keys::decode_secret_key(&pem, profile.passphrase.as_deref())
                .map_err(|error| format!("私钥解析失败：{error}"))?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("协商签名算法失败：{error}"))?
                .flatten();
            handle
                .authenticate_publickey(
                    &profile.user,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
        }
        _ => {
            let password = profile
                .password
                .clone()
                .filter(|value| !value.is_empty())
                .ok_or("请输入密码")?;
            handle.authenticate_password(&profile.user, password).await
        }
    }
    .map_err(|error| format!("SSH 认证失败：{error}"))?;

    if !auth_result.success() {
        return Err("认证失败：用户名、密码或密钥不正确".into());
    }

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("打开会话失败：{error}"))?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            profile.cols.max(2),
            profile.rows.max(2),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("请求终端失败：{error}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|error| format!("启动 shell 失败：{error}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SshCommand>();
    let out_task = out.clone();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                message = channel.wait() => {
                    match message {
                        Some(ChannelMsg::Data { data }) => {
                            if !emit(&out_task, "data", Some(BASE64.encode(data.as_ref())), None) { break; }
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if !emit(&out_task, "data", Some(BASE64.encode(data.as_ref())), None) { break; }
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            let _ = emit(&out_task, "exit", None, Some("连接已关闭".into()));
                            break;
                        }
                        Some(_) => {}
                    }
                }
                command = rx.recv() => {
                    match command {
                        Some(SshCommand::Data(bytes)) => {
                            if channel.data_bytes(bytes).await.is_err() { break; }
                        }
                        Some(SshCommand::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols.max(2), rows.max(2), 0, 0).await;
                        }
                        Some(SshCommand::Exec { command, stdin, reply }) => {
                            let result = exec_on(&handle, &command, stdin).await;
                            let _ = reply.send(result);
                        }
                        Some(SshCommand::Close) | None => {
                            let _ = channel.eof().await;
                            let _ = channel.close().await;
                            let _ = emit(&out_task, "exit", None, Some("会话已断开".into()));
                            break;
                        }
                    }
                }
            }
        }
        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "English").await;
    });

    state
        .map
        .lock()
        .unwrap()
        .insert(session_id, SshSession { tx, task });
    let _ = emit(&out, "ready", None, None);
    Ok(())
}

#[tauri::command]
pub async fn ssh_exec(
    state: tauri::State<'_, SshSessions>,
    session_id: String,
    command: String,
    stdin: Option<String>,
) -> Result<String, String> {
    let (reply, receiver) = tokio::sync::oneshot::channel();
    {
        let sessions = state.map.lock().unwrap();
        let session = sessions
            .get(&session_id)
            .ok_or("会话不存在或已断开")?;
        session
            .tx
            .send(SshCommand::Exec {
                command,
                stdin: stdin.map(|content| content.into_bytes()),
                reply,
            })
            .map_err(|_| "会话已关闭")?;
    }
    receiver.await.map_err(|_| "会话已关闭")?
}

#[tauri::command]
pub fn ssh_write(state: tauri::State<'_, SshSessions>, session_id: String, data: String) -> Result<(), String> {
    let bytes = BASE64
        .decode(data)
        .map_err(|error| format!("输入数据编码无效：{error}"))?;
    let sessions = state.map.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or("会话不存在或已断开，请重新连接")?;
    session
        .tx
        .send(SshCommand::Data(bytes))
        .map_err(|_| "会话已断开，请重新连接".to_string())
}

#[tauri::command]
pub fn ssh_resize(state: tauri::State<'_, SshSessions>, session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    let sessions = state.map.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or("会话不存在或已断开，请重新连接")?;
    let _ = session.tx.send(SshCommand::Resize { cols, rows });
    Ok(())
}

#[tauri::command]
pub fn ssh_close(state: tauri::State<'_, SshSessions>, session_id: String) {
    if let Some(session) = state.map.lock().unwrap().remove(&session_id) {
        let _ = session.tx.send(SshCommand::Close);
    }
}

/// 应用退出前清理所有 SSH 会话。
pub fn close_all(state: &SshSessions) {
    let sessions: Vec<_> = state.map.lock().unwrap().drain().map(|(_, session)| session).collect();
    for session in sessions {
        let _ = session.tx.send(SshCommand::Close);
        session.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::{load_known_hosts, save_known_hosts};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_path(name: &str) -> std::path::PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("spurh-known-hosts-{name}-{}-{id}.json", std::process::id()))
    }

    #[tokio::test]
    async fn load_missing_file_returns_empty() {
        let path = temp_path("missing");
        let map = load_known_hosts(&path).await.expect("缺失文件应视为空表");
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn load_corrupt_file_returns_err() {
        let path = temp_path("corrupt");
        tokio::fs::write(&path, "{not-json").await.unwrap();
        assert!(load_known_hosts(&path).await.is_err());
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn save_then_load_roundtrips() {
        let path = temp_path("roundtrip");
        let mut map = HashMap::new();
        map.insert("example.com:22".into(), "sha256:AbCdEf123456".into());
        map.insert("127.0.0.1:2222".into(), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...".into());
        save_known_hosts(&path, &map).await;
        let loaded = load_known_hosts(&path).await.expect("写入后应能读回");
        assert_eq!(loaded, map);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn load_ignores_tmp_leftovers() {
        // 临时文件残留不应影响正常读取
        let path = temp_path("leftover");
        let tmp = path.with_extension("tmp");
        tokio::fs::write(&tmp, "leftover").await.unwrap();
        tokio::fs::write(&path, "{}").await.unwrap();
        let map = load_known_hosts(&path).await.expect("正常文件应可读");
        assert!(map.is_empty());
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(&tmp).await;
    }
}
