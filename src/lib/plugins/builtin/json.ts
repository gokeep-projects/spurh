import { TOOL_ICONS as ICONS } from '../../icons';
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

/* ─────────────────────────── XML 格式化（纯字符串实现，node/浏览器均可用） ─────────────────────────── */

/** 从 '<' 位置开始查找标签结束位置（返回结束后的下标）：注释/CDATA/声明按各自结束符，普通标签引号感知 */
function xmlTagEnd(src: string, start: number): number {
  if (src.startsWith('<!--', start)) {
    const e = src.indexOf('-->', start + 4);
    return e === -1 ? -1 : e + 3;
  }
  if (src.startsWith('<![CDATA[', start)) {
    const e = src.indexOf(']]>', start + 9);
    return e === -1 ? -1 : e + 3;
  }
  if (src.startsWith('<?', start)) {
    const e = src.indexOf('?>', start + 2);
    return e === -1 ? -1 : e + 2;
  }
  let quote: string | null = null;
  for (let j = start + 1; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return j + 1;
  }
  return -1;
}

function formatXml(input: string): string {
  const src = input.trim();
  if (!src.startsWith('<')) throw new Error('XML 必须以 < 开头');
  const out: string[] = [];
  const stack: string[] = [];
  let depth = 0;
  let textBuf: string[] = [];
  const flushText = () => {
    const text = textBuf.join('').trim();
    textBuf = [];
    if (text) out.push('  '.repeat(depth) + text);
  };
  let i = 0;
  while (i < src.length) {
    if (src[i] === '<') {
      flushText();
      const end = xmlTagEnd(src, i);
      if (end === -1) throw new Error('XML 标签未闭合');
      const tag = src.slice(i, end);
      i = end;
      if (tag.startsWith('<!--') || tag.startsWith('<![CDATA[') || tag.startsWith('<?')) {
        out.push('  '.repeat(depth) + tag);
        continue;
      }
      if (tag.startsWith('</')) {
        const closingName = tag.slice(2, -1).trim();
        const top = stack[stack.length - 1];
        if (top && closingName !== top) {
          throw new Error(`XML 标签不匹配：期望 </${top}>，实际 </${closingName}>`);
        }
        depth = Math.max(0, depth - 1);
        out.push('  '.repeat(depth) + tag);
        stack.pop();
        continue;
      }
      if (tag.endsWith('/>')) {
        out.push('  '.repeat(depth) + tag);
        continue;
      }
      const name = tag.slice(1).match(/^[\w:.-]+/)?.[0];
      if (!name) throw new Error(`无法解析标签：${tag}`);
      out.push('  '.repeat(depth) + tag);
      stack.push(name);
      depth++;
    } else {
      const next = src.indexOf('<', i);
      const text = next === -1 ? src.slice(i) : src.slice(i, next);
      textBuf.push(text);
      i = next === -1 ? src.length : next;
    }
  }
  flushText();
  if (stack.length) throw new Error(`XML 标签未闭合：${stack.join(', ')}`);
  return out.join('\n');
}

function minifyXml(input: string): string {
  const src = input.trim();
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '<') {
      const end = xmlTagEnd(src, i);
      if (end === -1) throw new Error('XML 标签未闭合');
      out.push(src.slice(i, end));
      i = end;
    } else {
      const next = src.indexOf('<', i);
      const text = next === -1 ? src.slice(i) : src.slice(i, next);
      // 仅压缩标签间的纯空白，保留文本内容（CDATA/注释已由标签段整体保留）
      if (text.trim() !== '') out.push(text);
      i = next === -1 ? src.length : next;
    }
  }
  return out.join('');
}

export const jsonPlugin: SpurhPlugin = {
  id: 'spurh.json',
  name: '格式化',
  description: 'JSON / XML 格式化、压缩与解析',
  icon: ICONS['spurh.json'],
  version: '0.2.0',
  category: '数据',
  priority: 100,
  actions: [
    { id: 'format', label: '格式化', description: 'JSON 使用 2 空格缩进' },
    { id: 'xml-format', label: 'XML 格式化', description: 'XML 缩进排版' },
    { id: 'minify', label: '压缩', description: '移除不必要的空白' },
    { id: 'xml-minify', label: 'XML 压缩', description: '移除 XML 标签间空白' },
    { id: 'sort', label: '排序', description: '递归排序对象键' },
    { id: 'validate', label: '校验', description: '验证语法并显示结构' },
    { id: 'path', label: 'JSONPath', description: '查询 JSON 节点' },
  ],
  options: [
    { id: 'path', label: '路径', type: 'text', placeholder: '$.users[*].name', defaultValue: '$', actions: ['path'] },
  ],
  detect(input) {
    const value = input.trim();
    if (/^<[\w:?/-]/.test(value)) {
      try {
        formatXml(value);
        return { confidence: 0.92, reason: '检测到 XML 结构' };
      } catch {
        return { confidence: 0.6, reason: '内容看起来像 XML，但存在语法错误' };
      }
    }
    if (!(value.startsWith('{') || value.startsWith('['))) return null;
    try {
      JSON.parse(value);
      return { confidence: 0.99, reason: '检测到有效 JSON 结构' };
    } catch {
      return { confidence: 0.64, reason: '内容看起来像 JSON，但存在语法错误' };
    }
  },
  execute(actionId, input, options = {}): PluginResult {
    if (actionId === 'xml-format' || actionId === 'xml-minify') {
      const output = actionId === 'xml-format' ? formatXml(input) : minifyXml(input);
      return {
        output,
        language: 'text',
        view: 'text',
        summary: actionId === 'xml-format' ? '已格式化 XML' : '已压缩 XML',
        meta: { 字符数: output.length, 行数: actionId === 'xml-format' ? output.split('\n').length : 1 },
      };
    }
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
    if (actionId === 'minify') {
      // 压缩结果是单行文本：明确走文本视图，避免被树视图接管而看不到压缩效果
      return {
        output,
        language: 'json',
        view: 'text',
        summary: '已压缩 JSON',
        meta: { 字符数: output.length, 行数: 1 },
      };
    }
    return {
      output,
      language: 'json',
      view: 'code',
      summary: actionId === 'format' ? '已格式化 JSON' : actionId === 'sort' ? '已递归排序对象键' : 'JSON 语法和结构有效',
      meta: { 字符数: output.length },
    };
  },
};
