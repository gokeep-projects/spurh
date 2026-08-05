import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

export const clipboardPlugin: SpurhPlugin = {
  id: 'spurh.clipboard',
  name: '剪贴板历史',
  description: '最近复制内容 · 搜索与复用',
  icon: ICONS['spurh.clipboard'],
  version: '0.1.0',
  category: '开发',
  priority: 50,
  actions: [{ id: 'open', label: '打开', description: '打开剪贴板历史' }],
  detect() {
    return null;
  },
  execute(): PluginResult {
    return { output: '请在剪贴板历史面板中使用', view: 'text', summary: '打开剪贴板历史' };
  },
};
