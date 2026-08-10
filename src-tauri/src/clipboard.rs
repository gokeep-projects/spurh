// 剪贴板历史：后台监听 + 写入 + 历史快照
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

const HISTORY_LIMIT: usize = 100;
const WATCH_INTERVAL_MS: u64 = 1200;

/// 复用一个剪贴板句柄（与旧版 read_clipboard 保持兼容）。
static CLIPBOARD: LazyLock<Mutex<Option<arboard::Clipboard>>> = LazyLock::new(|| Mutex::new(None));
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn item_id() -> String {
    format!("{}-{}", now_ms(), ID_COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardItem {
    pub id: String,
    pub text: String,
    pub ts: u64,
}

#[derive(Default)]
struct HistoryInner {
    items: VecDeque<ClipboardItem>,
    last: Option<String>,
}

pub struct ClipboardHistory {
    inner: Mutex<HistoryInner>,
}

impl Default for ClipboardHistory {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HistoryInner::default()),
        }
    }
}

impl ClipboardHistory {
    /// 记录新的剪贴板内容；与上一条相同则忽略。返回新条目。
    pub fn push(&self, text: String) -> Option<ClipboardItem> {
        let mut inner = self.inner.lock().unwrap();
        if inner.last.as_deref() == Some(text.as_str()) {
            return None;
        }
        inner.last = Some(text.clone());
        let item = ClipboardItem {
            id: item_id(),
            text,
            ts: now_ms(),
        };
        inner.items.push_front(item.clone());
        if inner.items.len() > HISTORY_LIMIT {
            inner.items.truncate(HISTORY_LIMIT);
        }
        Some(item)
    }

    pub fn snapshot(&self) -> Vec<ClipboardItem> {
        self.inner.lock().unwrap().items.iter().cloned().collect()
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.items.clear();
        inner.last = None;
    }

    pub fn last(&self) -> Option<String> {
        self.inner.lock().unwrap().last.clone()
    }
}

fn emit_history(app: &tauri::AppHandle, history: &ClipboardHistory) {
    let _ = app.emit("clipboard:history", history.snapshot());
}

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
pub fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    {
        let mut slot = CLIPBOARD
            .lock()
            .map_err(|_| "剪贴板锁被占用".to_string())?;
        if slot.is_none() {
            *slot = Some(arboard::Clipboard::new().map_err(|error| format!("无法访问剪贴板：{error}"))?);
        }
        slot.as_mut()
            .unwrap()
            .set_text(text.clone())
            .map_err(|error| format!("写入剪贴板失败：{error}"))?;
    }
    let history = app.state::<Arc<ClipboardHistory>>();
    if let Some(item) = history.push(text) {
        emit_history(&app, &history);
        let _ = app.emit("clipboard:item", item);
    }
    Ok(())
}

#[tauri::command]
pub fn clipboard_history(app: tauri::AppHandle) -> Vec<ClipboardItem> {
    app.state::<Arc<ClipboardHistory>>().snapshot()
}

#[tauri::command]
pub fn clipboard_clear_history(app: tauri::AppHandle) {
    let history = app.state::<Arc<ClipboardHistory>>();
    history.clear();
    emit_history(&app, &history);
}

/// 剪贴板监听开关：由前端设置项控制，默认开启（与历史版本行为一致）。
pub struct ClipboardWatch(pub AtomicBool);

/// 在独立线程中轮询剪贴板：文本变化时写入历史并推送事件。
/// 监听被关闭时线程休眠但不退出，重新开启后立即恢复记录。
pub fn start_watcher(app: tauri::AppHandle, history: Arc<ClipboardHistory>, enabled: Arc<ClipboardWatch>) {
    std::thread::spawn(move || {
        let mut clip = arboard::Clipboard::new().ok();
        loop {
            std::thread::sleep(Duration::from_millis(WATCH_INTERVAL_MS));
            if !enabled.0.load(Ordering::Relaxed) {
                continue;
            }
            if clip.is_none() {
                clip = arboard::Clipboard::new().ok();
                continue;
            }
            let text = clip.as_mut().and_then(|clipboard| clipboard.get_text().ok());
            let Some(text) = text else { continue };
            if history.last().as_deref() == Some(text.as_str()) {
                continue;
            }
            if let Some(item) = history.push(text) {
                emit_history(&app, &history);
                let _ = app.emit("clipboard:item", item);
            }
        }
    });
}

#[tauri::command]
pub fn set_clipboard_watch(state: tauri::State<'_, Arc<ClipboardWatch>>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
}
