// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import TerminalView, { type RemoteSession } from './TerminalView.svelte';

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
  Channel: vi.fn(),
  Terminal: vi.fn(),
  FitAddon: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({ Terminal: mocks.Terminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: mocks.FitAddon }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: mocks.Channel }));
vi.mock('../env', () => ({
  isTauri: true,
  safeInvoke: mocks.safeInvoke,
  safeListen: vi.fn(() => Promise.resolve(() => undefined)),
}));

const session: RemoteSession = {
  id: 'test-1',
  name: 't',
  host: '127.0.0.1',
  port: 22,
  user: 'root',
  authType: 'password',
  password: 'secret',
  keyPath: '',
  passphrase: '',
};

function stubTerminal(): void {
  const term = {
    loadAddon: vi.fn(),
    open: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onResize: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    getSelection: vi.fn(() => ''),
    write: vi.fn(),
    options: {},
    cols: 80,
    rows: 24,
  };
  mocks.Terminal.mockImplementation(function () {
      return {
        loadAddon: vi.fn(),
        open: vi.fn(),
        attachCustomKeyEventHandler: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onResize: vi.fn(() => vi.fn()),
        dispose: vi.fn(),
        clear: vi.fn(),
        focus: vi.fn(),
        getSelection: vi.fn(() => ''),
        write: vi.fn(),
        options: {},
        cols: 80,
        rows: 24,
      };
    });
  mocks.FitAddon.mockImplementation(function () {
      return { fit: vi.fn() };
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubTerminal();
  // jsdom has no ResizeObserver
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
});

describe('TerminalView', () => {
  it('\u9996\u6b21\u6302\u8f7d\u5373\u5efa\u7acb\u8fde\u63a5\uff08$effect \u5148\u4e8e onMount\uff09', async () => {
    const onState = vi.fn();
    mocks.safeInvoke.mockResolvedValue(undefined);
    mocks.Channel.mockImplementation(function (this: { onmessage: unknown }) {
      this.onmessage = null;
    });
    render(TerminalView, { props: { session, active: true, onState } });
    await waitFor(() => {
      expect(mocks.safeInvoke).toHaveBeenCalledWith('ssh_connect', expect.objectContaining({ sessionId: session.id }));
    });
    expect(onState).toHaveBeenCalledWith(session.id, expect.objectContaining({ status: 'connecting' }));
  });

  it('Channel \u6784\u9020\u5f02\u5e38\u65f6\u72b6\u6001\u53d8\u4e3a error \u800c\u975e\u5361\u6b7b', async () => {
    const onState = vi.fn();
    mocks.Channel.mockImplementation(() => {
      throw new TypeError('no transformCallback');
    });
    render(TerminalView, { props: { session, active: true, onState } });
    await waitFor(() => {
      expect(onState).toHaveBeenCalledWith(session.id, expect.objectContaining({ status: 'error' }));
    });
    expect(mocks.safeInvoke).not.toHaveBeenCalled();
  });

  it('\u975e\u6d3b\u8dc3\u65f6\u4e0d\u8fde\u63a5', async () => {
    const onState = vi.fn();
    render(TerminalView, { props: { session, active: false, onState } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.safeInvoke).not.toHaveBeenCalled();
  });
});
