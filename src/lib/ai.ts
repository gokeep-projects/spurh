import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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
  openai: { provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.6-terra' },
  deepseek: { provider: 'deepseek', endpoint: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  qwen: { provider: 'qwen', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus' },
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
  if (next.provider === 'deepseek' && next.model === 'deepseek-chat') {
    next.endpoint = AI_PRESETS.deepseek.endpoint;
    next.model = AI_PRESETS.deepseek.model;
  }
  if (next.provider === 'qwen' && next.model === 'qwen-plus') next.model = AI_PRESETS.qwen.model;
  if (next.provider === 'openai' && !next.model) next.model = AI_PRESETS.openai.model;
  return next;
}

export function createAiProfile(provider = 'openai', name?: string): AiProfile {
  const preset = AI_PRESETS[provider] ?? AI_PRESETS.custom;
  return {
    id: profileId(),
    name: name ?? (provider === 'custom' ? '自定义模型' : `${provider[0].toUpperCase()}${provider.slice(1)} 模型`),
    ...preset,
    apiKey: '',
  };
}

export function loadAiProfileStore(): AiProfileStore {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as AiProfileStore;
      const profiles = Array.isArray(parsed.profiles) ? parsed.profiles.map((profile) => ({ ...profile, ...migrateConfig(profile) })) : [];
      return { profiles, activeId: profiles.some((profile) => profile.id === parsed.activeId) ? parsed.activeId : profiles[0]?.id ?? '' };
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const config = migrateConfig(JSON.parse(legacy) as AiConfig);
      const profile: AiProfile = { id: profileId(), name: config.model || '默认模型', ...config };
      const migrated = { profiles: [profile], activeId: profile.id };
      localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {
    // Fall through to an empty profile store. Local tools never depend on AI setup.
  }
  return { profiles: [], activeId: '' };
}

export function saveAiProfileStore(store: AiProfileStore): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

export function isAiConfigured(config: AiConfig | undefined): boolean {
  return Boolean(config?.endpoint.trim() && config.model.trim() && (config.provider === 'ollama' || config.apiKey.trim()));
}

export async function fetchAiModels(config: AiConfig): Promise<AiModel[]> {
  return invoke<AiModel[]>('ai_list_models', { request: config });
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

  const unlisten = await listen<StreamEvent>('ai-stream', (event) => {
    if (event.payload.requestId !== requestId) return;
    if (event.payload.kind === 'reasoning') reasoning += event.payload.delta;
    if (event.payload.kind === 'content') content += event.payload.delta;
    onUpdate({ reasoning, content });
  });
  try {
    const finalContent = await invoke<string>('ai_analyze_stream', {
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
