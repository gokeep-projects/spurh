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

const CONNECT_TIMEOUT_SECS: u64 = 12;

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

struct SshHandler;

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        async { Ok(true) }
    }
}

enum SshCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
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
    state: tauri::State<'_, SshSessions>,
    session_id: String,
    profile: SshProfile,
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
        return Err("请输入用户名".into());
    }

    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });
    let mut handle = tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECS),
        client::connect(config, (host.as_str(), profile.port), SshHandler),
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
