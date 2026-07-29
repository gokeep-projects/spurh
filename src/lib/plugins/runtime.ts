import type { DispatchResult, PluginMatch, PluginResult, SpurhPlugin } from './types';

const DEFAULT_TIMEOUT_MS = 2_500;

export class PluginRuntime {
  readonly #plugins = new Map<string, SpurhPlugin>();

  constructor(plugins: SpurhPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: SpurhPlugin): void {
    if (!plugin.id || !/^[a-z][a-z0-9.-]*$/.test(plugin.id)) {
      throw new Error(`Invalid plugin id: ${plugin.id}`);
    }
    if (this.#plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    if (plugin.actions.length === 0) {
      throw new Error(`Plugin must expose at least one action: ${plugin.id}`);
    }
    this.#plugins.set(plugin.id, Object.freeze(plugin));
  }

  unregister(pluginId: string): boolean {
    return this.#plugins.delete(pluginId);
  }

  list(): SpurhPlugin[] {
    return [...this.#plugins.values()];
  }

  dispatch(input: string): DispatchResult {
    if (!input.trim()) return { selected: null, alternatives: [] };

    const matches: PluginMatch[] = [];
    for (const plugin of this.#plugins.values()) {
      try {
        const detection = plugin.detect(input);
        if (!detection || detection.confidence <= 0) continue;
        matches.push({
          plugin,
          confidence: Math.min(1, Math.max(0, detection.confidence)),
          reason: detection.reason,
        });
      } catch {
        // A broken detector must never make the command bar unusable.
      }
    }

    matches.sort((a, b) => {
      const confidence = b.confidence - a.confidence;
      if (confidence !== 0) return confidence;
      return (b.plugin.priority ?? 0) - (a.plugin.priority ?? 0);
    });

    return { selected: matches[0] ?? null, alternatives: matches.slice(1, 4) };
  }

  async execute(
    pluginId: string,
    actionId: string,
    input: string,
    options: Record<string, string> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<PluginResult> {
    const plugin = this.#plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
    if (!plugin.actions.some((action) => action.id === actionId)) {
      throw new Error(`Unknown action "${actionId}" for ${pluginId}`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(plugin.execute(actionId, input, options)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${plugin.name} 执行超时`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      throw new Error(`${plugin.name}: ${message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
