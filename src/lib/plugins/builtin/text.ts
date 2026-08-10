import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

function countWords(input: string): number {
  const latinWords = input.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return latinWords.length;
}

function wrapText(input: string, width: number): string {
  return input.split('\n').flatMap((line) => {
    if (!line) return [''];
    const chunks: string[] = [];
    const characters = [...line];
    for (let index = 0; index < characters.length; index += width) {
      chunks.push(characters.slice(index, index + width).join(''));
    }
    return chunks;
  }).join('\n');
}

function unescapeText(input: string): string {
  // 单遍解析：从左到右匹配反斜杠转义。\\（字面反斜杠）与 \uXXXX 与其它转义
  // 在同一遍完成，因此 \\n / \\uXXXX 会先匹配为「字面反斜杠 + n/XXXX」，
  // 不会被误还原为换行或 Unicode 字符（修复 Windows 路径被破坏的问题）。
  return input.replace(/\\(?:u([0-9a-fA-F]{4})|([\\nrtbf"'/]))/g, (_, unicode: string, simple: string) => {
    if (unicode !== undefined) return String.fromCharCode(Number.parseInt(unicode, 16));
    switch (simple) {
      case '\\': return '\\';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return simple;
    }
  });
}

function splitWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
}

function joinCase(input: string, separator: string): string {
  const words = splitWords(input).map((word) => word.toLowerCase());
  if (!words.length) return '';
  // camel（separator=''）时后续单词首字母大写，其余风格全部小写连接
  return words.map((word, index) =>
    !separator && index > 0 ? word[0].toUpperCase() + word.slice(1) : word,
  ).join(separator);
}


type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

type LogEntry = {
  line: number;
  time?: string;
  level?: LogLevel;
  source?: string;
  message: string;
  stack?: string[];
};

const LOG_LEVEL_RE = /\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;
const LOG_TIME_RE = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/;

const MAX_LOG_ENTRIES = 2000;
const MAX_LOG_LINE = 2000;

/** 解析常见日志格式（时间戳 + 级别 + 消息 + 来源 + 堆栈），输出结构化结果 */
function parseLogs(input: string): { entries: LogEntry[]; counts: Record<string, number>; rootCause?: string } {
  const lines = input.split(/\r?\n/);
  const entries: LogEntry[] = [];
  const counts: Record<string, number> = {};
  let current: LogEntry | null = null;
  const rootCauses: string[] = [];

  const append = (entry: LogEntry): LogEntry => {
    if (entries.length < MAX_LOG_ENTRIES) {
      entries.push(entry);
      if (entry.level) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
      return entry;
    }
    return current ?? entry;
  };

  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].replace(/\s+$/, '').slice(0, MAX_LOG_LINE);
    const trimmed = text.trim();
    if (!trimmed) continue;

    // 堆栈帧 / 异常链：挂到上一条记录
    if (current && /^(at |\s+at |Caused by:|Suppressed:|\s*\.\.\.\s*\d+ more)/.test(trimmed)) {
      if (/^Caused by:/i.test(trimmed)) {
        rootCauses.push(trimmed.replace(/^Caused by:\s*/i, '').slice(0, 300));
      }
      if (!current.stack) current.stack = [];
      if (current.stack.length < 24) current.stack.push(trimmed);
      continue;
    }

    const timeMatch = text.match(LOG_TIME_RE);
    const levelMatch = text.match(LOG_LEVEL_RE);
    const time = timeMatch ? timeMatch[1] : undefined;
    const level = levelMatch ? (levelMatch[1].toUpperCase().replace('WARNING', 'WARN') as LogLevel) : undefined;

    if (!time && !level) {
      // 无时间无级别的行：作为上一条消息的续行；没有上一条则单独成条
      if (current) {
        current.message = (current.message + '\n' + trimmed).slice(0, MAX_LOG_LINE);
      } else {
        current = append({ line: index + 1, message: trimmed });
      }
      continue;
    }

    let message = text;
    if (time) message = message.replace(LOG_TIME_RE, '');
    if (levelMatch) message = message.replace(LOG_LEVEL_RE, '');
    // 去掉常见前缀装饰：[2024-...] [INFO] / INFO: / - 等
    message = message
      .replace(/^[\s\[\](){}:|-]+/, '')
      .replace(/\s+\|?\s*$/, '')
      .trim();
    // 来源：形如 - com.foo.Bar:42 / at com.foo.Bar.main(Bar.java:42)
    let source: string | undefined;
    const srcMatch = message.match(/(?:-|at)\s*([\w.$]+(?:\([^)]*\))?:\d+(?::\d+)?)$/);
    if (srcMatch) {
      source = srcMatch[1];
      message = message.slice(0, srcMatch.index).replace(/[\s-]+$/, '');
    }
    current = append({ line: index + 1, time, level, source, message: message.slice(0, MAX_LOG_LINE) });
  }

  let rootCause: string | undefined;
  if (rootCauses.length) {
    rootCause = rootCauses[rootCauses.length - 1];
  } else {
    const lastError = [...entries].reverse().find((entry) => entry.level === 'ERROR' || entry.level === 'FATAL');
    if (lastError) rootCause = lastError.message.slice(0, 300);
  }
  return { entries, counts, rootCause };
}

export const textPlugin: SpurhPlugin = {
  id: 'spurh.text',
  name: '文本处理',
  description: '日志解析、统计、换行、清理与特殊字符处理',
  icon: ICONS['spurh.text'],
  version: '0.1.0',
  category: '数据',
  priority: 78,
  actions: [
    { id: 'log-parse', label: '日志解析', description: '解析日志：时间/级别/来源/堆栈与错误统计' },
    { id: 'stats', label: '字符统计', description: '统计字符、单词、行数与字节' },
    { id: 'wrap', label: '自动换行', description: '按指定字符宽度自动换行' },
    { id: 'trim', label: '清理空白', description: '清理首尾空格和多余空行' },
    { id: 'dedupe', label: '行去重', description: '保持顺序去除重复行' },
    { id: 'remove-empty', label: '删除空行', description: '删除所有空白行' },
    { id: 'sort-lines', label: '行排序', description: '按字典序排列每一行' },
    { id: 'reverse', label: '反转文本', description: '按字符顺序反转整个文本' },
    { id: 'lines-reverse', label: '行序反转', description: '反转行的排列顺序' },
    { id: 'camel', label: '转驼峰', description: '单词连接为 camelCase' },
    { id: 'snake', label: '转蛇形', description: '单词连接为 snake_case' },
    { id: 'kebab', label: '转烤肉串', description: '单词连接为 kebab-case' },
    { id: 'escape', label: '特殊字符转义', description: '转义换行、制表符、引号等字符' },
    { id: 'unescape', label: '还原特殊字符', description: '把转义序列还原成真实字符' },
    { id: 'upper', label: '大写', description: '转换为大写文本' },
    { id: 'lower', label: '小写', description: '转换为小写文本' },
  ],
  options: [
    { id: 'width', label: '每行字符', type: 'text', defaultValue: '80', placeholder: '80', actions: ['wrap'] },
    { id: 'aiPrompt', label: 'AI 提示语', type: 'text', defaultValue: '', placeholder: '例如：润色语气，并保持原意' },
  ],
  detect(input) {
    const trimmed = input.trim();
    if (/^text:/i.test(trimmed)) return { confidence: 0.82, reason: '检测到文本处理指令', suggestedAction: 'stats' };
    // 日志行：任意行同时出现时间戳 + 级别关键字（堆栈续行可不带级别）→ 建议日志解析
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
    const leveled = lines.filter((line) => LOG_LEVEL_RE.test(line));
    const timed = lines.filter((line) => LOG_TIME_RE.test(line));
    if (leveled.length >= 1 && timed.length >= 1) {
      return { confidence: 0.88, reason: '检测到日志格式（时间戳 + 级别）', suggestedAction: 'log-parse' };
    }
    return null;
  },
  execute(actionId, input, options = {}): PluginResult {
    if (input.length > 10_000_000) throw new Error('输入过大（超过 1000 万字符），请分片处理');
    const content = input.replace(/^text:\s*/i, '');
    if (actionId === 'log-parse') {
      const parsed = parseLogs(content);
      const errorCount = (parsed.counts.ERROR ?? 0) + (parsed.counts.FATAL ?? 0);
      return {
        output: content,
        language: 'text',
        view: 'log',
        data: { format: 'text', entries: parsed.entries, counts: parsed.counts, rootCause: parsed.rootCause },
        summary: `${parsed.entries.length} 条记录 · ${errorCount} 条错误`,
        meta: { 记录: parsed.entries.length, 错误: errorCount, 警告: parsed.counts.WARN ?? 0, INFO: parsed.counts.INFO ?? 0, 根因: parsed.rootCause ? '已提取' : '无' },
      };
    }
    if (actionId === 'stats') {
      const stats = {
        字符数: [...content].length,
        不含空格: [...content.replace(/\s/g, '')].length,
        单词数: countWords(content),
        行数: content.length ? content.split(/\r?\n/).length : 0,
        段落数: content.trim() ? content.trim().split(/\n\s*\n/).length : 0,
        UTF8字节: new TextEncoder().encode(content).length,
      };
      return {
        output: Object.entries(stats).map(([key, value]) => `${key}: ${value}`).join('\n'),
        language: 'text',
        view: 'stats',
        data: stats,
        summary: '文本统计已实时更新',
        meta: { 字符: stats.字符数, 行数: stats.行数 },
      };
    }

    let output = content;
    if (actionId === 'wrap') {
      const width = Number.parseInt(options.width || '80', 10);
      if (!Number.isFinite(width) || width < 1 || width > 500) throw new Error('每行字符数请输入 1 到 500');
      output = wrapText(content, width);
    } else if (actionId === 'trim') {
      output = content.split(/\r?\n/).map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    } else if (actionId === 'dedupe') {
      output = [...new Set(content.split(/\r?\n/))].join('\n');
    } else if (actionId === 'remove-empty') {
      output = content.split(/\r?\n/).filter((line) => line.trim() !== '').join('\n');
    } else if (actionId === 'sort-lines') {
      output = content.split(/\r?\n/).sort((a, b) => a.localeCompare(b)).join('\n');
    } else if (actionId === 'reverse') {
      output = [...content].reverse().join('');
    } else if (actionId === 'lines-reverse') {
      output = content.split(/\r?\n/).reverse().join('\n');
    } else if (actionId === 'camel') {
      output = joinCase(content, '');
    } else if (actionId === 'snake') {
      output = joinCase(content, '_');
    } else if (actionId === 'kebab') {
      output = joinCase(content, '-');
    } else if (actionId === 'escape') {
      output = JSON.stringify(content).slice(1, -1);
    } else if (actionId === 'unescape') {
      output = unescapeText(content);
    } else if (actionId === 'upper') {
      output = content.toLocaleUpperCase();
    } else if (actionId === 'lower') {
      output = content.toLocaleLowerCase();
    }
    return {
      output,
      language: 'text',
      view: 'text',
      summary: '文本处理完成',
      meta: { 输入字符: [...content].length, 输出字符: [...output].length },
    };
  },
};
