import type { PluginResult, SpurhPlugin } from '../types';

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`JSON 语法错误：${error.message}`);
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function queryJsonPath(value: unknown, path: string): unknown {
  if (!path.startsWith('$')) throw new Error('JSONPath 必须以 $ 开头');
  const tokens = [...path.slice(1).matchAll(/\.([\w-]+)|\[['"]([^'"]+)['"]\]|\[(\d+|\*)\]/g)];
  const consumed = tokens.map((token) => token[0]).join('');
  if (consumed !== path.slice(1)) throw new Error('当前支持 $.key、[index] 和 [*] 路径');
  let current: unknown[] = [value];
  for (const token of tokens) {
    const key = token[1] ?? token[2];
    const index = token[3];
    current = current.flatMap((item) => {
      if (key !== undefined && item !== null && typeof item === 'object' && key in item) {
        return [(item as Record<string, unknown>)[key]];
      }
      if (index === '*' && Array.isArray(item)) return item;
      if (index !== undefined && Array.isArray(item) && Number(index) < item.length) return [item[Number(index)]];
      return [];
    });
  }
  return current.length === 1 ? current[0] : current;
}

export const jsonPlugin: SpurhPlugin = {
  id: 'spurh.json',
  name: 'JSON 工具',
  description: '格式化、压缩与稳定排序',
  icon: '{ }',
  version: '0.1.0',
  category: '数据',
  priority: 100,
  actions: [
    { id: 'format', label: '格式化', description: '使用 2 空格缩进' },
    { id: 'minify', label: '压缩', description: '移除不必要的空白' },
    { id: 'sort', label: '排序', description: '递归排序对象键' },
    { id: 'validate', label: '校验', description: '验证语法并显示结构' },
    { id: 'path', label: 'JSONPath', description: '查询 JSON 节点' },
  ],
  options: [
    { id: 'path', label: '路径', type: 'text', placeholder: '$.users[*].name', defaultValue: '$', actions: ['path'] },
  ],
  detect(input) {
    const value = input.trim();
    if (!(value.startsWith('{') || value.startsWith('['))) return null;
    try {
      JSON.parse(value);
      return { confidence: 0.99, reason: '检测到有效 JSON 结构' };
    } catch {
      return { confidence: 0.64, reason: '内容看起来像 JSON，但存在语法错误' };
    }
  },
  execute(actionId, input, options = {}): PluginResult {
    const parsed = parseJson(input);
    if (actionId === 'path') {
      const queried = queryJsonPath(parsed, options.path || '$');
      return {
        output: JSON.stringify(queried, null, 2), language: 'json', summary: `已查询 ${options.path || '$'}`,
        view: 'code',
        meta: { 路径: options.path || '$' },
      };
    }
    const output = actionId === 'minify'
      ? JSON.stringify(parsed)
      : JSON.stringify(actionId === 'sort' ? sortValue(parsed) : parsed, null, 2);
    return {
      output,
      language: 'json',
      view: 'code',
      summary: actionId === 'minify' ? '已压缩 JSON' : actionId === 'sort' ? '已递归排序对象键' : actionId === 'validate' ? 'JSON 语法和结构有效' : '已格式化 JSON',
      meta: { 字符数: output.length },
    };
  },
};
