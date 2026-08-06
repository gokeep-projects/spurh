import { invoke } from '@tauri-apps/api/core';

/**
 * 敏感信息统一存入系统钥匙串（Windows Credential Manager / macOS Keychain / Linux Secret Service），
 * localStorage 只保存非敏感配置。所有操作均为异步。
 */
const PREFIX = 'spurh';

export function secretKey(name: string): string {
  return PREFIX + '.' + name;
}

export async function setSecret(name: string, value: string): Promise<void> {
  if (!value) {
    await deleteSecret(name);
    return;
  }
  await invoke('secret_set', { key: secretKey(name), value });
}

export async function getSecret(name: string): Promise<string | null> {
  return invoke<string | null>('secret_get', { key: secretKey(name) });
}

export async function deleteSecret(name: string): Promise<void> {
  await invoke('secret_delete', { key: secretKey(name) }).catch(() => undefined);
}
