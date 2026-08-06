export type Detection = {
  confidence: number;
  reason: string;
  /** 命中时建议自动切换到的动作（如 JWT → jwt-decode），可为空 */
  suggestedAction?: string;
};

export type PluginAction = {
  id: string;
  label: string;
  description: string;
};

export type PluginOption = {
  id: string;
  label: string;
  type: 'text' | 'select' | 'datetime' | 'number' | 'password';
  placeholder?: string;
  defaultValue: string;
  choices?: Array<{ value: string; label: string }>;
  actions?: string[];
  showWhen?: { optionId: string; values: string[] };
};

export type PluginResult = {
  output: string;
  language?: string;
  summary?: string;
  meta?: Record<string, string | number | boolean>;
  view?: 'code' | 'text' | 'timestamp' | 'jwt' | 'hash' | 'matches' | 'stats' | 'list' | 'http' | 'sql' | 'log' | 'colors';
  data?: unknown;
};

export type SpurhPlugin = {
  id: string;
  name: string;
  description: string;
  icon: string;
  version: string;
  category: '数据' | '编码' | '安全' | '开发';
  priority?: number;
  actions: PluginAction[];
  options?: PluginOption[];
  detect(input: string): Detection | null;
  execute(
    actionId: string,
    input: string,
    options?: Record<string, string>,
  ): Promise<PluginResult> | PluginResult;
};

export type PluginMatch = {
  plugin: SpurhPlugin;
  confidence: number;
  reason: string;
  suggestedAction?: string;
};

export type DispatchResult = {
  selected: PluginMatch | null;
  alternatives: PluginMatch[];
};
