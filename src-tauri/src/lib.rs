use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

mod clipboard;
mod secrets;
mod net;
mod sql;
mod ssh;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiRequest {
    endpoint: String,
    api_key: String,
    model: String,
    input: Option<String>,
    instruction: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiModel {
    id: String,
    owned_by: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStreamEvent {
    request_id: String,
    kind: String,
    delta: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyEvent {
    kind: String,
    index: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenTarget {
    path: String,
    is_dir: bool,
}

struct TrayState(AtomicBool);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyStatus {
    key: String,
    ok: bool,
    error: Option<String>,
}

/// Tracks hotkeys registered from the frontend settings so they can be replaced.
#[derive(Default)]
struct HotkeyRegistry {
    dispatch: Mutex<Option<String>>,
    tools: Mutex<Vec<String>>,
}

/// Path passed in via the Explorer context menu before the webview is ready.
struct PendingOpen(Mutex<Option<(String, bool)>>);

#[cfg(target_os = "windows")]
fn reg_command() -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new("reg");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn reg_command() -> Command {
    Command::new("reg")
}

fn endpoint_url(endpoint: &str, path: &str) -> Result<String, String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    // 解析 scheme 与 host，仅允许 https；http 仅限本机 localhost/127.0.0.1/::1
    let (scheme, rest) = endpoint
        .split_once("://")
        .ok_or("接口地址格式不正确，需要包含 http:// 或 https://")?;
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let host = match host_port.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host_port,
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let localhost_http = scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1");
    if scheme != "https" && !localhost_http {
        return Err("接口地址必须使用 HTTPS；本地 localhost 服务可使用 HTTP".into());
    }
    Ok(format!("{endpoint}/{path}"))
}

fn client(timeout_seconds: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_seconds))
        .build()
        .map_err(|error| format!("无法创建 AI 客户端：{error}"))
}

fn authorized(call: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        call
    } else {
        call.bearer_auth(api_key.trim())
    }
}

/// 前端运行时错误转发到 stderr（tauri dev 终端可见），用于诊断「无输出」类问题
#[tauri::command]
fn app_log_error(message: String) {
    eprintln!("[frontend-error] {message}");
}

#[tauri::command]
async fn ai_list_models(request: AiRequest) -> Result<Vec<AiModel>, String> {
    let url = endpoint_url(&request.endpoint, "models")?;
    let response = authorized(client(20)?.get(url), &request.api_key)
        .send()
        .await
        .map_err(|error| format!("拉取模型失败：{error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取模型列表失败：{error}"))?;
    if !status.is_success() {
        return Err(format!(
            "模型服务返回 HTTP {status}：{}",
            text.chars().take(240).collect::<String>()
        ));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| "服务没有返回 OpenAI 兼容的模型列表".to_string())?;
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .ok_or_else(|| "模型列表中缺少 data 或 models 数组".to_string())?;
    let mut output = models
        .iter()
        .filter_map(|model| {
            let id = model
                .get("id")
                .or_else(|| model.get("name"))?
                .as_str()?
                .to_string();
            Some(AiModel {
                id,
                owned_by: model
                    .get("owned_by")
                    .or_else(|| model.get("ownedBy"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect::<Vec<_>>();
    output.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(output)
}

fn emit_stream(app: &tauri::AppHandle, request_id: &str, kind: &str, delta: &str) {
    let _ = app.emit(
        "ai-stream",
        AiStreamEvent {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            delta: delta.to_string(),
        },
    );
}

fn process_sse_line(
    app: &tauri::AppHandle,
    request_id: &str,
    line: &str,
    final_content: &mut String,
) -> Result<bool, String> {
    let Some(data) = line.trim().strip_prefix("data:") else {
        return Ok(false);
    };
    let data = data.trim();
    if data == "[DONE]" {
        return Ok(true);
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return Ok(false);
    };
    // 服务端错误事件（如 401/余额不足）：透出真实错误，避免前端误报“空结果”
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(message.to_string());
    }
    let Some(delta) = value.pointer("/choices/0/delta") else {
        return Ok(false);
    };
    if let Some(reasoning) = delta
        .get("reasoning_content")
        .or_else(|| delta.get("reasoning"))
        .and_then(Value::as_str)
    {
        emit_stream(app, request_id, "reasoning", reasoning);
    }
    if let Some(content) = delta.get("content").and_then(Value::as_str) {
        final_content.push_str(content);
        emit_stream(app, request_id, "content", content);
    }
    Ok(false)
}

#[tauri::command]
async fn ai_analyze_stream(
    app: tauri::AppHandle,
    request: AiRequest,
    request_id: String,
) -> Result<String, String> {
    let input = request.input.as_deref().unwrap_or_default();
    if input.trim().is_empty() {
        return Err("没有可供 AI 处理的内容".into());
    }
    let url = endpoint_url(&request.endpoint, "chat/completions")?;
    let body = json!({
        "model": request.model,
        "stream": true,
        "messages": [
            {
                "role": "system",
                "content": request.instruction.as_deref().unwrap_or("Return a clean final result.")
            },
            { "role": "user", "content": input }
        ]
    });
    let mut response = authorized(client(120)?.post(url).json(&body), &request.api_key)
        .send()
        .await
        .map_err(|error| format!("AI 请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "AI 服务返回 HTTP {status}：{}",
            text.chars().take(300).collect::<String>()
        ));
    }

    let mut buffer = String::new();
    let mut final_content = String::new();
    let mut done = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取 AI 流失败：{error}"))?
    {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(position) = buffer.find('\n') {
            let line = buffer[..position].trim_end_matches('\r').to_string();
            buffer.drain(..=position);
            match process_sse_line(&app, &request_id, &line, &mut final_content) {
                Ok(true) => {
                    done = true;
                    break;
                }
                Ok(false) => {}
                Err(message) => return Err(format!("AI 服务返回错误：{message}")),
            }
        }
        if done {
            break;
        }
    }
    if !buffer.trim().is_empty() {
        if let Err(message) = process_sse_line(&app, &request_id, &buffer, &mut final_content) {
            return Err(format!("AI 服务返回错误：{message}"));
        }
    }
    emit_stream(&app, &request_id, "done", "");
    if final_content.trim().is_empty() {
        Err("AI 服务返回了空结果，或该接口不支持流式 Chat Completions".into())
    } else {
        Ok(final_content)
    }
}

#[cfg(target_os = "windows")]
fn autostart_registry(enabled: bool) -> Result<bool, String> {
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    if enabled {
        let executable = std::env::current_exe().map_err(|error| format!("无法获取程序路径：{error}"))?;
        let value = format!("\"{}\"", executable.display());
        let status = reg_command()
            .args(["add", KEY, "/v", "Spurh", "/t", "REG_SZ", "/d", &value, "/f"])
            .status()
            .map_err(|error| format!("无法写入开机启动配置：{error}"))?;
        if !status.success() {
            return Err("写入开机启动配置失败".into());
        }
        Ok(true)
    } else {
        let _ = reg_command()
            .args(["delete", KEY, "/v", "Spurh", "/f"])
            .status();
        Ok(false)
    }
}

#[cfg(not(target_os = "windows"))]
fn autostart_registry(_enabled: bool) -> Result<bool, String> {
    Err("当前版本仅在 Windows 上支持开机启动".into())
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    autostart_registry(enabled)
}

#[tauri::command]
fn get_autostart() -> bool {
    #[cfg(target_os = "windows")]
    {
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        reg_command()
            .args(["query", KEY, "/v", "Spurh"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    false
}

#[cfg(target_os = "windows")]
fn register_context_menu(app_path: &str) -> Result<(), String> {
    let escaped = app_path.replace('\\', "\\\\");
    let file_command = format!("\"{}\" \"--open\" \"%1\"", escaped);
    let dir_command = format!("\"{}\" \"--open-dir\" \"%1\"", escaped);

    for (key, command) in [
        (r"HKCU\Software\Classes\*\shell\Spurh", file_command),
        (r"HKCU\Software\Classes\Directory\shell\Spurh", dir_command),
    ] {
        reg_command()
            .args(["add", key, "/ve", "/t", "REG_SZ", "/d", "用 Spurh 打开", "/f"])
            .status()
            .map_err(|e| format!("注册右键菜单失败：{e}"))?;
        reg_command()
            .args(["add", key, "/v", "Icon", "/t", "REG_SZ", "/d", app_path, "/f"])
            .status()
            .map_err(|e| format!("注册右键图标失败：{e}"))?;
        reg_command()
            .args(["add", &format!("{key}\\command"), "/ve", "/t", "REG_SZ", "/d", &command, "/f"])
            .status()
            .map_err(|e| format!("注册右键命令失败：{e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_context_menu() -> Result<(), String> {
    for key in [
        r"HKCU\Software\Classes\*\shell\Spurh",
        r"HKCU\Software\Classes\Directory\shell\Spurh",
    ] {
        reg_command()
            .args(["delete", key, "/f"])
            .status()
            .map_err(|e| format!("移除右键菜单失败：{e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn set_context_menu_enabled(enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| format!("无法获取程序路径：{e}"))?;
        let app_path = exe.to_string_lossy().to_string();
        if enabled {
            register_context_menu(&app_path)?;
        } else {
            unregister_context_menu()?;
        }
        Ok(enabled)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("右键菜单仅支持 Windows".into())
    }
}

#[tauri::command]
fn get_context_menu_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        reg_command()
            .args(["query", r"HKCU\Software\Classes\*\shell\Spurh", "/ve"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    false
}

/// 通过右键菜单打开文件时的最大体积（50MB），防止超大文件读满内存
const MAX_OPEN_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// 读取文本文件：优先 UTF-8，失败时回退 GBK（中文 Windows 常见编码）；
/// 若两种解码都出现大量替换字符则视为二进制文件
fn read_text_flexible(bytes: &[u8]) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_string()),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
            let replacement_count = decoded.chars().filter(|&ch| ch == '\u{FFFD}').count();
            if replacement_count > usize::max(4, bytes.len() / 100) {
                return Err("文件不是文本文件（无法识别的编码或二进制内容）".into());
            }
            Ok(decoded.into_owned())
        }
    }
}

#[tauri::command]
async fn open_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("无法读取文件 {}：{e}", path))?;
    if bytes.len() as u64 > MAX_OPEN_FILE_BYTES {
        return Err(format!("文件过大（{} MB），超过 50MB 上限，请手动打开", bytes.len() / (1024 * 1024)));
    }
    let content = read_text_flexible(&bytes)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.unminimize();
    }
    Ok(content)
}

/// Consumes the file/folder passed in through the Explorer context menu.
#[tauri::command]
fn take_pending_open(state: tauri::State<PendingOpen>) -> Option<OpenTarget> {
    state.0.lock().unwrap().take().map(|(path, is_dir)| OpenTarget { path, is_dir })
}


#[tauri::command]
fn set_tray_enabled(app: tauri::AppHandle, state: tauri::State<TrayState>, enabled: bool) -> Result<bool, String> {
    if enabled && app.tray_by_id("main").is_none() {
        #[cfg(desktop)]
        {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
            let show_item = MenuItem::with_id(&app, "show", "显示 Spurh", true, None::<&str>)
                .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
            let quit_item = MenuItem::with_id(&app, "quit", "退出", true, None::<&str>)
                .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
            let menu = Menu::with_items(&app, &[&show_item, &quit_item])
                .map_err(|error| format!("无法创建托盘菜单：{error}"))?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().ok_or_else(|| "应用图标不可用".to_string())?.clone())
                .tooltip("Spurh 开发者工具箱")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(&app)
                .map_err(|error| format!("无法创建系统托盘：{error}"))?;
        }
    }
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(enabled)
            .map_err(|error| format!("无法更新托盘状态：{error}"))?;
    }
    state.0.store(enabled, Ordering::Relaxed);
    Ok(enabled)
}

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.unminimize();
    }
}

#[cfg(desktop)]
fn emit_hotkey(app: &tauri::AppHandle, kind: &str, index: Option<usize>) {
    let _ = app.emit("spurh:hotkey", HotkeyEvent { kind: kind.to_string(), index });
}

/// Applies global hotkeys from settings. Tool hotkeys are registered at OS level
/// and delivered to the frontend as `spurh:hotkey` events.
#[tauri::command]
async fn apply_hotkeys(
    app: tauri::AppHandle,
    state: tauri::State<'_, HotkeyRegistry>,
    dispatch: Option<String>,
    tools: Vec<String>,
) -> Result<Vec<HotkeyStatus>, String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

    let global = app.global_shortcut();
    let mut results: Vec<HotkeyStatus> = Vec::new();

    // 统一注册回调：非捕获闭包可重复使用；注册失败时恢复旧快捷键，避免静默丢失
    let dispatch_handler = move |app: &tauri::AppHandle, _s: &Shortcut, event: ShortcutEvent| {
        if event.state == ShortcutState::Pressed {
            show_main_window(app);
            emit_hotkey(app, "dispatch", None);
        }
    };
    let tool_handler = |index: usize| {
        move |app: &tauri::AppHandle, _s: &Shortcut, event: ShortcutEvent| {
            if event.state == ShortcutState::Pressed {
                emit_hotkey(app, "tool", Some(index));
            }
        }
    };

    {
        let mut prev = state.dispatch.lock().unwrap();
        let old_shortcut: Option<Shortcut> = prev.take().and_then(|old| old.parse().ok());
        if let Some(old) = old_shortcut {
            let _ = global.unregister(old);
        }
        if let Some(raw) = dispatch {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() || trimmed == "off" {
                // 禁用：旧键已注销
            } else if trimmed == "ctrl+shift+space" {
                // 内置 toggle 由 setup 管理，不写入 registry
                results.push(HotkeyStatus { key: trimmed.clone(), ok: true, error: None });
            } else {
                match trimmed.parse::<Shortcut>() {
                    Err(e) => {
                        if let Some(old) = old_shortcut {
                            if global.on_shortcut(old, dispatch_handler).is_ok() {
                                *prev = Some(old.to_string());
                            }
                        }
                        results.push(HotkeyStatus { key: trimmed.clone(), ok: false, error: Some(format!("无法解析：{e}")) });
                    }
                    Ok(shortcut) => {
                        if shortcut.mods.is_empty() {
                            if let Some(old) = old_shortcut {
                                if global.on_shortcut(old, dispatch_handler).is_ok() {
                                    *prev = Some(old.to_string());
                                }
                            }
                            results.push(HotkeyStatus { key: trimmed.clone(), ok: false, error: Some("缺少修饰键（Ctrl/Alt/Shift/Win）".into()) });
                        } else {
                            // 可能被其它已注册键占用（如工具键）：先注销再注册
                            if global.is_registered(shortcut) {
                                let _ = global.unregister(shortcut);
                            }
                            match global.on_shortcut(shortcut, dispatch_handler) {
                                Ok(_) => {
                                    results.push(HotkeyStatus { key: trimmed.clone(), ok: true, error: None });
                                    *prev = Some(trimmed.clone());
                                    // 与工具键重叠时从 tools registry 剔除，避免后续全量注销误删刚注册的 dispatch 键
                                    state.tools.lock().unwrap().retain(|t| t != &trimmed);
                                }
                                Err(e) => {
                                    // 注册失败：恢复旧快捷键（若与新键不同）
                                    let changed = old_shortcut.as_ref().map(|old| old != &shortcut).unwrap_or(true);
                                    if changed {
                                        if let Some(old) = old_shortcut {
                                            if global.on_shortcut(old, dispatch_handler).is_ok() {
                                                *prev = Some(old.to_string());
                                            }
                                        }
                                    }
                                    results.push(HotkeyStatus { key: trimmed.clone(), ok: false, error: Some(format!("注册失败：{e}")) });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    {
        let mut prev = state.tools.lock().unwrap();
        let old_list: Vec<String> = prev.clone();
        for old in old_list.iter() {
            if let Ok(shortcut) = old.parse::<Shortcut>() {
                let _ = global.unregister(shortcut);
            }
        }
        prev.clear();
        for (index, raw) in tools.iter().enumerate() {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() || trimmed == "off" {
                continue;
            }
            let old_raw = old_list.get(index).cloned().unwrap_or_default();
            let old_shortcut: Option<Shortcut> = old_raw.parse().ok();
            let shortcut = match trimmed.parse::<Shortcut>() {
                Ok(s) => s,
                Err(e) => {
                    // 新键解析失败：恢复该工具的旧键
                    if let Some(old) = old_shortcut {
                        if global.on_shortcut(old, tool_handler(index)).is_ok() {
                            prev.push(old_raw);
                        }
                    }
                    results.push(HotkeyStatus { key: format!("工具{} {trimmed}", index + 1), ok: false, error: Some(format!("无法解析：{e}")) });
                    continue;
                }
            };
            if shortcut.mods.is_empty() {
                if let Some(old) = old_shortcut {
                    if global.on_shortcut(old, tool_handler(index)).is_ok() {
                        prev.push(old_raw);
                    }
                }
                results.push(HotkeyStatus { key: format!("工具{} {trimmed}", index + 1), ok: false, error: Some("缺少修饰键（Ctrl/Alt/Shift/Win）".into()) });
                continue;
            }
            if global.is_registered(shortcut) {
                results.push(HotkeyStatus {
                    key: format!("工具{} {trimmed}", index + 1),
                    ok: false,
                    error: Some("与其它已注册的快捷键重复（应用内）".into()),
                });
                continue; // reserved by the built-in window toggle or dispatch hotkey
            }
            match global.on_shortcut(shortcut, tool_handler(index)) {
                Ok(_) => {
                    results.push(HotkeyStatus { key: format!("工具{} {trimmed}", index + 1), ok: true, error: None });
                    prev.push(trimmed);
                }
                Err(e) => {
                    // 注册失败：恢复该工具的旧键（若与新键不同）
                    let changed = old_shortcut.as_ref().map(|old| old != &shortcut).unwrap_or(true);
                    if changed {
                        if let Some(old) = old_shortcut {
                            if global.on_shortcut(old, tool_handler(index)).is_ok() {
                                prev.push(old_raw);
                            }
                        }
                    }
                    results.push(HotkeyStatus { key: format!("工具{} {trimmed}", index + 1), ok: false, error: Some(format!("注册失败：{e}")) });
                }
            }
        }
    }
    Ok(results)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(cli_args: Vec<String>) {
    let mut open_file_path: Option<String> = None;
    let mut open_dir_path: Option<String> = None;
    let mut args = cli_args.iter();
    while let Some(arg) = args.next() {
        if arg == "--open" {
            open_file_path = args.next().cloned();
        } else if arg == "--open-dir" {
            open_dir_path = args.next().cloned();
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(TrayState(AtomicBool::new(false)))
        .manage(HotkeyRegistry::default())
        .manage(PendingOpen(Mutex::new(None)))
        .manage(Arc::new(clipboard::ClipboardHistory::default()))
        .manage(ssh::SshSessions::default())
        .setup(move |app| {
            use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

            // 剪贴板历史：独立线程轮询，文本变化时记录并推送事件（开关默认开启，前端设置同步）
            let history = app.state::<Arc<clipboard::ClipboardHistory>>().inner().clone();
            let watch = Arc::new(clipboard::ClipboardWatch(AtomicBool::new(true)));            app.manage(watch.clone());            clipboard::start_watcher(app.handle().clone(), history, watch);

            // Always available: show the window from anywhere.
            let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            match app.global_shortcut().register(toggle) {
                Ok(_) => {
                    let _ = app.global_shortcut().on_shortcut(toggle, move |app, _s, event| {
                        if event.state == ShortcutState::Pressed {
                            show_main_window(app);
                            emit_hotkey(app, "dispatch", None);
                        }
                    });
                }
                Err(e) => eprintln!("Failed to register global shortcut: {e}"),
            }

            // Explorer context menu launch: remember the target, show the window.
            let pending = open_file_path.map(|path| (path, false)).or_else(|| open_dir_path.map(|path| (path, true)));
            if let Some((path, is_dir)) = pending {
                *app.state::<PendingOpen>().0.lock().unwrap() = Some((path, is_dir));
                show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<TrayState>();
                if state.0.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_log_error,
            ai_list_models,
            ai_analyze_stream,
            set_autostart,
            get_autostart,
            set_tray_enabled,
            set_context_menu_enabled,
            get_context_menu_enabled,
            open_file,
            take_pending_open,
            clipboard::read_clipboard,
            clipboard::clipboard_write_text,
            clipboard::clipboard_history,
            clipboard::clipboard_clear_history,            clipboard::set_clipboard_watch,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            sql::sql_test,
sql::sql_disconnect,
            sql::sql_execute,
            sql::sql_databases,
            sql::sql_tables,
            sql::sql_table_columns,
            sql::sql_table_rows,
            sql::sql_update_row,
            sql::sql_insert_row,
            sql::sql_delete_rows,
            sql::sql_table_ddl,
            sql::sql_export_table,
sql::sql_create_table,
sql::sql_alter_table,
            net::net_port_scan,
            net::net_dns_lookup,
            net::net_tcp_send,
            net::net_traceroute,
            net::net_ip_geo,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_exec,
            ssh::ssh_resize,
            ssh::ssh_close,
            apply_hotkeys
        ])
        .build(tauri::generate_context!())
        .expect("error while building Spurh")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                ssh::close_all(&app.state::<ssh::SshSessions>());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::read_text_flexible;

    #[test]
    fn utf8_text_passes_through() {
        let text = "spurh 工具箱 你好\n";
        assert_eq!(read_text_flexible(text.as_bytes()).unwrap(), text);
    }

    #[test]
    fn gbk_text_decodes_fallback() {
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode("中文日志：连接失败\n");
        let decoded = read_text_flexible(&gbk_bytes).unwrap();
        assert!(decoded.contains("中文日志"));
        assert!(decoded.contains("连接失败"));
        // 回退解码不应产生替换字符
        assert!(!decoded.contains('\u{FFFD}'));
    }

    #[test]
    fn binary_bytes_rejected() {
        // 伪随机二进制：两种解码都会产生大量替换字符
        let bytes: Vec<u8> = (0..200u8).map(|i| i.wrapping_mul(37).wrapping_add(11)).collect();
        assert!(read_text_flexible(&bytes).is_err());
    }
}