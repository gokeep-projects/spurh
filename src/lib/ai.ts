import { safeInvoke, safeListen } from './env';
import { deleteSecret, getSecret, setSecret } from './secrets';

export type AiConfig = {
  provider: string;
  endpoint: string;
  apiKey: string;
  model: string;
};

export type AiProfile = AiConfig & {
  id: string;
  name: string;
};

export type AiProfileStore = {
  activeId: string;
  profiles: AiProfile[];
};

export type AiModel = {
  id: string;
  ownedBy?: string;
};

type StreamEvent = {
  requestId: string;
  kind: 'reasoning' | 'content' | 'done' | 'error';
  delta: string;
};

export const AI_PRESETS: Record<string, Omit<AiConfig, 'apiKey'>> = {
  openai: { provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { provider: 'deepseek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' },
  anthropic: { provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  gemini: { provider: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  ollama: { provider: 'ollama', endpoint: 'http://localhost:11434/v1', model: '' },
  custom: { provider: 'custom', endpoint: '', model: '' },
};

const STORE_KEY = 'spurh.ai.profiles.v2';
const LEGACY_KEY = 'spurh.ai.config.v1';

function profileId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function migrateConfig(config: AiConfig): AiConfig {
  const next = { ...config };
  if (next.provider === 'deepseek') {
    if (next.model === 'deepseek-v4-flash') next.model = AI_PRESETS.deepseek.model;
    // 旧配置端点缺失或为占位值时，回退到官方预设地址；用户自定义有效地址则保留
    if (next.model === AI_PRESETS.deepseek.model && !/^https?:\/\//i.test(next.endpoint || '')) {
      next.endpoint = AI_PRESETS.deepseek.endpoint;
    }
  }
  if (next.provider === 'openai' && (next.model === 'gpt-5.6-terra' || next.model === 'gpt-5.5' || next.model === 'gpt-5.2')) {
    next.model = AI_PRESETS.openai.model;
  }
  // 旧版未知名服务商：回退到自定义配置入口
  if (!AI_PRESETS[next.provider]) next.provider = 'custom';
  if (next.provider === 'openai' && !next.model) next.model = AI_PRESETS.openai.model;
  return next;
}

export function createAiProfile(provider = 'openai', name?: string): AiProfile {
  const preset = AI_PRESETS[provider] ?? AI_PRESETS.custom;
  return {
    id: profileId(),
    name: name ?? (provider === 'custom' ? '自定义模型' : (provider === 'openai' ? 'OpenAI' : provider === 'deepseek' ? 'DeepSeek' : provider === 'anthropic' ? 'Anthropic' : provider === 'gemini' ? 'Gemini' : `${provider[0].toUpperCase()}${provider.slice(1)}`) + ' 模型'),
    ...preset,
    apiKey: '',
  };
}

// 从旧版 localStorage 迁移时发现的明文密钥，等待应用初始化后写入系统钥匙串
let pendingLegacySecrets: Array<{ profileId: string; apiKey: string }> = [];

/**
 * 读取配置。API Key 不再持久化到 localStorage：旧数据中的明文 key 会被剥离并
 * 收集到 pendingLegacySecrets，由 flushLegacyAiSecrets() 迁移到系统钥匙串。
 */
export function loadAiProfileStore(): AiProfileStore {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as AiProfileStore;
      const profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles.map((profile) => {
            const merged = { ...profile, ...migrateConfig(profile) };
            const apiKey = typeof merged.apiKey === 'string' && merged.apiKey ? merged.apiKey : '';
            if (apiKey) pendingLegacySecrets.push({ profileId: merged.id, apiKey });
            return { ...merged, apiKey: '' };
          })
        : [];
      // 迁移发生过变化（如旧假模型名）时写回，确保旧数据被真正清理
      const migrated = { profiles, activeId: profiles.some((profile) => profile.id === parsed.activeId) ? parsed.activeId : profiles[0]?.id ?? '' };
      const changed = profiles.some((profile, index) => JSON.stringify(profile) !== JSON.stringify(parsed.profiles[index]));
      if (changed) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(migrated)); } catch { /* 忽略写入失败 */ }
      }
      return migrated;
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const config = migrateConfig(JSON.parse(legacy) as AiConfig);
      const id = profileId();
      if (config.apiKey) pendingLegacySecrets.push({ profileId: id, apiKey: config.apiKey });
      const profile: AiProfile = { id, name: config.model || '默认模型', ...config, apiKey: '' };
      const migrated = { profiles: [profile], activeId: id };
      localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {
    // Fall through to an empty profile store. Local tools never depend on AI setup.
  }
  return { profiles: [], activeId: '' };
}

/** 把旧版 localStorage 里的明文 API Key 写入系统钥匙串（应用初始化时调用一次）。 */
export async function flushLegacyAiSecrets(): Promise<void> {
  const pending = pendingLegacySecrets;
  pendingLegacySecrets = [];
  for (const item of pending) {
    try {
      await setSecret('ai.' + item.profileId + '.apiKey', item.apiKey);
    } catch {
      // 钥匙串不可用时放弃迁移；旧明文已在 load 时剥离，不会再次落盘
    }
  }
}

/** 从系统钥匙串读取所有配置的 API Key，填充到内存中的 store。 */
export async function hydrateAiSecrets(store: AiProfileStore): Promise<AiProfileStore> {
  const profiles = await Promise.all(store.profiles.map(async (profile) => ({
    ...profile,
    apiKey: (await getSecret('ai.' + profile.id + '.apiKey')) ?? '',
  })));
  return { profiles, activeId: store.activeId };
}

/** 保存配置：只把非敏感字段写入 localStorage，API Key 单独写入系统钥匙串。 */
export function saveAiProfileStore(store: AiProfileStore): void {
  const stripped = {
    ...store,
    profiles: store.profiles.map(({ apiKey: _key, ...rest }) => rest),
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(stripped));
}

/** 将某个配置的 API Key 写入系统钥匙串（空值表示删除）。失败时抛出，由调用方提示用户。 */
export async function saveProfileSecret(profile: AiProfile): Promise<void> {
  await setSecret('ai.' + profile.id + '.apiKey', profile.apiKey);
}

/** 删除某个配置的 API Key。 */
export function deleteProfileSecret(profileId: string): void {
  deleteSecret('ai.' + profileId + '.apiKey').catch(() => undefined);
}

export function isAiConfigured(config: AiConfig | undefined): boolean {
  return Boolean(config?.endpoint.trim() && config.model.trim() && (config.provider === 'ollama' || config.apiKey.trim()));
}

export async function fetchAiModels(config: AiConfig): Promise<AiModel[]> {
  const endpoint = config.endpoint.trim();
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error('服务地址格式不正确：应以 http:// 或 https:// 开头，例如 https://api.openai.com/v1');
  }
  return safeInvoke<AiModel[]>('ai_list_models', { request: config });
}

export async function testAiConnection(config: AiConfig): Promise<string> {
  const models = await fetchAiModels(config);
  return models.length ? `连接成功，发现 ${models.length} 个可用模型` : '连接成功，服务未返回模型';
}

function cleanResult(content: string, expectJson: boolean): { output: string; parseError?: string } {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!expectJson) return { output: cleaned };
  try {
    return { output: JSON.stringify(JSON.parse(cleaned), null, 2) };
  } catch {
    return { output: cleaned, parseError: 'AI 返回了非严格 JSON，已展示原始输出' };
  }
}

export async function processWithAi(
  config: AiConfig,
  input: string,
  context: { tool: string; action: string; localError?: string; expectJson?: boolean; userPrompt?: string },
  onUpdate: (state: { reasoning: string; content: string }) => void,
): Promise<{ output: string; parseError?: string }> {
  const requestId = crypto.randomUUID();
  let reasoning = '';
  let content = '';
  const task = context.expectJson
    ? 'The user provided malformed JSON. You MUST repair it to strict RFC 8259 JSON. Fix unquoted keys, trailing commas, single quotes, unescaped characters. Return ONLY the corrected JSON — no markdown, no explanation.'
    : `You are a developer tool assistant. Process this ${context.tool} input (action: "${context.action}") and return the useful result concisely. Focus on correctness. Return plain text or JSON as appropriate. No conversational filler.`;
  const instruction = [
    task,
    context.userPrompt ? `Additional instruction: ${context.userPrompt}` : '',
    context.localError ? `Note: local processing failed with: ${context.localError}` : '',
    'CRITICAL: Output ONLY the result. No introductions, no summaries, no markdown code fences.',
  ].filter(Boolean).join(' ');

  const unlisten = await safeListen<StreamEvent>('ai-stream', (event) => {
    if (event.payload.requestId !== requestId) return;
    if (event.payload.kind === 'reasoning') reasoning += event.payload.delta;
    if (event.payload.kind === 'content') content += event.payload.delta;
    onUpdate({ reasoning, content });
  });
  try {
    const finalContent = await safeInvoke<string>('ai_analyze_stream', {
      request: { ...config, input, instruction },
      requestId,
    });
    if (!content) content = finalContent;
    onUpdate({ reasoning, content });
    return cleanResult(content, Boolean(context.expectJson));
  } finally {
    unlisten();
  }
}
