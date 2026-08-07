import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

// Git 仓库工具：真正的逻辑在 GitPanel（直接调用 Rust 命令），
// 这里负责在侧栏 / 命令面板中注册入口。
export const gitPlugin: SpurhPlugin = {
  id: 'spurh.git',
  name: 'Git 仓库',
  description: '打开仓库 · 文件变更 · 提交推送 · 分支与历史',
  icon: ICONS['spurh.git'],
  version: '0.1.0',
  category: '开发',
  priority: 52,
  actions: [{ id: 'open', label: '打开', description: '打开 Git 仓库工作台' }],
  detect() {
    return null;
  },
  execute(): PluginResult {
    return { output: '请在 Git 仓库工作台中使用', view: 'text', summary: '打开 Git 仓库工作台' };
  },
};
