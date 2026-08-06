// 系统钥匙串：AI API Key、数据库密码、SSH 密码等敏感信息不再落盘到 localStorage。
// Windows 使用 Credential Manager，macOS 使用 Keychain，Linux 使用 Secret Service。
use keyring::Entry;

const SERVICE: &str = "dev.spurh.app";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|error| format!("无法访问系统钥匙串：{error}"))
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|error| format!("写入钥匙串失败：{error}"))
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取钥匙串失败：{error}")),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除钥匙串条目失败：{error}")),
    }
}
