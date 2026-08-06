// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
  safeListen: vi.fn(),
  setSecret: vi.fn(),
  getSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));

vi.mock('./env', () => ({
  isTauri: true,
  safeInvoke: mocks.safeInvoke,
  safeListen: mocks.safeListen,
}));
vi.mock('./secrets', () => ({
  setSecret: mocks.setSecret,
  getSecret: mocks.getSecret,
  deleteSecret: mocks.deleteSecret,
}));

import {
  AI_PRESETS,
  createAiProfile,
  deleteProfileSecret,
  flushLegacyAiSecrets,
  hydrateAiSecrets,
  isAiConfigured,
  loadAiProfileStore,
  processWithAi,
  saveAiProfileStore,
  saveProfileSecret,
} from './ai';

const STORE_KEY = 'spurh.ai.profiles.v2';
const LEGACY_KEY = 'spurh.ai.config.v1';

function storeJson(): string | null {
  return localStorage.getItem(STORE_KEY);
}

beforeEach(() => {
  localStorage.clear();
  mocks.safeInvoke.mockReset();
  mocks.safeListen.mockReset();
  mocks.setSecret.mockReset();
  mocks.getSecret.mockReset();
  mocks.deleteSecret.mockReset();
});

describe('AI_PRESETS', () => {
  it('exposes sane defaults for every provider', () => {
    expect(AI_PRESETS.openai.endpoint).toBe('https://api.openai.com/v1');
    expect(AI_PRESETS.deepseek.model).toMatch(/^deepseek/);
    expect(AI_PRESETS.qwen.endpoint).toContain('dashscope');
    expect(AI_PRESETS.ollama.endpoint).toBe('http://localhost:11434/v1');
    expect(AI_PRESETS.custom.endpoint).toBe('');
  });
});

describe('loadAiProfileStore', () => {
  it('returns an empty store when nothing is stored', () => {
    expect(loadAiProfileStore()).toEqual({ profiles: [], activeId: '' });
  });

  it('strips plaintext api keys from stored profiles', () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        activeId: 'p1',
        profiles: [
          { id: 'p1', name: 'A', provider: 'openai', endpoint: 'https://x', model: 'm', apiKey: 'sk-secret' },
        ],
      }),
    );
    const store = loadAiProfileStore();
    expect(store.profiles[0].apiKey).toBe('');
    expect(store.activeId).toBe('p1');
  });

  it('collects legacy keys for later flush to the keyring', async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        activeId: 'p1',
        profiles: [{ id: 'p1', name: 'A', provider: 'openai', endpoint: 'https://x', model: 'm', apiKey: 'sk-old' }],
      }),
    );
    loadAiProfileStore();
    await flushLegacyAiSecrets();
    expect(mocks.setSecret).toHaveBeenCalledWith('ai.p1.apiKey', 'sk-old');
  });

  it('migrates the legacy v1 config into a profile store', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ provider: 'deepseek', endpoint: 'old', model: 'deepseek-chat', apiKey: 'k' }));
    const store = loadAiProfileStore();
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0].apiKey).toBe('');
    // deepseek-chat is migrated to the current preset
    expect(store.profiles[0].model).toBe(AI_PRESETS.deepseek.model);
    expect(store.profiles[0].endpoint).toBe(AI_PRESETS.deepseek.endpoint);
    expect(JSON.parse(storeJson()!)).toMatchObject({ activeId: store.activeId });
  });

  it('falls back to the first profile when activeId is stale', () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        activeId: 'gone',
        profiles: [{ id: 'p1', name: 'A', provider: 'custom', endpoint: '', model: 'm' }],
      }),
    );
    expect(loadAiProfileStore().activeId).toBe('p1');
  });

  it('returns an empty store on corrupted JSON', () => {
    localStorage.setItem(STORE_KEY, '{broken');
    expect(loadAiProfileStore()).toEqual({ profiles: [], activeId: '' });
  });
});

describe('saveAiProfileStore', () => {
  it('never persists api keys to localStorage', () => {
    saveAiProfileStore({
      activeId: 'p1',
      profiles: [{ id: 'p1', name: 'A', provider: 'openai', endpoint: 'https://x', model: 'm', apiKey: 'sk-secret' }],
    });
    const raw = storeJson();
    expect(raw).not.toContain('sk-secret');
    expect(raw).toContain('https://x');
  });
});

describe('isAiConfigured', () => {
  it('requires endpoint and model', () => {
    expect(isAiConfigured(undefined)).toBe(false);
    expect(isAiConfigured({ provider: 'openai', endpoint: '', model: 'm', apiKey: 'k' })).toBe(false);
    expect(isAiConfigured({ provider: 'openai', endpoint: 'https://x', model: '', apiKey: 'k' })).toBe(false);
  });

  it('requires an api key except for ollama', () => {
    expect(isAiConfigured({ provider: 'openai', endpoint: 'https://x', model: 'm', apiKey: '' })).toBe(false);
    expect(isAiConfigured({ provider: 'openai', endpoint: 'https://x', model: 'm', apiKey: 'k' })).toBe(true);
    // ollama ? API Key??????????? /v1 ???? model ???
    expect(isAiConfigured({ provider: 'ollama', endpoint: 'http://localhost:11434/v1', model: '', apiKey: '' })).toBe(false);
    expect(isAiConfigured({ provider: 'ollama', endpoint: 'http://localhost:11434/v1', model: 'llama3', apiKey: '' })).toBe(true);
  });
});

describe('createAiProfile / secrets', () => {
  it('creates profiles from presets and falls back to custom', () => {
    expect(createAiProfile('custom')).toMatchObject({ provider: 'custom', endpoint: '', model: '', apiKey: '' });
    expect(createAiProfile('openai')).toMatchObject({ provider: 'openai', endpoint: AI_PRESETS.openai.endpoint });
    expect(createAiProfile('nope')).toMatchObject({ provider: 'custom' });
  });

  it('hydrates keys from the keyring', async () => {
    mocks.getSecret.mockImplementation(async (key: string) => (key === 'ai.p1.apiKey' ? 'sk-real' : null));
    const store = await hydrateAiSecrets({
      activeId: 'p1',
      profiles: [{ id: 'p1', name: 'A', provider: 'openai', endpoint: 'https://x', model: 'm', apiKey: '' }],
    });
    expect(store.profiles[0].apiKey).toBe('sk-real');
  });

  it('saves and deletes profile secrets with the right key', async () => {
    mocks.setSecret.mockResolvedValue(undefined);
    mocks.deleteSecret.mockResolvedValue(undefined);
    const profile = { id: 'p1', name: 'A', provider: 'openai', endpoint: 'https://x', model: 'm', apiKey: 'sk' };
    saveProfileSecret(profile);
    await vi.waitFor(() => expect(mocks.setSecret).toHaveBeenCalled());
    expect(mocks.setSecret).toHaveBeenCalledWith('ai.p1.apiKey', 'sk');
    deleteProfileSecret('p1');
    expect(mocks.deleteSecret).toHaveBeenCalledWith('ai.p1.apiKey');
  });
});

describe('processWithAi', () => {
  const config = { provider: 'openai', endpoint: 'https://x', model: 'm', apiKey: 'sk' };

  it('strips markdown fences and pretty-prints JSON', async () => {
    mocks.safeListen.mockResolvedValue(() => undefined);
    mocks.safeInvoke.mockResolvedValue('```json\n{"a":1,"b":[1,2]}\n```');
    const result = await processWithAi(config, '{"a":1}', { tool: 'json', action: 'format', expectJson: true }, () => {});
    expect(result.output).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(result.parseError).toBeUndefined();
  });

  it('accumulates streamed reasoning and content', async () => {
    let handler: (event: { payload: { requestId: string; kind: string; delta: string } }) => void = () => {};
    mocks.safeListen.mockImplementation(async (_event: string, cb: typeof handler) => {
      console.log('safeListen called');
      const wrapped = (event: { payload: { requestId: string; kind: string; delta: string } }) => {
        console.log('emit', event.payload.requestId.slice(0, 8), event.payload.kind, JSON.stringify(event.payload.delta));
        cb(event);
      };
      handler = wrapped;
      return () => undefined;
    });
    // defer the invoke: stream events must arrive while the request is still in flight
    let resolveInvoke!: (value: string) => void;
    mocks.safeInvoke.mockImplementation(() => new Promise<string>((resolve) => { resolveInvoke = resolve; }));
    const updates: Array<{ reasoning: string; content: string }> = [];
    const promise = processWithAi(config, 'hi', { tool: 'text', action: 'stats' }, (state) => updates.push(state));
    await vi.waitFor(() => expect(resolveInvoke).toBeDefined());
    const requestId = (mocks.safeInvoke.mock.calls[0] as unknown[])[1] as { requestId: string };
    handler({ payload: { requestId: requestId.requestId, kind: 'reasoning', delta: 'think ' } });
    handler({ payload: { requestId: requestId.requestId, kind: 'content', delta: 'hello' } });
    handler({ payload: { requestId: 'other', kind: 'content', delta: 'ignored' } });
    resolveInvoke(''); // streamed final content; invoke returns nothing extra
    const result = await promise;
    expect(result.output).toBe('hello');
    expect(updates[updates.length - 1]).toEqual({ reasoning: 'think ', content: 'hello' });
  });

  it('reports a parse error for non-JSON output when JSON is expected', async () => {
    mocks.safeListen.mockResolvedValue(() => undefined);
    mocks.safeInvoke.mockResolvedValue('not json at all');
    const result = await processWithAi(config, 'x', { tool: 'json', action: 'format', expectJson: true }, () => {});
    expect(result.output).toBe('not json at all');
    expect(result.parseError).toBeTruthy();
  });

  it('propagates invoke errors and always unlistens', async () => {
    const unlisten = vi.fn();
    mocks.safeListen.mockResolvedValue(unlisten);
    mocks.safeInvoke.mockRejectedValue(new Error('AI ????'));
    await expect(processWithAi(config, 'x', { tool: 'text', action: 'stats' }, () => {})).rejects.toThrow('AI ????');
    expect(unlisten).toHaveBeenCalled();
  });
});
