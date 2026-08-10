import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

// 网络工具是面板型工具：真正的逻辑在 NetworkPanel（直接调用 Rust 命令），
// 这里只负责在侧栏 / 命令面板中注册入口。
export const networkPlugin: SpurhPlugin = {
  id: 'spurh.network',
  name: '网络工具',
  description: '端口探测 · DNS · 链路追踪 · TCP/UDP · 速查',
  icon: ICONS['spurh.network'],
  version: '0.1.0',
  category: '开发',
  priority: 55,
  actions: [{ id: 'open', label: '打开', description: '打开网络工具箱' }],
  detect() {
    return null;
  },
  execute(): PluginResult {
    return { output: '请在网络工具箱中使用', view: 'text', summary: '打开网络工具箱' };
  },
};
