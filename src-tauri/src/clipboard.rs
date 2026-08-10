// 剪贴板读写：供所有工具的复制/粘贴使用（不维护历史）
use std::sync::{LazyLock, Mutex};

/// 复用一个剪贴板句柄（与旧版 read_clipboard 保持兼容）。
static CLIPBOARD: LazyLock<Mutex<Option<arboard::Clipboard>>> = LazyLock::new(|| Mutex::new(None));

#[tauri::command]
pub fn read_clipboard() -> Result<String, String> {
    let mut slot = CLIPBOARD
        .lock()
        .map_err(|_| "剪贴板锁被占用".to_string())?;
    if slot.is_none() {
        *slot = Some(arboard::Clipboard::new().map_err(|error| format!("无法访问剪贴板：{error}"))?);
    }
    slot.as_mut()
        .unwrap()
        .get_text()
        .map_err(|error| format!("剪贴板为空或非文本：{error}"))
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut slot = CLIPBOARD
        .lock()
        .map_err(|_| "剪贴板锁被占用".to_string())?;
    if slot.is_none() {
        *slot = Some(arboard::Clipboard::new().map_err(|error| format!("无法访问剪贴板：{error}"))?);
    }
    slot.as_mut()
        .unwrap()
        .set_text(text)
        .map_err(|error| format!("写入剪贴板失败：{error}"))
}
