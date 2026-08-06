import { describe, expect, it } from 'vitest';
import { isTauri, safeInvoke, safeListen } from './env';

describe('env', () => {
  it('detects non-tauri browser environment', () => {
    expect(isTauri).toBe(false);
  });

  it('safeListen resolves to a noop unlisten in browser mode', async () => {
    const unlisten = await safeListen('any:event', () => {});
    expect(typeof unlisten).toBe('function');
    unlisten();
  });

  it('safeInvoke throws a friendly error in browser mode', async () => {
    await expect(safeInvoke('any_command')).rejects.toThrow('浏览器预览模式无法调用桌面能力');
  });
});
