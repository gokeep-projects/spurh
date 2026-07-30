use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{process::Command, sync::atomic::{AtomicBool, Ordering}, time::Duration};
use tauri::{Emitter, Manager};

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

struct TrayState(AtomicBool);

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
    if !(endpoint.starts_with("https://")
        || endpoint.starts_with("http://localhost")
        || endpoint.starts_with("http://127.0.0.1"))
    {
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
) -> bool {
    let Some(data) = line.trim().strip_prefix("data:") else {
        return false;
    };
    let data = data.trim();
    if data == "[DONE]" {
        return true;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    let Some(delta) = value.pointer("/choices/0/delta") else {
        return false;
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
    false
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
            if process_sse_line(&app, &request_id, &line, &mut final_content) {
                done = true;
                break;
            }
        }
        if done {
            break;
        }
    }
    if !buffer.trim().is_empty() {
        process_sse_line(&app, &request_id, &buffer, &mut final_content);
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
        return reg_command()
            .args(["query", KEY, "/v", "Spurh"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "windows"))]
    false
}

#[cfg(target_os = "windows")]
fn register_context_menu(app_path: &str) -> Result<(), String> {
    let icon_path = app_path.replace('\\', "\\\\");
    let command = format!("\"{}\" \"--open\" \"%1\"", app_path.replace('\\', "\\\\"));

    reg_command()
        .args(["add", r"HKCU\Software\Classes\*\shell\Spurh", "/ve", "/t", "REG_SZ", "/d", "用 Spurh 打开", "/f"])
        .status()
        .map_err(|e| format!("注册右键菜单失败：{e}"))?;

    reg_command()
        .args(["add", r"HKCU\Software\Classes\*\shell\Spurh", "/v", "Icon", "/t", "REG_SZ", "/d", &icon_path, "/f"])
        .status()
        .map_err(|e| format!("注册右键图标失败：{e}"))?;

    reg_command()
        .args(["add", r"HKCU\Software\Classes\*\shell\Spurh\command", "/ve", "/t", "REG_SZ", "/d", &command, "/f"])
        .status()
        .map_err(|e| format!("注册右键命令失败：{e}"))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_context_menu() -> Result<(), String> {
    reg_command()
        .args(["delete", r"HKCU\Software\Classes\*\shell\Spurh", "/f"])
        .status()
        .map_err(|e| format!("移除右键菜单失败：{e}"))?;
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

#[tauri::command]
async fn open_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("无法读取文件 {}：{e}", path))?;
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| format!("{e}"))?;
        window.set_focus().map_err(|e| format!("{e}"))?;
    }
    Ok(content)
}

#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("无法访问剪贴板：{e}"))?;
    clipboard.get_text().map_err(|e| format!("剪贴板为空或非文本：{e}"))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(cli_args: Vec<String>) {
    let mut open_file_path: Option<String> = None;
    let mut args = cli_args.iter();
    while let Some(arg) = args.next() {
        if arg == "--open" {
            open_file_path = args.next().cloned();
        }
    }

    tauri::Builder::default()
        .manage(TrayState(AtomicBool::new(false)))
        .setup(move |app| {
            if let Some(path) = open_file_path {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval(&format!(
                            "window.__spurhOpenFile&&window.__spurhOpenFile({})",
                            serde_json::to_string(&json!({ "path": path, "content": content })).unwrap_or_default()
                        ));
                    }
                }
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
            ai_list_models,
            ai_analyze_stream,
            set_autostart,
            get_autostart,
            set_tray_enabled,
            set_context_menu_enabled,
            get_context_menu_enabled,
            open_file,
            read_clipboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running Spurh");
}
