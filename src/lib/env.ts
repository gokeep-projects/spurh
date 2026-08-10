
/**
 * 运行环境检测与安全桥接。
 *
 * `npm run dev`（纯浏览器）下没有 Tauri IPC，直接调用 @tauri-apps/api 的
 * listen()/invoke() 会抛错（如 transformCallback undefined）。统一从这里
 * 判断环境，浏览器模式静默降级，保证开发预览不报错。
 */

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 浏览器模式下为空实现：不订阅任何事件，返回空取消函数。*/
export async function safeListen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(event, handler);
}

/**
 * 浏览器模式下调 Tauri 命令会抛原生 JS 错误（"Cannot read properties of
 * undefined"）。统一换成友好错误，让各面板已有的 catch 分支展示可读文案。
 */
export async function safeInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri) {
    throw new Error('浏览器预览模式无法调用桌面能力，请运行 npm run tauri dev 获得完整功能');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * 复制文本：桌面端走原生剪贴板命令（免 WebView2 权限弹窗），
 * 浏览器模式回退 navigator.clipboard。返回是否成功。
 */
export async function copyText(text: string): Promise<boolean> {
  if (isTauri) {
    try {
      await safeInvoke('clipboard_write_text', { text });
      return true;
    } catch {
      // 原生写入失败时回退 Web API
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 读取剪贴板文本：桌面端走原生命令，浏览器模式回退 Web API。 */
export async function readClipboardText(): Promise<string> {
  if (isTauri) {
    try {
      return (await safeInvoke<string>('read_clipboard')) ?? '';
    } catch {
      // fallthrough
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}
