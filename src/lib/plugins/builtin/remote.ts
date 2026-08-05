import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

export const remotePlugin: SpurhPlugin = {
  id: 'spurh.remote',
  name: '远程连接',
  description: 'SSH 终端 · 会话管理',
  icon: ICONS['spurh.remote'],
  version: '0.1.0',
  category: '开发',
  priority: 48,
  actions: [{ id: 'open', label: '打开', description: '打开远程终端' }],
  detect() {
    return null;
  },
  execute(): PluginResult {
    return { output: '请在远程终端面板中使用', view: 'text', summary: '打开远程终端' };
  },
};
